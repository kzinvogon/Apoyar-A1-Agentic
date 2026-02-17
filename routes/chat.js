const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getTenantConnection } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { getOnlineExperts } = require('../services/chat-socket');
const { ChatQualificationEngine } = require('../services/chat-qualification');

router.use(verifyToken);

// Configure multer for chat file uploads (max 10MB)
const chatUploadDir = path.join(__dirname, '..', 'uploads', 'chat');
if (!fs.existsSync(chatUploadDir)) {
  fs.mkdirSync(chatUploadDir, { recursive: true });
}

const chatStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, chatUploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const chatUpload = multer({
  storage: chatStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|pdf|doc|docx|xls|xlsx|txt|csv|zip/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    if (ext || mime) cb(null, true);
    else cb(new Error('Only images, documents, and archives are allowed'));
  }
});

// GET /:tenantId/sessions - List chat sessions
router.get('/:tenantId/sessions', async (req, res) => {
  try {
    const tenantCode = req.params.tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);
    try {
      const { status, limit = 50 } = req.query;
      let query, params;

      if (req.user.role === 'customer') {
        // Customers see only their own sessions
        query = `SELECT cs.*, u.full_name as expert_name,
                   (SELECT COUNT(*) FROM chat_messages WHERE session_id = cs.id AND read_at IS NULL AND sender_user_id != ?) as unread_count,
                   (SELECT content FROM chat_messages WHERE session_id = cs.id ORDER BY created_at DESC LIMIT 1) as last_message
                 FROM chat_sessions cs
                 LEFT JOIN users u ON cs.expert_user_id = u.id
                 WHERE cs.customer_user_id = ?`;
        params = [req.user.userId, req.user.userId];
        if (status) { query += ` AND cs.status = ?`; params.push(status); }
        query += ` ORDER BY cs.updated_at DESC LIMIT ?`;
        params.push(parseInt(limit));
      } else {
        // Experts/admins see all sessions
        query = `SELECT cs.*, cu.full_name as customer_name, eu.full_name as expert_name,
                   (SELECT COUNT(*) FROM chat_messages WHERE session_id = cs.id AND read_at IS NULL AND sender_user_id != ?) as unread_count,
                   (SELECT content FROM chat_messages WHERE session_id = cs.id ORDER BY created_at DESC LIMIT 1) as last_message
                 FROM chat_sessions cs
                 LEFT JOIN users cu ON cs.customer_user_id = cu.id
                 LEFT JOIN users eu ON cs.expert_user_id = eu.id
                 WHERE 1=1`;
        params = [req.user.userId];
        if (status) { query += ` AND cs.status = ?`; params.push(status); }
        query += ` ORDER BY cs.updated_at DESC LIMIT ?`;
        params.push(parseInt(limit));
      }

      const [sessions] = await connection.query(query, params);
      res.json({ success: true, sessions });
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error('[Chat API] Error listing sessions:', err);
    res.status(500).json({ success: false, error: 'Failed to list sessions' });
  }
});

