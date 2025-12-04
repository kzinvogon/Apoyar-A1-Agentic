const express = require('express');
const router = express.Router();
const { getMasterConnection } = require('../config/database');
const { verifyToken, requireMasterAuth, requireRole, hashPassword } = require('../middleware/auth');
const {
  validateTenantCreate,
  validateTenantUpdate,
  validateEmailTest,
  validatePagination
} = require('../middleware/validation');
const {
  masterAdminLimiter,
  emailLimiter
} = require('../middleware/rateLimiter');

// Apply verifyToken middleware to all master routes
router.use(verifyToken);

// Get all tenants
router.get('/tenants', requireMasterAuth, async (req, res) => {
  try {
    const connection = await getMasterConnection();
    try {
      const [rows] = await connection.query(`
        SELECT t.*,
               COUNT(ta.id) as admin_count,
               mu.username as created_by_username,
               (SELECT email FROM tenant_admins WHERE tenant_id = t.id LIMIT 1) as admin_email
        FROM tenants t
        LEFT JOIN tenant_admins ta ON t.id = ta.tenant_id
        LEFT JOIN master_users mu ON t.created_by = mu.id
        GROUP BY t.id
        ORDER BY t.created_at DESC
      `);

      res.json({ success: true, tenants: rows });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching tenants:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get single tenant
router.get('/tenants/:id', requireMasterAuth, async (req, res) => {
  try {
    const connection = await getMasterConnection();
    try {
      const [rows] = await connection.query(
        'SELECT * FROM tenants WHERE id = ?',
        [req.params.id]
      );
      
      if (rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Tenant not found' });
      }
      
      res.json({ success: true, tenant: rows[0] });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching tenant:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Create new tenant
router.post('/tenants', requireMasterAuth, requireRole(['super_admin']), masterAdminLimiter, validateTenantCreate, async (req, res) => {
  try {
    const {
      tenant_code,
      company_name,
      display_name,
      database_host,
      database_port,
      database_user,
      database_password,
      max_users,
      max_tickets,
      subscription_plan
    } = req.body;

    // Validate required fields
    if (!tenant_code || !company_name || !display_name || !database_user || !database_password) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const connection = await getMasterConnection();
    try {
      // Check if tenant code already exists
      const [existing] = await connection.query(
        'SELECT id FROM tenants WHERE tenant_code = ?',
        [tenant_code]
      );
      
      if (existing.length > 0) {
        return res.status(400).json({ success: false, message: 'Tenant code already exists' });
      }

      // Generate database name
      const database_name = `a1_tenant_${tenant_code}`;

      // Insert new tenant
      const [result] = await connection.query(`
        INSERT INTO tenants (
          tenant_code, company_name, display_name, database_name,
          database_host, database_port, database_user, database_password,
          max_users, max_tickets, subscription_plan, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        tenant_code, company_name, display_name, database_name,
        database_host || 'localhost', database_port || 3306,
        database_user, database_password, max_users || 100,
        max_tickets || 1000, subscription_plan || 'basic', req.user.userId
      ]);

      // Create tenant admin user
      const defaultPassword = process.env.DEFAULT_TENANT_PASSWORD || 'CHANGE_ME_IMMEDIATELY';
      const adminPassword = await hashPassword(defaultPassword);
      await connection.query(`
        INSERT INTO tenant_admins (
          tenant_id, username, email, password_hash, full_name, role
        ) VALUES (?, ?, ?, ?, ?, ?)
      `, [
        result.insertId,
        'admin',
        `admin@${tenant_code}.com`,
        adminPassword,
        `${company_name} Administrator`,
        'tenant_admin'
      ]);

      // Log the action
      await connection.query(`
        INSERT INTO master_audit_log (user_id, action, details, ip_address)
        VALUES (?, 'tenant_created', ?, ?)
      `, [req.user.userId, JSON.stringify({ message: `Created tenant: ${company_name}`, company_name, tenant_code }), req.ip]);

      res.status(201).json({
        success: true,
        message: 'Tenant created successfully. IMPORTANT: Change the default admin password immediately!',
        tenantId: result.insertId,
        adminCredentials: {
          username: 'admin',
          note: 'Password set from DEFAULT_TENANT_PASSWORD environment variable'
        }
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error creating tenant:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Update tenant
router.put('/tenants/:id', requireMasterAuth, requireRole(['super_admin']), masterAdminLimiter, validateTenantUpdate, async (req, res) => {
  try {
    const {
      company_name,
      display_name,
      is_active,
      admin_email
    } = req.body;

    const connection = await getMasterConnection();
    try {
      // Check if tenant exists
      const [existing] = await connection.query(
        'SELECT id FROM tenants WHERE id = ?',
        [req.params.id]
      );

      if (existing.length === 0) {
        return res.status(404).json({ success: false, message: 'Tenant not found' });
      }

      // Update tenant basic info
      await connection.query(`
        UPDATE tenants SET
          company_name = COALESCE(?, company_name),
          display_name = COALESCE(?, display_name),
          is_active = COALESCE(?, is_active),
          updated_at = NOW()
        WHERE id = ?
      `, [company_name, display_name, is_active, req.params.id]);

      // Update tenant admin email if provided
      if (admin_email) {
        await connection.query(`
          UPDATE tenant_admins
          SET email = ?, updated_at = NOW()
          WHERE tenant_id = ?
        `, [admin_email, req.params.id]);
      }

      // Log the action
      await connection.query(`
        INSERT INTO master_audit_log (user_id, action, details, ip_address)
        VALUES (?, 'tenant_updated', ?, ?)
      `, [req.user.userId, JSON.stringify({ message: `Updated tenant ID: ${req.params.id}`, tenant_id: req.params.id }), req.ip]);

      res.json({ success: true, message: 'Tenant updated successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error updating tenant:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Delete tenant (soft delete by setting status to suspended)
router.delete('/tenants/:id', requireMasterAuth, requireRole(['super_admin']), async (req, res) => {
  try {
    const connection = await getMasterConnection();
    try {
      // Check if tenant exists
      const [existing] = await connection.query(
        'SELECT id, company_name FROM tenants WHERE id = ?',
        [req.params.id]
      );
      
      if (existing.length === 0) {
        return res.status(404).json({ success: false, message: 'Tenant not found' });
      }

      // Soft delete by setting status to suspended
      await connection.query(
        'UPDATE tenants SET status = "suspended", updated_at = NOW() WHERE id = ?',
        [req.params.id]
      );

      // Log the action
      await connection.query(`
        INSERT INTO master_audit_log (user_id, action, details, ip_address)
        VALUES (?, 'tenant_suspended', ?, ?)
      `, [req.user.userId, JSON.stringify({ message: `Suspended tenant: ${existing[0].company_name}`, tenant_id: req.params.id }), req.ip]);

      res.json({ success: true, message: 'Tenant suspended successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error suspending tenant:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get tenant statistics
router.get('/tenants/:id/stats', requireMasterAuth, async (req, res) => {
  try {
    const connection = await getMasterConnection();
    try {
      // Get tenant info
      const [tenantRows] = await connection.query(
        'SELECT * FROM tenants WHERE id = ?',
        [req.params.id]
      );
      
      if (tenantRows.length === 0) {
        return res.status(404).json({ success: false, message: 'Tenant not found' });
      }

      const tenant = tenantRows[0];

      // Get tenant admin count
      const [adminRows] = await connection.query(
        'SELECT COUNT(*) as count FROM tenant_admins WHERE tenant_id = ? AND is_active = TRUE',
        [req.params.id]
      );

      // Get audit log count
      const [auditRows] = await connection.query(
        'SELECT COUNT(*) as count FROM master_audit_log WHERE user_type = "tenant_admin"',
        []
      );

      const stats = {
        tenant: {
          id: tenant.id,
          company_name: tenant.company_name,
          status: tenant.status,
          subscription_plan: tenant.subscription_plan,
          created_at: tenant.created_at
        },
        counts: {
          admins: adminRows[0].count,
          audit_entries: auditRows[0].count
        },
        limits: {
          max_users: tenant.max_users,
          max_tickets: tenant.max_tickets
        }
      };

      res.json({ success: true, stats });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching tenant stats:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get system overview
router.get('/overview', requireMasterAuth, async (req, res) => {
  try {
    const connection = await getMasterConnection();
    try {
      // Get total counts
      const [tenantCount] = await connection.query('SELECT COUNT(*) as count FROM tenants');
      const [activeTenantCount] = await connection.query('SELECT COUNT(*) as count FROM tenants WHERE status = "active"');
      const [masterUserCount] = await connection.query('SELECT COUNT(*) as count FROM master_users WHERE is_active = TRUE');
      const [auditLogCount] = await connection.query('SELECT COUNT(*) as count FROM master_audit_log');

      // Get recent audit logs
      const [recentAudit] = await connection.query(`
        SELECT al.*, mu.username as user_username
        FROM master_audit_log al
        LEFT JOIN master_users mu ON al.user_id = mu.id
        ORDER BY al.created_at DESC
        LIMIT 10
      `);

      const overview = {
        counts: {
          total_tenants: tenantCount[0].count,
          active_tenants: activeTenantCount[0].count,
          master_users: masterUserCount[0].count,
          audit_logs: auditLogCount[0].count
        },
        recent_activity: recentAudit
      };

      res.json({ success: true, overview });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching system overview:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get audit logs
router.get('/audit-logs', requireMasterAuth, validatePagination, async (req, res) => {
  try {
    const { page = 1, limit = 50, action, user_type } = req.query;
    const offset = (page - 1) * limit;

    const connection = await getMasterConnection();
    try {
      let whereClause = '';
      let params = [];

      if (action) {
        whereClause += ' WHERE al.action = ?';
        params.push(action);
      }

      if (user_type) {
        whereClause += whereClause ? ' AND al.user_type = ?' : ' WHERE al.user_type = ?';
        params.push(user_type);
      }

      // Get total count
      const [countRows] = await connection.query(
        `SELECT COUNT(*) as count FROM master_audit_log al${whereClause}`,
        params
      );

      // Get audit logs with pagination
      const [auditLogs] = await connection.query(`
        SELECT al.*, mu.username as user_username
        FROM master_audit_log al
        LEFT JOIN master_users mu ON al.user_id = mu.id
        ${whereClause}
        ORDER BY al.created_at DESC
        LIMIT ? OFFSET ?
      `, [...params, parseInt(limit), offset]);

      res.json({
        success: true,
        audit_logs: auditLogs,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: countRows[0].count,
          pages: Math.ceil(countRows[0].count / limit)
        }
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching audit logs:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get subscriptions
router.get('/subscriptions', requireMasterAuth, async (req, res) => {
  try {
    // Return mock subscription data for now
    const subscriptions = [
      {
        id: 1,
        tenant_id: 1,
        plan_id: 1,
        status: 'active',
        plan: 'professional',
        previousPlan: 'trial',
        monthlyPrice: 99.00,
        created_at: '2025-10-22T18:57:55.000Z',
        updated_at: '2025-10-22T18:57:55.000Z',
        company_name: 'Apoyar',
        tenant_code: 'apoyar',
        plan_name: 'Professional'
      },
      {
        id: 2,
        tenant_id: 2,
        plan_id: 1,
        status: 'active',
        plan: 'trial',
        previousPlan: null,
        monthlyPrice: 0.00,
        created_at: '2025-10-23T10:00:00.000Z',
        updated_at: '2025-10-23T10:00:00.000Z',
        company_name: 'Test Company',
        tenant_code: 'testcompany',
        plan_name: 'Trial'
      }
    ];
    
    res.json({ success: true, subscriptions });
  } catch (error) {
    console.error('Error fetching subscriptions:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get billing information
router.get('/billing', requireMasterAuth, async (req, res) => {
  try {
    // Return mock billing data for now
    const billing = {
      mrr: 198.00,
      pendingPayments: 99.00,
      churnRate: 5.2,
      arpu: 99.00,
      transactions: [
        {
          id: 1,
          tenant: 'Apoyar',
          amount: 99.00,
          status: 'paid',
          date: '2025-10-22T18:57:55.000Z',
          plan: 'Professional'
        },
        {
          id: 2,
          tenant: 'Test Company',
          amount: 0.00,
          status: 'trial',
          date: '2025-10-23T10:00:00.000Z',
          plan: 'Trial'
        },
        {
          id: 3,
          tenant: 'Apoyar',
          amount: 99.00,
          status: 'pending',
          date: '2025-10-23T12:00:00.000Z',
          plan: 'Professional'
        }
      ]
    };
    
    res.json({ success: true, billing });
  } catch (error) {
    console.error('Error fetching billing:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get subscription plans
router.get('/plans', requireMasterAuth, async (req, res) => {
  try {
    // Return mock subscription plans for now
    const plans = [
      {
        id: 1,
        name: 'Trial',
        description: 'Free trial for 30 days',
        monthly_price: 0.00,
        max_users: 5,
        max_tickets: 100,
        max_storage: 1,
        features: ['Basic support', 'Email notifications', 'Basic reporting'],
        status: 'active',
        tenant_count: 0
      },
      {
        id: 2,
        name: 'Professional',
        description: 'Full-featured plan for growing businesses',
        monthly_price: 99.00,
        max_users: 25,
        max_tickets: 1000,
        max_storage: 10,
        features: ['Priority support', 'Advanced reporting', 'API access', 'Custom branding'],
        status: 'active',
        tenant_count: 1
      },
      {
        id: 3,
        name: 'Enterprise',
        description: 'Enterprise-grade solution with unlimited resources',
        monthly_price: 299.00,
        max_users: -1,
        max_tickets: -1,
        max_storage: 100,
        features: ['24/7 support', 'Custom integrations', 'Dedicated account manager', 'SLA guarantees'],
        status: 'active',
        tenant_count: 0
      }
    ];
    
    res.json({ success: true, plans });
  } catch (error) {
    console.error('Error fetching plans:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Create new subscription plan
router.post('/plans', requireMasterAuth, async (req, res) => {
  try {
    const { name, id, monthlyPrice, maxUsers, maxTickets, maxStorage, status, features } = req.body;

    // Validate required fields
    if (!name || !id) {
      return res.status(400).json({ success: false, message: 'Plan name and ID are required' });
    }

    // In a real implementation, this would save to a plans table in the database
    // For now, we'll return success with the plan data
    const newPlan = {
      id,
      name,
      description: `${name} plan`,
      monthly_price: parseFloat(monthlyPrice) || 0,
      max_users: parseInt(maxUsers) || -1,
      max_tickets: parseInt(maxTickets) || -1,
      max_storage: parseInt(maxStorage) || 10,
      features: Array.isArray(features) ? features : [],
      status: status || 'active',
      created_at: new Date().toISOString()
    };

    // TODO: Save to database when plans table is created
    // const connection = await getMasterConnection();
    // await connection.query('INSERT INTO plans ...');

    res.json({
      success: true,
      message: 'Plan created successfully',
      plan: newPlan
    });
  } catch (error) {
    console.error('Error creating plan:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get email settings
router.get('/email-settings', requireMasterAuth, async (req, res) => {
  try {
    // Return mock email settings for now
    const emailSettings = {
      imap: {
        host: 'imap.gmail.com',
        port: 993,
        user: 'support@apoyar.com',
        secure: true
      },
      checkInterval: 30000,
      status: 'Active',
      tenants: [
        {
          tenantId: 'apoyar',
          companyName: 'Apoyar',
          domain: 'apoyar.com',
          emailProcessingEnabled: true
        }
      ]
    };
    
    res.json({ success: true, settings: emailSettings });
  } catch (error) {
    console.error('Error fetching email settings:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get email connection status
router.get('/email-settings/status', requireMasterAuth, async (req, res) => {
  try {
    const { testEmailConnection } = require('../config/email');
    const result = await testEmailConnection();

    res.json(result);
  } catch (error) {
    console.error('Error checking email connection status:', error);
    res.status(500).json({
      success: false,
      configured: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Test email connection and send test email
router.post('/email-settings/test', requireMasterAuth, emailLimiter, validateEmailTest, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email address is required'
      });
    }

    // Use the new test email connection function
    const { testEmailConnection } = require('../config/email');
    const result = await testEmailConnection(email);

    res.json(result);
  } catch (error) {
    console.error('Error testing email connection:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Update tenant email settings
router.put('/tenants/:tenantId/email-settings', requireMasterAuth, async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { domain, enabled } = req.body;
    
    // Mock update - just log the details
    console.log('Updating tenant email settings:', { tenantId, domain, enabled });
    
    res.json({ 
      success: true, 
      message: 'Tenant email settings updated successfully' 
    });
  } catch (error) {
    console.error('Error updating tenant email settings:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;

