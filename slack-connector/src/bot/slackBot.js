/**
 * Slack Bot Handler
 * Handles slash commands, messages, and interactions for ServiFlow
 */

const crypto = require('crypto');
const { getTenantConnection, getMasterConnection } = require('../config/database');
const {
  buildTicketBlocks,
  buildTicketListBlocks,
  buildHelpBlocks,
  buildModeBlocks,
  buildCreateTicketModal
} = require('./blocks/ticketBlocks');

// Default tenant code if no mapping found
const DEFAULT_TENANT_CODE = process.env.SERVIFLOW_TENANT_CODE || 'apoyar';
const SERVIFLOW_URL = process.env.SERVIFLOW_URL || 'https://app.serviflow.app';

// Cache for workspace mappings (TTL: 5 minutes)
const workspaceCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

// Cache for user modes (TTL: 30 minutes)
const userModeCache = new Map();
const MODE_CACHE_TTL = 30 * 60 * 1000;

/**
 * Resolve tenant code from Slack workspace ID
 */
async function resolveTenant(workspaceId, userEmail) {
  const cacheKey = workspaceId || userEmail?.split('@')[1];

  if (cacheKey && workspaceCache.has(cacheKey)) {
    const cached = workspaceCache.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.tenantCode;
    }
    workspaceCache.delete(cacheKey);
  }

  let tenantCode = null;

  try {
    const masterPool = await getMasterConnection();

    // Try workspace mapping first
    if (workspaceId) {
      const [rows] = await masterPool.query(
        'SELECT tenant_code FROM slack_workspace_mappings WHERE slack_workspace_id = ? AND is_active = TRUE',
        [workspaceId]
      );
      if (rows.length > 0) {
        tenantCode = rows[0].tenant_code;
      }
    }

    // Fallback to email domain
    if (!tenantCode && userEmail) {
      const emailDomain = userEmail.split('@')[1]?.toLowerCase();
      if (emailDomain) {
        const [rows] = await masterPool.query(
          'SELECT tenant_code FROM slack_email_domain_mappings WHERE email_domain = ? AND is_active = TRUE',
          [emailDomain]
        );
        if (rows.length > 0) {
          tenantCode = rows[0].tenant_code;
        }
      }
    }

    if (tenantCode && cacheKey) {
      workspaceCache.set(cacheKey, { tenantCode, timestamp: Date.now() });
    }
  } catch (error) {
    console.error('[Slack Bot] Error resolving tenant:', error.message);
  }

  return tenantCode || DEFAULT_TENANT_CODE;
}

/**
 * Get user info from Slack API
 */
async function getSlackUserInfo(client, userId) {
  try {
    const result = await client.users.info({ user: userId });
    if (result.ok) {
      return {
        id: result.user.id,
        email: result.user.profile?.email,
        name: result.user.real_name || result.user.name,
        displayName: result.user.profile?.display_name || result.user.real_name
      };
    }
  } catch (error) {
    console.error('[Slack Bot] Error getting user info:', error.message);
  }
  return null;
}

/**
 * Generate a unique username
 */
async function generateUniqueUsername(pool, base) {
  const root = base.toLowerCase().trim().replace(/[^a-z0-9._-]/g, '-').replace(/-+/g, '-').slice(0, 40);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const [rows] = await pool.query('SELECT id FROM users WHERE username = ? LIMIT 1', [candidate]);
    if (rows.length === 0) return candidate;
  }
  return `${root}-${crypto.randomBytes(3).toString('hex')}`.slice(0, 50);
}

/**
 * Ensure Slack user exists in database
 */
