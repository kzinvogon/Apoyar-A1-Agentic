const crypto = require('crypto');
const { TeamsActivityHandler, CardFactory, TeamsInfo } = require('botbuilder');
const { buildTicketCard, buildTicketListCard, buildHelpCard, buildCreateTicketForm, buildModeCard } = require('./adaptiveCards/ticketCard');

// Import database utilities (local for standalone deployment)
// NOTE: These functions return mysql2 *pools*, not single connections.
const { getTenantConnection, getMasterConnection } = require('../config/database');

// Fallback tenant code if no mapping found
const DEFAULT_TENANT_CODE = process.env.SERVIFLOW_TENANT_CODE || 'apoyar';

// Cache for tenant mappings (TTL: 5 minutes)
const tenantCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

// Cache for user modes (TTL: 30 minutes)
const userModeCache = new Map();
const MODE_CACHE_TTL = 30 * 60 * 1000;

// Optional: disable DB-driven tenant mapping until the mapping tables exist.
// Set DISABLE_TEAMS_TENANT_MAPPING=true to always use DEFAULT_TENANT_CODE.
const DISABLE_TEAMS_TENANT_MAPPING = String(process.env.DISABLE_TEAMS_TENANT_MAPPING || '').toLowerCase() === 'true';

/**
 * Normalise an email-like value into a lowercase string (or null).
 */
function normaliseEmail(value) {
  if (value == null) return null;
  const email = String(value).trim();
  if (!email) return null;
  if (!email.includes('@')) return null;
  return email.toLowerCase();
}

/**
 * Get user email from Teams context.
 * Tries multiple sources: activity.from, TeamsInfo API.
 */
async function getUserEmail(context) {
  // Try direct properties first
  const direct = context.activity.from?.email || context.activity.from?.userPrincipalName;
  const directNorm = normaliseEmail(direct);
  if (directNorm) return directNorm;

  // Try to get from Teams API
  try {
    const member = await TeamsInfo.getMember(context, context.activity.from.id);
    const apiEmail = member?.email || member?.userPrincipalName;
    const apiNorm = normaliseEmail(apiEmail);
    if (apiNorm) {
      console.log(`[Bot] Got email from TeamsInfo: ${apiNorm}`);
      return apiNorm;
    }
  } catch (error) {
    console.log(`[Bot] TeamsInfo.getMember failed: ${error.message}`);
  }

  // Log what we have for debugging (avoid dumping huge objects)
  console.log('[Bot] User info available:', JSON.stringify({
    id: context.activity.from?.id,
    name: context.activity.from?.name,
    aadObjectId: context.activity.from?.aadObjectId,
    userPrincipalName: context.activity.from?.userPrincipalName
  }));

  return null;
}

/**
 * Extract domain from email address
 */
function getDomainFromEmail(email) {
  if (!email || !email.includes('@')) return null;
  return email.split('@')[1].toLowerCase();
}

/**
 * Get company name from domain (simple version)
 */
