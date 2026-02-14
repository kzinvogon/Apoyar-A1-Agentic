const express = require('express');
const router = express.Router();
const { getTenantConnection } = require('../config/database');
const { verifyToken, requireRole, hashPassword } = require('../middleware/auth');
const { body } = require('express-validator');
const { handleValidationErrors } = require('../middleware/validation');
const {
  writeOperationsLimiter,
  readOperationsLimiter
} = require('../middleware/rateLimiter');

// Apply authentication to all routes
router.use(verifyToken);

// Validation for customer company creation
const validateCompanyCreation = [
  body('company_name')
    .trim()
    .isLength({ min: 1, max: 100 }).withMessage('Company name is required and must not exceed 100 characters'),
  body('company_domain')
    .trim()
    .isLength({ min: 3, max: 255 }).withMessage('Company domain is required')
    .matches(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?(\.[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?)*\.[a-zA-Z]{2,}$/)
    .withMessage('Invalid domain format (e.g., example.com)'),
  body('contact_phone')
    .optional()
    .trim()
    .isLength({ max: 20 }).withMessage('Phone number must not exceed 20 characters'),
  body('address')
    .optional()
    .trim()
    .isLength({ max: 500 }).withMessage('Address must not exceed 500 characters'),
  body('sla_level')
    .optional()
    .isIn(['basic', 'premium', 'enterprise']).withMessage('SLA level must be basic, premium, or enterprise'),
  body('notes')
    .optional()
    .trim()
    .isLength({ max: 1000 }).withMessage('Notes must not exceed 1000 characters'),
  handleValidationErrors
];

// Validation for customer company update
const validateCompanyUpdate = [
  body('company_name')
    .optional()
    .trim()
    .isLength({ min: 1, max: 100 }).withMessage('Company name must not exceed 100 characters'),
  body('contact_phone')
    .optional()
    .trim()
    .isLength({ max: 20 }).withMessage('Phone number must not exceed 20 characters'),
  body('address')
    .optional()
    .trim()
    .isLength({ max: 500 }).withMessage('Address must not exceed 500 characters'),
  body('sla_level')
    .optional()
    .isIn(['basic', 'premium', 'enterprise']).withMessage('SLA level must be basic, premium, or enterprise'),
  body('notes')
    .optional()
    .trim()
    .isLength({ max: 1000 }).withMessage('Notes must not exceed 1000 characters'),
  handleValidationErrors
];

// Get all customer companies (Master records)
router.get('/', requireRole(['admin', 'expert']), readOperationsLimiter, async (req, res) => {
  try {
    const { tenantCode } = req.user;
    const connection = await getTenantConnection(tenantCode);

    try {
      const [companies] = await connection.query(`
        SELECT
          cc.id,
          cc.company_name,
          cc.company_domain,
          cc.admin_user_id,
          cc.admin_email,
          cc.contact_phone,
          cc.address,
          cc.sla_level,
          cc.sla_definition_id,
          sd.name as sla_name,
          cc.is_active,
          cc.notes,
          cc.created_at,
          cc.updated_at,
          u.full_name as admin_name,
          u.username as admin_username,
          (SELECT COUNT(*) FROM customers c
           JOIN users cu ON c.user_id = cu.id
           WHERE c.customer_company_id = cc.id AND cu.is_active = TRUE AND cu.role = 'customer') as team_member_count
        FROM customer_companies cc
        LEFT JOIN users u ON cc.admin_user_id = u.id
        LEFT JOIN sla_definitions sd ON cc.sla_definition_id = sd.id
        WHERE cc.is_active = TRUE
        ORDER BY cc.company_name ASC
      `);

      res.json({ success: true, companies });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching customer companies:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get single customer company with team members
router.get('/:id', requireRole(['admin', 'expert']), readOperationsLimiter, async (req, res) => {
  try {
    const { tenantCode } = req.user;
    const { id } = req.params;
    const connection = await getTenantConnection(tenantCode);

    try {
      // Get company details
      const [companies] = await connection.query(`
        SELECT
          cc.id,
          cc.company_name,
          cc.company_domain,
          cc.admin_user_id,
          cc.admin_email,
          cc.contact_phone,
          cc.address,
          cc.sla_level,
          cc.sla_definition_id,
          sd.name as sla_name,
          cc.is_active,
          cc.notes,
          cc.created_at,
          cc.updated_at,
          u.full_name as admin_name,
          u.username as admin_username
        FROM customer_companies cc
        LEFT JOIN users u ON cc.admin_user_id = u.id
        LEFT JOIN sla_definitions sd ON cc.sla_definition_id = sd.id
        WHERE cc.id = ?
      `, [id]);

      if (companies.length === 0) {
        return res.status(404).json({ success: false, message: 'Customer company not found' });
      }

      // Get team members (only active by default)
      const [teamMembers] = await connection.query(`
        SELECT
          u.id,
          u.username,
          u.email,
          u.full_name,
          u.is_active,
          c.is_company_admin,
          c.job_title,
          c.created_at
        FROM users u
        JOIN customers c ON u.id = c.user_id
        WHERE c.customer_company_id = ? AND u.is_active = TRUE AND u.role = 'customer'
        ORDER BY c.is_company_admin DESC, u.full_name ASC
      `, [id]);

      res.json({
        success: true,
        company: companies[0],
        teamMembers
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching customer company:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Create new customer company (Master record)
// Automatically creates admin user with admin@{domain} email
router.post('/', requireRole(['admin', 'expert']), writeOperationsLimiter, validateCompanyCreation, async (req, res) => {
  try {
    const { tenantCode } = req.user;
    const {
      company_name,
      company_domain,
      contact_phone,
      address,
      sla_level,
      sla_definition_id,
      notes
    } = req.body;

    const normalizedDomain = company_domain.toLowerCase();
    const adminEmail = `admin@${normalizedDomain}`;

    const connection = await getTenantConnection(tenantCode);

    try {
      // Start transaction
      await connection.beginTransaction();

      // Check if domain already exists
      const [existing] = await connection.query(
        'SELECT id FROM customer_companies WHERE company_domain = ?',
        [normalizedDomain]
      );

      if (existing.length > 0) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: 'A company with this domain already exists'
        });
      }

      // Generate random password for the admin user
      const tempPassword = Math.random().toString(36).slice(-10);
      const passwordHash = await hashPassword(tempPassword);
      const adminUsername = `${normalizedDomain.split('.')[0]}_admin`;

      // Create admin user account
      const [userResult] = await connection.query(
        `INSERT INTO users (username, password_hash, role, email, full_name, is_active)
         VALUES (?, ?, 'customer', ?, ?, TRUE)`,
        [adminUsername, passwordHash, adminEmail, `${company_name} Admin`]
      );

      const adminUserId = userResult.insertId;

      // Create customer company
      const [companyResult] = await connection.query(
        `INSERT INTO customer_companies (company_name, company_domain, admin_user_id, admin_email, contact_phone, address, sla_level, sla_definition_id, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [company_name, normalizedDomain, adminUserId, adminEmail, contact_phone || null, address || null, sla_level || 'basic', sla_definition_id || null, notes || null]
      );

      const companyId = companyResult.insertId;

      // Create customer profile for admin (team member record)
      await connection.query(
        `INSERT INTO customers (user_id, customer_company_id, is_company_admin, company_name, company_domain, sla_level)
         VALUES (?, ?, TRUE, ?, ?, ?)`,
        [adminUserId, companyId, company_name, normalizedDomain, sla_level || 'basic']
      );

      // Commit transaction
      await connection.commit();

      // Fetch created company
      const [newCompany] = await connection.query(`
        SELECT
          cc.id,
          cc.company_name,
          cc.company_domain,
          cc.admin_user_id,
          cc.admin_email,
          cc.contact_phone,
          cc.address,
          cc.sla_level,
          cc.notes,
          cc.created_at
        FROM customer_companies cc
        WHERE cc.id = ?
      `, [companyId]);

      console.log(`Created customer company ${company_name} (${normalizedDomain}) with admin: ${adminUsername}`);

      res.status(201).json({
        success: true,
        message: 'Customer company created successfully',
        company: newCompany[0],
        admin: {
          username: adminUsername,
          email: adminEmail,
          tempPassword: tempPassword // Return temp password for admin to share (in production, send via email)
        }
      });
    } catch (error) {
      // Rollback on error
      await connection.rollback();

      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(400).json({
          success: false,
          message: 'Company domain or admin email already exists'
        });
      }
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error creating customer company:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Update customer company
router.put('/:id', requireRole(['admin', 'expert']), writeOperationsLimiter, validateCompanyUpdate, async (req, res) => {
  try {
    const { tenantCode } = req.user;
    const { id } = req.params;
    const {
      company_name,
      contact_phone,
      address,
      sla_level,
      sla_definition_id,
      notes,
      is_active
    } = req.body;

    const connection = await getTenantConnection(tenantCode);

    try {
      // Verify company exists
      const [existing] = await connection.query(
        'SELECT id FROM customer_companies WHERE id = ?',
        [id]
      );

      if (existing.length === 0) {
        return res.status(404).json({ success: false, message: 'Customer company not found' });
      }

      // Build update query dynamically
      const updates = [];
      const values = [];

      if (company_name !== undefined) {
        updates.push('company_name = ?');
        values.push(company_name);
      }
      if (contact_phone !== undefined) {
        updates.push('contact_phone = ?');
        values.push(contact_phone);
      }
      if (address !== undefined) {
        updates.push('address = ?');
        values.push(address);
      }
      if (sla_level !== undefined) {
        updates.push('sla_level = ?');
        values.push(sla_level);
      }
      if (sla_definition_id !== undefined) {
        updates.push('sla_definition_id = ?');
        values.push(sla_definition_id || null);
      }
      if (notes !== undefined) {
        updates.push('notes = ?');
        values.push(notes);
      }
      if (is_active !== undefined) {
        updates.push('is_active = ?');
        values.push(is_active);
      }

      if (updates.length === 0) {
        return res.status(400).json({ success: false, message: 'No fields to update' });
      }

      updates.push('updated_at = NOW()');
      values.push(id);

      await connection.query(
        `UPDATE customer_companies SET ${updates.join(', ')} WHERE id = ?`,
        values
      );

      // If SLA level changed, update all team members
      if (sla_level !== undefined) {
        await connection.query(
          'UPDATE customers SET sla_level = ? WHERE customer_company_id = ?',
          [sla_level, id]
        );
      }

      // If company name changed, update all team members
      if (company_name !== undefined) {
        await connection.query(
          'UPDATE customers SET company_name = ? WHERE customer_company_id = ?',
          [company_name, id]
        );
      }

      // Fetch updated company
      const [updated] = await connection.query(`
        SELECT
          cc.id,
          cc.company_name,
          cc.company_domain,
          cc.admin_user_id,
          cc.admin_email,
          cc.contact_phone,
          cc.address,
          cc.sla_level,
          cc.is_active,
          cc.notes,
          cc.created_at,
          cc.updated_at
        FROM customer_companies cc
        WHERE cc.id = ?
      `, [id]);

      res.json({
        success: true,
        message: 'Customer company updated successfully',
        company: updated[0]
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error updating customer company:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Delete customer company
// Requires all team members to be deactivated first
router.delete('/:id', requireRole(['admin']), writeOperationsLimiter, async (req, res) => {
  try {
    const { tenantCode } = req.user;
    const { id } = req.params;
    const { permanent } = req.query; // ?permanent=true for hard delete
    const connection = await getTenantConnection(tenantCode);

    try {
      // Check if company exists
      const [companies] = await connection.query(
        'SELECT id, company_name, is_active FROM customer_companies WHERE id = ?',
        [id]
      );

      if (companies.length === 0) {
        return res.status(404).json({ success: false, message: 'Customer company not found' });
      }

      const company = companies[0];

      // Check for active team members
      const [activeMembers] = await connection.query(`
        SELECT COUNT(*) as count FROM customers c
        JOIN users u ON c.user_id = u.id
        WHERE c.customer_company_id = ? AND u.is_active = TRUE
      `, [id]);

      if (activeMembers[0].count > 0) {
        return res.status(400).json({
          success: false,
          message: `Cannot delete company with ${activeMembers[0].count} active team member(s). Deactivate all team members first.`
        });
      }

      if (permanent === 'true') {
        // Hard delete - remove company and orphan customer records
        await connection.beginTransaction();

        try {
          // Remove customer records linked to this company
          await connection.query(
            'DELETE FROM customers WHERE customer_company_id = ?',
            [id]
          );

          // Delete the company
          await connection.query(
            'DELETE FROM customer_companies WHERE id = ?',
            [id]
          );

          await connection.commit();

          console.log(`Permanently deleted company: ${company.company_name} (ID: ${id})`);
          res.json({
            success: true,
            message: 'Customer company permanently deleted'
          });
        } catch (error) {
          await connection.rollback();
          throw error;
        }
      } else {
        // Soft delete - just deactivate
        await connection.query(
          'UPDATE customer_companies SET is_active = FALSE, updated_at = NOW() WHERE id = ?',
          [id]
        );

        console.log(`Deactivated company: ${company.company_name} (ID: ${id})`);
        res.json({
          success: true,
          message: 'Customer company deactivated successfully'
        });
      }
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error deleting customer company:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Add team member to company
router.post('/:id/team-members', requireRole(['admin', 'expert']), writeOperationsLimiter, async (req, res) => {
  try {
    const { tenantCode } = req.user;
    const { id } = req.params;
    const {
      username,
      email,
      full_name,
      job_title,
      is_company_admin
    } = req.body;

    const connection = await getTenantConnection(tenantCode);

    try {
      // Get company details
      const [companies] = await connection.query(
        'SELECT id, company_name, company_domain, sla_level FROM customer_companies WHERE id = ?',
        [id]
      );

      if (companies.length === 0) {
        return res.status(404).json({ success: false, message: 'Customer company not found' });
      }

      const company = companies[0];

      // Start transaction
      await connection.beginTransaction();

      // Generate random password
      const tempPassword = Math.random().toString(36).slice(-10);
      const passwordHash = await hashPassword(tempPassword);

      // Create user account
      const [userResult] = await connection.query(
        `INSERT INTO users (username, password_hash, role, email, full_name, is_active)
         VALUES (?, ?, 'customer', ?, ?, TRUE)`,
        [username, passwordHash, email, full_name || username]
      );

      const userId = userResult.insertId;

      // Create customer profile (team member)
      await connection.query(
        `INSERT INTO customers (user_id, customer_company_id, is_company_admin, job_title, company_name, company_domain, sla_level)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [userId, id, is_company_admin || false, job_title || null, company.company_name, company.company_domain, company.sla_level]
      );

      // If this is set as company admin, update the company record
      if (is_company_admin) {
        await connection.query(
          'UPDATE customer_companies SET admin_user_id = ?, admin_email = ? WHERE id = ?',
          [userId, email, id]
        );
      }

      // Commit transaction
      await connection.commit();

      console.log(`Added team member ${username} to company ${company.company_name}`);

      res.status(201).json({
        success: true,
        message: 'Team member added successfully',
        teamMember: {
          id: userId,
          username,
          email,
          full_name: full_name || username,
          job_title,
          is_company_admin: is_company_admin || false
        },
        tempPassword // Return temp password (in production, send via email)
      });
    } catch (error) {
      await connection.rollback();

      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(400).json({
          success: false,
          message: 'Username or email already exists'
        });
      }
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error adding team member:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Remove team member from company (deactivate)
router.delete('/:companyId/team-members/:userId', requireRole(['admin', 'expert']), writeOperationsLimiter, async (req, res) => {
  try {
    const { tenantCode } = req.user;
    const { companyId, userId } = req.params;
    const connection = await getTenantConnection(tenantCode);

    try {
      // Verify the user belongs to this company
      const [member] = await connection.query(`
        SELECT c.id, c.is_company_admin, cc.admin_user_id
        FROM customers c
        JOIN customer_companies cc ON c.customer_company_id = cc.id
        WHERE c.user_id = ? AND c.customer_company_id = ?
      `, [userId, companyId]);

      if (member.length === 0) {
        return res.status(404).json({ success: false, message: 'Team member not found in this company' });
      }

      // Don't allow removing the company admin
      if (member[0].admin_user_id == userId) {
        return res.status(400).json({
          success: false,
          message: 'Cannot remove the company admin. Assign a new admin first.'
        });
      }

      // Deactivate the user
      await connection.query(
        'UPDATE users SET is_active = FALSE, updated_at = NOW() WHERE id = ?',
        [userId]
      );

      res.json({
        success: true,
        message: 'Team member deactivated successfully'
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error removing team member:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Set company admin
router.put('/:companyId/admin/:userId', requireRole(['admin']), writeOperationsLimiter, async (req, res) => {
  try {
    const { tenantCode } = req.user;
    const { companyId, userId } = req.params;
    const connection = await getTenantConnection(tenantCode);

    try {
      // Verify the user belongs to this company
      const [member] = await connection.query(`
        SELECT c.id, u.email
        FROM customers c
        JOIN users u ON c.user_id = u.id
        WHERE c.user_id = ? AND c.customer_company_id = ?
      `, [userId, companyId]);

      if (member.length === 0) {
        return res.status(404).json({ success: false, message: 'User not found in this company' });
      }

      // Start transaction
      await connection.beginTransaction();

      // Remove admin flag from previous admin
      await connection.query(
        'UPDATE customers SET is_company_admin = FALSE WHERE customer_company_id = ? AND is_company_admin = TRUE',
        [companyId]
      );

      // Set new admin
      await connection.query(
        'UPDATE customers SET is_company_admin = TRUE WHERE user_id = ? AND customer_company_id = ?',
        [userId, companyId]
      );

      // Update company record
      await connection.query(
        'UPDATE customer_companies SET admin_user_id = ?, admin_email = ? WHERE id = ?',
        [userId, member[0].email, companyId]
      );

      // Commit transaction
      await connection.commit();

      res.json({
        success: true,
        message: 'Company admin updated successfully'
      });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error setting company admin:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
