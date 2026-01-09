const { TeamsActivityHandler, CardFactory, TeamsInfo } = require('botbuilder');
const { buildTicketCard, buildTicketListCard, buildHelpCard, buildCreateTicketForm } = require('./adaptiveCards/ticketCard');

// Import database utilities (local for standalone deployment)
const { getTenantConnection, getMasterConnection } = require('../config/database');

// Fallback tenant code if no mapping found
const DEFAULT_TENANT_CODE = process.env.SERVIFLOW_TENANT_CODE || 'apoyar';

// Cache for tenant mappings (TTL: 5 minutes)
const tenantCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

/**
 * Get user email from Teams context
 * Tries multiple sources: activity.from, TeamsInfo API
 */
async function getUserEmail(context) {
  // Try direct properties first
  let email = context.activity.from?.email || context.activity.from?.userPrincipalName;

  if (email) return email;

  // Try to get from Teams API
  try {
    const member = await TeamsInfo.getMember(context, context.activity.from.id);
    email = member.email || member.userPrincipalName;
    if (email) {
      console.log(`[Bot] Got email from TeamsInfo: ${email}`);
      return email;
    }
  } catch (error) {
    console.log(`[Bot] TeamsInfo.getMember failed: ${error.message}`);
  }

  // Log what we have for debugging
  console.log('[Bot] User info available:', JSON.stringify({
    id: context.activity.from?.id,
    name: context.activity.from?.name,
    aadObjectId: context.activity.from?.aadObjectId
  }));

  return null;
}

class ServiFlowBot extends TeamsActivityHandler {
  constructor() {
    super();

    // Handle incoming messages
    this.onMessage(async (context, next) => {
      await this.handleMessage(context);
      await next();
    });

    // Handle when bot is added to a team/channel
    this.onMembersAdded(async (context, next) => {
      const membersAdded = context.activity.membersAdded;
      for (const member of membersAdded) {
        if (member.id !== context.activity.recipient.id) {
          await context.sendActivity(
            'Hello! I\'m the ServiFlow Bot. I can help you manage support tickets.\n\n' +
            'Try commands like:\n' +
            '- `raise ticket: [description]` - Create a new ticket\n' +
            '- `status #123` - Check ticket status\n' +
            '- `my tickets` - List your assigned tickets\n' +
            '- `trends` - View ticket trends and insights\n' +
            '- `help` - Show all commands'
          );
        }
      }
      await next();
    });

  }

  /**
   * Resolve tenant code from Teams context
   * Priority: 1) Teams tenant ID mapping, 2) Email domain mapping, 3) Default
   */
  async resolveTenant(context) {
    const teamsTenantId = context.activity.conversation?.tenantId ||
                          context.activity.channelData?.tenant?.id;
    const userEmail = context.activity.from?.email ||
                      context.activity.from?.userPrincipalName || '';
    const emailDomain = userEmail.split('@')[1]?.toLowerCase();

    // Check cache first
    const cacheKey = teamsTenantId || emailDomain;
    if (cacheKey && tenantCache.has(cacheKey)) {
      const cached = tenantCache.get(cacheKey);
      if (Date.now() - cached.timestamp < CACHE_TTL) {
        console.log(`[Bot] Tenant from cache: ${cached.tenantCode}`);
        return cached.tenantCode;
      }
      tenantCache.delete(cacheKey);
    }

    let tenantCode = null;
    let masterConn;

    try {
      masterConn = await getMasterConnection();

      // Try Teams tenant ID mapping first
      if (teamsTenantId) {
        const [rows] = await masterConn.query(
          'SELECT tenant_code FROM teams_tenant_mappings WHERE teams_tenant_id = ? AND is_active = TRUE',
          [teamsTenantId]
        );
        if (rows.length > 0) {
          tenantCode = rows[0].tenant_code;
          console.log(`[Bot] Tenant from Teams ID mapping: ${tenantCode}`);
        }
      }

      // Fall back to email domain mapping
      if (!tenantCode && emailDomain) {
        const [rows] = await masterConn.query(
          'SELECT tenant_code FROM teams_email_domain_mappings WHERE email_domain = ? AND is_active = TRUE',
          [emailDomain]
        );
        if (rows.length > 0) {
          tenantCode = rows[0].tenant_code;
          console.log(`[Bot] Tenant from email domain mapping: ${tenantCode}`);
        }
      }

      // Cache the result
      if (tenantCode && cacheKey) {
        tenantCache.set(cacheKey, { tenantCode, timestamp: Date.now() });
      }

    } catch (error) {
      console.error('[Bot] Error resolving tenant:', error.message);
      // Tables might not exist yet, fall back to default
    }

    // Fall back to default
    if (!tenantCode) {
      tenantCode = DEFAULT_TENANT_CODE;
      console.log(`[Bot] Using default tenant: ${tenantCode}`);
    }

    return tenantCode;
  }