// GET /:tenantId/sessions/:sessionId - Get session detail with messages
router.get('/:tenantId/sessions/:sessionId', async (req, res) => {
  try {
    const tenantCode = req.params.tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const { sessionId } = req.params;
    const connection = await getTenantConnection(tenantCode);
    try {
      const [sessions] = await connection.query(
        `SELECT cs.*, cu.full_name as customer_name, eu.full_name as expert_name
         FROM chat_sessions cs
         LEFT JOIN users cu ON cs.customer_user_id = cu.id
         LEFT JOIN users eu ON cs.expert_user_id = eu.id
         WHERE cs.id = ?`,
        [sessionId]
      );

      if (sessions.length === 0) {
        return res.status(404).json({ success: false, error: 'Session not found' });
      }

      const [messages] = await connection.query(
        `SELECT cm.*, u.full_name as sender_name
         FROM chat_messages cm
         LEFT JOIN users u ON cm.sender_user_id = u.id
         WHERE cm.session_id = ?
         ORDER BY cm.created_at ASC`,
        [sessionId]
      );

      res.json({ success: true, session: sessions[0], messages });
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error('[Chat API] Error getting session:', err);
    res.status(500).json({ success: false, error: 'Failed to get session' });
  }
});

// GET /:tenantId/sessions/:sessionId/messages - Get messages (with pagination)
router.get('/:tenantId/sessions/:sessionId/messages', async (req, res) => {
  try {
    const tenantCode = req.params.tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const { sessionId } = req.params;
    const { before, limit = 50 } = req.query;
    const connection = await getTenantConnection(tenantCode);
    try {
      let query = `SELECT cm.*, u.full_name as sender_name
                   FROM chat_messages cm
                   LEFT JOIN users u ON cm.sender_user_id = u.id
                   WHERE cm.session_id = ?`;
      const params = [sessionId];

      if (before) {
        query += ` AND cm.id < ?`;
        params.push(parseInt(before));
      }

      query += ` ORDER BY cm.created_at DESC LIMIT ?`;
      params.push(parseInt(limit));

      const [messages] = await connection.query(query, params);
      res.json({ success: true, messages: messages.reverse() });
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error('[Chat API] Error getting messages:', err);
    res.status(500).json({ success: false, error: 'Failed to get messages' });
  }
});

// GET /:tenantId/queue - Get queue status
router.get('/:tenantId/queue', async (req, res) => {
  try {
    const tenantCode = req.params.tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);
    try {
      const [waiting] = await connection.query(
        `SELECT cs.id, cs.queue_position, cs.created_at, u.full_name as customer_name
         FROM chat_sessions cs
         LEFT JOIN users u ON cs.customer_user_id = u.id
         WHERE cs.status = 'waiting'
         ORDER BY cs.queue_position ASC`
      );
      const [activeCount] = await connection.query(
        `SELECT COUNT(*) as cnt FROM chat_sessions WHERE status = 'active'`
      );

      const experts = getOnlineExperts(tenantCode);

      res.json({
        success: true,
        queue: waiting,
        activeChats: activeCount[0].cnt,
        onlineExperts: experts.length,
        experts
      });
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error('[Chat API] Error getting queue:', err);
    res.status(500).json({ success: false, error: 'Failed to get queue' });
  }
});

// GET /:tenantId/online-experts - Get online experts
router.get('/:tenantId/online-experts', async (req, res) => {
  try {
    const tenantCode = req.params.tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const experts = getOnlineExperts(tenantCode);
    res.json({ success: true, experts, count: experts.length });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to get online experts' });
  }
});

// GET /:tenantId/canned-responses - List canned responses
router.get('/:tenantId/canned-responses', async (req, res) => {
  try {
    const tenantCode = req.params.tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);
    try {
      const [responses] = await connection.query(
        `SELECT * FROM chat_canned_responses WHERE is_active = TRUE ORDER BY sort_order ASC, label ASC`
      );
      res.json({ success: true, responses });
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error('[Chat API] Error listing canned responses:', err);
    res.status(500).json({ success: false, error: 'Failed to list canned responses' });
  }
});

// POST /:tenantId/canned-responses - Create canned response (admin only)
router.post('/:tenantId/canned-responses', async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin only' });
    }
    const tenantCode = req.params.tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const { label, message, action_type = 'text', sort_order = 0 } = req.body;
    const connection = await getTenantConnection(tenantCode);
    try {
      const [result] = await connection.query(
        `INSERT INTO chat_canned_responses (label, message, action_type, sort_order) VALUES (?, ?, ?, ?)`,
        [label, message, action_type, sort_order]
      );
      res.json({ success: true, id: result.insertId });
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error('[Chat API] Error creating canned response:', err);
    res.status(500).json({ success: false, error: 'Failed to create' });
  }
});

// PUT /:tenantId/canned-responses/:id - Update canned response (admin only)
router.put('/:tenantId/canned-responses/:id', async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin only' });
    }
    const tenantCode = req.params.tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const { id } = req.params;
    const { label, message, action_type, sort_order, is_active } = req.body;
    const connection = await getTenantConnection(tenantCode);
    try {
      const updates = [];
      const params = [];
      if (label !== undefined) { updates.push('label = ?'); params.push(label); }
      if (message !== undefined) { updates.push('message = ?'); params.push(message); }
      if (action_type !== undefined) { updates.push('action_type = ?'); params.push(action_type); }
      if (sort_order !== undefined) { updates.push('sort_order = ?'); params.push(sort_order); }
      if (is_active !== undefined) { updates.push('is_active = ?'); params.push(is_active); }

      if (updates.length === 0) {
        return res.status(400).json({ success: false, error: 'No fields to update' });
      }

      params.push(id);
      await connection.query(`UPDATE chat_canned_responses SET ${updates.join(', ')} WHERE id = ?`, params);
      res.json({ success: true });
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error('[Chat API] Error updating canned response:', err);
    res.status(500).json({ success: false, error: 'Failed to update' });
  }
});

// DELETE /:tenantId/canned-responses/:id - Delete canned response (admin only)
router.delete('/:tenantId/canned-responses/:id', async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin only' });
    }
    const tenantCode = req.params.tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const { id } = req.params;
    const connection = await getTenantConnection(tenantCode);
    try {
      await connection.query(`DELETE FROM chat_canned_responses WHERE id = ?`, [id]);
      res.json({ success: true });
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error('[Chat API] Error deleting canned response:', err);
    res.status(500).json({ success: false, error: 'Failed to delete' });
  }
});

// POST /:tenantId/sessions/:sessionId/upload - Upload file in chat
router.post('/:tenantId/sessions/:sessionId/upload', chatUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }
    const tenantCode = req.params.tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const { sessionId } = req.params;
    const fileUrl = `/uploads/chat/${req.file.filename}`;
    const connection = await getTenantConnection(tenantCode);
    try {
      const [result] = await connection.query(
        `INSERT INTO chat_messages (session_id, sender_user_id, sender_role, message_type, content, file_url, file_name, file_size)
         VALUES (?, ?, ?, 'file', ?, ?, ?, ?)`,
        [sessionId, req.user.userId, req.user.role === 'customer' ? 'customer' : 'expert',
         req.file.originalname, fileUrl, req.file.originalname, req.file.size]
      );
      res.json({
        success: true,
        message: {
          id: result.insertId,
          sessionId: parseInt(sessionId),
          fileUrl,
          fileName: req.file.originalname,
          fileSize: req.file.size
        }
      });
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error('[Chat API] Error uploading file:', err);
    res.status(500).json({ success: false, error: 'Failed to upload file' });
  }
});

