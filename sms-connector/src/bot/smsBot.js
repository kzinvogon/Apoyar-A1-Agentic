/**
 * SMS Bot - Command parser and ticket operation handlers
 * Mirrors the Teams connector's teamsBot.js but for SMS (plain text).
 */

const crypto = require('crypto');
const { getTenantConnection, getMasterConnection } = require('../config/database');
/**
 * Inline activity logger — avoids fragile cross-project require('../../../services/activityLogger')
 * so the SMS connector can run as a standalone Railway service.
 */
async function logTicketActivity(executor, payload) {
  const {
    ticketId,
    userId = null,
    activityType,
    description,
    isPublic = true,
    source = 'web',
    actorType: actorTypeIn,
    actorId: actorIdIn,
    eventKey: eventKeyIn,
    meta = null,
    requestId = null
  } = payload;

  const actorType = actorTypeIn || (userId ? 'user' : 'system');
  const actorId = actorIdIn !== undefined ? actorIdIn : (userId || null);
  const eventKey = eventKeyIn || `ticket.${activityType}`;
  const metaJson = meta ? JSON.stringify(meta) : null;

  const [result] = await executor.query(
    `INSERT INTO ticket_activity
       (ticket_id, user_id, activity_type, description, is_public,
        source, actor_type, actor_id, event_key, meta, request_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [ticketId, userId, activityType, description, isPublic,
     source, actorType, actorId, eventKey, metaJson, requestId]
  );

  return { insertId: result.insertId };
}
const { createTicketViewUrl } = require('../utils/tokenGenerator');
const {
  formatTicketCreated,
  formatTicketDetail,
  formatTicketList,
  formatHelp,
  formatMode,
  formatModeSwitch
} = require('./formatters/ticketFormatter');

// Fallback tenant code
const DEFAULT_TENANT_CODE = process.env.SERVIFLOW_TENANT_CODE || 'apoyar';

// Cache for phone→tenant mappings (TTL: 5 minutes)
const tenantCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

// Cache for user modes (TTL: 30 minutes)
const userModeCache = new Map();
const MODE_CACHE_TTL = 30 * 60 * 1000;

/**
 * Resolve tenant code from the Twilio phone number (the number that received the SMS).
 * Falls back to DEFAULT_TENANT_CODE.
 */
async function resolveTenant(twilioPhoneNumber) {
  if (!twilioPhoneNumber) return DEFAULT_TENANT_CODE;

  const cacheKey = twilioPhoneNumber;
  if (tenantCache.has(cacheKey)) {
    const cached = tenantCache.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.tenantCode;
    }
    tenantCache.delete(cacheKey);
  }

  let tenantCode = null;

  try {
    const masterPool = await getMasterConnection();
    const [rows] = await masterPool.query(
      'SELECT tenant_code FROM sms_phone_tenant_mappings WHERE twilio_phone_number = ? AND is_active = TRUE',
      [twilioPhoneNumber]
    );

    if (rows.length > 0) {
      tenantCode = rows[0].tenant_code;
      tenantCache.set(cacheKey, { tenantCode, timestamp: Date.now() });
    }
  } catch (error) {
    console.error('[SMS] Error resolving tenant:', error.message);
  }

  return tenantCode || DEFAULT_TENANT_CODE;
}

/**
 * Ensure the SMS user exists and is mapped via sms_user_preferences.
 * Creates a user record if needed.
 * Returns: { userId, mode }
 */
async function ensureSmsUser(pool, phoneNumber, { defaultMode = 'customer' } = {}) {
  // Try to find existing mapping by phone number
  try {
    const [prefs] = await pool.query(
      'SELECT user_id, mode FROM sms_user_preferences WHERE phone_number = ? LIMIT 1',
      [phoneNumber]
    );

    if (prefs.length > 0) {
      return { userId: prefs[0].user_id, mode: prefs[0].mode, created: false };
    }
  } catch (error) {
    // Table might not exist — we'll create it below
    if (!error.message.includes("doesn't exist")) {
      console.error('[SMS] Error looking up user:', error.message);
    }
  }

  // No mapping found — create a new user with phone-based identity
  const username = `sms-${phoneNumber.replace(/[^0-9]/g, '')}`;
  const fullName = `SMS User (${phoneNumber})`;
  const passwordHash = `sms:${crypto.randomBytes(32).toString('hex')}`;

  let userId;

  // Check if username already exists (from a previous partial setup)
  const [existing] = await pool.query(
    'SELECT id FROM users WHERE username = ? LIMIT 1',
    [username]
  );

  if (existing.length > 0) {
    userId = existing[0].id;
  } else {
    const [ins] = await pool.query(
      `INSERT INTO users (username, password_hash, role, full_name, is_active, must_reset_password)
       VALUES (?, ?, 'customer', ?, 1, 0)`,
      [username, passwordHash, fullName]
    );
    userId = ins.insertId;
  }

  // Create SMS preference mapping
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS sms_user_preferences (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        phone_number VARCHAR(20) NOT NULL,
        mode ENUM('expert', 'customer') DEFAULT 'customer',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_user (user_id),
        UNIQUE KEY unique_phone (phone_number)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );

    await pool.query(
      `INSERT INTO sms_user_preferences (user_id, phone_number, mode)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE phone_number = VALUES(phone_number), updated_at = CURRENT_TIMESTAMP`,
      [userId, phoneNumber, defaultMode]
    );
  } catch (err) {
    console.error('[SMS] Error creating preference:', err.message);
  }

  return { userId, mode: defaultMode, created: true };
}

/**
 * Check if user is an expert
 */
async function isUserExpert(pool, userId) {
  try {
    const [users] = await pool.query(
      'SELECT role FROM users WHERE id = ? AND is_active = TRUE',
      [userId]
    );
    if (users.length === 0) return false;
    const role = users[0].role?.toLowerCase();
    return role === 'admin' || role === 'expert' || role === 'agent';
  } catch (error) {
    return false;
  }
}

/**
 * Get user's current mode
 */
async function getUserMode(pool, userId) {
  const cacheKey = `mode_${userId}`;

  if (userModeCache.has(cacheKey)) {
    const cached = userModeCache.get(cacheKey);
    if (Date.now() - cached.timestamp < MODE_CACHE_TTL) {
      return cached.mode;
    }
    userModeCache.delete(cacheKey);
  }

  try {
    const [prefs] = await pool.query(
      'SELECT mode FROM sms_user_preferences WHERE user_id = ?',
      [userId]
    );

    if (prefs.length > 0) {
      const mode = prefs[0].mode;
      userModeCache.set(cacheKey, { mode, timestamp: Date.now() });
      return mode;
    }
  } catch (error) {
    // Fall through to default
  }

  // Default based on role
  const expert = await isUserExpert(pool, userId);
  const defaultMode = expert ? 'expert' : 'customer';
  userModeCache.set(cacheKey, { mode: defaultMode, timestamp: Date.now() });
  return defaultMode;
}

/**
 * Set user's mode
 */
async function setUserMode(pool, userId, mode) {
  const cacheKey = `mode_${userId}`;

  try {
    await pool.query(
      `UPDATE sms_user_preferences SET mode = ?, updated_at = NOW() WHERE user_id = ?`,
      [mode, userId]
    );
    userModeCache.set(cacheKey, { mode, timestamp: Date.now() });
    return true;
  } catch (error) {
    console.error('[SMS] Error setting mode:', error.message);
    return false;
  }
}

/**
 * Find or create a customer profile for a user
 */
async function findOrCreateCustomer(pool, userId) {
  const [existing] = await pool.query(
    'SELECT id FROM customers WHERE user_id = ?',
    [userId]
  );

  if (existing.length > 0) return existing[0].id;

  const [result] = await pool.query(
    `INSERT INTO customers (user_id, sla_level) VALUES (?, 'basic')`,
    [userId]
  );

  return result.insertId;
}

// ──────────────────────────────────────────────
// Command handlers
// ──────────────────────────────────────────────

/**
 * Main message handler: parse the SMS text and dispatch to the right handler.
 * @param {string} fromPhone - Sender's phone number (E.164)
 * @param {string} toPhone - Twilio number that received the SMS
 * @param {string} body - SMS body text
 * @returns {Promise<string>} Response text
 */
async function handleIncomingSms(fromPhone, toPhone, body) {
  const rawText = (body || '').trim();
  const text = rawText.toLowerCase();

  console.log(`[SMS] From ${fromPhone}: ${text}`);

  try {
    const tenantCode = await resolveTenant(toPhone);
    const pool = await getTenantConnection(tenantCode);
    const { userId, mode } = await ensureSmsUser(pool, fromPhone);

    // ── Mode commands ──
    if (text === 'mode' || text === 'mode status') {
      const expert = await isUserExpert(pool, userId);
      const currentMode = await getUserMode(pool, userId);
      return formatMode(currentMode, expert);
    }

    if (text === 'mode expert' || text === 'expert mode') {
      const expert = await isUserExpert(pool, userId);
      if (!expert) {
        return 'You cannot switch to Expert mode. Contact your admin.';
      }
      await setUserMode(pool, userId, 'expert');
      return formatModeSwitch('expert');
    }

    if (text === 'mode customer' || text === 'customer mode') {
      await findOrCreateCustomer(pool, userId);
      await setUserMode(pool, userId, 'customer');
      return formatModeSwitch('customer');
    }

    // ── Create ticket ──
    if (text.startsWith('new:') || text.startsWith('new ') || text.startsWith('raise ticket:') || text.startsWith('raise ticket ')) {
      const description = rawText
        .replace(/^(new:|new\s|raise ticket:|raise ticket\s)/i, '')
        .trim();

      if (!description) {
        return 'To create a ticket, send:\nnew: [description]';
      }

      return await handleCreateTicket(pool, tenantCode, userId, mode, fromPhone, description);
    }

    // ── View ticket: #123 or status 123 ──
    if (text.match(/^#\d+$/) || text.startsWith('status ') || text.startsWith('status#')) {
      const ticketId = text.replace(/^(status\s*#?|#)/, '').trim();
      return await handleViewTicket(pool, tenantCode, ticketId);
    }

    // ── My tickets / list ──
    if (text === 'my tickets' || text === 'list' || text === 'tickets') {
      const currentMode = await getUserMode(pool, userId);
      return await handleMyTickets(pool, userId, currentMode);
    }

    // ── Resolve (expert only) ──
    if (text.startsWith('resolve ') || text.startsWith('resolve#')) {
      const currentMode = await getUserMode(pool, userId);
      if (currentMode !== 'expert') {
        return 'Resolve is expert-only. Send "mode expert" to switch.';
      }
      const parts = rawText.replace(/^resolve\s*#?/i, '').trim().split(' ');
      const ticketId = parts[0].replace('#', '');
      const comment = parts.slice(1).join(' ') || 'Resolved via SMS';
      return await handleResolveTicket(pool, tenantCode, userId, ticketId, comment);
    }

    // ── Assign (expert only) ──
    if (text.startsWith('assign ') || text.startsWith('assign#')) {
      const currentMode = await getUserMode(pool, userId);
      if (currentMode !== 'expert') {
        return 'Assign is expert-only. Send "mode expert" to switch.';
      }
      const ticketId = text.replace(/^assign\s*#?/, '').trim();
      return await handleAssignToMe(pool, tenantCode, userId, ticketId);
    }

    // ── Help ──
    if (text === 'help' || text === '?' || text === 'commands') {
      return formatHelp();
    }

    // ── Default: show help ──
    return formatHelp();

  } catch (error) {
    console.error('[SMS] Error handling message:', error);
    return 'Something went wrong. Please try again or send "help".';
  }
}

/**
 * Create a new ticket
 */
async function handleCreateTicket(pool, tenantCode, requesterId, mode, fromPhone, description) {
  if (mode === 'customer') {
    await findOrCreateCustomer(pool, requesterId);
  }

  const category = mode === 'customer' ? 'Customer Portal' : 'SMS';
  const title = description.substring(0, 100);

  const [result] = await pool.query(
    `INSERT INTO tickets (title, description, status, priority, requester_id, category)
     VALUES (?, ?, 'Open', 'medium', ?, ?)`,
    [title, description, requesterId, category]
  );

  const ticketId = result.insertId;

  await logTicketActivity(pool, {
    ticketId,
    userId: requesterId,
    activityType: 'created',
    description: `Ticket raised via SMS from ${fromPhone}`,
    source: 'sms',
    eventKey: 'ticket.created'
  });

  // Get the created ticket for formatting
  const [tickets] = await pool.query(
    `SELECT t.*, u.full_name as requester_name
     FROM tickets t
     LEFT JOIN users u ON t.requester_id = u.id
     WHERE t.id = ?`,
    [ticketId]
  );

  let ticketUrl;
  try { ticketUrl = await createTicketViewUrl(tenantCode, ticketId); } catch (e) { /* ok */ }

  return formatTicketCreated(tickets[0], ticketUrl);
}

/**
 * View a ticket's details
 */
async function handleViewTicket(pool, tenantCode, ticketId) {
  const [tickets] = await pool.query(
    `SELECT t.*,
            u.full_name as requester_name,
            a.full_name as assignee_name
     FROM tickets t
     LEFT JOIN users u ON t.requester_id = u.id
     LEFT JOIN users a ON t.assignee_id = a.id
     WHERE t.id = ?`,
    [ticketId]
  );

  if (tickets.length === 0) {
    return `Ticket #${ticketId} not found.`;
  }

  let ticketUrl;
  try { ticketUrl = await createTicketViewUrl(tenantCode, parseInt(ticketId)); } catch (e) { /* ok */ }

  return formatTicketDetail(tickets[0], ticketUrl);
}

