/**
 * Magic Link Authentication Service
 *
 * Handles: token generation, tenant resolution, user provisioning,
 * context loading, and multi-role JWT issuance.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { masterQuery, tenantQuery, getTenantConnection } = require('../config/database');
const { sendEmail } = require('../config/email');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = '24h';
const TOKEN_EXPIRY_MINUTES = 15;

// ── Tenant Resolution ──────────────────────────────────────────────

/**
 * Demo hosts — any email can sign up, always binds to tenant_code=demo.
 * All other environments (UAT, prod) require an existing user or verified domain mapping.
 */
const DEMO_HOSTS = ['demo.serviflow.app', 'web-demo.up.railway.app'];

/**
 * Resolve which tenant an email belongs to.
 * - Demo host → demo tenant (is_demo=1), any email accepted
 * - All others (UAT, prod) → tenant_email_domains lookup by email domain
 */
async function resolveTenant(email, host) {
  const isDemoHost = DEMO_HOSTS.some(h => host && host.includes(h));

  if (isDemoHost) {
    const rows = await masterQuery(
      'SELECT id, tenant_code FROM tenants WHERE is_demo = 1 AND status = ? LIMIT 1',
      ['active']
    );
    if (rows.length === 0) return null;
    return { tenantId: rows[0].id, tenantCode: rows[0].tenant_code, isDemo: true };
  }

  // UAT + Production: resolve by verified email domain only
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return null;

  const rows = await masterQuery(
    `SELECT ted.tenant_id, t.tenant_code
     FROM tenant_email_domains ted
     JOIN tenants t ON t.id = ted.tenant_id
     WHERE ted.domain = ? AND t.status = ?`,
    [domain, 'active']
  );
  if (rows.length === 0) return null;
  return { tenantId: rows[0].tenant_id, tenantCode: rows[0].tenant_code, isDemo: false };
}

// ── Token Management ───────────────────────────────────────────────

/**
 * Request a magic link for the given email.
 * Always returns ok (anti-enumeration).
 */
async function requestMagicLink(email, host, ip, userAgent) {
  email = email.toLowerCase().trim();

  // Resolve tenant
  const tenant = await resolveTenant(email, host);

  // Log event regardless of resolution (anti-enumeration — always return ok)
  const ipHash = ip ? crypto.createHash('sha256').update(ip).digest('hex').substring(0, 16) : null;
  await logAuthEvent('magic_link_requested', email, tenant?.tenantId || null, { host }, ipHash);

  if (!tenant) {
    // Don't reveal that the tenant wasn't found
    return { ok: true };
  }

  // Revoke any pending tokens for this email
  await masterQuery(
    `UPDATE auth_magic_links SET status = 'revoked'
     WHERE email = ? AND status = 'pending'`,
    [email]
  );

  // Generate token
  const tokenPlain = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(tokenPlain).digest('hex');
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MINUTES * 60 * 1000);

  await masterQuery(
    `INSERT INTO auth_magic_links (email, token_hash, tenant_id, purpose, requested_host, expires_at, ip_hash, user_agent)
     VALUES (?, ?, ?, 'login', ?, ?, ?, ?)`,
    [email, tokenHash, tenant.tenantId, host || null, expiresAt, ipHash, userAgent || null]
  );

  // Build magic link URL
  const protocol = host && host.includes('localhost') ? 'http' : 'https';
  const magicUrl = `${protocol}://${host}/auth/magic?token=${tokenPlain}`;

  // Send email
  try {
    await sendEmail(tenant.tenantCode, {
      to: email,
      subject: 'Sign in to ServiFlow',
      html: buildMagicLinkEmail(magicUrl, TOKEN_EXPIRY_MINUTES),
      skipKillSwitch: true
    });
  } catch (err) {
    console.error('Failed to send magic link email:', err.message);
    // Don't expose email failures to caller
  }

  return { ok: true };
}

/**
 * Consume a magic link token. Returns JWT + user context or error.
 */
