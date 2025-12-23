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

// Validation for customer creation
const validateCustomerCreation = [
  body('username')
    .trim()
    .isLength({ min: 3, max: 50 }).withMessage('Username must be between 3 and 50 characters')
    .matches(/^[a-zA-Z0-9_]+$/).withMessage('Username can only contain letters, numbers, and underscores'),
  body('email')
    .trim()
    .isEmail().withMessage('Valid email is required')
    .normalizeEmail(),
  body('full_name')
    .optional()
    .trim()
    .isLength({ max: 100 }).withMessage('Full name must not exceed 100 characters'),
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
  handleValidationErrors
];

// Validation for customer update
const validateCustomerUpdate = [
  body('email')
    .optional()
    .trim()
    .isEmail().withMessage('Valid email is required')
    .normalizeEmail(),
  body('full_name')
    .optional()
    .trim()
    .isLength({ max: 100 }).withMessage('Full name must not exceed 100 characters'),
  body('company_name')
    .optional()
    .trim()
    .isLength({ min: 1, max: 100 }).withMessage('Company name must not exceed 100 characters'),
  body('company_domain')
    .optional()
    .trim()
    .isLength({ min: 3, max: 255 }).withMessage('Company domain must be at least 3 characters')
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
  handleValidationErrors
];

// Get all customers (for admin/expert)
router.get('/', requireRole(['admin', 'expert']), readOperationsLimiter, async (req, res) => {
  try {
    const { tenantCode } = req.user;
    const { company_id } = req.query; // Optional filter by company
    const connection = await getTenantConnection(tenantCode);

    try {
      let query = `
        SELECT
          u.id, u.username, u.email, u.full_name, u.role, u.is_active,
          u.email_notifications_enabled,
          c.id as customer_id, c.company_name,
          c.contact_phone, c.address, c.sla_level,
          c.customer_company_id, c.is_company_admin, c.job_title,
          c.created_at, c.updated_at,
          cc.company_name as master_company_name,
          cc.company_domain as company_domain,
          (SELECT COUNT(*) FROM tickets t WHERE t.requester_id = u.id AND LOWER(t.status) != 'closed') as open_ticket_count
        FROM users u
        LEFT JOIN customers c ON u.id = c.user_id
        LEFT JOIN customer_companies cc ON c.customer_company_id = cc.id
        WHERE u.role = 'customer'
      `;

      const params = [];
      if (company_id) {
        query += ' AND c.customer_company_id = ?';
        params.push(company_id);
      }

      query += ' ORDER BY cc.company_name ASC, c.is_company_admin DESC, u.full_name ASC, u.username ASC';

      const [customers] = await connection.query(query, params);

      res.json({ success: true, customers });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching customers:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get single customer by ID
router.get('/:id', requireRole(['admin', 'expert']), readOperationsLimiter, async (req, res) => {
  try {
    const { tenantCode } = req.user;
    const { id } = req.params;
    const connection = await getTenantConnection(tenantCode);

    try {
      const [customers] = await connection.query(`
        SELECT
          u.id, u.username, u.email, u.full_name, u.role, u.is_active,
          u.email_notifications_enabled,
          c.id as customer_id, c.company_name,
          c.contact_phone, c.address, c.sla_level,
          c.customer_company_id, c.is_company_admin, c.job_title,
          c.created_at, c.updated_at,
          cc.company_name as master_company_name,
          cc.company_domain as company_domain,
          cc.admin_email as company_admin_email
        FROM users u
        LEFT JOIN customers c ON u.id = c.user_id
        LEFT JOIN customer_companies cc ON c.customer_company_id = cc.id
        WHERE u.id = ? AND u.role = 'customer'
      `, [id]);

      if (customers.length === 0) {
        return res.status(404).json({ success: false, message: 'Customer not found' });
      }

      res.json({ success: true, customer: customers[0] });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching customer:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Create new customer (team member)
// If company_domain matches existing customer_company, links to it
// If not, creates a new customer_company
router.post('/', requireRole(['admin', 'expert']), writeOperationsLimiter, validateCustomerCreation, async (req, res) => {
  try {
    const { tenantCode } = req.user;
    const {
      username,
      email,
      full_name,
      company_name,
      company_domain,
      contact_phone,
      address,
      sla_level,
      job_title,
      customer_company_id // Optional: directly specify company ID
    } = req.body;

    const normalizedDomain = company_domain.toLowerCase();
    const connection = await getTenantConnection(tenantCode);

    try {
      // Start transaction
      await connection.beginTransaction();

      let companyId = customer_company_id;
      let companyData = null;

      // If company_id not provided, look up or create by domain
      if (!companyId) {
        const [existingCompany] = await connection.query(
          'SELECT id, company_name, sla_level FROM customer_companies WHERE company_domain = ?',
          [normalizedDomain]
        );

        if (existingCompany.length > 0) {
          companyId = existingCompany[0].id;
          companyData = existingCompany[0];
        } else {
          // Create new customer company
          const adminEmail = `admin@${normalizedDomain}`;
          const [companyResult] = await connection.query(
            `INSERT INTO customer_companies (company_name, company_domain, admin_email, contact_phone, address, sla_level)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [company_name, normalizedDomain, adminEmail, contact_phone || null, address || null, sla_level || 'basic']
          );
          companyId = companyResult.insertId;
          companyData = { id: companyId, company_name, sla_level: sla_level || 'basic' };
          console.log(`Created new customer company: ${company_name} (${normalizedDomain})`);
        }
      } else {
        // Verify company exists
        const [company] = await connection.query(
          'SELECT id, company_name, company_domain, sla_level FROM customer_companies WHERE id = ?',
          [companyId]
        );
        if (company.length === 0) {
          await connection.rollback();
          return res.status(400).json({ success: false, message: 'Customer company not found' });
        }
        companyData = company[0];
      }

      // Generate random password for the customer
      const tempPassword = Math.random().toString(36).slice(-10);
      const passwordHash = await hashPassword(tempPassword);

      // Create user account
      const [userResult] = await connection.query(
        `INSERT INTO users (username, password_hash, role, email, full_name, is_active)
         VALUES (?, ?, 'customer', ?, ?, TRUE)`,
        [username, passwordHash, email, full_name || username]
      );

      const userId = userResult.insertId;

      // Create customer profile linked to company
      await connection.query(
        `INSERT INTO customers (user_id, customer_company_id, company_name, company_domain, contact_phone, address, sla_level, job_title)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, companyId, companyData.company_name || company_name, normalizedDomain, contact_phone || null, address || null, companyData.sla_level || sla_level || 'basic', job_title || null]
      );

      // Commit transaction
      await connection.commit();

      // Fetch created customer
      const [newCustomer] = await connection.query(`
        SELECT
          u.id, u.username, u.email, u.full_name, u.role,
          c.id as customer_id, c.company_name, c.company_domain,
          c.contact_phone, c.address, c.sla_level,
          c.customer_company_id, c.is_company_admin, c.job_title,
          cc.company_name as master_company_name
        FROM users u
        LEFT JOIN customers c ON u.id = c.user_id
        LEFT JOIN customer_companies cc ON c.customer_company_id = cc.id
        WHERE u.id = ?
      `, [userId]);

      console.log(`Created customer ${username} for company ${companyData.company_name || company_name} with temp password: ${tempPassword}`);

      res.status(201).json({
        success: true,
        message: 'Customer created successfully',
        customer: newCustomer[0],
        tempPassword: tempPassword // Return temp password for admin to share (in production, send via email)
      });
    } catch (error) {
      // Rollback on error
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
    console.error('Error creating customer:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Update customer
router.put('/:id', requireRole(['admin', 'expert']), writeOperationsLimiter, validateCustomerUpdate, async (req, res) => {
  try {
    const { tenantCode } = req.user;
    const { id } = req.params;
    const {
      email,
      full_name,
      company_name,
      company_domain,
      contact_phone,
      address,
      sla_level,
      email_notifications_enabled
    } = req.body;

    const connection = await getTenantConnection(tenantCode);

    try {
      // Verify customer exists
      const [existing] = await connection.query(
        'SELECT u.id, c.id as customer_id FROM users u LEFT JOIN customers c ON u.id = c.user_id WHERE u.id = ? AND u.role = "customer"',
        [id]
      );

      if (existing.length === 0) {
        return res.status(404).json({ success: false, message: 'Customer not found' });
      }

      // Start transaction
      await connection.beginTransaction();

      // Update user table
      const userUpdates = [];
      const userValues = [];

      if (email !== undefined) {
        userUpdates.push('email = ?');
        userValues.push(email);
      }
      if (full_name !== undefined) {
        userUpdates.push('full_name = ?');
        userValues.push(full_name);
      }
      if (email_notifications_enabled !== undefined) {
        userUpdates.push('email_notifications_enabled = ?');
        userValues.push(email_notifications_enabled ? 1 : 0);
      }

      if (userUpdates.length > 0) {
        userUpdates.push('updated_at = NOW()');
        userValues.push(id);
        await connection.query(
          `UPDATE users SET ${userUpdates.join(', ')} WHERE id = ?`,
          userValues
        );
      }

      // Update or create customers table entry
      const customerUpdates = [];
      const customerValues = [];

      if (company_name !== undefined) {
        customerUpdates.push('company_name = ?');
        customerValues.push(company_name);
      }
      if (company_domain !== undefined) {
        customerUpdates.push('company_domain = ?');
        customerValues.push(company_domain.toLowerCase());
      }
      if (contact_phone !== undefined) {
        customerUpdates.push('contact_phone = ?');
        customerValues.push(contact_phone);
      }
      if (address !== undefined) {
        customerUpdates.push('address = ?');
        customerValues.push(address);
      }
      if (sla_level !== undefined) {
        customerUpdates.push('sla_level = ?');
        customerValues.push(sla_level);
      }

      if (customerUpdates.length > 0) {
        if (existing[0].customer_id) {
          // Customer profile exists - update it
          customerUpdates.push('updated_at = NOW()');
          customerValues.push(id);
          await connection.query(
            `UPDATE customers SET ${customerUpdates.join(', ')} WHERE user_id = ?`,
            customerValues
          );
        } else {
          // Customer profile doesn't exist - create it
          await connection.query(
            `INSERT INTO customers (user_id, company_name, company_domain, contact_phone, address, sla_level)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              id,
              company_name || null,
              company_domain ? company_domain.toLowerCase() : null,
              contact_phone || null,
              address || null,
              sla_level || 'basic'
            ]
          );
        }
      }

      // Commit transaction
      await connection.commit();

      // Fetch updated customer
      const [updated] = await connection.query(`
        SELECT
          u.id, u.username, u.email, u.full_name, u.role,
          c.id as customer_id, c.company_name, c.company_domain,
          c.contact_phone, c.address, c.sla_level
        FROM users u
        LEFT JOIN customers c ON u.id = c.user_id
        WHERE u.id = ?
      `, [id]);

      res.json({
        success: true,
        message: 'Customer updated successfully',
        customer: updated[0]
      });
    } catch (error) {
      // Rollback on error
      await connection.rollback();

      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(400).json({
          success: false,
          message: 'Email already exists'
        });
      }
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error updating customer:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Toggle email notifications for a customer
router.patch('/:id/email-notifications', requireRole(['admin', 'expert']), writeOperationsLimiter, async (req, res) => {
  try {
    const { tenantCode } = req.user;
    const { id } = req.params;
    const { enabled } = req.body;

    if (enabled === undefined) {
      return res.status(400).json({ success: false, message: 'enabled field is required' });
    }

    const connection = await getTenantConnection(tenantCode);

    try {
      // Verify customer exists
      const [existing] = await connection.query(
        'SELECT id, email, full_name, email_notifications_enabled FROM users WHERE id = ? AND role = "customer"',
        [id]
      );

      if (existing.length === 0) {
        return res.status(404).json({ success: false, message: 'Customer not found' });
      }

      // Update the setting
      await connection.query(
        'UPDATE users SET email_notifications_enabled = ?, updated_at = NOW() WHERE id = ?',
        [enabled ? 1 : 0, id]
      );

      const status = enabled ? 'enabled' : 'disabled';
      console.log(`Email notifications ${status} for customer ${existing[0].email} (ID: ${id})`);

      res.json({
        success: true,
        message: `Email notifications ${status} for ${existing[0].full_name || existing[0].email}`,
        email_notifications_enabled: enabled
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error toggling email notifications:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Delete customer (soft delete by setting is_active to FALSE)
router.delete('/:id', requireRole(['admin', 'expert']), writeOperationsLimiter, async (req, res) => {
  try {
    const { tenantCode } = req.user;
    const { id } = req.params;
    const connection = await getTenantConnection(tenantCode);

    try {
      // Check if customer exists and has no active tickets
      const [customer] = await connection.query(
        'SELECT u.id FROM users u WHERE u.id = ? AND u.role = "customer"',
        [id]
      );

      if (customer.length === 0) {
        return res.status(404).json({ success: false, message: 'Customer not found' });
      }

      // Check for active tickets
      const [activeTickets] = await connection.query(
        'SELECT COUNT(*) as count FROM tickets WHERE requester_id = ? AND status NOT IN ("closed", "resolved")',
        [id]
      );

      if (activeTickets[0].count > 0) {
        return res.status(400).json({
          success: false,
          message: `Cannot delete customer with ${activeTickets[0].count} active ticket(s). Please close all tickets first.`
        });
      }

      // Soft delete by setting is_active to FALSE
      await connection.query(
        'UPDATE users SET is_active = FALSE, updated_at = NOW() WHERE id = ?',
        [id]
      );

      res.json({
        success: true,
        message: 'Customer deactivated successfully'
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error deleting customer:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Reactivate customer
router.post('/:id/reactivate', requireRole(['admin', 'expert']), writeOperationsLimiter, async (req, res) => {
  try {
    const { tenantCode } = req.user;
    const { id } = req.params;
    const connection = await getTenantConnection(tenantCode);

    try {
      const [result] = await connection.query(
        'UPDATE users SET is_active = TRUE, updated_at = NOW() WHERE id = ? AND role = "customer"',
        [id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: 'Customer not found' });
      }

      res.json({
        success: true,
        message: 'Customer reactivated successfully'
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error reactivating customer:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