async function ensureSlackUser(client, slackUserId, workspaceId, tenantCode, { defaultMode = 'customer' } = {}) {
  const pool = await getTenantConnection(tenantCode);

  // Get user info from Slack
  const slackUser = await getSlackUserInfo(client, slackUserId);
  const email = slackUser?.email?.toLowerCase();
  const fullName = slackUser?.name || 'Slack User';

  // Check if we have a mapping already
  const [maps] = await pool.query(
    'SELECT user_id, mode FROM slack_user_preferences WHERE slack_user_id = ? LIMIT 1',
    [slackUserId]
  );

  if (maps.length > 0) {
    const { user_id: userId, mode } = maps[0];
    // Update user info
    await pool.query(
      `UPDATE users SET is_active = 1, full_name = COALESCE(NULLIF(full_name,''), ?),
       email = COALESCE(email, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [fullName, email, userId]
    );
    return { userId, email, created: false, mode };
  }

  // Check if user exists by email
  let existingUserId = null;
  let existingRole = null;

  if (email) {
    const [urows] = await pool.query('SELECT id, role FROM users WHERE email = ? LIMIT 1', [email]);
    if (urows.length > 0) {
      existingUserId = urows[0].id;
      existingRole = urows[0].role;
    }
  }

  // Create user if needed
  let userId = existingUserId;
  let created = false;

  if (!userId) {
    const baseUsername = (email && email.split('@')[0]) || fullName;
    const username = await generateUniqueUsername(pool, baseUsername);
    const passwordHash = `slack:${crypto.randomBytes(32).toString('hex')}`;
    const role = defaultMode === 'expert' ? 'expert' : 'customer';

    const [ins] = await pool.query(
      `INSERT INTO users (username, password_hash, role, email, full_name, is_active, must_reset_password)
       VALUES (?, ?, ?, ?, ?, 1, 0)`,
      [username, passwordHash, role, email, fullName]
    );

    userId = ins.insertId;
    created = true;
  } else {
    await pool.query(
      `UPDATE users SET is_active = 1, full_name = COALESCE(NULLIF(full_name,''), ?),
       email = COALESCE(email, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [fullName, email, userId]
    );
  }

  // Create preference mapping
  const mode = defaultMode;
  try {
    await pool.query(
      `INSERT INTO slack_user_preferences (user_id, slack_user_id, mode)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE slack_user_id = VALUES(slack_user_id), mode = VALUES(mode), updated_at = CURRENT_TIMESTAMP`,
      [userId, slackUserId, mode]
    );
  } catch (err) {
    await pool.query(
      `UPDATE slack_user_preferences SET slack_user_id = COALESCE(slack_user_id, ?),
       mode = COALESCE(mode, ?), updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
      [slackUserId, mode, userId]
    );
  }

  return { userId, email, created, mode };
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
    const [prefs] = await pool.query('SELECT mode FROM slack_user_preferences WHERE user_id = ?', [userId]);
    if (prefs.length > 0) {
      const mode = prefs[0].mode;
      userModeCache.set(cacheKey, { mode, timestamp: Date.now() });
      return mode;
    }
  } catch (error) {
    console.log('[Slack Bot] Mode lookup error:', error.message);
  }

  return 'customer';
}

/**
 * Set user's mode
 */
async function setUserMode(pool, userId, mode) {
  const cacheKey = `mode_${userId}`;
  try {
    await pool.query(
      `INSERT INTO slack_user_preferences (user_id, mode) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE mode = VALUES(mode), updated_at = NOW()`,
      [userId, mode]
    );
    userModeCache.set(cacheKey, { mode, timestamp: Date.now() });
    return true;
  } catch (error) {
    console.error('[Slack Bot] Error setting mode:', error.message);
    return false;
  }
}

/**
 * Check if user is an expert
 */
async function isUserExpert(pool, userId) {
  try {
    const [users] = await pool.query('SELECT role FROM users WHERE id = ? AND is_active = TRUE', [userId]);
    if (users.length === 0) return false;
    const role = users[0].role?.toLowerCase();
    return role === 'admin' || role === 'expert' || role === 'agent';
  } catch (error) {
    return false;
  }
}

/**
 * Setup Slack bot handlers
 */
function setupSlackBot(app) {
  // Handle /ticket command
  app.command('/ticket', async ({ command, ack, respond, client }) => {
    await ack();

    const text = command.text?.trim().toLowerCase() || '';
    const rawText = command.text?.trim() || '';
    const workspaceId = command.team_id;
    const slackUserId = command.user_id;

    console.log(`[Slack Bot] Command from ${slackUserId}: /ticket ${text}`);

    try {
      const tenantCode = await resolveTenant(workspaceId);
      const { userId, mode } = await ensureSlackUser(client, slackUserId, workspaceId, tenantCode);
      const pool = await getTenantConnection(tenantCode);

      // Parse command
      if (text === 'help' || text === '') {
        await handleHelp(respond, mode);
      }
      else if (text === 'mode' || text === 'mode status') {
        await handleShowMode(respond, client, slackUserId, pool, userId);
      }
      else if (text === 'mode expert' || text === 'expert') {
        await handleSetMode(respond, pool, userId, 'expert');
      }
      else if (text === 'mode customer' || text === 'customer') {
        await handleSetMode(respond, pool, userId, 'customer');
      }
      else if (text.startsWith('create ') || text.startsWith('new ') || text.startsWith('raise ')) {
        const description = rawText.replace(/^(create|new|raise)\s+/i, '').trim();
        await handleCreateTicket(respond, pool, userId, description, mode);
      }
      else if (text.startsWith('status ') || text.match(/^#?\d+$/)) {
        const ticketId = text.replace(/^status\s*#?|^#/, '').trim();
        await handleViewTicket(respond, pool, ticketId, mode);
      }
      else if (text === 'list' || text === 'my' || text === 'my tickets' || text === 'assigned') {
        await handleMyTickets(respond, pool, userId, mode);
      }
      else if (text.startsWith('resolve ')) {
        if (mode !== 'expert') {
          await respond({ text: ':lock: This command is only available in *Expert mode*. Use `/ticket mode expert` to switch.' });
          return;
        }
        const parts = rawText.replace(/^resolve\s*#?/i, '').trim().split(' ');
        const ticketId = parts[0].replace('#', '');
        const comment = parts.slice(1).join(' ') || 'Resolved via Slack';
        await handleResolveTicket(respond, pool, userId, ticketId, comment);
      }
      else if (text.startsWith('assign ')) {
        if (mode !== 'expert') {
          await respond({ text: ':lock: This command is only available in *Expert mode*. Use `/ticket mode expert` to switch.' });
          return;
        }
        const ticketId = text.replace(/^assign\s*#?/, '').trim();
        await handleAssignTicket(respond, pool, userId, ticketId);
      }
      else if (text === 'trends' || text === 'insights' || text === 'analytics') {
        if (mode !== 'expert') {
          await respond({ text: ':lock: This command is only available in *Expert mode*. Use `/ticket mode expert` to switch.' });
          return;
        }
        await handleTrends(respond, pool);
      }
      else {
        await handleHelp(respond, mode);
      }
    } catch (error) {
      console.error('[Slack Bot] Command error:', error);
      await respond({ text: `:x: Error: ${error.message}` });
    }
  });

  // Handle button actions
  app.action(/^(view_ticket|assign_ticket|resolve_ticket|set_mode)_/, async ({ action, ack, respond, client, body }) => {
    await ack();

    const [actionType, ...rest] = action.action_id.split('_');
    const value = action.value;
    const workspaceId = body.team?.id;
    const slackUserId = body.user?.id;

    try {
      const tenantCode = await resolveTenant(workspaceId);
      const { userId, mode } = await ensureSlackUser(client, slackUserId, workspaceId, tenantCode);
      const pool = await getTenantConnection(tenantCode);

      if (actionType === 'view' && rest[0] === 'ticket') {
        await handleViewTicket(respond, pool, value, mode);
      }
      else if (actionType === 'assign' && rest[0] === 'ticket') {
        if (mode !== 'expert') {
          await respond({ text: ':lock: This action requires Expert mode.' });
          return;
        }
        await handleAssignTicket(respond, pool, userId, value);
      }
      else if (actionType === 'resolve' && rest[0] === 'ticket') {
        if (mode !== 'expert') {
          await respond({ text: ':lock: This action requires Expert mode.' });
          return;
        }
        await handleResolveTicket(respond, pool, userId, value, 'Resolved via Slack');
      }
      else if (actionType === 'set' && rest[0] === 'mode') {
        await handleSetMode(respond, pool, userId, value);
      }
    } catch (error) {
      console.error('[Slack Bot] Action error:', error);
      await respond({ text: `:x: Error: ${error.message}` });
    }
  });

  // Handle app mentions
  app.event('app_mention', async ({ event, client, say }) => {
    const text = event.text?.replace(/<@[A-Z0-9]+>/gi, '').trim().toLowerCase();

    if (text.includes('help')) {
      await say({
        blocks: buildHelpBlocks('customer'),
        text: 'ServiFlow Help'
      });
    } else {
      await say({
        text: `Hi! I'm the ServiFlow bot. Use \`/ticket help\` to see available commands.`
      });
    }
  });

  // Handle direct messages
  app.event('message', async ({ event, client, say }) => {
    // Only handle DMs (channel type 'im')
    if (event.channel_type !== 'im' || event.subtype) return;

    const text = event.text?.trim().toLowerCase();

    if (text === 'help' || text === '?') {
      await say({
        blocks: buildHelpBlocks('customer'),
        text: 'ServiFlow Help'
      });
    } else {
      await say({
        text: `Use \`/ticket help\` to see available commands, or try:\n• \`/ticket create [description]\` - Create a ticket\n• \`/ticket list\` - View your tickets\n• \`/ticket status #123\` - Check ticket status`
      });
    }
  });
}