async function consumeMagicLink(tokenPlain, host) {
  const tokenHash = crypto.createHash('sha256').update(tokenPlain).digest('hex');

  // Fetch token row
  const rows = await masterQuery(
    `SELECT * FROM auth_magic_links WHERE token_hash = ? LIMIT 1`,
    [tokenHash]
  );

  if (rows.length === 0) {
    return { success: false, message: 'Invalid or expired link' };
  }

  const link = rows[0];

  // Check status
  if (link.status !== 'pending') {
    return { success: false, message: 'This link has already been used' };
  }

  // Check expiry
  if (new Date(link.expires_at) < new Date()) {
    await masterQuery(
      `UPDATE auth_magic_links SET status = 'expired' WHERE id = ?`,
      [link.id]
    );
    return { success: false, message: 'This link has expired' };
  }

  // Attempt tracking — revoke after 5 attempts
  if (link.attempts_count >= 5) {
    await masterQuery(
      `UPDATE auth_magic_links SET status = 'revoked' WHERE id = ?`,
      [link.id]
    );
    return { success: false, message: 'Too many attempts — please request a new link' };
  }

  await masterQuery(
    `UPDATE auth_magic_links SET attempts_count = attempts_count + 1 WHERE id = ?`,
    [link.id]
  );

  // Host binding check (demo tokens stay on demo hosts)
  const requestedOnDemo = DEMO_HOSTS.some(h => link.requested_host && link.requested_host.includes(h));
  const consumedOnDemo = DEMO_HOSTS.some(h => host && host.includes(h));
  if (requestedOnDemo !== consumedOnDemo) {
    return { success: false, message: 'This link cannot be used on this domain' };
  }

  // Mark consumed
  await masterQuery(
    `UPDATE auth_magic_links SET status = 'consumed', consumed_at = NOW() WHERE id = ?`,
    [link.id]
  );

  // Resolve tenant
  const tenantRows = await masterQuery(
    'SELECT tenant_code, is_demo FROM tenants WHERE id = ?',
    [link.tenant_id]
  );
  if (tenantRows.length === 0) {
    return { success: false, message: 'Tenant not found' };
  }

  const tenantCode = tenantRows[0].tenant_code;
  const isDemo = tenantRows[0].is_demo === 1;

  // Find or create user — only demo hosts auto-provision with any email
  const user = await findOrCreateUser(tenantCode, link.email, isDemo);
  if (!user) {
    return { success: false, message: 'Unable to provision user account' };
  }

  // Load context
  const context = await getUserContext(tenantCode, user.id);

  // Auto-resolve active role/company for simple cases
  let activeRole = null;
  let activeCompanyId = null;
  let requiresContext = false;

  if (context.roles.length === 1) {
    activeRole = context.roles[0];
    if (activeRole === 'customer' && context.companies.length === 1) {
      activeCompanyId = context.companies[0].id;
    } else if (activeRole === 'customer' && context.companies.length > 1) {
      requiresContext = true;
    }
  } else if (context.roles.length > 1) {
    requiresContext = true;
  }

  // Issue JWT
  const token = issueMultiRoleJWT({
    userId: user.id,
    username: user.username,
    role: activeRole || context.roles[0] || user.role,
    tenantCode,
    userType: 'tenant',
    roles: context.roles,
    active_role: activeRole,
    active_company_id: activeCompanyId,
    requires_context: requiresContext
  });

  await logAuthEvent('magic_link_consumed', link.email, link.tenant_id, { userId: user.id }, null);

  return {
    success: true,
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      fullName: user.full_name,
      role: activeRole || context.roles[0] || user.role,
      tenantCode,
      roles: context.roles,
      companies: context.companies
    },
    requires_context: requiresContext
  };
}

// ── User Provisioning ──────────────────────────────────────────────

/**
 * Find user by email in tenant DB, or auto-create if on a demo host.
 * @param {boolean} isDemo - true only for demo hosts; enables auto-provisioning with any email
 */
