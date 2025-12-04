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
      const [rows] = await connection.query(
        'SELECT * FROM users WHERE username = ? AND is_active = TRUE',
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

      // Note: last_login column doesn't exist in users table
      // Update timestamp to track last activity
      await connection.query(
        'UPDATE users SET updated_at = NOW() WHERE id = ?',
        [user.id]
      );

      // Generate JWT token
      const token = jwt.sign(
        {
          userId: user.id,
          username: user.username,
          role: user.role,
          tenantCode: tenantCode,
          userType: 'tenant'
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
          role: user.role,
          tenantCode: tenantCode
        },
        token
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
  hashPassword,
  comparePassword,
  JWT_SECRET,
  JWT_EXPIRES_IN
};

