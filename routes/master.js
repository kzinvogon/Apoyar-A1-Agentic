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
               COUNT(DISTINCT ta.id) as admin_count,
               mu.username as created_by_username,
               (SELECT email FROM tenant_admins WHERE tenant_id = t.id LIMIT 1) as admin_email,
               ts.id as subscription_id,
               ts.plan_id,
               ts.status as subscription_status,
               ts.billing_cycle,
               ts.trial_start,
               ts.trial_end,
               ts.current_period_start,
               ts.current_period_end,
               sp.name as plan_name,
               sp.slug as plan_slug,
               sp.price_monthly,
               sp.price_yearly
        FROM tenants t
        LEFT JOIN tenant_admins ta ON t.id = ta.tenant_id
        LEFT JOIN master_users mu ON t.created_by = mu.id
        LEFT JOIN tenant_subscriptions ts ON t.id = ts.tenant_id
        LEFT JOIN subscription_plans sp ON ts.plan_id = sp.id
        GROUP BY t.id, ts.id, ts.plan_id, ts.status, ts.billing_cycle, ts.trial_start, ts.trial_end,
                 ts.current_period_start, ts.current_period_end, sp.name, sp.slug, sp.price_monthly, sp.price_yearly
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
      // Check if new columns exist (for backward compatibility before migration)
      let hasNewColumns = false;
      try {
        const [cols] = await connection.query(`
          SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME = 'subscription_plans' AND COLUMN_NAME = 'pricing_model'
        `);
        hasNewColumns = cols.length > 0;
      } catch (e) {
        // Ignore - columns don't exist yet
      }

      const selectFields = hasNewColumns
        ? `p.id, p.slug, p.name, p.display_name, p.tagline, p.description,
           p.price_monthly, p.price_yearly, p.price_per_user,
           p.pricing_model, p.price_per_client, p.base_clients_included,
           p.price_additional_client, p.unlimited_technicians,
           p.features, p.feature_limits,
           p.display_order, p.is_active, p.is_featured, p.badge_text,
           p.created_at, p.updated_at`
        : `p.id, p.slug, p.name, p.display_name, p.tagline, p.description,
           p.price_monthly, p.price_yearly, p.price_per_user,
           'per_technician' as pricing_model, 0 as price_per_client, 0 as base_clients_included,
           0 as price_additional_client, 0 as unlimited_technicians,
           p.features, p.feature_limits,
           p.display_order, p.is_active, p.is_featured, p.badge_text,
           p.created_at, p.updated_at`;

      const [plans] = await connection.query(`
        SELECT
          ${selectFields},
          COUNT(ts.id) as tenant_count
        FROM subscription_plans p
        LEFT JOIN tenant_subscriptions ts ON p.id = ts.plan_id AND ts.status IN ('active', 'trial')
        GROUP BY p.id
        ORDER BY p.display_order ASC
      `);

      // Parse JSON features
      const parsedPlans = plans.map(plan => ({
        ...plan,
        features: typeof plan.features === 'string' ? JSON.parse(plan.features) : (plan.features || []),
        feature_limits: typeof plan.feature_limits === 'string' ? JSON.parse(plan.feature_limits) : (plan.feature_limits || {}),
        price_monthly: parseFloat(plan.price_monthly || 0),
        price_yearly: parseFloat(plan.price_yearly || 0),
        price_per_user: parseFloat(plan.price_per_user || 0),
        price_per_client: parseFloat(plan.price_per_client || 0),
        base_clients_included: parseInt(plan.base_clients_included || 0),
        price_additional_client: parseFloat(plan.price_additional_client || 0),
        unlimited_technicians: !!plan.unlimited_technicians,
        pricing_model: plan.pricing_model || 'per_technician'
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

// Get feature catalog
router.get('/plans/features', requireMasterAuth, async (req, res) => {
  try {
    const connection = await getMasterConnection();

    try {
      const [features] = await connection.query(`
        SELECT feature_key, name, marketing_name, description, category, display_order, is_visible_marketing
        FROM plan_features
        ORDER BY category, display_order ASC
      `);

      // Group by category
      const grouped = features.reduce((acc, feature) => {
        const cat = feature.category || 'other';
        if (!acc[cat]) {
          acc[cat] = [];
        }
        acc[cat].push(feature);
        return acc;
      }, {});

      res.json({ success: true, features, grouped });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching features:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Create new subscription plan
router.post('/plans', requireMasterAuth, async (req, res) => {
  try {
    const {
      slug, name, displayName, tagline, description,
      priceMonthly, priceYearly, pricePerUser,
      features, featureLimits,
      displayOrder, isActive, isFeatured, badgeText
    } = req.body;

    // Validate required fields
    if (!slug || !name) {
      return res.status(400).json({ success: false, message: 'Slug and name are required' });
    }

    const connection = await getMasterConnection();

    try {
      // Check if slug already exists
      const [existing] = await connection.query('SELECT id FROM subscription_plans WHERE slug = ?', [slug]);
      if (existing.length > 0) {
        return res.status(400).json({ success: false, message: 'Plan with this slug already exists' });
      }

      const monthly = parseFloat(priceMonthly) || 0;
      const yearly = parseFloat(priceYearly) || (monthly * 10);
      const perUser = parseFloat(pricePerUser) || monthly;

      const [result] = await connection.query(`
        INSERT INTO subscription_plans (
          slug, name, display_name, tagline, description,
          price_monthly, price_yearly, price_per_user,
          features, feature_limits,
          display_order, is_active, is_featured, badge_text
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        slug,
        name,
        displayName || name,
        tagline || '',
        description || '',
        monthly,
        yearly,
        perUser,
        JSON.stringify(Array.isArray(features) ? features : []),
        JSON.stringify(featureLimits || {}),
        parseInt(displayOrder) || 0,
        isActive !== false,
        !!isFeatured,
        badgeText || null
      ]);

      // Clear plans cache
      try {
        const { clearPlansCache } = require('../plans');
        clearPlansCache();
      } catch (e) {}

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

// Update subscription plan
router.put('/plans/:id', requireMasterAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      slug, name, displayName, tagline, description,
      priceMonthly, priceYearly, pricePerUser,
      features, featureLimits,
      displayOrder, isActive, isFeatured, badgeText
    } = req.body;

    const connection = await getMasterConnection();

    try {
      // Check if plan exists
      const [existing] = await connection.query('SELECT id FROM subscription_plans WHERE id = ?', [id]);
      if (existing.length === 0) {
        return res.status(404).json({ success: false, message: 'Plan not found' });
      }

      // Check if slug is being changed and conflicts
      if (slug) {
        const [slugConflict] = await connection.query('SELECT id FROM subscription_plans WHERE slug = ? AND id != ?', [slug, id]);
        if (slugConflict.length > 0) {
          return res.status(400).json({ success: false, message: 'Another plan with this slug already exists' });
        }
      }

      // Build update query dynamically
      const updates = [];
      const values = [];

      if (slug !== undefined) { updates.push('slug = ?'); values.push(slug); }
      if (name !== undefined) { updates.push('name = ?'); values.push(name); }
      if (displayName !== undefined) { updates.push('display_name = ?'); values.push(displayName); }
      if (tagline !== undefined) { updates.push('tagline = ?'); values.push(tagline); }
      if (description !== undefined) { updates.push('description = ?'); values.push(description); }
      if (priceMonthly !== undefined) { updates.push('price_monthly = ?'); values.push(parseFloat(priceMonthly) || 0); }
      if (priceYearly !== undefined) { updates.push('price_yearly = ?'); values.push(parseFloat(priceYearly) || 0); }
      if (pricePerUser !== undefined) { updates.push('price_per_user = ?'); values.push(parseFloat(pricePerUser) || 0); }
      if (features !== undefined) { updates.push('features = ?'); values.push(JSON.stringify(features)); }
      if (featureLimits !== undefined) { updates.push('feature_limits = ?'); values.push(JSON.stringify(featureLimits)); }
      if (displayOrder !== undefined) { updates.push('display_order = ?'); values.push(parseInt(displayOrder) || 0); }
      if (isActive !== undefined) { updates.push('is_active = ?'); values.push(!!isActive); }
      if (isFeatured !== undefined) { updates.push('is_featured = ?'); values.push(!!isFeatured); }
      if (badgeText !== undefined) { updates.push('badge_text = ?'); values.push(badgeText || null); }

      if (updates.length === 0) {
        return res.status(400).json({ success: false, message: 'No fields to update' });
      }

      values.push(id);
      await connection.query(`UPDATE subscription_plans SET ${updates.join(', ')} WHERE id = ?`, values);

      // Clear plans cache
      try {
        const { clearPlansCache } = require('../plans');
        clearPlansCache();
      } catch (e) {}

      // Clear public plans cache
      try {
        const { clearPlansCache: clearPublicCache } = require('./plans-public');
        clearPublicCache();
      } catch (e) {}

      res.json({ success: true, message: 'Plan updated successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error updating plan:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ============ TENANT SUBSCRIPTION MANAGEMENT ============

// Get subscription for a tenant
router.get('/tenants/:id/subscription', requireMasterAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const connection = await getMasterConnection();

    try {
      const [subscriptions] = await connection.query(`
        SELECT
          ts.*,
          sp.slug as plan_slug,
          sp.name as plan_name,
          sp.display_name as plan_display_name,
          sp.price_monthly,
          sp.price_yearly,
          sp.features as plan_features,
          sp.feature_limits as plan_limits,
          t.tenant_code,
          t.company_name
        FROM tenant_subscriptions ts
        JOIN subscription_plans sp ON ts.plan_id = sp.id
        JOIN tenants t ON ts.tenant_id = t.id
        WHERE ts.tenant_id = ?
        ORDER BY ts.created_at DESC
        LIMIT 1
      `, [id]);

      if (subscriptions.length === 0) {
        return res.json({ success: true, subscription: null, message: 'No subscription found' });
      }

      const sub = subscriptions[0];
      res.json({
        success: true,
        subscription: {
          ...sub,
          plan_features: typeof sub.plan_features === 'string' ? JSON.parse(sub.plan_features) : sub.plan_features,
          plan_limits: typeof sub.plan_limits === 'string' ? JSON.parse(sub.plan_limits) : sub.plan_limits
        }
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching tenant subscription:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Assign/update subscription for a tenant
router.post('/tenants/:id/subscription', requireMasterAuth, async (req, res) => {
  try {
    const { id } = req.params;
    // Support both camelCase and snake_case for flexibility
    const planId = req.body.planId || req.body.plan_id;
    const status = req.body.status;
    const billingCycle = req.body.billingCycle || req.body.billing_cycle;
    const pricingModel = req.body.pricingModel || req.body.pricing_model;
    const trialDays = req.body.trialDays || req.body.trial_days;
    const trialEnd = req.body.trialEnd || req.body.trial_end;
    const periodStart = req.body.periodStart || req.body.current_period_start;
    const periodEnd = req.body.periodEnd || req.body.current_period_end;
    const userCount = req.body.userCount || req.body.user_count || 0;
    const clientCount = req.body.clientCount || req.body.client_count || 0;

    if (!planId) {
      return res.status(400).json({ success: false, message: 'planId is required' });
    }

    const connection = await getMasterConnection();

    try {
      // Verify plan exists and get pricing model
      const [plans] = await connection.query(
        'SELECT id, slug, features, pricing_model FROM subscription_plans WHERE id = ?',
        [planId]
      );
      if (plans.length === 0) {
        return res.status(404).json({ success: false, message: 'Plan not found' });
      }

      const planPricingModel = pricingModel || plans[0].pricing_model || 'per_technician';

      // Check for existing subscription
      const [existing] = await connection.query(
        'SELECT id, plan_id, status FROM tenant_subscriptions WHERE tenant_id = ?',
        [id]
      );

      const now = new Date();

      // Calculate period dates
      let calcPeriodStart = periodStart ? new Date(periodStart) : now;
      let calcPeriodEnd;
      let calcTrialEnd = null;

      if (trialEnd) {
        calcTrialEnd = new Date(trialEnd);
        calcPeriodEnd = calcTrialEnd;
      } else if (periodEnd) {
        calcPeriodEnd = new Date(periodEnd);
      } else if (status === 'trial' && trialDays) {
        calcPeriodEnd = new Date(calcPeriodStart);
        calcPeriodEnd.setDate(calcPeriodEnd.getDate() + parseInt(trialDays));
        calcTrialEnd = calcPeriodEnd;
      } else if (billingCycle === 'yearly') {
        calcPeriodEnd = new Date(calcPeriodStart);
        calcPeriodEnd.setFullYear(calcPeriodEnd.getFullYear() + 1);
      } else {
        calcPeriodEnd = new Date(calcPeriodStart);
        calcPeriodEnd.setMonth(calcPeriodEnd.getMonth() + 1);
      }

      if (status === 'trial' && !calcTrialEnd) {
        calcTrialEnd = calcPeriodEnd;
      }

      if (existing.length > 0) {
        // Update existing subscription
        const oldPlanId = existing[0].plan_id;
        const oldStatus = existing[0].status;

        await connection.query(`
          UPDATE tenant_subscriptions SET
            plan_id = ?,
            status = ?,
            billing_cycle = ?,
            pricing_model = ?,
            previous_plan_id = ?,
            plan_changed_at = NOW(),
            current_period_start = ?,
            current_period_end = ?,
            trial_start = ?,
            trial_end = ?,
            user_count = ?,
            client_count = ?
          WHERE tenant_id = ?
        `, [
          planId,
          status || 'active',
          billingCycle || 'monthly',
          planPricingModel,
          oldPlanId,
          calcPeriodStart,
          calcPeriodEnd,
          status === 'trial' ? calcPeriodStart : null,
          calcTrialEnd,
          userCount,
          clientCount,
          id
        ]);

        // Log history
        const action = oldPlanId !== planId
          ? (planId > oldPlanId ? 'upgraded' : 'downgraded')
          : (oldStatus !== status ? 'reactivated' : 'renewed');

        await connection.query(`
          INSERT INTO subscription_history (subscription_id, tenant_id, action, from_plan_id, to_plan_id, from_status, to_status)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [existing[0].id, id, action, oldPlanId, planId, oldStatus, status || 'active']);

      } else {
        // Create new subscription
        const [result] = await connection.query(`
          INSERT INTO tenant_subscriptions (
            tenant_id, plan_id, status, billing_cycle, pricing_model,
            current_period_start, current_period_end,
            trial_start, trial_end, user_count, client_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          id,
          planId,
          status || 'trial',
          billingCycle || 'monthly',
          planPricingModel,
          calcPeriodStart,
          calcPeriodEnd,
          status === 'trial' ? calcPeriodStart : null,
          calcTrialEnd,
          userCount,
          clientCount
        ]);

        // Log history
        await connection.query(`
          INSERT INTO subscription_history (subscription_id, tenant_id, action, to_plan_id, to_status)
          VALUES (?, ?, 'created', ?, ?)
        `, [result.insertId, id, planId, status || 'trial']);
      }

      // Sync features to tenant_features table
      const plan = plans[0];
      const features = typeof plan.features === 'string' ? JSON.parse(plan.features) : plan.features;

      // Get tenant code
      const [tenant] = await connection.query('SELECT tenant_code FROM tenants WHERE id = ?', [id]);
      if (tenant.length > 0) {
        try {
          const tenantConn = await getTenantConnection(tenant[0].tenant_code);
          try {
            // Clear existing plan features and set new ones
            await tenantConn.query("DELETE FROM tenant_features WHERE source = 'plan'");

            for (const featureKey of features) {
              await tenantConn.query(`
                INSERT INTO tenant_features (feature_key, enabled, source)
                VALUES (?, TRUE, 'plan')
                ON DUPLICATE KEY UPDATE enabled = TRUE, source = 'plan'
              `, [featureKey]);
            }
            console.log(`[Subscription] Synced ${features.length} features to ${tenant[0].tenant_code}`);
          } finally {
            tenantConn.release();
          }
        } catch (e) {
          console.warn(`[Subscription] Could not sync features to tenant: ${e.message}`);
        }
      }

      res.json({ success: true, message: 'Subscription updated successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error updating tenant subscription:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Cancel subscription
router.delete('/tenants/:id/subscription', requireMasterAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const connection = await getMasterConnection();

    try {
      const [existing] = await connection.query(
        'SELECT id, status FROM tenant_subscriptions WHERE tenant_id = ?',
        [id]
      );

      if (existing.length === 0) {
        return res.status(404).json({ success: false, message: 'No subscription found' });
      }

      await connection.query(`
        UPDATE tenant_subscriptions SET status = 'cancelled', cancelled_at = NOW()
        WHERE tenant_id = ?
      `, [id]);

      // Log history
      await connection.query(`
        INSERT INTO subscription_history (subscription_id, tenant_id, action, from_status, to_status)
        VALUES (?, ?, 'cancelled', ?, 'cancelled')
      `, [existing[0].id, id, existing[0].status]);

      res.json({ success: true, message: 'Subscription cancelled' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error cancelling subscription:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get subscription history for a tenant
router.get('/tenants/:id/subscription/history', requireMasterAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const connection = await getMasterConnection();

    try {
      const [history] = await connection.query(`
        SELECT
          sh.*,
          fp.name as from_plan_name,
          tp.name as to_plan_name
        FROM subscription_history sh
        LEFT JOIN subscription_plans fp ON sh.from_plan_id = fp.id
        LEFT JOIN subscription_plans tp ON sh.to_plan_id = tp.id
        WHERE sh.tenant_id = ?
        ORDER BY sh.created_at DESC
        LIMIT 50
      `, [id]);

      res.json({ success: true, history });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching subscription history:', error);
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