function getCompanyNameFromDomain(domain) {
  if (!domain) return 'Unknown Company';
  // Remove common TLDs and capitalize
  const name = domain.split('.')[0];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Slugify a string for use as username
 */
function slugifyUsername(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

/**
 * Generate a unique username based on a base string
 */
async function generateUniqueUsername(pool, base) {
  const root = slugifyUsername(base) || 'teamsuser';
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const [rows] = await pool.query('SELECT id FROM users WHERE username = ? LIMIT 1', [candidate]);
    if (rows.length === 0) return candidate;
  }
  return `${root}-${crypto.randomBytes(3).toString('hex')}`.slice(0, 50);
}

/**
 * Ensures a Teams user exists and is mapped via teams_user_preferences table.
 * Returns: { userId, email, created, mode }
 */
async function ensureTeamsUser(context, tenantCode, { defaultMode = 'customer' } = {}) {
  const pool = await getTenantConnection(tenantCode);

  // Prefer AAD object id (stable) as teams_user_id
  const teamsUserId =
    context.activity.from?.aadObjectId ||
    context.activity.from?.id ||
    null;

  // Pull Teams profile for name/email (best effort)
  let member = null;
  try {
    member = await TeamsInfo.getMember(context, context.activity.from.id);
  } catch (_) {}

  const emailLc = normaliseEmail(
    context.activity.from?.email ||
    context.activity.from?.userPrincipalName ||
    member?.email ||
    member?.userPrincipalName
  );

  const fullName =
    (member && (member.name || `${member.givenName || ''} ${member.surname || ''}`.trim())) ||
    context.activity.from?.name ||
    emailLc ||
    'Teams User';

  // 1) If we have teamsUserId, try mapping table first
  if (teamsUserId) {
    const [maps] = await pool.query(
      `SELECT user_id, mode FROM teams_user_preferences WHERE teams_user_id = ? LIMIT 1`,
      [teamsUserId]
    );

    if (maps.length > 0) {
      const { user_id: userId, mode } = maps[0];

      // Optional: keep user active + update name/email if we got them
      await pool.query(
        `UPDATE users
            SET is_active = 1,
                full_name = COALESCE(NULLIF(full_name,''), ?),
                email = COALESCE(email, ?),
                updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
        [fullName, emailLc, userId]
      );

      return { userId, email: emailLc, created: false, mode };
    }
  }

  // 2) Fall back: if we have email, see if user already exists
  let existingUserId = null;
  let existingRole = null;

  if (emailLc) {
    const [urows] = await pool.query(
      'SELECT id, role FROM users WHERE email = ? LIMIT 1',
      [emailLc]
    );
    if (urows.length > 0) {
      existingUserId = urows[0].id;
      existingRole = urows[0].role;
    }
  }

  // 3) Create user if needed
  let userId = existingUserId;
  let created = false;

  if (!userId) {
    const baseUsername = (emailLc && emailLc.split('@')[0]) || fullName;
    const username = await generateUniqueUsername(pool, baseUsername);

    // Non-login placeholder (can replace later with invitation flow)
    const passwordHash = `teams:${crypto.randomBytes(32).toString('hex')}`;

    const role = defaultMode === 'expert' ? 'expert' : 'customer';

    const [ins] = await pool.query(
      `INSERT INTO users (username, password_hash, role, email, full_name, is_active, must_reset_password)
       VALUES (?, ?, ?, ?, ?, 1, 0)`,
      [username, passwordHash, role, emailLc, fullName]
    );

    userId = ins.insertId;
    created = true;
  } else {
    // Ensure active + update name/email
    await pool.query(
      `UPDATE users
          SET is_active = 1,
              full_name = COALESCE(NULLIF(full_name,''), ?),
              email = COALESCE(email, ?),
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [fullName, emailLc, userId]
    );
  }

  // 4) Insert mapping row if we have teamsUserId
  const mode = defaultMode;

  if (teamsUserId) {
    try {
      await pool.query(
        `INSERT INTO teams_user_preferences (user_id, teams_user_id, mode)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE teams_user_id = VALUES(teams_user_id), mode = VALUES(mode), updated_at = CURRENT_TIMESTAMP`,
        [userId, teamsUserId, mode]
      );
    } catch (err) {
      // If UNIQUE(user_id) blocks insert (already mapped), just update it
      await pool.query(
        `UPDATE teams_user_preferences
            SET teams_user_id = COALESCE(teams_user_id, ?),
                mode = COALESCE(mode, ?),
                updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ?`,
        [teamsUserId, mode, userId]
      );
    }
  }

  // Optional: sync users.role with mode if you want
  if (defaultMode && (!existingRole || existingRole !== (defaultMode === 'expert' ? 'expert' : 'customer'))) {
    await pool.query(
      `UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [defaultMode === 'expert' ? 'expert' : 'customer', userId]
    );
  }

  return { userId, email: emailLc, created, mode };
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
      const membersAdded = context.activity.membersAdded || [];
      for (const member of membersAdded) {
        if (member.id !== context.activity.recipient.id) {
          await context.sendActivity(
            'Hello! I\'m the ServiFlow Bot. I can help you manage support tickets.\n\n' +
            'Try commands like:\n' +
            '- `raise ticket: [description]` - Create a new ticket\n' +
            '- `status #123` - Check ticket status\n' +
            '- `my tickets` - List your tickets\n' +
            '- `mode` - Check/switch between Expert and Customer mode\n' +
            '- `help` - Show all commands'
          );
        }
      }
      await next();
    });
  }

  /**
   * Check if user is an expert (staff member)
   */
  async isUserExpert(pool, userId) {
    try {
      const [users] = await pool.query(
        `SELECT role FROM users WHERE id = ? AND is_active = TRUE`,
        [userId]
      );
      if (users.length === 0) return false;
      const role = users[0].role?.toLowerCase();
      return role === 'admin' || role === 'expert' || role === 'agent';
    } catch (error) {
      console.error('[Bot] Error checking expert status:', error.message);
      return false;
    }
  }

  /**
   * Get user's current mode preference
   */
  async getUserMode(pool, userId, userEmail) {
    const cacheKey = `mode_${userId}`;

    // Check cache first
    if (userModeCache.has(cacheKey)) {
      const cached = userModeCache.get(cacheKey);
      if (Date.now() - cached.timestamp < MODE_CACHE_TTL) {
        return cached.mode;
      }
      userModeCache.delete(cacheKey);
    }

    try {
      // Check if preferences table exists and has a record
      const [prefs] = await pool.query(
        `SELECT mode FROM teams_user_preferences WHERE user_id = ?`,
        [userId]
      );

      if (prefs.length > 0) {
        const mode = prefs[0].mode;
        userModeCache.set(cacheKey, { mode, timestamp: Date.now() });
        return mode;
      }

      // No preference set - determine default based on role
      const isExpert = await this.isUserExpert(pool, userId);
      const defaultMode = isExpert ? 'expert' : 'customer';

      // Save default preference
      try {
        await pool.query(
          `INSERT INTO teams_user_preferences (user_id, mode) VALUES (?, ?)
           ON DUPLICATE KEY UPDATE mode = VALUES(mode)`,
          [userId, defaultMode]
        );
      } catch (e) {
        // Table might not exist yet, ignore
        console.log('[Bot] Could not save mode preference:', e.message);
      }

      userModeCache.set(cacheKey, { mode: defaultMode, timestamp: Date.now() });
      return defaultMode;
    } catch (error) {
      // If table doesn't exist, fall back to role-based detection
      console.log('[Bot] Mode lookup error:', error.message);
      const isExpert = await this.isUserExpert(pool, userId);
      return isExpert ? 'expert' : 'customer';
    }
  }

  /**
   * Set user's mode preference
   */
  async setUserMode(pool, userId, mode) {
    const cacheKey = `mode_${userId}`;

    try {
      await pool.query(
        `INSERT INTO teams_user_preferences (user_id, mode) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE mode = VALUES(mode), updated_at = NOW()`,
        [userId, mode]
      );
      userModeCache.set(cacheKey, { mode, timestamp: Date.now() });
      return true;
    } catch (error) {
      console.error('[Bot] Error setting mode:', error.message);
      // Try to create table if it doesn't exist
      try {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS teams_user_preferences (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            mode ENUM('expert', 'customer') DEFAULT 'expert',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY unique_user (user_id)
          )
        `);
        await pool.query(
          `INSERT INTO teams_user_preferences (user_id, mode) VALUES (?, ?)`,
          [userId, mode]
        );
        userModeCache.set(cacheKey, { mode, timestamp: Date.now() });
        return true;
      } catch (e) {
        console.error('[Bot] Could not create preferences table:', e.message);
        return false;
      }
    }
  }

  /**
   * Find or create user record
   */
  async findOrCreateUser(pool, email, fullName) {
    // First try to find existing user
    const [existing] = await pool.query(
      `SELECT id, role FROM users WHERE email = ? AND is_active = TRUE`,
      [email]
    );

    if (existing.length > 0) {
      return { userId: existing[0].id, role: existing[0].role, isNew: false };
    }

    // Create new user as customer
    const [result] = await pool.query(
      `INSERT INTO users (email, full_name, role, is_active, created_at)
       VALUES (?, ?, 'customer', TRUE, NOW())`,
      [email, fullName || email.split('@')[0]]
    );

    return { userId: result.insertId, role: 'customer', isNew: true };
  }

  /**
   * Find or create customer profile
   */
  async findOrCreateCustomer(pool, userId, email, fullName) {
    // Check if customer profile exists
    const [existing] = await pool.query(
      `SELECT id, customer_company_id FROM customers WHERE user_id = ?`,
      [userId]
    );

    if (existing.length > 0) {
      return { customerId: existing[0].id, companyId: existing[0].customer_company_id, isNew: false };
    }

    // Get or create company based on email domain
    const domain = getDomainFromEmail(email);
    let companyId = null;

    if (domain) {
      // Try to find existing company by domain
      const [companies] = await pool.query(
        `SELECT id FROM customer_companies WHERE company_domain = ? AND is_active = TRUE`,
        [domain]
      );

      if (companies.length > 0) {
        companyId = companies[0].id;
      } else {
        // Create new company
        const companyName = getCompanyNameFromDomain(domain);
        const [companyResult] = await pool.query(
          `INSERT INTO customer_companies (company_name, company_domain, sla_level, is_active, created_at)
           VALUES (?, ?, 'basic', TRUE, NOW())`,
          [companyName, domain]
        );
        companyId = companyResult.insertId;
        console.log(`[Bot] Created new company: ${companyName} (${domain})`);
      }
    }

    // Create customer profile
    const [result] = await pool.query(
      `INSERT INTO customers (user_id, customer_company_id, company_name, company_domain, sla_level)
       VALUES (?, ?, ?, ?, 'basic')`,
      [userId, companyId, companyId ? null : getCompanyNameFromDomain(domain), domain]
    );

    console.log(`[Bot] Created customer profile for user ${userId}`);
    return { customerId: result.insertId, companyId, isNew: true };
  }

  /**
   * Resolve tenant code from Teams context.
   */
  async resolveTenant(context) {
    if (DISABLE_TEAMS_TENANT_MAPPING) {
      return DEFAULT_TENANT_CODE;
    }

    const teamsTenantId =
      context.activity.conversation?.tenantId ||
      context.activity.channelData?.tenant?.id;

    const rawUserEmail =
      context.activity.from?.email ||
      context.activity.from?.userPrincipalName ||
      '';

    const emailLc = normaliseEmail(rawUserEmail);
    const emailDomain = emailLc ? emailLc.split('@')[1] : null;

    const cacheKey = teamsTenantId || emailDomain;

    if (cacheKey && tenantCache.has(cacheKey)) {
      const cached = tenantCache.get(cacheKey);
      if (Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.tenantCode;
      }
      tenantCache.delete(cacheKey);
    }

    let tenantCode = null;

    try {
      const masterPool = await getMasterConnection();

      if (teamsTenantId) {
        const [rows] = await masterPool.query(
          'SELECT tenant_code FROM teams_tenant_mappings WHERE teams_tenant_id = ? AND is_active = TRUE',
          [teamsTenantId]
        );
        if (rows.length > 0) {
          tenantCode = rows[0].tenant_code;
        }
      }

      if (!tenantCode && emailDomain) {
        const [rows] = await masterPool.query(
          'SELECT tenant_code FROM teams_email_domain_mappings WHERE email_domain = ? AND is_active = TRUE',
          [emailDomain]
        );
        if (rows.length > 0) {
          tenantCode = rows[0].tenant_code;
        }
      }

      if (tenantCode && cacheKey) {
        tenantCache.set(cacheKey, { tenantCode, timestamp: Date.now() });
      }
    } catch (error) {
      console.error('[Bot] Error resolving tenant:', error.message);
    }

    if (!tenantCode) {
      tenantCode = DEFAULT_TENANT_CODE;
    }

    return tenantCode;
  }

  // Handle adaptive card actions
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
        case 'setMode':
          await this.handleSetMode(context, data.mode);
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

    const userEmail = await getUserEmail(context);
    const fallbackIdentity = context.activity.from?.aadObjectId || context.activity.from?.id || 'unknown';
    console.log(`[Bot] Message from ${userEmail || fallbackIdentity}: ${text}`);

    try {
      // Mode commands
      if (text === 'mode' || text === 'mode status') {
        await this.handleShowMode(context);
      }
      else if (text === 'mode expert' || text === 'expert mode') {
        await this.handleSetMode(context, 'expert');
      }
      else if (text === 'mode customer' || text === 'customer mode') {
        await this.handleSetMode(context, 'customer');
      }
      // raise ticket: [description]
      else if (text.startsWith('raise ticket:') || text.startsWith('raise ticket ')) {
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
      // resolve #123 [comment] - expert only
      else if (text.startsWith('resolve ') || text.startsWith('resolve#')) {
        await this.handleExpertCommand(context, async () => {
          const parts = rawText.replace(/^resolve\s*#?/i, '').trim().split(' ');
          const ticketId = parts[0].replace('#', '');
          const comment = parts.slice(1).join(' ') || 'Resolved via Teams';
          await this.handleResolveTicket(context, ticketId, comment);
        });
      }
      // assign #123 - expert only
      else if (text.startsWith('assign ') || text.startsWith('assign#')) {
        await this.handleExpertCommand(context, async () => {
          const ticketId = text.replace(/^assign\s*#?/, '').trim();
          await this.handleAssignToMe(context, ticketId);
        });
      }
      // trends / insights - expert only
      else if (text === 'trends' || text === 'insights' || text === 'analytics') {
        await this.handleExpertCommand(context, async () => {
          await this.handleTrends(context);
        });
      }
      // cmdb [search] - expert only
      else if (text.startsWith('cmdb ') || text === 'cmdb') {
        await this.handleExpertCommand(context, async () => {
          const search = text.replace('cmdb', '').trim();
          await this.handleCMDBSearch(context, search);
        });
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

  /**
   * Wrapper for expert-only commands
   */
  async handleExpertCommand(context, handler) {
    const userEmailLc = await getUserEmail(context);
    const tenantCode = await this.resolveTenant(context);

    if (!userEmailLc) {
      await context.sendActivity('Unable to identify your email.');
      return;
    }

    try {
      const pool = await getTenantConnection(tenantCode);

      const [users] = await pool.query(
        `SELECT id FROM users WHERE email = ? AND is_active = TRUE`,
        [userEmailLc]
      );

      if (users.length === 0) {
        await context.sendActivity('Your email is not linked to a ServiFlow account.');
        return;
      }

      const userId = users[0].id;
      const mode = await this.getUserMode(pool, userId, userEmailLc);

      if (mode !== 'expert') {
        await context.sendActivity(
          '🔒 This command is only available in **Expert mode**.\n\n' +
          'Type `mode expert` to switch to Expert mode.'
        );
        return;
      }

      // User is in expert mode, execute the command
      await handler();
    } catch (error) {
      console.error('[Bot] Expert command error:', error);
      await context.sendActivity(`Error: ${error.message}`);
    }
  }

  /**
   * Show current mode
   */
  async handleShowMode(context) {
    const userEmailLc = await getUserEmail(context);
    const tenantCode = await this.resolveTenant(context);

    if (!userEmailLc) {
      await context.sendActivity('Unable to identify your email.');
      return;
    }

    try {
      const pool = await getTenantConnection(tenantCode);
      const userName = context.activity.from?.name || userEmailLc;

      // Find or create user
      const { userId, role } = await this.findOrCreateUser(pool, userEmailLc, userName);
      const isExpert = role === 'admin' || role === 'expert' || role === 'agent';
      const currentMode = await this.getUserMode(pool, userId, userEmailLc);

      const card = buildModeCard(currentMode, isExpert, userName);
      await context.sendActivity({ attachments: [CardFactory.adaptiveCard(card)] });
    } catch (error) {
      console.error('[Bot] Show mode error:', error);
      await context.sendActivity(`Failed to get mode: ${error.message}`);
    }
  }

  /**
   * Set user mode
   */
  async handleSetMode(context, newMode) {
    const userEmailLc = await getUserEmail(context);
    const tenantCode = await this.resolveTenant(context);

    if (!userEmailLc) {
      await context.sendActivity('Unable to identify your email.');
      return;
    }

    try {
      const pool = await getTenantConnection(tenantCode);
      const userName = context.activity.from?.name || userEmailLc;

      // Find or create user
      const { userId, role } = await this.findOrCreateUser(pool, userEmailLc, userName);
      const isExpert = role === 'admin' || role === 'expert' || role === 'agent';

      // Validate mode change
      if (newMode === 'expert' && !isExpert) {
        await context.sendActivity(
          '❌ You cannot switch to Expert mode because your account does not have expert privileges.\n\n' +
          'Please contact your administrator if you believe this is an error.'
        );
        return;
      }

      // If switching to customer mode, ensure customer profile exists
      if (newMode === 'customer') {
        await this.findOrCreateCustomer(pool, userId, userEmailLc, userName);
      }

      // Set the mode
      const success = await this.setUserMode(pool, userId, newMode);

      if (success) {
        const modeEmoji = newMode === 'expert' ? '👔' : '👤';
        const modeFeatures = newMode === 'expert'
          ? '• View assigned tickets\n• Resolve & assign tickets\n• Access trends & CMDB'
          : '• View your raised tickets\n• Create new tickets\n• Check ticket status';

        await context.sendActivity(
          `${modeEmoji} **Mode switched to ${newMode.charAt(0).toUpperCase() + newMode.slice(1)}**\n\n` +
          `Available features:\n${modeFeatures}`
        );
      } else {
        await context.sendActivity('Failed to switch mode. Please try again.');
      }
    } catch (error) {
      console.error('[Bot] Set mode error:', error);
      await context.sendActivity(`Failed to set mode: ${error.message}`);
    }
  }

  async handleCreateTicket(context, description) {
    if (!description) {
      const card = buildCreateTicketForm();
      await context.sendActivity({ attachments: [CardFactory.adaptiveCard(card)] });
      return;
    }

    const userEmailLc = await getUserEmail(context);
    const userName = context.activity.from?.name || userEmailLc || 'Unknown';
    const tenantCode = await this.resolveTenant(context);

    try {
      const pool = await getTenantConnection(tenantCode);

      // Find or create user
      const { userId, isNew: isNewUser } = await this.findOrCreateUser(pool, userEmailLc, userName);

      // Get user mode
      const mode = await this.getUserMode(pool, userId, userEmailLc);

      // If in customer mode, ensure customer profile exists
      if (mode === 'customer') {
        await this.findOrCreateCustomer(pool, userId, userEmailLc, userName);
      }

      // Create ticket
      const category = mode === 'customer' ? 'Customer Portal' : 'Teams';
      const [result] = await pool.query(
        `INSERT INTO tickets (title, description, status, priority, requester_id, category)
         VALUES (?, ?, 'Open', 'medium', ?, ?)`,
        [description.substring(0, 100), description, userId, category]
      );

      const ticketId = result.insertId;

      // Log activity
      const activityDesc = mode === 'customer'
        ? `Ticket raised by customer ${userName} via Teams`
        : `Ticket created by ${userName} via Teams (Expert mode)`;

      await pool.query(
        `INSERT INTO ticket_activity (ticket_id, user_id, activity_type, description)
         VALUES (?, ?, 'created', ?)`,
        [ticketId, userId, activityDesc]
      );

      // Get full ticket with joins
      const [tickets] = await pool.query(
        `SELECT t.*,
                u.full_name as requester_name, u.email as requester_email,
                a.full_name as assignee_name,
                ci.asset_name as cmdb_item_name, ci.id as cmdb_item_id,
                ae.sentiment, ae.ai_category as category, ae.confidence_score
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
      const modeLabel = mode === 'customer' ? ' (as Customer)' : '';
      await context.sendActivity({
        text: `✅ Ticket #${ticketId} created successfully!${modeLabel}`,
        attachments: [CardFactory.adaptiveCard(card)]
      });
    } catch (error) {
      console.error('[Bot] Create ticket error:', error);
      await context.sendActivity(`Failed to create ticket: ${error.message}`);
    }
  }

  async handleCreateTicketSubmit(context, data) {
    await this.handleCreateTicket(context, data.description || data.title);
  }

  async handleViewTicket(context, ticketId) {
    const tenantCode = await this.resolveTenant(context);

    try {
      const pool = await getTenantConnection(tenantCode);

      const [tickets] = await pool.query(
        `SELECT t.*,
                u.full_name as requester_name, u.email as requester_email,
                a.full_name as assignee_name, a.email as assignee_email,
                ci.asset_name as cmdb_item_name, ci.id as cmdb_item_id, ci.asset_category as cmdb_item_type,
                ae.sentiment, ae.ai_category as category, ae.confidence_score,
                ae.root_cause_type as root_cause, ae.impact_level
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
    }
  }

  async handleMyTickets(context) {
    const userEmailLc = await getUserEmail(context);
    const tenantCode = await this.resolveTenant(context);

    if (!userEmailLc) {
      await context.sendActivity('Unable to identify your email. Please ensure you are signed in to Teams with a work account.');
      return;
    }

    try {
      const pool = await getTenantConnection(tenantCode);
      const userName = context.activity.from?.name || userEmailLc;

      // Find or create user
      const { userId } = await this.findOrCreateUser(pool, userEmailLc, userName);

      // Get user mode
      const mode = await this.getUserMode(pool, userId, userEmailLc);

      let tickets;
      let listTitle;

      if (mode === 'expert') {
        // Expert mode: show tickets assigned to user
        [tickets] = await pool.query(
          `SELECT t.*,
                  u.full_name as requester_name,
                  ci.asset_name as cmdb_item_name
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
        listTitle = 'My Assigned Tickets';
      } else {
        // Customer mode: show tickets raised by user
        [tickets] = await pool.query(
          `SELECT t.*,
                  a.full_name as assignee_name,
                  ci.asset_name as cmdb_item_name
           FROM tickets t
           LEFT JOIN users a ON t.assignee_id = a.id
           LEFT JOIN cmdb_items ci ON t.cmdb_item_id = ci.id
           WHERE t.requester_id = ?
           ORDER BY t.created_at DESC
           LIMIT 20`,
          [userId]
        );
        listTitle = 'My Raised Tickets';
      }

      if (tickets.length === 0) {
        const emptyMessage = mode === 'expert'
          ? 'You have no assigned tickets. 🎉'
          : 'You haven\'t raised any tickets yet.';
        await context.sendActivity(emptyMessage);
        return;
      }

      const card = buildTicketListCard(tickets, listTitle);
      await context.sendActivity({ attachments: [CardFactory.adaptiveCard(card)] });
    } catch (error) {
      console.error('[Bot] My tickets error:', error);
      await context.sendActivity(`Failed to get tickets: ${error.message}`);
    }
  }

  async handleAssignToMe(context, ticketId) {
    const userEmailLc = await getUserEmail(context);
    const tenantCode = await this.resolveTenant(context);

    if (!userEmailLc) {
      await context.sendActivity('Unable to identify your email.');
      return;
    }

    try {
      const pool = await getTenantConnection(tenantCode);

      const [users] = await pool.query(
        'SELECT id, full_name FROM users WHERE email = ? AND is_active = TRUE',
        [userEmailLc]
      );

      if (users.length === 0) {
        await context.sendActivity('Your email is not linked to a ServiFlow account.');
        return;
      }

      const userId = users[0].id;
      const userName = users[0].full_name;

      await pool.query(
        'UPDATE tickets SET assignee_id = ?, status = "In Progress", updated_at = NOW() WHERE id = ?',
        [userId, ticketId]
      );

      await pool.query(
        `INSERT INTO ticket_activity (ticket_id, user_id, activity_type, description)
         VALUES (?, ?, 'assigned', ?)`,
        [ticketId, userId, `Assigned to ${userName} via Teams`]
      );

      await context.sendActivity(`✅ Ticket #${ticketId} assigned to you.`);
      await this.handleViewTicket(context, ticketId);
    } catch (error) {
      console.error('[Bot] Assign ticket error:', error);
      await context.sendActivity(`Failed to assign ticket: ${error.message}`);
    }
  }

  async handleResolveTicket(context, ticketId, comment = 'Resolved via Teams') {
    const userEmailLc = await getUserEmail(context);
    const tenantCode = await this.resolveTenant(context);

    if (!userEmailLc) {
      await context.sendActivity('Unable to identify your email.');
      return;
    }

    try {
      const pool = await getTenantConnection(tenantCode);

      const [users] = await pool.query(
        'SELECT id, full_name FROM users WHERE email = ? AND is_active = TRUE',
        [userEmailLc]
      );

      if (users.length === 0) {
        await context.sendActivity('Your email is not linked to a ServiFlow account.');
        return;
      }

      const userId = users[0].id;
      const userName = users[0].full_name;

      await pool.query(
        `UPDATE tickets
         SET status = 'Resolved', resolved_by = ?, resolved_at = NOW(),
             resolution_comment = ?, updated_at = NOW()
         WHERE id = ?`,
        [userId, comment, ticketId]
      );

      await pool.query(
        `INSERT INTO ticket_activity (ticket_id, user_id, activity_type, description)
         VALUES (?, ?, 'resolved', ?)`,
        [ticketId, userId, `Resolved by ${userName} via Teams: ${comment}`]
      );

      await context.sendActivity(`✅ Ticket #${ticketId} resolved.`);
      await this.handleViewTicket(context, ticketId);
    } catch (error) {
      console.error('[Bot] Resolve ticket error:', error);
      await context.sendActivity(`Failed to resolve ticket: ${error.message}`);
    }
  }

  async handleTrends(context) {
    const tenantCode = await this.resolveTenant(context);

    try {
      const pool = await getTenantConnection(tenantCode);

      const [stats] = await pool.query(`
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

      const [categories] = await pool.query(`
        SELECT ai_category as category, COUNT(*) as count
        FROM ai_email_analysis
        WHERE analysis_timestamp >= DATE_SUB(NOW(), INTERVAL 7 DAY) AND ai_category IS NOT NULL
        GROUP BY ai_category
        ORDER BY count DESC
        LIMIT 5
      `);

      const [insights] = await pool.query(`
        SELECT insight_type, description, severity, created_at
        FROM ai_insights
        WHERE status = 'active'
        ORDER BY created_at DESC
        LIMIT 3
      `);

      const s = (stats && stats[0]) ? stats[0] : {};
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
                { type: 'TextBlock', text: String(s.total_tickets ?? 0), size: 'extraLarge', weight: 'bolder', horizontalAlignment: 'center' },
                { type: 'TextBlock', text: 'Total', horizontalAlignment: 'center', isSubtle: true }
              ]},
              { type: 'Column', width: 'stretch', items: [
                { type: 'TextBlock', text: String(s.open_tickets ?? 0), size: 'extraLarge', weight: 'bolder', horizontalAlignment: 'center', color: 'attention' },
                { type: 'TextBlock', text: 'Open', horizontalAlignment: 'center', isSubtle: true }
              ]},
              { type: 'Column', width: 'stretch', items: [
                { type: 'TextBlock', text: String(s.resolved_today ?? 0), size: 'extraLarge', weight: 'bolder', horizontalAlignment: 'center', color: 'good' },
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

      if (Array.isArray(categories) && categories.length > 0) {
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

      if (Array.isArray(insights) && insights.length > 0) {
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
    }
  }

  async handleCMDBSearch(context, search) {
    const tenantCode = await this.resolveTenant(context);

    try {
      const pool = await getTenantConnection(tenantCode);

      let query = `
        SELECT id, asset_name as name, asset_category as type, status, description
        FROM cmdb_items
        WHERE is_active = TRUE
      `;
      const params = [];

      if (search) {
        query += ` AND (asset_name LIKE ? OR description LIKE ? OR asset_category LIKE ?)`;
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      }

      query += ` ORDER BY asset_name LIMIT 10`;

      const [items] = await pool.query(query, params);

      if (!items || items.length === 0) {
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
    }
  }

  async handleViewCMDB(context, cmdbId) {
    await this.handleCMDBSearch(context, '');
  }

  async sendHelpCard(context) {
    const userEmailLc = await getUserEmail(context);
    const tenantCode = await this.resolveTenant(context);
    let mode = 'expert'; // default

    try {
      if (userEmailLc) {
        const pool = await getTenantConnection(tenantCode);
        const userName = context.activity.from?.name || userEmailLc;
        const { userId } = await this.findOrCreateUser(pool, userEmailLc, userName);
        mode = await this.getUserMode(pool, userId, userEmailLc);
      }
    } catch (e) {
      // Ignore errors, use default
    }

    const card = buildHelpCard(mode);
    await context.sendActivity({ attachments: [CardFactory.adaptiveCard(card)] });
  }

  removeBotMention(text) {
    return text.replace(/<at>.*?<\/at>/gi, '').trim();
  }
}

module.exports = { ServiFlowBot };
