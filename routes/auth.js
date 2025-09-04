const express = require('express');
const router = express.Router();
const { authenticateMasterUser, authenticateTenantUser, hashPassword } = require('../middleware/auth');
const { getMasterConnection, getTenantConnection } = require('../config/database');

// Master user login
router.post('/master/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password are required' });
    }

    const result = await authenticateMasterUser(username, password);

    if (!result.success) {
      return res.status(401).json({ success: false, message: result.message });
    }

    res.json({
      success: true,
      message: 'Login successful',
      user: result.user,
      token: result.token
    });
  } catch (error) {
    console.error('Error in master login:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Tenant user login
router.post('/tenant/login', async (req, res) => {
  try {
    const { tenant_code, username, password } = req.body;

    if (!tenant_code || !username || !password) {
      return res.status(400).json({ success: false, message: 'Tenant code, username and password are required' });
    }

    const result = await authenticateTenantUser(tenant_code, username, password);

    if (!result.success) {
      return res.status(401).json({ success: false, message: result.message });
    }

    res.json({
      success: true,
      message: 'Login successful',
      user: result.user,
      token: result.token
    });
  } catch (error) {
    console.error('Error in tenant login:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get available tenants for login
router.get('/tenants', async (req, res) => {
  try {
    const connection = await getMasterConnection();
    try {
      const [rows] = await connection.query(
        'SELECT tenant_code, company_name, display_name, status FROM tenants WHERE status = "active" ORDER BY company_name'
      );
      
      res.json({ success: true, tenants: rows });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching tenants:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Change password (master user)
router.post('/master/change-password', async (req, res) => {
  try {
    const { username, current_password, new_password } = req.body;

    if (!username || !current_password || !new_password) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    if (new_password.length < 8) {
      return res.status(400).json({ success: false, message: 'New password must be at least 8 characters long' });
    }

    const connection = await getMasterConnection();
    try {
      // Verify current password
      const [rows] = await connection.query(
        'SELECT id, password_hash FROM master_users WHERE username = ? AND is_active = TRUE',
        [username]
      );

      if (rows.length === 0) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      const user = rows[0];
      const bcrypt = require('bcrypt');
      const isValidPassword = await bcrypt.compare(current_password, user.password_hash);

      if (!isValidPassword) {
        return res.status(401).json({ success: false, message: 'Current password is incorrect' });
      }

      // Hash new password and update
      const newPasswordHash = await hashPassword(new_password);
      await connection.query(
        'UPDATE master_users SET password_hash = ?, updated_at = NOW() WHERE id = ?',
        [newPasswordHash, user.id]
      );

      res.json({ success: true, message: 'Password changed successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error changing master password:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Change password (tenant user)
router.post('/tenant/change-password', async (req, res) => {
  try {
    const { tenant_code, username, current_password, new_password } = req.body;

    if (!tenant_code || !username || !current_password || !new_password) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    if (new_password.length < 8) {
      return res.status(400).json({ success: false, message: 'New password must be at least 8 characters long' });
    }

    const connection = await getTenantConnection(tenant_code);
    try {
      // Verify current password
      const [rows] = await connection.query(
        'SELECT id, password_hash FROM users WHERE username = ? AND is_active = TRUE',
        [username]
      );

      if (rows.length === 0) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      const user = rows[0];
      const bcrypt = require('bcrypt');
      const isValidPassword = await bcrypt.compare(current_password, user.password_hash);

      if (!isValidPassword) {
        return res.status(401).json({ success: false, message: 'Current password is incorrect' });
      }

      // Hash new password and update
      const newPasswordHash = await hashPassword(new_password);
      await connection.query(
        'UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?',
        [newPasswordHash, user.id]
      );

      res.json({ success: true, message: 'Password changed successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error changing tenant password:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Reset password (admin only)
router.post('/reset-password', async (req, res) => {
  try {
    const { user_type, tenant_code, username, new_password } = req.body;

    if (!user_type || !username || !new_password) {
      return res.status(400).json({ success: false, message: 'User type, username and new password are required' });
    }

    if (new_password.length < 8) {
      return res.status(400).json({ success: false, message: 'New password must be at least 8 characters long' });
    }

    const newPasswordHash = await hashPassword(new_password);

    if (user_type === 'master') {
      const connection = await getMasterConnection();
      try {
        const [result] = await connection.query(
          'UPDATE master_users SET password_hash = ?, updated_at = NOW() WHERE username = ?',
          [newPasswordHash, username]
        );

        if (result.affectedRows === 0) {
          return res.status(404).json({ success: false, message: 'Master user not found' });
        }

        res.json({ success: true, message: 'Master user password reset successfully' });
      } finally {
        connection.release();
      }
    } else if (user_type === 'tenant') {
      if (!tenant_code) {
        return res.status(400).json({ success: false, message: 'Tenant code is required for tenant users' });
      }

      const connection = await getTenantConnection(tenant_code);
      try {
        const [result] = await connection.query(
          'UPDATE users SET password_hash = ?, updated_at = NOW() WHERE username = ?',
          [newPasswordHash, username]
        );

        if (result.affectedRows === 0) {
          return res.status(404).json({ success: false, message: 'Tenant user not found' });
        }

        res.json({ success: true, message: 'Tenant user password reset successfully' });
      } finally {
        connection.release();
      }
    } else {
      return res.status(400).json({ success: false, message: 'Invalid user type' });
    }
  } catch (error) {
    console.error('Error resetting password:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Verify token validity
router.get('/verify', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ success: false, message: 'Token required' });
    }

    const jwt = require('jsonwebtoken');
    const JWT_SECRET = process.env.JWT_SECRET || 'a1-support-secret-key-2024';

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      
      // Check if user still exists and is active
      if (decoded.userType === 'master') {
        const connection = await getMasterConnection();
        try {
          const [rows] = await connection.query(
            'SELECT id, username, email, full_name, role FROM master_users WHERE id = ? AND is_active = TRUE',
            [decoded.userId]
          );

          if (rows.length === 0) {
            return res.status(401).json({ success: false, message: 'User no longer exists or is inactive' });
          }

          res.json({ success: true, user: rows[0], userType: 'master' });
        } finally {
          connection.release();
        }
      } else if (decoded.userType === 'tenant') {
        const connection = await getTenantConnection(decoded.tenantCode);
        try {
          const [rows] = await connection.query(
            'SELECT id, username, email, full_name, role FROM users WHERE id = ? AND is_active = TRUE',
            [decoded.userId]
          );

          if (rows.length === 0) {
            return res.status(401).json({ success: false, message: 'User no longer exists or is inactive' });
          }

          res.json({ 
            success: true, 
            user: { ...rows[0], tenantCode: decoded.tenantCode }, 
            userType: 'tenant' 
          });
        } finally {
          connection.release();
        }
      } else {
        return res.status(401).json({ success: false, message: 'Invalid token type' });
      }
    } catch (jwtError) {
      return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }
  } catch (error) {
    console.error('Error verifying token:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;