// Command handlers
async function handleHelp(respond, mode) {
  await respond({
    blocks: buildHelpBlocks(mode),
    text: 'ServiFlow Bot Help'
  });
}

async function handleShowMode(respond, client, slackUserId, pool, userId) {
  const mode = await getUserMode(pool, userId);
  const isExpert = await isUserExpert(pool, userId);
  const slackUser = await getSlackUserInfo(client, slackUserId);

  await respond({
    blocks: buildModeBlocks(mode, isExpert, slackUser?.name || 'User'),
    text: `Current mode: ${mode}`
  });
}

async function handleSetMode(respond, pool, userId, newMode) {
  const isExpert = await isUserExpert(pool, userId);

  if (newMode === 'expert' && !isExpert) {
    await respond({
      text: ':x: You cannot switch to Expert mode because your account does not have expert privileges.'
    });
    return;
  }

  const success = await setUserMode(pool, userId, newMode);

  if (success) {
    const emoji = newMode === 'expert' ? ':necktie:' : ':bust_in_silhouette:';
    const features = newMode === 'expert'
      ? '• View assigned tickets\n• Resolve & assign tickets\n• Access trends'
      : '• View your raised tickets\n• Create new tickets\n• Check ticket status';

    await respond({
      text: `${emoji} *Mode switched to ${newMode.charAt(0).toUpperCase() + newMode.slice(1)}*\n\nAvailable features:\n${features}`
    });
  } else {
    await respond({ text: ':x: Failed to switch mode. Please try again.' });
  }
}

