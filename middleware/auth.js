const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { getMasterConnection, getTenantConnection } = require('../config/database');

// JWT_SECRET is required - application will fail if not set
if (!process.env.JWT_SECRET) {
  console.error('FATAL ERROR: JWT_SECRET environment variable is not set.');
  console.error('Please set JWT_SECRET in your .env file.');
  console.error('Generate a secure secret with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = '24h';

// Master user authentication
async function authenticateMasterUser(username, password) {
  try {
    const connection = await getMasterConnection();
    try {
      const [rows] = await connection.query(
        'SELECT * FROM master_users WHERE username = ? AND is_active = TRUE',
        [username]
      );

      if (rows.length === 0) {
        return { success: false, message: 'Invalid credentials' };
      }

      const user = rows[0];
      const isValidPassword = await bcrypt.compare(password, user.password_hash);

      if (!isValidPassword) {
        return { success: false, message: 'Invalid credentials' };
      }

      // Update last login
      await connection.query(
        'UPDATE master_users SET last_login = NOW() WHERE id = ?',
        [user.id]
      );

      // Generate JWT token
      const token = jwt.sign(
        {
          userId: user.id,
          username: user.username,
          role: user.role,
          userType: 'master'
        },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
      );

      return {
        success: true,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          fullName: user.full_name,
          role: user.role
        },
        token
      };
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error authenticating master user:', error);
    return { success: false, message: 'Authentication error' };
  }
}

// Tenant user authentication
async function authenticateTenantUser(tenantCode, username, password) {
  try {
    const connection = await getTenantConnection(tenantCode);
    try {
      // Join with customers table to get is_company_admin for customer users
      // Accept either username or email for login
      const [rows] = await connection.query(
        `SELECT u.*, c.is_company_admin, c.customer_company_id
         FROM users u
         LEFT JOIN customers c ON c.user_id = u.id
         WHERE (u.username = ? OR u.email = ?) AND u.is_active = TRUE`,
        [username, username]
      );

      if (rows.length === 0) {
        return { success: false, message: 'Invalid credentials' };
      }

      const user = rows[0];

      // Magic-link-only users cannot password login
      if (!user.password_hash) {
        return { success: false, message: 'Invalid credentials' };
      }

      const isValidPassword = await bcrypt.compare(password, user.password_hash);

      if (!isValidPassword) {
        return { success: false, message: 'Invalid credentials' };
      }

      // Check if user must reset password on first login
      if (user.must_reset_password) {
        // Generate a temporary token for password reset only
        const resetToken = jwt.sign(
          {
            userId: user.id,
            username: user.username,
            tenantCode: tenantCode,
            purpose: 'password_reset'
          },
          JWT_SECRET,
          { expiresIn: '15m' } // Short expiry for password reset
        );

        return {
          success: true,
          mustResetPassword: true,
          message: 'Password reset required on first login',
          user: {
            id: user.id,
            username: user.username,
            email: user.email,
            fullName: user.full_name,
            tenantCode: tenantCode,
            isCompanyAdmin: user.is_company_admin === 1
          },
          resetToken
        };
      }

      // Update last_login timestamp
      await connection.query(
        'UPDATE users SET last_login = NOW(), updated_at = NOW() WHERE id = ?',
        [user.id]
      );

      // Load multi-role data
      let roles = [];
      let companies = [];
      try {
        const [roleRows] = await connection.query(
          'SELECT role_key FROM tenant_user_roles WHERE tenant_user_id = ?',
          [user.id]
        );
        roles = roleRows.map(r => r.role_key);
      } catch (e) {
        // Table may not exist yet — fallback
      }
      // Fallback to users.role if no explicit roles
      if (roles.length === 0) {
        roles = [user.role];
      }

      try {
        const [companyRows] = await connection.query(
          `SELECT tucm.company_id as id, cc.company_name, tucm.membership_role
           FROM tenant_user_company_memberships tucm
           JOIN customer_companies cc ON cc.id = tucm.company_id
           WHERE tucm.tenant_user_id = ?`,
          [user.id]
        );
        companies = companyRows;
      } catch (e) {
        // Table may not exist yet — fallback
      }

      // Auto-resolve active role + company for simple cases
      let activeRole = null;
      let activeCompanyId = null;
      let requiresContext = false;

      if (roles.length === 1) {
        activeRole = roles[0];
        if (activeRole === 'customer' && companies.length === 1) {
          activeCompanyId = companies[0].id;
        } else if (activeRole === 'customer' && companies.length > 1) {
          requiresContext = true;
        }
      } else if (roles.length > 1) {
        requiresContext = true;
      }

      // Generate JWT token with multi-role payload
      const token = jwt.sign(
        {
          userId: user.id,
          username: user.username,
          role: activeRole || user.role, // backward compat
          tenantCode: tenantCode,
          userType: 'tenant',
          roles,
          active_role: activeRole,
          active_company_id: activeCompanyId,
          requires_context: requiresContext
        },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
      );

      return {
        success: true,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          fullName: user.full_name,
          role: activeRole || user.role,
          tenantCode: tenantCode,
          isCompanyAdmin: user.is_company_admin === 1,
          customerCompanyId: user.customer_company_id || null,
          roles,
          companies
        },
        token,
        requires_context: requiresContext
      };
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error(`Error authenticating tenant user for ${tenantCode}:`, error);
    return { success: false, message: 'Authentication error' };
  }
}

// Verify JWT token middleware
function verifyToken(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ message: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

// Master user authorization middleware
function requireMasterAuth(req, res, next) {
  if (!req.user || req.user.userType !== 'master') {
    return res.status(403).json({ message: 'Master access required' });
  }
  next();
}

// Tenant user authorization middleware
function requireTenantAuth(req, res, next) {
  if (!req.user || req.user.userType !== 'tenant') {
    return res.status(403).json({ message: 'Tenant access required' });
  }
  next();
}

// Role-based authorization middleware
function requireRole(allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Insufficient permissions' });
    }
    next();
  };
}

// Require an active role to be set (rejects tokens where requires_context is still true)
function requireActiveRole(req, res, next) {
  if (!req.user || !req.user.active_role) {
    return res.status(403).json({ message: 'Please select a role before continuing', requires_context: true });
  }
  next();
}

// Require customer users to have an active company selected
function requireCustomerCompany(req, res, next) {
  if (req.user && req.user.role === 'customer' && !req.user.active_company_id) {
    return res.status(403).json({ message: 'Please select a company before continuing', requires_context: true });
  }
  next();
}

// Hash password utility
async function hashPassword(password) {
  const saltRounds = 10;
  return await bcrypt.hash(password, saltRounds);
}

// Compare password utility
async function comparePassword(password, hash) {
  return await bcrypt.compare(password, hash);
}

module.exports = {
  authenticateMasterUser,
  authenticateTenantUser,
  verifyToken,
  requireMasterAuth,
  requireTenantAuth,
  requireRole,
  requireActiveRole,
  requireCustomerCompany,
  hashPassword,
  comparePassword,
  JWT_SECRET,
  JWT_EXPIRES_IN
};

