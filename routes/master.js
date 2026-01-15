const express = require('express');
const router = express.Router();
const { getMasterConnection, getTenantConnection } = require('../config/database');
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
    const connection = await getMasterConnection();

    try {
      const [subscriptions] = await connection.query(`
        SELECT
          s.id, s.tenant_id, s.plan_id, s.status, s.trial_ends_at,
          s.billing_cycle, s.next_billing_date, s.created_at, s.updated_at,
          t.company_name, t.tenant_code,
          p.name as plan_name, p.monthly_price,
          pp.name as previous_plan_name
        FROM subscriptions s
        JOIN tenants t ON s.tenant_id = t.id
        JOIN plans p ON s.plan_id = p.id
        LEFT JOIN plans pp ON s.previous_plan_id = pp.id
        ORDER BY s.created_at DESC
      `);

      res.json({ success: true, subscriptions });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching subscriptions:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get billing information
router.get('/billing', requireMasterAuth, async (req, res) => {
  try {
    const connection = await getMasterConnection();

    try {
      // Calculate MRR from active subscriptions
      const [mrrResult] = await connection.query(`
        SELECT COALESCE(SUM(p.monthly_price), 0) as mrr
        FROM subscriptions s
        JOIN plans p ON s.plan_id = p.id
        WHERE s.status = 'active'
      `);

      // Get pending payments
      const [pendingResult] = await connection.query(`
        SELECT COALESCE(SUM(amount), 0) as pending
        FROM billing_transactions
        WHERE status = 'pending'
      `);

      // Get active subscription count for ARPU calculation
      const [subCountResult] = await connection.query(`
        SELECT COUNT(*) as count FROM subscriptions WHERE status = 'active'
      `);

      // Get recent transactions
      const [transactions] = await connection.query(`
        SELECT
          bt.id, bt.amount, bt.status, bt.transaction_date as date, bt.description,
          t.company_name as tenant,
          p.name as plan
        FROM billing_transactions bt
        JOIN tenants t ON bt.tenant_id = t.id
        JOIN subscriptions s ON bt.subscription_id = s.id
        JOIN plans p ON s.plan_id = p.id
        ORDER BY bt.transaction_date DESC
        LIMIT 50
      `);

      const mrr = parseFloat(mrrResult[0].mrr) || 0;
      const activeCount = subCountResult[0].count || 1;

      const billing = {
        mrr: mrr,
        pendingPayments: parseFloat(pendingResult[0].pending) || 0,
        churnRate: 0, // Would need historical data to calculate
        arpu: mrr / activeCount,
        transactions: transactions
      };

      res.json({ success: true, billing });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching billing:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get subscription plans
router.get('/plans', requireMasterAuth, async (req, res) => {
  try {
    const connection = await getMasterConnection();

    try {
      const [plans] = await connection.query(`
        SELECT
          p.id, p.name, p.display_name, p.description,
          p.price_monthly as monthly_price, p.max_users,
          p.max_tickets, p.max_storage_gb as max_storage, p.features,
          CASE WHEN p.is_active THEN 'active' ELSE 'inactive' END as status,
          COUNT(s.id) as tenant_count
        FROM subscription_plans p
        LEFT JOIN tenant_subscriptions s ON p.id = s.plan_id AND s.status IN ('active', 'trial')
        GROUP BY p.id
        ORDER BY p.price_monthly ASC
      `);

      // Parse JSON features
      const parsedPlans = plans.map(plan => ({
        ...plan,
        features: typeof plan.features === 'string' ? JSON.parse(plan.features) : (plan.features || [])
      }));

      res.json({ success: true, plans: parsedPlans });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching plans:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Create new subscription plan
router.post('/plans', requireMasterAuth, async (req, res) => {
  try {
    const { name, displayName, description, monthlyPrice, yearlyPrice, maxUsers, maxTickets, maxStorage, status, features } = req.body;

    // Validate required fields
    if (!name) {
      return res.status(400).json({ success: false, message: 'Plan name is required' });
    }

    const connection = await getMasterConnection();

    try {
      // Check if plan name already exists
      const [existing] = await connection.query('SELECT id FROM subscription_plans WHERE name = ?', [name]);
      if (existing.length > 0) {
        return res.status(400).json({ success: false, message: 'Plan with this name already exists' });
      }

      const priceMonthly = parseFloat(monthlyPrice) || 0;
      const priceYearly = parseFloat(yearlyPrice) || (priceMonthly * 10); // Default: 10 months for yearly

      const [result] = await connection.query(`
        INSERT INTO subscription_plans (name, display_name, description, price_monthly, price_yearly, max_users, max_tickets, max_storage_gb, features, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        name,
        displayName || name,
        description || `${name} plan`,
        priceMonthly,
        priceYearly,
        parseInt(maxUsers) || -1,
        parseInt(maxTickets) || -1,
        parseInt(maxStorage) || 10,
        JSON.stringify(Array.isArray(features) ? features : []),
        status === 'active' || status === undefined
      ]);

      res.json({
        success: true,
        message: 'Plan created successfully',
        planId: result.insertId
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error creating plan:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get email settings
router.get('/email-settings', requireMasterAuth, async (req, res) => {
  try {
    const connection = await getMasterConnection();

    try {
      // Get all tenants
      const [tenants] = await connection.query(`
        SELECT id, tenant_code, company_name FROM tenants WHERE status = 'active'
      `);

      // For each tenant, get their email settings
      const tenantSettings = [];
      for (const tenant of tenants) {
        try {
          const tenantConn = await getTenantConnection(tenant.tenant_code);
          try {
            const [settings] = await tenantConn.query('SELECT * FROM email_ingest_settings LIMIT 1');
            const [domainSetting] = await tenantConn.query(
              "SELECT setting_value FROM tenant_settings WHERE setting_key = 'tenant_domain'"
            );

            tenantSettings.push({
              tenantId: tenant.tenant_code,
              companyName: tenant.company_name,
              domain: domainSetting[0]?.setting_value || null,
              emailProcessingEnabled: settings[0]?.enabled || false,
              serverHost: settings[0]?.server_host || null,
              checkInterval: settings[0]?.check_interval_minutes || 5
            });
          } finally {
            tenantConn.release();
          }
        } catch (e) {
          // Skip tenants with database issues
          console.log(`Could not fetch settings for tenant ${tenant.tenant_code}:`, e.message);
        }
      }

      const emailSettings = {
        tenants: tenantSettings
      };

      res.json({ success: true, settings: emailSettings });
    } finally {
      connection.release();
    }
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

    // Get tenant connection
    const connection = await getMasterConnection();

    try {
      // Verify tenant exists
      const [tenant] = await connection.query(
        'SELECT tenant_code FROM tenants WHERE id = ?',
        [tenantId]
      );

      if (tenant.length === 0) {
        return res.status(404).json({ success: false, message: 'Tenant not found' });
      }

      const tenantCode = tenant[0].tenant_code;
      const tenantConn = await getTenantConnection(tenantCode);

      try {
        // Update domain setting
        if (domain !== undefined) {
          await tenantConn.query(`
            INSERT INTO tenant_settings (setting_key, setting_value)
            VALUES ('tenant_domain', ?)
            ON DUPLICATE KEY UPDATE setting_value = ?, updated_at = NOW()
          `, [domain, domain]);
        }

        // Update email enabled setting
        if (enabled !== undefined) {
          await tenantConn.query(
            'UPDATE email_ingest_settings SET enabled = ? WHERE id = 1',
            [enabled]
          );
        }

        res.json({
          success: true,
          message: 'Tenant email settings updated successfully'
        });
      } finally {
        tenantConn.release();
      }
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error updating tenant email settings:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;

