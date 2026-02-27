const express = require('express');
const router = express.Router();
const { authenticateMasterUser, authenticateTenantUser, hashPassword, comparePassword, verifyToken, generateElevatedToken, JWT_SECRET } = require('../middleware/auth');
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
const { sendEmail, getTenantDisplayName } = require('../config/email');
const { logAudit, AUDIT_ACTIONS } = require('../utils/auditLog');

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
      logAudit({ tenantCode: tenant_code, user: { username }, action: AUDIT_ACTIONS.LOGIN_FAILED, entityType: 'AUTH', req }).catch(() => {});
      return res.status(401).json({ success: false, message: result.message });
    }

    // Check if user must reset password on first login
    if (result.mustResetPassword) {
      return res.json({
        success: true,
        mustResetPassword: true,
        message: result.message,
        user: result.user,
        resetToken: result.resetToken
      });
    }

    logAudit({ tenantCode: tenant_code, user: { userId: result.user.id, username }, action: AUDIT_ACTIONS.LOGIN, entityType: 'AUTH', req }).catch(() => {});

    res.json({
      success: true,
      message: 'Login successful',
      user: result.user,
      token: result.token,
      requires_context: result.requires_context || false
    });
  } catch (error) {
    console.error('Error in tenant login:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// First-time password reset (for accounts requiring password change on first login)
router.post('/tenant/first-login-password-reset', passwordChangeLimiter, async (req, res) => {
  try {
    const { reset_token, new_password } = req.body;

    if (!reset_token || !new_password) {
      return res.status(400).json({
        success: false,
        message: 'Reset token and new password are required'
      });
    }

    if (new_password.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 8 characters long'
      });
    }

    // Verify the reset token
    const jwt = require('jsonwebtoken');
    let decoded;
    try {
      decoded = jwt.verify(reset_token, JWT_SECRET);
    } catch (tokenError) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired reset token. Please login again.'
      });
    }

    // Ensure this is a password reset token
    if (decoded.purpose !== 'password_reset') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token type'
      });
    }

    const connection = await getTenantConnection(decoded.tenantCode);

    try {
      // Verify user still needs password reset
      const [users] = await connection.query(
        'SELECT id, must_reset_password FROM users WHERE id = ? AND is_active = TRUE',
        [decoded.userId]
      );

      if (users.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      if (!users[0].must_reset_password) {
        return res.status(400).json({
          success: false,
          message: 'Password reset not required. Please login normally.'
        });
      }

      // Hash and update password, clear must_reset_password flag
      const newPasswordHash = await hashPassword(new_password);
      await connection.query(
        'UPDATE users SET password_hash = ?, must_reset_password = FALSE, updated_at = NOW() WHERE id = ?',
        [newPasswordHash, decoded.userId]
      );

      // Log the password change
      await connection.query(
        'INSERT INTO tenant_audit_log (user_id, action, details) VALUES (?, ?, ?)',
        [decoded.userId, 'first_login_password_reset', JSON.stringify({ message: 'User completed first-time password reset' })]
      );

      res.json({
        success: true,
        message: 'Password reset successfully. You can now login with your new password.'
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error in first-login password reset:', error);
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

      logAudit({ tenantCode: tenant_code, user: { userId: user.id, username }, action: AUDIT_ACTIONS.PASSWORD_CHANGE, entityType: 'AUTH', req }).catch(() => {});
      res.json({ success: true, message: 'Password changed successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error changing tenant password:', error);
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
          // Only return users who are linked to a customer company (real customers)
          const [customers] = await connection.query(
            `SELECT u.id, u.username, u.email, u.full_name, u.role, u.phone, u.department, u.created_at,
                    cc.company_name as company
             FROM users u
             INNER JOIN customers c ON c.user_id = u.id
             LEFT JOIN customer_companies cc ON c.customer_company_id = cc.id
             WHERE u.role = 'customer' AND u.is_active = TRUE
             ORDER BY u.full_name ASC, u.username ASC`
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
router.get('/profile', verifyToken, async (req, res) => {
  try {
    if (req.user.userType === 'tenant') {
      const connection = await getTenantConnection(req.user.tenantCode);
      try {
        // Try full query first, fall back to basic query if columns missing
        let rows;
        try {
          [rows] = await connection.query(
            'SELECT id, username, email, full_name, role, phone, department, receive_email_updates, created_at, updated_at FROM users WHERE id = ?',
            [req.user.userId]
          );
        } catch (queryErr) {
          // Fall back to basic query if some columns don't exist
          console.warn('Profile full query failed, trying basic query:', queryErr.message);
          [rows] = await connection.query(
            'SELECT id, username, email, full_name, role, created_at, updated_at FROM users WHERE id = ?',
            [req.user.userId]
          );
          // Add default values for missing fields
          if (rows.length > 0) {
            rows[0].phone = rows[0].phone || '';
            rows[0].department = rows[0].department || '';
            rows[0].receive_email_updates = rows[0].receive_email_updates ?? 1;
          }
        }

        if (rows.length === 0) {
          return res.status(404).json({ success: false, message: 'User not found' });
        }

        // For customer users, include company name
        if (rows[0].role === 'customer') {
          try {
            const [custRows] = await connection.query(
              `SELECT c.company_name, cc.name as company_company_name
               FROM customers c
               LEFT JOIN customer_companies cc ON c.customer_company_id = cc.id
               WHERE c.user_id = ?`,
              [req.user.userId]
            );
            if (custRows.length > 0) {
              rows[0].customer_name = custRows[0].company_company_name || custRows[0].company_name || '';
            }
          } catch (e) {
            // customers table may not exist on older tenants
          }
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
          [req.user.userId]
        );

        if (rows.length === 0) {
          return res.status(404).json({ success: false, message: 'User not found' });
        }

        res.json({ success: true, profile: rows[0] });
      } finally {
        connection.release();
      }
    }
  } catch (error) {
    console.error('Error getting profile:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Update user profile
router.put('/profile', verifyToken, validateProfileUpdate, async (req, res) => {
  try {
    const { full_name, email, phone, department, receive_email_updates } = req.body;

    if (req.user.userType === 'tenant') {
      const connection = await getTenantConnection(req.user.tenantCode);
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

        // Handle receive_email_updates preference (coerce to 0/1)
        if (receive_email_updates !== undefined) {
          updates.push('receive_email_updates = ?');
          values.push(receive_email_updates ? 1 : 0);
        }

        if (updates.length === 0) {
          return res.status(400).json({ success: false, message: 'No fields to update' });
        }

        updates.push('updated_at = NOW()');
        values.push(req.user.userId);

        await connection.query(
          `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
          values
        );

        // Get updated profile
        const [rows] = await connection.query(
          'SELECT id, username, email, full_name, role, phone, department, receive_email_updates, created_at, updated_at FROM users WHERE id = ?',
          [req.user.userId]
        );

        // Log preference change to audit (best-effort, don't block save)
        if (receive_email_updates !== undefined) {
          try {
            await connection.query(`
              INSERT INTO audit_log (user_id, action, entity_type, entity_id, details)
              VALUES (?, 'EMAIL_PREFERENCE_CHANGED', 'users', ?, ?)
            `, [req.user.userId, req.user.userId, JSON.stringify({ receive_email_updates: receive_email_updates ? 1 : 0 })]);
          } catch (auditErr) {
            console.error('Could not log email preference change:', auditErr.message);
          }
        }

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

        values.push(req.user.userId);

        await connection.query(
          `UPDATE master_users SET ${updates.join(', ')} WHERE id = ?`,
          values
        );

        const [rows] = await connection.query(
          'SELECT id, username, email, full_name, role FROM master_users WHERE id = ?',
          [req.user.userId]
        );

        res.json({ success: true, message: 'Profile updated successfully', profile: rows[0] });
      } finally {
        connection.release();
      }
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

    // Validate tenant code format and get connection
    let connection;
    try {
      connection = await getTenantConnection(tenant_code);
    } catch (tenantError) {
      console.error('Invalid tenant code in forgot-password:', tenant_code, tenantError.message);
      // Return generic success to prevent tenant enumeration
      return res.json({
        success: true,
        message: 'If this email exists, you will receive password reset instructions shortly.'
      });
    }

    try {
      // Find user by email
      const [users] = await connection.query(
        'SELECT id, username, email, full_name, role, email_notifications_enabled FROM users WHERE email = ? AND is_active = TRUE',
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

      // Check if email notifications are enabled for this user
      if (user.email_notifications_enabled === 0) {
        console.log(`Password reset blocked for ${email} - email notifications disabled`);
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
      const baseUrl = process.env.BASE_URL || 'https://app.serviflow.app';
      const resetLink = `${baseUrl}/reset-password.html?token=${resetToken}&tenant=${tenant_code}`;

      try {
        // Determine email type based on user role (customers vs experts)
        const emailType = user.role === 'customer' ? 'customers' : 'experts';
        const tenantDisplayName = await getTenantDisplayName(tenant_code);

        await sendEmail(tenant_code, {
          to: email,
          subject: `Password Reset Request - ${tenantDisplayName} ServiFlow Support`,
          html: `
            <h2>Password Reset Request</h2>
            <p>Hello ${user.full_name || user.username},</p>
            <p>You requested to reset your password. Click the link below to reset it:</p>
            <p><a href="${resetLink}">Reset Password</a></p>
            <p>This link will expire in 1 hour.</p>
            <p>If you didn't request this, please ignore this email.</p>
            <br>
            <p>Best regards,<br>${tenantDisplayName} ServiFlow Support Team</p>
          `,
          emailType: emailType,
          skipUserCheck: true, // User explicitly requested password reset
          skipKillSwitch: true // Security-critical: password reset must always work
        });

        console.log(`Password reset email sent to ${email} (type: ${emailType})`);
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

    // Validate tenant code and get connection
    let connection;
    try {
      connection = await getTenantConnection(tenant_code);
    } catch (tenantError) {
      console.error('Invalid tenant code in reset-password-with-token:', tenant_code, tenantError.message);
      return res.status(400).json({
        success: false,
        message: 'Invalid tenant code'
      });
    }

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
        const tenantDisplayName = await getTenantDisplayName(tenant_code);
        await sendEmail(tenant_code, {
          to: user.email,
          subject: `Password Successfully Reset - ${tenantDisplayName} ServiFlow Support`,
          html: `
            <h2>Password Reset Successful</h2>
            <p>Hello ${user.username},</p>
            <p>Your password has been successfully reset.</p>
            <p>If you didn't make this change, please contact support immediately.</p>
            <br>
            <p>Best regards,<br>${tenantDisplayName} ServiFlow Support Team</p>
          `,
          skipKillSwitch: true // Security-critical: confirmation must always be sent
        });
      } catch (emailError) {
        console.error('Error sending confirmation email:', emailError);
      }

      res.json({
        success: true,
        message: 'Password reset successfully. You can now login with your new password.',
        username: user.username
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error resetting password with token:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Master user forgot password request
router.post('/master/forgot-password', passwordChangeLimiter, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }

    const connection = await getMasterConnection();

    try {
      // Find master user by email
      const [users] = await connection.query(
        'SELECT id, username, email, full_name FROM master_users WHERE email = ? AND is_active = TRUE',
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

      // Generate reset token
      const resetToken = crypto.randomBytes(32).toString('hex');
      const resetTokenExpiry = new Date(Date.now() + 3600000); // 1 hour from now

      // Store reset token in database
      await connection.query(
        'UPDATE master_users SET reset_token = ?, reset_token_expiry = ? WHERE id = ?',
        [resetToken, resetTokenExpiry, user.id]
      );

      // Send reset email
      const baseUrl = process.env.BASE_URL || 'https://app.serviflow.app';
      const resetLink = `${baseUrl}/reset-password.html?token=${resetToken}&type=master`;

      try {
        // Use nodemailer directly for master users (no tenant context)
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: {
            user: process.env.SMTP_EMAIL,
            pass: process.env.SMTP_PASSWORD
          }
        });

        await transporter.sendMail({
          from: process.env.SMTP_EMAIL,
          to: email,
          subject: 'Password Reset Request - ServiFlow Admin',
          html: `
            <h2>Password Reset Request</h2>
            <p>Hello ${user.full_name || user.username},</p>
            <p>You requested to reset your master admin password. Click the link below to reset it:</p>
            <p><a href="${resetLink}">Reset Password</a></p>
            <p>This link will expire in 1 hour.</p>
            <p>If you didn't request this, please ignore this email.</p>
            <br>
            <p>Best regards,<br>ServiFlow Team</p>
          `
        });

        console.log(`Master password reset email sent to ${email}`);
      } catch (emailError) {
        console.error('Error sending master password reset email:', emailError);
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
    console.error('Error in master forgot password:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Master user reset password with token
router.post('/master/reset-password-with-token', passwordChangeLimiter, async (req, res) => {
  try {
    const { token, new_password } = req.body;

    if (!token || !new_password) {
      return res.status(400).json({
        success: false,
        message: 'Token and new password are required'
      });
    }

    if (new_password.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 8 characters long'
      });
    }

    const connection = await getMasterConnection();

    try {
      // Find user by reset token
      const [users] = await connection.query(
        'SELECT id, username, email, reset_token_expiry FROM master_users WHERE reset_token = ? AND is_active = TRUE',
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
        'UPDATE master_users SET password_hash = ?, reset_token = NULL, reset_token_expiry = NULL, updated_at = NOW() WHERE id = ?',
        [newPasswordHash, user.id]
      );

      // Send confirmation email
      try {
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: {
            user: process.env.SMTP_EMAIL,
            pass: process.env.SMTP_PASSWORD
          }
        });

        await transporter.sendMail({
          from: process.env.SMTP_EMAIL,
          to: user.email,
          subject: 'Password Successfully Reset - ServiFlow Admin',
          html: `
            <h2>Password Reset Successful</h2>
            <p>Hello ${user.username},</p>
            <p>Your master admin password has been successfully reset.</p>
            <p>If you didn't make this change, please contact support immediately.</p>
            <br>
            <p>Best regards,<br>ServiFlow Team</p>
          `
        });
      } catch (emailError) {
        console.error('Error sending confirmation email:', emailError);
      }

      res.json({
        success: true,
        message: 'Password reset successfully. You can now login with your new password.',
        username: user.username
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error resetting master password with token:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// =============================================
// Expert Invitation Acceptance (Public Routes)
// =============================================

// Validate invitation token (public - no auth required)
router.get('/invitation/validate', async (req, res) => {
  try {
    const { token, tenant } = req.query;

    if (!token || !tenant) {
      return res.status(400).json({
        success: false,
        message: 'Token and tenant are required'
      });
    }

    const connection = await getTenantConnection(tenant);

    try {
      const [users] = await connection.query(
        `SELECT id, email, full_name, invitation_expires
         FROM users
         WHERE invitation_token = ? AND role IN ('admin', 'expert')`,
        [token]
      );

      if (users.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Invalid or expired invitation token'
        });
      }

      const user = users[0];

      // Check if token is expired
      if (new Date(user.invitation_expires) < new Date()) {
        return res.status(410).json({
          success: false,
          message: 'This invitation has expired. Please request a new invitation.'
        });
      }

      // Get tenant name
      let tenantName = tenant;
      let masterConn;
      try {
        masterConn = await getMasterConnection();
        const [tenantInfo] = await masterConn.query(
          'SELECT company_name FROM tenants WHERE tenant_code = ?',
          [tenant]
        );
        if (tenantInfo.length > 0) tenantName = tenantInfo[0].company_name;
      } catch (e) {
        // Tenant lookup is optional - continue with default name
      } finally {
        if (masterConn) masterConn.release();
      }

      res.json({
        success: true,
        invitation: {
          email: user.email,
          fullName: user.full_name,
          tenantCode: tenant,
          tenantName: tenantName
        }
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error validating invitation:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Accept invitation and set password (public - no auth required)
router.post('/invitation/accept', async (req, res) => {
  try {
    const { token, tenant, password } = req.body;

    if (!token || !tenant || !password) {
      return res.status(400).json({
        success: false,
        message: 'Token, tenant, and password are required'
      });
    }

    // Validate password strength
    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters long'
      });
    }

    const connection = await getTenantConnection(tenant);

    try {
      const [users] = await connection.query(
        `SELECT id, email, full_name, invitation_expires, is_active
         FROM users
         WHERE invitation_token = ? AND role IN ('admin', 'expert')`,
        [token]
      );

      if (users.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Invalid invitation token'
        });
      }

      const user = users[0];

      // Check if already accepted
      if (user.is_active) {
        return res.status(400).json({
          success: false,
          message: 'This invitation has already been accepted. Please log in.'
        });
      }

      // Check if token is expired
      if (new Date(user.invitation_expires) < new Date()) {
        return res.status(410).json({
          success: false,
          message: 'This invitation has expired. Please request a new invitation.'
        });
      }

      // Hash the new password
      const passwordHash = await hashPassword(password);

      // Update user: set password, activate, clear invitation token
      await connection.query(
        `UPDATE users
         SET password_hash = ?,
             is_active = TRUE,
             invitation_token = NULL,
             invitation_expires = NULL,
             invitation_accepted_at = NOW()
         WHERE id = ?`,
        [passwordHash, user.id]
      );

      console.log(`✅ Expert ${user.email} accepted invitation for tenant ${tenant}`);

      res.json({
        success: true,
        message: 'Account activated successfully! You can now log in.',
        user: {
          email: user.email,
          fullName: user.full_name
        }
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error accepting invitation:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Re-authentication for sensitive operations (e.g., Raw Variables)
router.post('/:tenantCode/reauth', verifyToken, async (req, res) => {
  const { tenantCode } = req.params;
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ success: false, error: 'Password is required' });
  }

  let connection;
  try {
    connection = await getTenantConnection(tenantCode);

    // Get user from JWT
    const userId = req.user.userId;
    const [users] = await connection.query(
      'SELECT id, password_hash, role FROM users WHERE id = ? AND deleted_at IS NULL',
      [userId]
    );

    if (users.length === 0) {
      return res.status(401).json({ success: false, error: 'User not found' });
    }

    const user = users[0];

    // Verify password
    const isValid = await comparePassword(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ success: false, error: 'Invalid password' });
    }

    // Return success with 10-minute window
    const reauthUntil = Date.now() + (10 * 60 * 1000);

    // If admin, generate an elevated token (30-min JWT with is_elevated_admin)
    let elevated_token = undefined;
    if (user.role === 'admin') {
      elevated_token = generateElevatedToken(req.user);
    }

    res.json({ success: true, reauth_until: reauthUntil, elevated_token });

  } catch (error) {
    console.error('[Reauth] Error:', error.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  } finally {
    if (connection) connection.release();
  }
});

// Admin password reset endpoint (admin only)
router.post('/admin/reset-password/:tenantCode', verifyToken, async (req, res) => {
  try {
    const { tenantCode } = req.params;
    const { username, newPassword } = req.body;

    // Verify requester is admin
    if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    if (!username || !newPassword) {
      return res.status(400).json({ success: false, message: 'Username and newPassword are required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }

    const connection = await getTenantConnection(tenantCode);
    try {
      // Check if user exists
      const [users] = await connection.query(
        'SELECT id, username, email FROM users WHERE username = ?',
        [username]
      );

      if (users.length === 0) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      // Hash and update password
      const newPasswordHash = await hashPassword(newPassword);
      await connection.query(
        'UPDATE users SET password_hash = ?, updated_at = NOW() WHERE username = ?',
        [newPasswordHash, username]
      );

      // Log to audit
      try {
        await connection.query(`
          INSERT INTO audit_log (user_id, action, entity_type, entity_id, details)
          VALUES (?, 'ADMIN_PASSWORD_RESET', 'users', ?, ?)
        `, [req.user.userId, users[0].id, JSON.stringify({
          resetBy: req.user.username,
          targetUser: username
        })]);
      } catch (auditErr) {
        console.error('Audit log error:', auditErr.message);
      }

      res.json({
        success: true,
        message: `Password reset for ${username}`,
        user: { id: users[0].id, username: users[0].username, email: users[0].email }
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error in admin password reset:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;