async function handleCreateTicket(respond, pool, userId, description, mode) {
  if (!description) {
    await respond({
      text: 'Please provide a description: `/ticket create Your ticket description here`'
    });
    return;
  }

  const category = mode === 'customer' ? 'Customer Portal' : 'Slack';
  const [result] = await pool.query(
    `INSERT INTO tickets (title, description, status, priority, requester_id, category)
     VALUES (?, ?, 'Open', 'medium', ?, ?)`,
    [description.substring(0, 100), description, userId, category]
  );

  const ticketId = result.insertId;

  await pool.query(
    `INSERT INTO ticket_activity (ticket_id, user_id, activity_type, description)
     VALUES (?, ?, 'created', ?)`,
    [ticketId, userId, `Ticket created via Slack`]
  );

  // Get full ticket
  const [tickets] = await pool.query(
    `SELECT t.*, u.full_name as requester_name, a.full_name as assignee_name
     FROM tickets t
     LEFT JOIN users u ON t.requester_id = u.id
     LEFT JOIN users a ON t.assignee_id = a.id
     WHERE t.id = ?`,
    [ticketId]
  );

  await respond({
    text: `:white_check_mark: Ticket #${ticketId} created successfully!`,
    blocks: buildTicketBlocks(tickets[0], { mode })
  });
}

async function handleViewTicket(respond, pool, ticketId, mode) {
  const [tickets] = await pool.query(
    `SELECT t.*, u.full_name as requester_name, u.email as requester_email,
            a.full_name as assignee_name, ci.asset_name as cmdb_item_name,
            ae.sentiment, ae.ai_category as category, ae.confidence_score
     FROM tickets t
     LEFT JOIN users u ON t.requester_id = u.id
     LEFT JOIN users a ON t.assignee_id = a.id
     LEFT JOIN cmdb_items ci ON t.cmdb_item_id = ci.id
     LEFT JOIN ai_email_analysis ae ON t.id = ae.ticket_id
     WHERE t.id = ?`,
    [ticketId]
  );

  if (tickets.length === 0) {
    await respond({ text: `:x: Ticket #${ticketId} not found.` });
    return;
  }

  await respond({
    blocks: buildTicketBlocks(tickets[0], { mode }),
    text: `Ticket #${ticketId}`
  });
}

