const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { getTenantConnection } = require('../config/database');

// Track online users per tenant: { tenantCode: { userId: { socketId, role, fullName } } }
const onlineUsers = {};
// Track active chat sessions: { sessionId: { customerSocketId, expertSocketId } }
const activeSessions = {};
// Auto-assign timers: { sessionId: timeoutId }
const autoAssignTimers = {};

const AUTO_ASSIGN_DELAY_MS = 60000; // 60 seconds before auto-assign

function initializeChatSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    path: '/socket.io'
  });

  // JWT authentication middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth.token || socket.handshake.query.token;
    if (!token) return next(new Error('Authentication required'));

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key-change-in-production');
      socket.user = decoded;
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.user;
    const tenantCode = user.tenantCode;

    // Track online presence
    if (!onlineUsers[tenantCode]) onlineUsers[tenantCode] = {};
    onlineUsers[tenantCode][user.userId] = {
      socketId: socket.id,
      role: user.role,
      username: user.username,
      userId: user.userId
    };

    // Join tenant room
    socket.join(`tenant:${tenantCode}`);
    socket.join(`user:${tenantCode}:${user.userId}`);

    // Notify experts about online status
    io.to(`tenant:${tenantCode}`).emit('presence_update', {
      onlineExperts: getOnlineExperts(tenantCode)
    });

    console.log(`[Chat] ${user.username} (${user.role}) connected - tenant: ${tenantCode}`);

    // --- Customer Events ---

    // Customer initiates a chat session
    socket.on('chat:start', async (data, callback) => {
      try {
        const connection = await getTenantConnection(tenantCode);
        try {
          // Count waiting sessions for queue position
          const [waiting] = await connection.query(
            `SELECT COUNT(*) as cnt FROM chat_sessions WHERE status = 'waiting'`
          );
          const queuePosition = (waiting[0]?.cnt || 0) + 1;

          // Create session
          const [result] = await connection.query(
            `INSERT INTO chat_sessions (customer_user_id, status, queue_position) VALUES (?, 'waiting', ?)`,
            [user.userId, queuePosition]
          );
          const sessionId = result.insertId;

          // Add system message
          await connection.query(
            `INSERT INTO chat_messages (session_id, sender_role, message_type, content) VALUES (?, 'system', 'system', ?)`,
            [sessionId, `Chat session started. You are #${queuePosition} in queue.`]
          );

          // Join session room
          socket.join(`chat:${sessionId}`);
          activeSessions[sessionId] = { customerSocketId: socket.id };

          // Broadcast to all online experts
          io.to(`tenant:${tenantCode}`).emit('chat:new_request', {
            sessionId,
            customerId: user.userId,
            customerName: user.username,
            queuePosition,
            createdAt: new Date().toISOString()
          });

          // Start auto-assign timer
          startAutoAssignTimer(io, tenantCode, sessionId, connection);

          if (callback) callback({ success: true, sessionId, queuePosition });
        } finally {
          connection.release();
        }
      } catch (err) {
        console.error('[Chat] Error starting session:', err);
        if (callback) callback({ success: false, error: 'Failed to start chat' });
      }
    });

    // Send a message
    socket.on('chat:message', async (data, callback) => {
      try {
        const { sessionId, content, messageType = 'text', fileUrl, fileName, fileSize } = data;
        const connection = await getTenantConnection(tenantCode);
        try {
          // Save message
          const [result] = await connection.query(
            `INSERT INTO chat_messages (session_id, sender_user_id, sender_role, message_type, content, file_url, file_name, file_size)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [sessionId, user.userId, user.role === 'customer' ? 'customer' : 'expert', messageType, content, fileUrl || null, fileName || null, fileSize || null]
          );

          const message = {
            id: result.insertId,
            sessionId,
            senderUserId: user.userId,
            senderRole: user.role === 'customer' ? 'customer' : 'expert',
            senderName: user.username,
            messageType,
            content,
            fileUrl,
            fileName,
            fileSize,
            createdAt: new Date().toISOString()
          };

          // Broadcast to session room
          io.to(`chat:${sessionId}`).emit('chat:message', message);

          if (callback) callback({ success: true, messageId: result.insertId });
        } finally {
          connection.release();
        }
      } catch (err) {
        console.error('[Chat] Error sending message:', err);
        if (callback) callback({ success: false, error: 'Failed to send message' });
      }
    });

    // Typing indicator
    socket.on('chat:typing', (data) => {
      const { sessionId } = data;
      socket.to(`chat:${sessionId}`).emit('chat:typing', {
        sessionId,
        userId: user.userId,
        username: user.username
      });
    });

    // Mark messages as read
    socket.on('chat:read', async (data) => {
      try {
        const { sessionId } = data;
        const connection = await getTenantConnection(tenantCode);
        try {
          await connection.query(
            `UPDATE chat_messages SET read_at = NOW() WHERE session_id = ? AND sender_user_id != ? AND read_at IS NULL`,
            [sessionId, user.userId]
          );
          socket.to(`chat:${sessionId}`).emit('chat:read', { sessionId, readBy: user.userId });
        } finally {
          connection.release();
        }
      } catch (err) {
        console.error('[Chat] Error marking read:', err);
      }
    });

    // --- Expert Events ---

    // Expert claims a chat session
    socket.on('chat:claim', async (data, callback) => {
      try {
        const { sessionId } = data;
        if (user.role !== 'admin' && user.role !== 'expert') {
          return callback && callback({ success: false, error: 'Only experts can claim chats' });
        }

        const connection = await getTenantConnection(tenantCode);
        try {
          // Check session is still waiting
          const [sessions] = await connection.query(
            `SELECT * FROM chat_sessions WHERE id = ? AND status = 'waiting'`, [sessionId]
          );
          if (sessions.length === 0) {
            return callback && callback({ success: false, error: 'Session already claimed or closed' });
          }

          // Clear auto-assign timer
          if (autoAssignTimers[sessionId]) {
            clearTimeout(autoAssignTimers[sessionId]);
            delete autoAssignTimers[sessionId];
          }

          // Claim the session
          await connection.query(
            `UPDATE chat_sessions SET expert_user_id = ?, status = 'active', started_at = NOW() WHERE id = ?`,
            [user.userId, sessionId]
          );

          // Add system message
          await connection.query(
            `INSERT INTO chat_messages (session_id, sender_role, message_type, content) VALUES (?, 'system', 'system', ?)`,
            [sessionId, `${user.username} has joined the chat.`]
          );

          // Join session room
          socket.join(`chat:${sessionId}`);
          if (activeSessions[sessionId]) {
            activeSessions[sessionId].expertSocketId = socket.id;
          }

          // Notify the session room
          io.to(`chat:${sessionId}`).emit('chat:expert_joined', {
            sessionId,
            expertId: user.userId,
            expertName: user.username
          });

          // Update queue positions for remaining waiting sessions
          await updateQueuePositions(connection, tenantCode, io);

          // Notify all experts that this session was claimed
          io.to(`tenant:${tenantCode}`).emit('chat:request_claimed', { sessionId, expertId: user.userId });

          if (callback) callback({ success: true });
        } finally {
          connection.release();
        }
      } catch (err) {
        console.error('[Chat] Error claiming session:', err);
        if (callback) callback({ success: false, error: 'Failed to claim chat' });
      }
    });

    // Expert transfers a chat
    socket.on('chat:transfer', async (data, callback) => {
      try {
        const { sessionId, targetExpertId, reason } = data;
        const connection = await getTenantConnection(tenantCode);
        try {
          await connection.query(
            `UPDATE chat_sessions SET expert_user_id = ?, transferred_from_expert_id = ?, transfer_reason = ?, status = 'active' WHERE id = ?`,
            [targetExpertId, user.userId, reason || null, sessionId]
          );

          // Get target expert name
          const [experts] = await connection.query(`SELECT username, full_name FROM users WHERE id = ?`, [targetExpertId]);
          const targetName = experts[0]?.full_name || experts[0]?.username || 'another expert';

          // Add system message
          await connection.query(
            `INSERT INTO chat_messages (session_id, sender_role, message_type, content) VALUES (?, 'system', 'system', ?)`,
            [sessionId, `You've been transferred to ${targetName}.${reason ? ' Reason: ' + reason : ''}`]
          );

          // Notify session
          io.to(`chat:${sessionId}`).emit('chat:transferred', {
            sessionId,
            fromExpertId: user.userId,
            toExpertId: targetExpertId,
            toExpertName: targetName,
            reason
          });

          // Notify target expert
          io.to(`user:${tenantCode}:${targetExpertId}`).emit('chat:transfer_incoming', { sessionId });

          // Leave session room for old expert
          socket.leave(`chat:${sessionId}`);

          if (callback) callback({ success: true });
        } finally {
          connection.release();
        }
      } catch (err) {
        console.error('[Chat] Error transferring:', err);
        if (callback) callback({ success: false, error: 'Failed to transfer' });
      }
    });

    // Close a chat session
    socket.on('chat:close', async (data, callback) => {
      try {
        const { sessionId } = data;
        const connection = await getTenantConnection(tenantCode);
        try {
          await connection.query(
            `UPDATE chat_sessions SET status = 'closed', ended_at = NOW() WHERE id = ?`, [sessionId]
          );

          await connection.query(
            `INSERT INTO chat_messages (session_id, sender_role, message_type, content) VALUES (?, 'system', 'system', 'Chat session ended.')`,
            [sessionId]
          );

          io.to(`chat:${sessionId}`).emit('chat:closed', { sessionId });

          // Cleanup
          delete activeSessions[sessionId];
          if (autoAssignTimers[sessionId]) {
            clearTimeout(autoAssignTimers[sessionId]);
            delete autoAssignTimers[sessionId];
          }

          if (callback) callback({ success: true });
        } finally {
          connection.release();
        }
      } catch (err) {
        console.error('[Chat] Error closing session:', err);
        if (callback) callback({ success: false, error: 'Failed to close' });
      }
    });

    // Rate a chat session
    socket.on('chat:rate', async (data, callback) => {
      try {
        const { sessionId, rating } = data;
        const connection = await getTenantConnection(tenantCode);
        try {
          await connection.query(
            `UPDATE chat_sessions SET satisfaction_rating = ? WHERE id = ?`, [rating, sessionId]
          );
          if (callback) callback({ success: true });
        } finally {
          connection.release();
        }
      } catch (err) {
        if (callback) callback({ success: false });
      }
    });

    // Join an existing session (for reconnection or transfer acceptance)
    socket.on('chat:join', (data) => {
      const { sessionId } = data;
      socket.join(`chat:${sessionId}`);
    });

    // Expert-to-expert direct message
    socket.on('chat:direct', async (data, callback) => {
      try {
        const { targetUserId, content } = data;
        // For expert-to-expert, we create a session on-the-fly or reuse existing
        const connection = await getTenantConnection(tenantCode);
        try {
          // Check for existing active direct session between these two users
          const [existing] = await connection.query(
            `SELECT id FROM chat_sessions WHERE
             ((customer_user_id = ? AND expert_user_id = ?) OR (customer_user_id = ? AND expert_user_id = ?))
             AND status = 'active'
             ORDER BY created_at DESC LIMIT 1`,
            [user.userId, targetUserId, targetUserId, user.userId]
          );

          let sessionId;
          if (existing.length > 0) {
            sessionId = existing[0].id;
          } else {
            const [result] = await connection.query(
              `INSERT INTO chat_sessions (customer_user_id, expert_user_id, status, started_at) VALUES (?, ?, 'active', NOW())`,
              [user.userId, targetUserId]
            );
            sessionId = result.insertId;
          }

          // Save message
          await connection.query(
            `INSERT INTO chat_messages (session_id, sender_user_id, sender_role, message_type, content) VALUES (?, ?, 'expert', 'text', ?)`,
            [sessionId, user.userId, content]
          );

          socket.join(`chat:${sessionId}`);

          // Notify target
          io.to(`user:${tenantCode}:${targetUserId}`).emit('chat:direct_message', {
            sessionId,
            senderId: user.userId,
            senderName: user.username,
            content,
            createdAt: new Date().toISOString()
          });

          if (callback) callback({ success: true, sessionId });
        } finally {
          connection.release();
        }
      } catch (err) {
        console.error('[Chat] Error sending direct message:', err);
        if (callback) callback({ success: false });
      }
    });

    // Disconnect
    socket.on('disconnect', () => {
      if (onlineUsers[tenantCode]) {
        delete onlineUsers[tenantCode][user.userId];
      }
      io.to(`tenant:${tenantCode}`).emit('presence_update', {
        onlineExperts: getOnlineExperts(tenantCode)
      });
      console.log(`[Chat] ${user.username} disconnected`);
    });
  });

  return io;
}

