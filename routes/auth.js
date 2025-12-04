const express = require('express');
const router = express.Router();
const { authenticateMasterUser, authenticateTenantUser, hashPassword, JWT_SECRET } = require('../middleware/auth');
const { getMasterConnection, getTenantConnection } = require('../config/database');
const {
  validateLogin,
  validateTenantLogin,
  validatePasswordChange,
  validateTenantPasswordChange,
  validateProfileUpdate
} = require('../middleware/validation');
const {
  loginLimiter,
  passwordChangeLimiter,
  accountEnumerationLimiter
} = require('../middleware/rateLimiter');
const crypto = require('crypto');
const { sendEmail } = require('../config/email');

// Master user login
router.post('/master/login', loginLimiter, validateLogin, async (req, res) => {
  try {
    const { username, password } = req.body;

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
router.post('/tenant/login', loginLimiter, validateTenantLogin, async (req, res) => {
  try {
    const { tenant_code, username, password } = req.body;

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
router.get('/tenants', accountEnumerationLimiter, async (req, res) => {
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
router.post('/master/change-password', passwordChangeLimiter, validatePasswordChange, async (req, res) => {
  try {
    const { username, current_password, new_password } = req.body;

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
router.post('/tenant/change-password', passwordChangeLimiter, validateTenantPasswordChange, async (req, res) => {
  try {
    const { tenant_code, username, current_password, new_password } = req.body;

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

// Get list of customers (for experts/admins)
router.get('/customers', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ success: false, message: 'Token required' });
    }

    const jwt = require('jsonwebtoken');

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      
      if (decoded.userType === 'tenant') {
        const connection = await getTenantConnection(decoded.tenantCode);
        
        try {
          const [customers] = await connection.query(
            `SELECT id, username, email, full_name, role, phone, department, created_at
             FROM users
             WHERE role = 'customer' AND is_active = TRUE
             ORDER BY full_name ASC, username ASC`
          );
          
          res.json({ success: true, customers });
        } finally {
          connection.release();
        }
      } else {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
    } catch (tokenError) {
      return res.status(401).json({ success: false, message: 'Invalid token' });
    }
  } catch (error) {
    console.error('Error fetching customers:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get user profile
router.get('/profile', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ success: false, message: 'Token required' });
    }

    const jwt = require('jsonwebtoken');

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      
      if (decoded.userType === 'tenant') {
        const connection = await getTenantConnection(decoded.tenantCode);
        try {
          const [rows] = await connection.query(
            'SELECT id, username, email, full_name, role, phone, department, created_at, updated_at FROM users WHERE id = ?',
            [decoded.userId]
          );

          if (rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
          }

          res.json({ success: true, profile: rows[0] });
        } finally {
          connection.release();
        }
      } else {
        const connection = await getMasterConnection();
        try {
          const [rows] = await connection.query(
            'SELECT id, username, email, full_name, role FROM master_users WHERE id = ?',
            [decoded.userId]
          );

          if (rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
          }

          res.json({ success: true, profile: rows[0] });
        } finally {
          connection.release();
        }
      }
    } catch (jwtError) {
      return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }
  } catch (error) {
    console.error('Error getting profile:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Update user profile
router.put('/profile', validateProfileUpdate, async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const { full_name, email, phone, department } = req.body;

    if (!token) {
      return res.status(401).json({ success: false, message: 'Token required' });
    }

    const jwt = require('jsonwebtoken');

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      
      if (decoded.userType === 'tenant') {
        const connection = await getTenantConnection(decoded.tenantCode);
        try {
          // Build update fields
          const updates = [];
          const values = [];
          
          if (full_name !== undefined) {
            updates.push('full_name = ?');
            values.push(full_name);
          }
          
          if (email !== undefined) {
            updates.push('email = ?');
            values.push(email);
          }
          
          if (phone !== undefined) {
            updates.push('phone = ?');
            values.push(phone);
          }
          
          if (department !== undefined) {
            updates.push('department = ?');
            values.push(department);
          }
          
          if (updates.length === 0) {
            return res.status(400).json({ success: false, message: 'No fields to update' });
          }
          
          updates.push('updated_at = NOW()');
          values.push(decoded.userId);
          
          await connection.query(
            `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
            values
          );

          // Get updated profile
          const [rows] = await connection.query(
            'SELECT id, username, email, full_name, role, phone, department, created_at, updated_at FROM users WHERE id = ?',
            [decoded.userId]
          );

          res.json({ success: true, message: 'Profile updated successfully', profile: rows[0] });
        } finally {
          connection.release();
        }
      } else {
        const connection = await getMasterConnection();
        try {
          const updates = [];
          const values = [];
          
          if (full_name !== undefined) {
            updates.push('full_name = ?');
            values.push(full_name);
          }
          
          if (email !== undefined) {
            updates.push('email = ?');
            values.push(email);
          }
          
          if (updates.length === 0) {
            return res.status(400).json({ success: false, message: 'No fields to update' });
          }
          
          values.push(decoded.userId);
          
          await connection.query(
            `UPDATE master_users SET ${updates.join(', ')} WHERE id = ?`,
            values
          );

          const [rows] = await connection.query(
            'SELECT id, username, email, full_name, role FROM master_users WHERE id = ?',
            [decoded.userId]
          );

          res.json({ success: true, message: 'Profile updated successfully', profile: rows[0] });
        } finally {
          connection.release();
        }
      }
    } catch (jwtError) {
      return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get list of experts (for all authenticated users)
router.get('/experts', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ success: false, message: 'Token required' });
    }

    const jwt = require('jsonwebtoken');

    try {
      const decoded = jwt.verify(token, JWT_SECRET);

      if (decoded.userType === 'tenant') {
        const connection = await getTenantConnection(decoded.tenantCode);

        try {
          const [experts] = await connection.query(
            `SELECT id, username, email, full_name, role, phone, department, created_at
             FROM users
             WHERE role IN ('admin', 'expert') AND is_active = TRUE
             ORDER BY full_name ASC, username ASC`
          );

          res.json({ success: true, experts });
        } finally {
          connection.release();
        }
      } else {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
    } catch (tokenError) {
      return res.status(401).json({ success: false, message: 'Invalid token' });
    }
  } catch (error) {
    console.error('Error fetching experts:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Request password reset (forgot password)
router.post('/tenant/forgot-password', passwordChangeLimiter, async (req, res) => {
  try {
    const { tenant_code, email } = req.body;

    if (!tenant_code || !email) {
      return res.status(400).json({ success: false, message: 'Tenant code and email are required' });
    }

    const connection = await getTenantConnection(tenant_code);

    try {
      // Find user by email
      const [users] = await connection.query(
        'SELECT id, username, email, full_name, role FROM users WHERE email = ? AND is_active = TRUE',
        [email]
      );

      // Always return success to prevent email enumeration
      if (users.length === 0) {
        return res.json({
          success: true,
          message: 'If this email exists, you will receive password reset instructions shortly.'
        });
      }

      const user = users[0];

      // Only allow for customer and expert roles
      if (!['customer', 'expert'].includes(user.role)) {
        return res.json({
          success: true,
          message: 'If this email exists, you will receive password reset instructions shortly.'
        });
      }

      // Generate reset token
      const resetToken = crypto.randomBytes(32).toString('hex');
      const resetTokenExpiry = new Date(Date.now() + 3600000); // 1 hour from now

      // Store reset token in database
      await connection.query(
        'UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE id = ?',
        [resetToken, resetTokenExpiry, user.id]
      );

      // Send reset email
      const resetLink = `http://localhost:3000/reset-password.html?token=${resetToken}&tenant=${tenant_code}`;

      try {
        await sendEmail(tenant_code, {
          to: email,
          subject: 'Password Reset Request - A1 Support',
          html: `
            <h2>Password Reset Request</h2>
            <p>Hello ${user.full_name || user.username},</p>
            <p>You requested to reset your password. Click the link below to reset it:</p>
            <p><a href="${resetLink}">Reset Password</a></p>
            <p>This link will expire in 1 hour.</p>
            <p>If you didn't request this, please ignore this email.</p>
            <br>
            <p>Best regards,<br>A1 Support Team</p>
          `
        });

        console.log(`Password reset email sent to ${email}`);
      } catch (emailError) {
        console.error('Error sending password reset email:', emailError);
        // Still return success to prevent email enumeration
      }

      res.json({
        success: true,
        message: 'If this email exists, you will receive password reset instructions shortly.'
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error in forgot password:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Reset password with token
router.post('/tenant/reset-password-with-token', passwordChangeLimiter, async (req, res) => {
  try {
    const { tenant_code, token, new_password } = req.body;

    if (!tenant_code || !token || !new_password) {
      return res.status(400).json({
        success: false,
        message: 'Tenant code, token, and new password are required'
      });
    }

    if (new_password.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 8 characters long'
      });
    }

    const connection = await getTenantConnection(tenant_code);

    try {
      // Find user by reset token
      const [users] = await connection.query(
        'SELECT id, username, email, reset_token_expiry FROM users WHERE reset_token = ? AND is_active = TRUE',
        [token]
      );

      if (users.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Invalid or expired reset token'
        });
      }

      const user = users[0];

      // Check if token is expired
      if (new Date() > new Date(user.reset_token_expiry)) {
        return res.status(400).json({
          success: false,
          message: 'Reset token has expired. Please request a new password reset.'
        });
      }

      // Hash new password
      const newPasswordHash = await hashPassword(new_password);

      // Update password and clear reset token
      await connection.query(
        'UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expiry = NULL, updated_at = NOW() WHERE id = ?',
        [newPasswordHash, user.id]
      );

      // Send confirmation email
      try {
        await sendEmail(tenant_code, {
          to: user.email,
          subject: 'Password Successfully Reset - A1 Support',
          html: `
            <h2>Password Reset Successful</h2>
            <p>Hello ${user.username},</p>
            <p>Your password has been successfully reset.</p>
            <p>If you didn't make this change, please contact support immediately.</p>
            <br>
            <p>Best regards,<br>A1 Support Team</p>
          `
        });
      } catch (emailError) {
        console.error('Error sending confirmation email:', emailError);
      }

      res.json({
        success: true,
        message: 'Password reset successfully. You can now login with your new password.'
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error resetting password with token:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;