async function handleMyTickets(respond, pool, userId, mode) {
  let tickets;
  let listTitle;

  if (mode === 'expert') {
    [tickets] = await pool.query(
      `SELECT t.*, u.full_name as requester_name
       FROM tickets t
       LEFT JOIN users u ON t.requester_id = u.id
       WHERE t.assignee_id = ? AND t.status IN ('Open', 'In Progress', 'Pending', 'Paused')
       ORDER BY CASE t.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
                t.created_at DESC
       LIMIT 20`,
      [userId]
    );
    listTitle = 'My Assigned Tickets';
  } else {
    [tickets] = await pool.query(
      `SELECT t.*, a.full_name as assignee_name
       FROM tickets t
       LEFT JOIN users a ON t.assignee_id = a.id
       WHERE t.requester_id = ?
       ORDER BY t.created_at DESC
       LIMIT 20`,
      [userId]
    );
    listTitle = 'My Raised Tickets';
  }

  if (tickets.length === 0) {
    const msg = mode === 'expert' ? 'You have no assigned tickets. :tada:' : "You haven't raised any tickets yet.";
    await respond({ text: msg });
    return;
  }

  await respond({
    blocks: buildTicketListBlocks(tickets, listTitle, { mode }),
    text: listTitle
  });
}

async function handleAssignTicket(respond, pool, userId, ticketId) {
  const [users] = await pool.query('SELECT id, full_name FROM users WHERE id = ?', [userId]);
  if (users.length === 0) {
    await respond({ text: ':x: User not found.' });
    return;
  }

  const userName = users[0].full_name;

  await pool.query(
    'UPDATE tickets SET assignee_id = ?, status = "In Progress", updated_at = NOW() WHERE id = ?',
    [userId, ticketId]
  );

  await pool.query(
    `INSERT INTO ticket_activity (ticket_id, user_id, activity_type, description)
     VALUES (?, ?, 'assigned', ?)`,
    [ticketId, userId, `Assigned to ${userName} via Slack`]
  );

  await respond({ text: `:white_check_mark: Ticket #${ticketId} assigned to you.` });
}

async function handleResolveTicket(respond, pool, userId, ticketId, comment) {
  const [users] = await pool.query('SELECT id, full_name FROM users WHERE id = ?', [userId]);
  if (users.length === 0) {
    await respond({ text: ':x: User not found.' });
    return;
  }

  const userName = users[0].full_name;

  await pool.query(
    `UPDATE tickets SET status = 'Resolved', resolved_by = ?, resolved_at = NOW(),
     resolution_comment = ?, updated_at = NOW() WHERE id = ?`,
    [userId, comment, ticketId]
  );

  await pool.query(
    `INSERT INTO ticket_activity (ticket_id, user_id, activity_type, description)
     VALUES (?, ?, 'resolved', ?)`,
    [ticketId, userId, `Resolved by ${userName} via Slack: ${comment}`]
  );

  await respond({ text: `:white_check_mark: Ticket #${ticketId} resolved.` });
}

async function handleTrends(respond, pool) {
  const [stats] = await pool.query(`
    SELECT
      COUNT(*) as total_tickets,
      SUM(CASE WHEN status = 'Open' THEN 1 ELSE 0 END) as open_tickets,
      SUM(CASE WHEN status = 'In Progress' THEN 1 ELSE 0 END) as in_progress,
      SUM(CASE WHEN status = 'Resolved' THEN 1 ELSE 0 END) as resolved,
      SUM(CASE WHEN priority = 'critical' THEN 1 ELSE 0 END) as critical_count,
      SUM(CASE WHEN priority = 'high' THEN 1 ELSE 0 END) as high_count
    FROM tickets
    WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
  `);

  const s = stats[0] || {};

  await respond({
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: ':bar_chart: Ticket Trends (Last 7 Days)' }
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Total*\n${s.total_tickets || 0}` },
          { type: 'mrkdwn', text: `*Open*\n${s.open_tickets || 0}` },
          { type: 'mrkdwn', text: `*In Progress*\n${s.in_progress || 0}` },
          { type: 'mrkdwn', text: `*Resolved*\n${s.resolved || 0}` }
        ]
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `:red_circle: Critical: ${s.critical_count || 0} | :large_orange_circle: High: ${s.high_count || 0}` }
      }
    ],
    text: 'Ticket Trends'
  });
}

module.exports = { setupSlackBot, resolveTenant, ensureSlackUser };