/**
 * List user's tickets
 */
async function handleMyTickets(pool, userId, mode) {
  let tickets;
  let title;

  if (mode === 'expert') {
    [tickets] = await pool.query(
      `SELECT t.*, u.full_name as requester_name
       FROM tickets t
       LEFT JOIN users u ON t.requester_id = u.id
       WHERE t.assignee_id = ? AND t.status IN ('Open', 'In Progress', 'Pending', 'Paused')
       ORDER BY
         CASE t.priority
           WHEN 'critical' THEN 1
           WHEN 'high' THEN 2
           WHEN 'medium' THEN 3
           ELSE 4
         END,
         t.created_at DESC
       LIMIT 10`,
      [userId]
    );
    title = 'Assigned tickets';
  } else {
    [tickets] = await pool.query(
      `SELECT t.*, a.full_name as assignee_name
       FROM tickets t
       LEFT JOIN users a ON t.assignee_id = a.id
       WHERE t.requester_id = ?
       ORDER BY t.created_at DESC
       LIMIT 10`,
      [userId]
    );
    title = 'Your tickets';
  }

  if (tickets.length === 0) {
    return mode === 'expert'
      ? 'No assigned tickets.'
      : 'No tickets found. Send "new: [description]" to create one.';
  }

  return formatTicketList(tickets, title);
}