async function findOrCreateUser(tenantCode, email, isDemo) {
  const conn = await getTenantConnection(tenantCode);
  try {
    // Look up existing user
    const [existing] = await conn.query(
      'SELECT * FROM users WHERE email = ? LIMIT 1',
      [email]
    );
    if (existing.length > 0) {
      return existing[0];
    }

    if (!isDemo) return null;

    // Create user with no password (magic-link-only)
    const username = email.split('@')[0].replace(/[^a-zA-Z0-9._-]/g, '') + '_' + Date.now().toString(36);
    const fullName = email.split('@')[0].replace(/[._+-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    const [result] = await conn.query(
      `INSERT INTO users (username, email, password_hash, full_name, role, auth_method, is_active)
       VALUES (?, ?, NULL, ?, 'customer', 'magic_link', TRUE)`,
      [username, email, fullName]
    );
    const userId = result.insertId;

    // Grant default customer role
    await conn.query(
      'INSERT IGNORE INTO tenant_user_roles (tenant_user_id, role_key) VALUES (?, ?)',
      [userId, 'customer']
    );

    // For open-signup hosts: also grant all demo persona roles + company memberships
    // so users can freely switch personas in demo/UAT
    if (isDemo) {
      try {
        const [personas] = await conn.query('SELECT DISTINCT role, company_id FROM demo_personas');
        for (const p of personas) {
          await conn.query(
            'INSERT IGNORE INTO tenant_user_roles (tenant_user_id, role_key) VALUES (?, ?)',
            [userId, p.role]
          );
          if (p.company_id) {
            await conn.query(
              'INSERT IGNORE INTO tenant_user_company_memberships (tenant_user_id, company_id) VALUES (?, ?)',
              [userId, p.company_id]
            );
          }
        }
      } catch (e) { /* demo_personas table may not exist */ }
    }

    const [newUser] = await conn.query('SELECT * FROM users WHERE id = ?', [userId]);
    return newUser[0] || null;
  } finally {
    conn.release();
  }
}

// ── Context Loading ────────────────────────────────────────────────

/**
 * Get user's roles and company memberships.
 */
async function getUserContext(tenantCode, userId) {
  const roleRows = await tenantQuery(
    tenantCode,
    'SELECT role_key FROM tenant_user_roles WHERE tenant_user_id = ?',
    [userId]
  );
  const roles = roleRows.map(r => r.role_key);

  const companyRows = await tenantQuery(
    tenantCode,
    `SELECT tucm.company_id as id, cc.company_name, tucm.membership_role
     FROM tenant_user_company_memberships tucm
     JOIN customer_companies cc ON cc.id = tucm.company_id
     WHERE tucm.tenant_user_id = ?`,
    [userId]
  );

  // If no explicit roles, fallback to users.role
  if (roles.length === 0) {
    const userRows = await tenantQuery(tenantCode, 'SELECT role FROM users WHERE id = ?', [userId]);
    if (userRows.length > 0) {
      roles.push(userRows[0].role);
    }
  }

  return { roles, companies: companyRows };
}

// ── JWT ────────────────────────────────────────────────────────────

/**
 * Issue a JWT with the multi-role payload.
 */
function issueMultiRoleJWT(payload) {
  return jwt.sign(
    {
      userId: payload.userId,
      username: payload.username,
      role: payload.active_role || payload.role, // backward compat
      tenantCode: payload.tenantCode,
      userType: payload.userType || 'tenant',
      roles: payload.roles || [],
      active_role: payload.active_role || null,
      active_company_id: payload.active_company_id || null,
      requires_context: payload.requires_context || false,
      personaKey: payload.personaKey || null
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

// ── Helpers ────────────────────────────────────────────────────────

async function logAuthEvent(eventType, email, tenantId, metadata, ipHash) {
  try {
    await masterQuery(
      `INSERT INTO auth_events (event_type, email, tenant_id, metadata, ip_hash)
       VALUES (?, ?, ?, ?, ?)`,
      [eventType, email, tenantId, JSON.stringify(metadata || {}), ipHash]
    );
  } catch (err) {
    console.error('Failed to log auth event:', err.message);
  }
}

function buildMagicLinkEmail(url, expiryMinutes) {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
      <h2 style="color: #1a1a2e; margin-bottom: 8px;">Sign in to ServiFlow</h2>
      <p style="color: #666; margin-bottom: 24px;">Click the button below to sign in. This link expires in ${expiryMinutes} minutes.</p>
      <a href="${url}" style="display: inline-block; background: #4361ee; color: #fff; padding: 12px 32px; border-radius: 6px; text-decoration: none; font-weight: 600;">Sign in to ServiFlow</a>
      <p style="color: #999; font-size: 13px; margin-top: 24px;">If you didn't request this, you can safely ignore this email.</p>
      <p style="color: #ccc; font-size: 12px; margin-top: 32px;">— The ServiFlow Team</p>
    </div>
  `;
}

module.exports = {
  resolveTenant,
  requestMagicLink,
  consumeMagicLink,
  findOrCreateUser,
  getUserContext,
  issueMultiRoleJWT,
  logAuthEvent
};