function getOnlineExperts(tenantCode) {
  const users = onlineUsers[tenantCode] || {};
  return Object.values(users)
    .filter(u => u.role === 'admin' || u.role === 'expert')
    .map(u => ({ userId: u.userId, username: u.username, role: u.role }));
}

async function updateQueuePositions(connection, tenantCode, io) {
  const [waiting] = await connection.query(
    `SELECT id FROM chat_sessions WHERE status = 'waiting' ORDER BY created_at ASC`
  );
  for (let i = 0; i < waiting.length; i++) {
    await connection.query(`UPDATE chat_sessions SET queue_position = ? WHERE id = ?`, [i + 1, waiting[i].id]);
    io.to(`chat:${waiting[i].id}`).emit('chat:queue_update', { sessionId: waiting[i].id, queuePosition: i + 1 });
  }
}

function startAutoAssignTimer(io, tenantCode, sessionId) {
  autoAssignTimers[sessionId] = setTimeout(async () => {
    try {
      const connection = await getTenantConnection(tenantCode);
      try {
        // Check if still waiting
        const [sessions] = await connection.query(
          `SELECT * FROM chat_sessions WHERE id = ? AND status = 'waiting'`, [sessionId]
        );
        if (sessions.length === 0) return;

        // Find best available expert (fewest active sessions)
        const experts = getOnlineExperts(tenantCode);
        if (experts.length === 0) return; // No experts online, stay in queue

        // Get active session counts per expert
        const [counts] = await connection.query(
          `SELECT expert_user_id, COUNT(*) as cnt FROM chat_sessions WHERE status = 'active' AND expert_user_id IS NOT NULL GROUP BY expert_user_id`
        );
        const countMap = {};
        counts.forEach(c => { countMap[c.expert_user_id] = c.cnt; });

        // Sort experts by fewest active chats
        experts.sort((a, b) => (countMap[a.userId] || 0) - (countMap[b.userId] || 0));
        const bestExpert = experts[0];

        // Auto-assign
        await connection.query(
          `UPDATE chat_sessions SET expert_user_id = ?, status = 'active', started_at = NOW() WHERE id = ? AND status = 'waiting'`,
          [bestExpert.userId, sessionId]
        );

        await connection.query(
          `INSERT INTO chat_messages (session_id, sender_role, message_type, content) VALUES (?, 'system', 'system', ?)`,
          [sessionId, `${bestExpert.username} has been automatically assigned to your chat.`]
        );

        io.to(`chat:${sessionId}`).emit('chat:expert_joined', {
          sessionId,
          expertId: bestExpert.userId,
          expertName: bestExpert.username,
          autoAssigned: true
        });

        io.to(`user:${tenantCode}:${bestExpert.userId}`).emit('chat:auto_assigned', { sessionId });
        io.to(`tenant:${tenantCode}`).emit('chat:request_claimed', { sessionId, expertId: bestExpert.userId });

        await updateQueuePositions(connection, tenantCode, io);
      } finally {
        connection.release();
      }
    } catch (err) {
      console.error('[Chat] Auto-assign error:', err);
    }
    delete autoAssignTimers[sessionId];
  }, AUTO_ASSIGN_DELAY_MS);
}

function getOnlineUsersForTenant(tenantCode) {
  return onlineUsers[tenantCode] || {};
}

module.exports = { initializeChatSocket, getOnlineExperts, getOnlineUsersForTenant };