  // Handle adaptive card actions (override method)
  async onAdaptiveCardInvoke(context, invokeValue) {
    const action = invokeValue.action;
    const data = action.data || {};

    try {
      switch (data.action) {
        case 'viewTicket':
          await this.handleViewTicket(context, data.ticketId);
          break;
        case 'assignToMe':
          await this.handleAssignToMe(context, data.ticketId);
          break;
        case 'resolveTicket':
          await this.handleResolveTicket(context, data.ticketId);
          break;
        case 'createTicket':
          await this.handleCreateTicketSubmit(context, data);
          break;
        case 'viewCMDB':
          await this.handleViewCMDB(context, data.cmdbId);
          break;
        default:
          await context.sendActivity('Unknown action');
      }
      return { statusCode: 200 };
    } catch (error) {
      console.error('Card action error:', error);
      await context.sendActivity(`Error: ${error.message}`);
      return { statusCode: 500 };
    }
  }

  async handleMessage(context) {
    const rawText = this.removeBotMention(context.activity.text || '').trim();
    const text = rawText.toLowerCase();
    const teamsUserEmail = context.activity.from.email || context.activity.from.userPrincipalName;

    console.log(`[Bot] Message from ${teamsUserEmail}: ${text}`);

    try {
      // raise ticket: [description]
      if (text.startsWith('raise ticket:') || text.startsWith('raise ticket ')) {
        const description = rawText.replace(/^raise ticket[:\s]*/i, '').trim();
        await this.handleCreateTicket(context, description);
      }
      // status #123 or status 123
      else if (text.startsWith('status ') || text.startsWith('status#') || text.match(/^#\d+$/)) {
        const ticketId = text.replace(/^(status\s*#?|#)/, '').trim();
        await this.handleViewTicket(context, ticketId);
      }
      // my tickets / assigned / list
      else if (text.includes('my tickets') || text === 'assigned' || text === 'list') {
        await this.handleMyTickets(context);
      }
      // resolve #123 [comment]
      else if (text.startsWith('resolve ') || text.startsWith('resolve#')) {
        const parts = rawText.replace(/^resolve\s*#?/i, '').trim().split(' ');
        const ticketId = parts[0].replace('#', '');
        const comment = parts.slice(1).join(' ') || 'Resolved via Teams';
        await this.handleResolveTicket(context, ticketId, comment);
      }
      // assign #123
      else if (text.startsWith('assign ') || text.startsWith('assign#')) {
        const ticketId = text.replace(/^assign\s*#?/, '').trim();
        await this.handleAssignToMe(context, ticketId);
      }
      // trends / insights
      else if (text === 'trends' || text === 'insights' || text === 'analytics') {
        await this.handleTrends(context);
      }
      // cmdb [search]
      else if (text.startsWith('cmdb ') || text === 'cmdb') {
        const search = text.replace('cmdb', '').trim();
        await this.handleCMDBSearch(context, search);
      }
      // help
      else if (text === 'help' || text === '?' || text === 'commands') {
        await this.sendHelpCard(context);
      }
      // Default to help
      else {
        await this.sendHelpCard(context);
      }
    } catch (error) {
      console.error('[Bot] Error handling message:', error);
      await context.sendActivity(`Error: ${error.message}`);
    }
  }

  async handleCreateTicket(context, description) {
    if (!description) {
      const card = buildCreateTicketForm();
      await context.sendActivity({ attachments: [CardFactory.adaptiveCard(card)] });
      return;
    }

    const userEmail = await getUserEmail(context);
    const userName = context.activity.from?.name || userEmail || 'Unknown';
    const tenantCode = await this.resolveTenant(context);

    let connection;
    try {
      connection = await getTenantConnection(tenantCode);

      // Find or create requester
      let requesterId = null;
      if (userEmail) {
        const [users] = await connection.query(
          'SELECT id FROM users WHERE email = ? AND is_active = TRUE',
          [userEmail.toLowerCase()]
        );
        if (users.length > 0) {
          requesterId = users[0].id;
        }
      }

      // Create ticket
      const [result] = await connection.query(
        `INSERT INTO tickets (title, description, status, priority, requester_id, source, created_at, updated_at)
         VALUES (?, ?, 'Open', 'medium', ?, 'teams', NOW(), NOW())`,
        [description.substring(0, 100), description, requesterId]
      );

      const ticketId = result.insertId;

      // Log activity
      await connection.query(
        `INSERT INTO ticket_activity (ticket_id, user_id, activity_type, description)
         VALUES (?, ?, 'created', ?)`,
        [ticketId, requesterId, `Ticket created from Teams by ${userName}`]
      );

      // Get full ticket with joins
      const [tickets] = await connection.query(
        `SELECT t.*,
                u.full_name as requester_name, u.email as requester_email,
                a.full_name as assignee_name,
                ci.name as cmdb_item_name, ci.id as cmdb_item_id,
                ae.sentiment, ae.category, ae.suggested_resolution, ae.confidence_score
         FROM tickets t
         LEFT JOIN users u ON t.requester_id = u.id
         LEFT JOIN users a ON t.assignee_id = a.id
         LEFT JOIN cmdb_items ci ON t.cmdb_item_id = ci.id
         LEFT JOIN ai_email_analysis ae ON t.id = ae.ticket_id
         WHERE t.id = ?`,
        [ticketId]
      );

      const ticket = tickets[0];
      const card = buildTicketCard(ticket);
      await context.sendActivity({
        text: `✅ Ticket #${ticketId} created successfully!`,
        attachments: [CardFactory.adaptiveCard(card)]
      });

    } catch (error) {
      console.error('[Bot] Create ticket error:', error);
      await context.sendActivity(`Failed to create ticket: ${error.message}`);
    } finally {
      if (connection && connection.release) connection.release();
    }
  }

  async handleCreateTicketSubmit(context, data) {
    await this.handleCreateTicket(context, data.description || data.title);
  }

  async handleViewTicket(context, ticketId) {
    const tenantCode = await this.resolveTenant(context);
    let connection;
    try {
      connection = await getTenantConnection(tenantCode);

      const [tickets] = await connection.query(
        `SELECT t.*,
                u.full_name as requester_name, u.email as requester_email,
                a.full_name as assignee_name, a.email as assignee_email,
                ci.name as cmdb_item_name, ci.id as cmdb_item_id, ci.type as cmdb_item_type,
                ae.sentiment, ae.category, ae.suggested_resolution, ae.confidence_score,
                ae.root_cause, ae.impact_level
         FROM tickets t
         LEFT JOIN users u ON t.requester_id = u.id
         LEFT JOIN users a ON t.assignee_id = a.id
         LEFT JOIN cmdb_items ci ON t.cmdb_item_id = ci.id
         LEFT JOIN ai_email_analysis ae ON t.id = ae.ticket_id
         WHERE t.id = ?`,
        [ticketId]
      );

      if (tickets.length === 0) {
        await context.sendActivity(`Ticket #${ticketId} not found.`);
        return;
      }

      const card = buildTicketCard(tickets[0]);
      await context.sendActivity({ attachments: [CardFactory.adaptiveCard(card)] });

    } catch (error) {
      console.error('[Bot] View ticket error:', error);
      await context.sendActivity(`Failed to get ticket: ${error.message}`);
    } finally {
      if (connection && connection.release) connection.release();
    }
  }

  async handleMyTickets(context) {
    const userEmail = await getUserEmail(context);
    const tenantCode = await this.resolveTenant(context);

    if (!userEmail) {
      await context.sendActivity('Unable to identify your email. Please ensure you are signed in to Teams with a work account.');
      return;
    }

    let connection;
    try {
      connection = await getTenantConnection(tenantCode);

      // Find user by email
      const [users] = await connection.query(
        'SELECT id FROM users WHERE email = ? AND is_active = TRUE',
        [userEmail.toLowerCase()]
      );

      if (users.length === 0) {
        await context.sendActivity('Your email is not linked to a ServiFlow account. Please contact your administrator.');
        return;
      }

      const userId = users[0].id;

      const [tickets] = await connection.query(
        `SELECT t.*,
                u.full_name as requester_name,
                ci.name as cmdb_item_name
         FROM tickets t
         LEFT JOIN users u ON t.requester_id = u.id
         LEFT JOIN cmdb_items ci ON t.cmdb_item_id = ci.id
         WHERE t.assignee_id = ? AND t.status IN ('Open', 'In Progress', 'Pending', 'Paused')
         ORDER BY
           CASE t.priority
             WHEN 'critical' THEN 1
             WHEN 'high' THEN 2
             WHEN 'medium' THEN 3
             ELSE 4
           END,
           t.created_at DESC
         LIMIT 20`,
        [userId]
      );

      if (tickets.length === 0) {
        await context.sendActivity('You have no assigned tickets. 🎉');
        return;
      }

      const card = buildTicketListCard(tickets);
      await context.sendActivity({ attachments: [CardFactory.adaptiveCard(card)] });

    } catch (error) {
      console.error('[Bot] My tickets error:', error);
      await context.sendActivity(`Failed to get tickets: ${error.message}`);
    } finally {
      if (connection && connection.release) connection.release();
    }
  }

  async handleAssignToMe(context, ticketId) {
    const userEmail = await getUserEmail(context);
    const tenantCode = await this.resolveTenant(context);

    if (!userEmail) {
      await context.sendActivity('Unable to identify your email.');
      return;
    }

    let connection;
    try {
      connection = await getTenantConnection(tenantCode);

      // Find user
      const [users] = await connection.query(
        'SELECT id, full_name FROM users WHERE email = ? AND is_active = TRUE',
        [userEmail.toLowerCase()]
      );

      if (users.length === 0) {
        await context.sendActivity('Your email is not linked to a ServiFlow account.');
        return;
      }

      const userId = users[0].id;
      const userName = users[0].full_name;

      // Update ticket
      await connection.query(
        'UPDATE tickets SET assignee_id = ?, status = "In Progress", updated_at = NOW() WHERE id = ?',
        [userId, ticketId]
      );

      // Log activity
      await connection.query(
        `INSERT INTO ticket_activity (ticket_id, user_id, activity_type, description)
         VALUES (?, ?, 'assigned', ?)`,
        [ticketId, userId, `Assigned to ${userName} via Teams`]
      );

      await context.sendActivity(`✅ Ticket #${ticketId} assigned to you.`);
      await this.handleViewTicket(context, ticketId);

    } catch (error) {
      console.error('[Bot] Assign ticket error:', error);
      await context.sendActivity(`Failed to assign ticket: ${error.message}`);
    } finally {
      if (connection && connection.release) connection.release();
    }
  }

  async handleResolveTicket(context, ticketId, comment = 'Resolved via Teams') {
    const userEmail = await getUserEmail(context);
    const tenantCode = await this.resolveTenant(context);

    if (!userEmail) {
      await context.sendActivity('Unable to identify your email.');
      return;
    }

    let connection;
    try {
      connection = await getTenantConnection(tenantCode);

      // Find user
      const [users] = await connection.query(
        'SELECT id, full_name FROM users WHERE email = ? AND is_active = TRUE',
        [userEmail.toLowerCase()]
      );

      if (users.length === 0) {
        await context.sendActivity('Your email is not linked to a ServiFlow account.');
        return;
      }

      const userId = users[0].id;
      const userName = users[0].full_name;

      // Update ticket
      await connection.query(
        `UPDATE tickets
         SET status = 'Resolved', resolved_by = ?, resolved_at = NOW(),
             resolution_comment = ?, updated_at = NOW()
         WHERE id = ?`,
        [userId, comment, ticketId]
      );

      // Log activity
      await connection.query(
        `INSERT INTO ticket_activity (ticket_id, user_id, activity_type, description)
         VALUES (?, ?, 'resolved', ?)`,
        [ticketId, userId, `Resolved by ${userName} via Teams: ${comment}`]
      );

      await context.sendActivity(`✅ Ticket #${ticketId} resolved.`);
      await this.handleViewTicket(context, ticketId);

    } catch (error) {
      console.error('[Bot] Resolve ticket error:', error);
      await context.sendActivity(`Failed to resolve ticket: ${error.message}`);
    } finally {
      if (connection && connection.release) connection.release();
    }
  }

  async handleTrends(context) {
    const tenantCode = await this.resolveTenant(context);
    let connection;
    try {
      connection = await getTenantConnection(tenantCode);

      // Get ticket stats for last 7 days
      const [stats] = await connection.query(`
        SELECT
          COUNT(*) as total_tickets,
          SUM(CASE WHEN status = 'Open' THEN 1 ELSE 0 END) as open_tickets,
          SUM(CASE WHEN status = 'In Progress' THEN 1 ELSE 0 END) as in_progress,
          SUM(CASE WHEN status = 'Resolved' THEN 1 ELSE 0 END) as resolved_today,
          SUM(CASE WHEN priority = 'critical' THEN 1 ELSE 0 END) as critical_count,
          SUM(CASE WHEN priority = 'high' THEN 1 ELSE 0 END) as high_count
        FROM tickets
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      `);

      // Get top categories from AI analysis
      const [categories] = await connection.query(`
        SELECT category, COUNT(*) as count
        FROM ai_email_analysis
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) AND category IS NOT NULL
        GROUP BY category
        ORDER BY count DESC
        LIMIT 5
      `);

      // Get recent AI insights
      const [insights] = await connection.query(`
        SELECT insight_type, description, severity, created_at
        FROM ai_insights
        WHERE status = 'active'
        ORDER BY created_at DESC
        LIMIT 3
      `);

      const s = stats[0];
      const card = {
        type: 'AdaptiveCard',
        version: '1.4',
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        body: [
          {
            type: 'TextBlock',
            text: '📊 Ticket Trends (Last 7 Days)',
            weight: 'bolder',
            size: 'large'
          },
          {
            type: 'ColumnSet',
            columns: [
              { type: 'Column', width: 'stretch', items: [
                { type: 'TextBlock', text: s.total_tickets?.toString() || '0', size: 'extraLarge', weight: 'bolder', horizontalAlignment: 'center' },
                { type: 'TextBlock', text: 'Total', horizontalAlignment: 'center', isSubtle: true }
              ]},
              { type: 'Column', width: 'stretch', items: [
                { type: 'TextBlock', text: s.open_tickets?.toString() || '0', size: 'extraLarge', weight: 'bolder', horizontalAlignment: 'center', color: 'attention' },
                { type: 'TextBlock', text: 'Open', horizontalAlignment: 'center', isSubtle: true }
              ]},
              { type: 'Column', width: 'stretch', items: [
                { type: 'TextBlock', text: s.resolved_today?.toString() || '0', size: 'extraLarge', weight: 'bolder', horizontalAlignment: 'center', color: 'good' },
                { type: 'TextBlock', text: 'Resolved', horizontalAlignment: 'center', isSubtle: true }
              ]}
            ]
          },
          {
            type: 'TextBlock',
            text: `🔴 Critical: ${s.critical_count || 0} | 🟠 High: ${s.high_count || 0}`,
            spacing: 'medium'
          }
        ]
      };

      // Add categories if available
      if (categories.length > 0) {
        card.body.push({
          type: 'TextBlock',
          text: '🏷️ Top Categories',
          weight: 'bolder',
          spacing: 'large'
        });
        card.body.push({
          type: 'TextBlock',
          text: categories.map(c => `• ${c.category} (${c.count})`).join('\n'),
          wrap: true
        });
      }

      // Add AI insights if available
      if (insights.length > 0) {
        card.body.push({
          type: 'TextBlock',
          text: '🤖 AI Insights',
          weight: 'bolder',
          spacing: 'large'
        });
        for (const insight of insights) {
          card.body.push({
            type: 'TextBlock',
            text: `${insight.severity === 'high' ? '⚠️' : 'ℹ️'} ${insight.description}`,
            wrap: true,
            size: 'small'
          });
        }
      }

      await context.sendActivity({ attachments: [CardFactory.adaptiveCard(card)] });

    } catch (error) {
      console.error('[Bot] Trends error:', error);
      await context.sendActivity(`Failed to get trends: ${error.message}`);
    } finally {
      if (connection && connection.release) connection.release();
    }
  }

  async handleCMDBSearch(context, search) {
    const tenantCode = await this.resolveTenant(context);
    let connection;
    try {
      connection = await getTenantConnection(tenantCode);

      let query = `
        SELECT id, name, type, status, description
        FROM cmdb_items
        WHERE is_active = TRUE
      `;
      const params = [];

      if (search) {
        query += ` AND (name LIKE ? OR description LIKE ? OR type LIKE ?)`;
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      }

      query += ` ORDER BY name LIMIT 10`;

      const [items] = await connection.query(query, params);

      if (items.length === 0) {
        await context.sendActivity(search ? `No CMDB items found matching "${search}".` : 'No CMDB items found.');
        return;
      }

      const card = {
        type: 'AdaptiveCard',
        version: '1.4',
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        body: [
          {
            type: 'TextBlock',
            text: search ? `🔍 CMDB Results for "${search}"` : '📦 CMDB Items',
            weight: 'bolder',
            size: 'large'
          },
          ...items.map(item => ({
            type: 'Container',
            items: [
              {
                type: 'ColumnSet',
                columns: [
                  { type: 'Column', width: 'stretch', items: [
                    { type: 'TextBlock', text: item.name, weight: 'bolder' },
                    { type: 'TextBlock', text: `${item.type} • ${item.status}`, size: 'small', isSubtle: true }
                  ]},
                  { type: 'Column', width: 'auto', items: [
                    { type: 'TextBlock', text: `#${item.id}`, size: 'small' }
                  ]}
                ]
              }
            ],
            separator: true
          }))
        ]
      };

      await context.sendActivity({ attachments: [CardFactory.adaptiveCard(card)] });

    } catch (error) {
      console.error('[Bot] CMDB search error:', error);
      await context.sendActivity(`Failed to search CMDB: ${error.message}`);
    } finally {
      if (connection && connection.release) connection.release();
    }
  }

  async handleViewCMDB(context, cmdbId) {
    await this.handleCMDBSearch(context, '');
  }

  async sendHelpCard(context) {
    const card = buildHelpCard();
    await context.sendActivity({ attachments: [CardFactory.adaptiveCard(card)] });
  }

  removeBotMention(text) {
    return text.replace(/<at>.*?<\/at>/gi, '').trim();
  }
}

module.exports = { ServiFlowBot };
