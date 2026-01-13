/**
 * Company Admin Routes
 *
 * Allows company admins (is_company_admin=true) to manage users in their company.
 * Permissions: View users, invite new users, enable/disable existing users.
 * Cannot: Delete users, modify their own admin status, access other companies.
 */

const express = require('express');
const router = express.Router();
const { getTenantConnection } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { body, param, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// Apply verifyToken middleware to all routes
router.use(verifyToken);

/**
 * Middleware to verify user is a company admin
 */
async function requireCompanyAdmin(req, res, next) {
  try {
    const { tenantId } = req.params;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      // Check if the user is a company admin
      const [customers] = await connection.query(`
        SELECT c.is_company_admin, c.customer_company_id, cc.company_name
        FROM customers c
        LEFT JOIN customer_companies cc ON c.customer_company_id = cc.id
        WHERE c.user_id = ?
      `, [req.user.userId]);

      if (customers.length === 0) {
        return res.status(403).json({ success: false, message: 'Not a customer user' });
      }

      if (!customers[0].is_company_admin) {
        return res.status(403).json({ success: false, message: 'Company admin access required' });
      }

      if (!customers[0].customer_company_id) {
        return res.status(403).json({ success: false, message: 'No company assigned to user' });
      }

      // Attach company info to request for use in routes
      req.companyId = customers[0].customer_company_id;
      req.companyName = customers[0].company_name;

      next();
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error checking company admin status:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

/**
 * GET /:tenantId/my-company
 * Get company details for the logged-in user
 * Access: All customers (read-only view)
 */
router.get('/:tenantId/my-company', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      // Get user's company info
      const [results] = await connection.query(`
        SELECT
          cc.id,
          cc.company_name,
          cc.company_domain,
          cc.contact_phone,
          cc.address,
          cc.sla_definition_id,
          sd.name as sla_name,
          c.is_company_admin,
          (SELECT COUNT(*) FROM customers c2 WHERE c2.customer_company_id = cc.id) as user_count
        FROM customers c
        JOIN customer_companies cc ON c.customer_company_id = cc.id
        LEFT JOIN sla_definitions sd ON cc.sla_definition_id = sd.id
        WHERE c.user_id = ?
      `, [req.user.userId]);

      if (results.length === 0) {
        return res.status(404).json({ success: false, message: 'No company found for user' });
      }

      const company = results[0];

      res.json({
        success: true,
        company: {
          id: company.id,
          name: company.company_name,
          domain: company.company_domain,
          phone: company.contact_phone,
          address: company.address,
          sla: company.sla_name || 'Default SLA',
          userCount: company.user_count,
          isAdmin: company.is_company_admin === 1
        }
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching company details:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

/**
 * GET /:tenantId/my-company/users
 * List users in the company
 * Access: Company admins only
 */
router.get('/:tenantId/my-company/users', requireCompanyAdmin, async (req, res) => {
  try {
    const { tenantId } = req.params;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      const [users] = await connection.query(`
        SELECT
          u.id,
          u.username,
          u.email,
          u.full_name,
          u.is_active,
          c.is_company_admin,
          c.job_title,
          u.created_at,
          u.last_login
        FROM users u
        JOIN customers c ON c.user_id = u.id
        WHERE c.customer_company_id = ?
        ORDER BY c.is_company_admin DESC, u.full_name ASC
      `, [req.companyId]);

      res.json({
        success: true,
        companyName: req.companyName,
        users: users.map(u => ({
          id: u.id,
          username: u.username,
          email: u.email,
          fullName: u.full_name,
          isActive: u.is_active === 1,
          isCompanyAdmin: u.is_company_admin === 1,
          jobTitle: u.job_title,
          createdAt: u.created_at,
          lastLogin: u.last_login
        }))
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching company users:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

/**
 * POST /:tenantId/my-company/invite
 * Invite a new user to the company
 * Access: Company admins only
 */
router.post('/:tenantId/my-company/invite',
  requireCompanyAdmin,
  body('email').isEmail().withMessage('Valid email required'),
  body('fullName').optional().isString().trim(),
  body('jobTitle').optional().isString().trim(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { tenantId } = req.params;
      const { email, fullName, jobTitle } = req.body;
      const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
      const connection = await getTenantConnection(tenantCode);

      try {
        // Check if email already exists
        const [existing] = await connection.query(
          'SELECT id FROM users WHERE email = ?',
          [email]
        );

        if (existing.length > 0) {
          return res.status(409).json({ success: false, message: 'Email already registered' });
        }

        // Generate username from email
        const username = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '_');

        // Check if username exists, append number if needed
        let finalUsername = username;
        let counter = 1;
        while (true) {
          const [usernameCheck] = await connection.query(
            'SELECT id FROM users WHERE username = ?',
            [finalUsername]
          );
          if (usernameCheck.length === 0) break;
          finalUsername = `${username}${counter}`;
          counter++;
        }

        // Generate temporary password
        const tempPassword = crypto.randomBytes(8).toString('hex');
        const passwordHash = await bcrypt.hash(tempPassword, 10);

        // Create user
        const [userResult] = await connection.query(`
          INSERT INTO users (username, email, password_hash, full_name, role, is_active)
          VALUES (?, ?, ?, ?, 'customer', 1)
        `, [finalUsername, email, passwordHash, fullName || email.split('@')[0]]);

        const newUserId = userResult.insertId;

        // Create customer record linked to company
        await connection.query(`
          INSERT INTO customers (user_id, customer_company_id, is_company_admin, job_title)
          VALUES (?, ?, 0, ?)
        `, [newUserId, req.companyId, jobTitle || null]);

        // Log to audit
        try {
          await connection.query(`
            INSERT INTO audit_log (user_id, action, entity_type, entity_id, details)
            VALUES (?, 'COMPANY_USER_INVITED', 'users', ?, ?)
          `, [req.user.userId, newUserId, JSON.stringify({
            invitedBy: req.user.userId,
            companyId: req.companyId,
            email: email
          })]);
        } catch (auditErr) {
          console.error('Audit log error:', auditErr.message);
        }

        res.status(201).json({
          success: true,
          message: 'User invited successfully',
          user: {
            id: newUserId,
            username: finalUsername,
            email: email,
            fullName: fullName || email.split('@')[0],
            tempPassword: tempPassword // In production, send via email instead
          }
        });

      } finally {
        connection.release();
      }
    } catch (error) {
      console.error('Error inviting user:', error);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  }
);

/**
 * PUT /:tenantId/my-company/users/:userId/toggle
 * Enable or disable a user in the company
 * Access: Company admins only
 */
router.put('/:tenantId/my-company/users/:userId/toggle',
  requireCompanyAdmin,
  param('userId').isInt().withMessage('Valid user ID required'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { tenantId, userId } = req.params;
      const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
      const connection = await getTenantConnection(tenantCode);

      try {
        // Verify user belongs to the same company
        const [users] = await connection.query(`
          SELECT u.id, u.is_active, c.is_company_admin
          FROM users u
          JOIN customers c ON c.user_id = u.id
          WHERE u.id = ? AND c.customer_company_id = ?
        `, [userId, req.companyId]);

        if (users.length === 0) {
          return res.status(404).json({ success: false, message: 'User not found in your company' });
        }

        // Prevent disabling yourself
        if (parseInt(userId) === req.user.userId) {
          return res.status(400).json({ success: false, message: 'Cannot disable your own account' });
        }

        // Prevent disabling other company admins (optional security measure)
        if (users[0].is_company_admin === 1) {
          return res.status(400).json({ success: false, message: 'Cannot disable other company admins' });
        }

        // Toggle the status
        const newStatus = users[0].is_active === 1 ? 0 : 1;

        await connection.query(
          'UPDATE users SET is_active = ?, updated_at = NOW() WHERE id = ?',
          [newStatus, userId]
        );

        // Log to audit
        try {
          await connection.query(`
            INSERT INTO audit_log (user_id, action, entity_type, entity_id, details)
            VALUES (?, ?, 'users', ?, ?)
          `, [
            req.user.userId,
            newStatus === 1 ? 'COMPANY_USER_ENABLED' : 'COMPANY_USER_DISABLED',
            userId,
            JSON.stringify({ companyId: req.companyId, newStatus })
          ]);
        } catch (auditErr) {
          console.error('Audit log error:', auditErr.message);
        }

        res.json({
          success: true,
          message: `User ${newStatus === 1 ? 'enabled' : 'disabled'} successfully`,
          userId: parseInt(userId),
          isActive: newStatus === 1
        });

      } finally {
        connection.release();
      }
    } catch (error) {
      console.error('Error toggling user status:', error);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  }
);

module.exports = router;