/**
 * Resolve a ticket (expert only)
 */
async function handleResolveTicket(pool, tenantCode, userId, ticketId, comment) {
  const [users] = await pool.query(
    'SELECT full_name FROM users WHERE id = ?',
    [userId]
  );
  const userName = users.length > 0 ? users[0].full_name : 'SMS User';

  await pool.query(
    `UPDATE tickets
     SET status = 'Resolved', resolved_by = ?, resolved_at = NOW(),
         resolution_comment = ?, updated_at = NOW()
     WHERE id = ?`,
    [userId, comment, ticketId]
  );

  await logTicketActivity(pool, {
    ticketId: parseInt(ticketId),
    userId,
    activityType: 'resolved',
    description: `Resolved by ${userName} via SMS: ${comment}`,
    source: 'sms',
    eventKey: 'ticket.resolved'
  });

  return `Ticket #${ticketId} resolved.`;
}

/**
 * Assign a ticket to the current user (expert only)
 */
async function handleAssignToMe(pool, tenantCode, userId, ticketId) {
  const [users] = await pool.query(
    'SELECT full_name FROM users WHERE id = ?',
    [userId]
  );
  const userName = users.length > 0 ? users[0].full_name : 'SMS User';

  await pool.query(
    'UPDATE tickets SET assignee_id = ?, status = "In Progress", updated_at = NOW() WHERE id = ?',
    [userId, ticketId]
  );

  await logTicketActivity(pool, {
    ticketId: parseInt(ticketId),
    userId,
    activityType: 'assigned',
    description: `Assigned to ${userName} via SMS`,
    source: 'sms',
    eventKey: 'ticket.assigned'
  });

  return `Ticket #${ticketId} assigned to you.`;
}

module.exports = {
  handleIncomingSms,
  resolveTenant,
  ensureSmsUser,
  getUserMode
};
