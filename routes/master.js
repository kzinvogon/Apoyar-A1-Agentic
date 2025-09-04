const express = require('express');
const router = express.Router();
const { getMasterConnection } = require('../config/database');
const { requireMasterAuth, requireRole, hashPassword } = require('../middleware/auth');

// Get all tenants
router.get('/tenants', requireMasterAuth, async (req, res) => {
  try {
    const connection = await getMasterConnection();
    try {
      const [rows] = await connection.query(`
        SELECT t.*, 
               COUNT(ta.id) as admin_count,
               mu.username as created_by_username
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
router.post('/tenants', requireMasterAuth, requireRole(['super_admin']), async (req, res) => {
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
      const adminPassword = await hashPassword('admin123');
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
        INSERT INTO master_audit_log (user_id, user_type, action, details, ip_address)
        VALUES (?, 'master_user', 'tenant_created', ?, ?)
      `, [req.user.userId, `Created tenant: ${company_name}`, req.ip]);

      res.status(201).json({
        success: true,
        message: 'Tenant created successfully',
        tenantId: result.insertId,
        adminCredentials: {
          username: 'admin',
          password: 'admin123'
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
router.put('/tenants/:id', requireMasterAuth, requireRole(['super_admin']), async (req, res) => {
  try {
    const {
      company_name,
      display_name,
      status,
      max_users,
      max_tickets,
      subscription_plan
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

      // Update tenant
      await connection.query(`
        UPDATE tenants SET
          company_name = COALESCE(?, company_name),
          display_name = COALESCE(?, display_name),
          status = COALESCE(?, status),
          max_users = COALESCE(?, max_users),
          max_tickets = COALESCE(?, max_tickets),
          subscription_plan = COALESCE(?, subscription_plan),
          updated_at = NOW()
        WHERE id = ?
      `, [company_name, display_name, status, max_users, max_tickets, subscription_plan, req.params.id]);

      // Log the action
      await connection.query(`
        INSERT INTO master_audit_log (user_id, user_type, action, details, ip_address)
        VALUES (?, 'master_user', 'tenant_updated', ?, ?)
      `, [req.user.userId, `Updated tenant ID: ${req.params.id}`, req.ip]);

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
        INSERT INTO master_audit_log (user_id, user_type, action, details, ip_address)
        VALUES (?, 'master_user', 'tenant_suspended', ?, ?)
      `, [req.user.userId, `Suspended tenant: ${existing[0].company_name}`, req.ip]);

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
router.get('/audit-logs', requireMasterAuth, async (req, res) => {
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

module.exports = router;