// POST /:tenantId/sessions/:sessionId/create-ticket - Create ticket from chat session
router.post('/:tenantId/sessions/:sessionId/create-ticket', async (req, res) => {
  try {
    const tenantCode = req.params.tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const { sessionId } = req.params;
    const { title, description, priority = 'medium', category = 'General' } = req.body;
    const connection = await getTenantConnection(tenantCode);
    try {
      // Get session info
      const [sessions] = await connection.query(
        `SELECT * FROM chat_sessions WHERE id = ?`, [sessionId]
      );
      if (sessions.length === 0) {
        return res.status(404).json({ success: false, error: 'Session not found' });
      }
      const session = sessions[0];

      // Create ticket linked to chat session
      const [result] = await connection.query(
        `INSERT INTO tickets (title, description, priority, requester_id, category, source, chat_session_id)
         VALUES (?, ?, ?, ?, ?, 'chat', ?)`,
        [title, description, priority, session.customer_user_id, category, sessionId]
      );
      const ticketId = result.insertId;

      // Link ticket back to session
      await connection.query(`UPDATE chat_sessions SET ticket_id = ? WHERE id = ?`, [ticketId, sessionId]);

      // Add system message to chat
      await connection.query(
        `INSERT INTO chat_messages (session_id, sender_role, message_type, content) VALUES (?, 'system', 'system', ?)`,
        [sessionId, `Ticket #${ticketId} has been created for this conversation.`]
      );

      // Log activity
      const { logTicketActivity } = require('../services/activityLogger');
      await logTicketActivity(connection, {
        ticketId,
        userId: req.user.userId,
        activityType: 'created',
        description: `Ticket created from live chat session #${sessionId}`,
        source: 'chat',
        eventKey: 'ticket.created'
      });

      res.json({ success: true, ticketId });
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error('[Chat API] Error creating ticket from chat:', err);
    res.status(500).json({ success: false, error: 'Failed to create ticket' });
  }
});

// GET /:tenantId/sessions/:sessionId/transcript - Get formatted transcript
router.get('/:tenantId/sessions/:sessionId/transcript', async (req, res) => {
  try {
    const tenantCode = req.params.tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const { sessionId } = req.params;
    const connection = await getTenantConnection(tenantCode);
    try {
      const [messages] = await connection.query(
        `SELECT cm.*, u.full_name as sender_name
         FROM chat_messages cm
         LEFT JOIN users u ON cm.sender_user_id = u.id
         WHERE cm.session_id = ?
         ORDER BY cm.created_at ASC`,
        [sessionId]
      );

      const transcript = messages.map(m => {
        const time = new Date(m.created_at).toLocaleString();
        const sender = m.sender_name || m.sender_role;
        if (m.message_type === 'file') {
          return `[${time}] ${sender}: [File: ${m.file_name}]`;
        }
        return `[${time}] ${sender}: ${m.content}`;
      }).join('\n');

      res.json({ success: true, transcript, messages });
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error('[Chat API] Error getting transcript:', err);
    res.status(500).json({ success: false, error: 'Failed to get transcript' });
  }
});

// POST /:tenantId/qualification/questions - Get qualification questions
router.post('/:tenantId/qualification/questions', async (req, res) => {
  try {
    const tenantCode = req.params.tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const { problemDescription = '' } = req.body;
    const engine = new ChatQualificationEngine(tenantCode);
    const result = await engine.getQualificationQuestions(problemDescription);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Chat API] Error getting qualification questions:', err);
    res.status(500).json({ success: false, error: 'Failed to get questions' });
  }
});

// POST /:tenantId/qualification/process - Process qualification answers
router.post('/:tenantId/qualification/process', async (req, res) => {
  try {
    const tenantCode = req.params.tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const { answers, problemDescription } = req.body;
    const engine = new ChatQualificationEngine(tenantCode);
    const result = await engine.processAnswers(answers || {}, problemDescription || '');
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Chat API] Error processing qualification:', err);
    res.status(500).json({ success: false, error: 'Failed to process answers' });
  }
});

// GET /:tenantId/qualification/search-assets - Search CMDB items for asset picker
router.get('/:tenantId/qualification/search-assets', async (req, res) => {
  try {
    const tenantCode = req.params.tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const { q } = req.query;
    if (!q || q.length < 2) {
      return res.json({ success: true, items: [] });
    }
    const engine = new ChatQualificationEngine(tenantCode);
    const items = await engine.searchAssets(q);
    res.json({ success: true, items });
  } catch (err) {
    console.error('[Chat API] Error searching assets:', err);
    res.status(500).json({ success: false, error: 'Failed to search assets' });
  }
});

module.exports = router;
