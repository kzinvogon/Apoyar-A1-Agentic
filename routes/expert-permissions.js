const express = require('express');
const router = express.Router();
const { getTenantConnection } = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');

// Apply authentication to all routes
router.use(verifyToken);

// Get available customers for assignment - MUST come before /:tenantId/:expertId
router.get('/:tenantId/customers/available', requireRole(['admin']), async (req, res) => {
  try {
    const { tenantId } = req.params;
    const connection = await getTenantConnection(tenantId);

    try {
      const [customers] = await connection.query(
        `SELECT u.id, u.username, u.email, u.full_name,
                c.company_name, c.company_domain
         FROM users u
         LEFT JOIN customers c ON u.id = c.user_id
         WHERE u.role = 'customer' AND u.is_active = TRUE
         ORDER BY u.full_name ASC, u.username ASC`
      );

      res.json({
        success: true,
        customers: customers
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching customers:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch customers',
      message: error.message
    });
  }
});

// Get all experts with their permission summary - MUST come before /:tenantId/:expertId
router.get('/:tenantId/summary/all', requireRole(['admin']), async (req, res) => {
  try {
    const { tenantId } = req.params;
    const connection = await getTenantConnection(tenantId);

    try {
      // Get all experts
      const [experts] = await connection.query(
        `SELECT id, username, email, full_name, role
         FROM users
         WHERE role IN ('admin', 'expert') AND is_active = TRUE
         ORDER BY full_name ASC, username ASC`
      );

      // Get permission counts for each expert
      for (let expert of experts) {
        const [perms] = await connection.query(
          `SELECT
            permission_type,
            COUNT(*) as count
           FROM expert_ticket_permissions
           WHERE expert_id = ? AND is_active = TRUE
           GROUP BY permission_type`,
          [expert.id]
        );

        expert.permissions = {
          all_tickets: 0,
          specific_customers: 0,
          title_patterns: 0
        };

        perms.forEach(p => {
          expert.permissions[p.permission_type] = p.count;
        });
      }

      res.json({
        success: true,
        experts: experts
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching expert permission summary:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch expert summary',
      message: error.message
    });
  }
});

// Get all permissions for an expert
router.get('/:tenantId/:expertId', requireRole(['admin', 'expert']), async (req, res) => {
  try {
    const { tenantId, expertId } = req.params;
    const connection = await getTenantConnection(tenantId);

    try {
      const [permissions] = await connection.query(
        `SELECT ep.*,
                u.username as customer_username,
                u.full_name as customer_name,
                c.company_name
         FROM expert_ticket_permissions ep
         LEFT JOIN users u ON ep.customer_id = u.id
         LEFT JOIN customers c ON u.id = c.user_id
         WHERE ep.expert_id = ? AND ep.is_active = TRUE
         ORDER BY ep.created_at DESC`,
        [expertId]
      );

      res.json({
        success: true,
        permissions: permissions
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching expert permissions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch permissions',
      message: error.message
    });
  }
});

// Create new permission for an expert
router.post('/:tenantId/:expertId', requireRole(['admin']), async (req, res) => {
  try {
    const { tenantId, expertId } = req.params;
    const { permission_type, customer_id, title_pattern } = req.body;

    // Validate permission type
    if (!['all_tickets', 'specific_customers', 'title_patterns'].includes(permission_type)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid permission type'
      });
    }

    // Validate required fields based on permission type
    if (permission_type === 'specific_customers' && !customer_id) {
      return res.status(400).json({
        success: false,
        error: 'customer_id is required for specific_customers permission'
      });
    }

    if (permission_type === 'title_patterns' && !title_pattern) {
      return res.status(400).json({
        success: false,
        error: 'title_pattern is required for title_patterns permission'
      });
    }

    const connection = await getTenantConnection(tenantId);

    try {
      // Check if 'all_tickets' permission already exists for this expert
      if (permission_type === 'all_tickets') {
        const [existing] = await connection.query(
          `SELECT id FROM expert_ticket_permissions
           WHERE expert_id = ? AND permission_type = 'all_tickets' AND is_active = TRUE`,
          [expertId]
        );

        if (existing.length > 0) {
          return res.status(400).json({
            success: false,
            error: 'Expert already has all_tickets permission'
          });
        }

        // Remove other permissions when granting all_tickets
        await connection.query(
          `UPDATE expert_ticket_permissions
           SET is_active = FALSE
           WHERE expert_id = ? AND permission_type != 'all_tickets'`,
          [expertId]
        );
      } else {
        // Remove all_tickets permission if adding specific permissions
        await connection.query(
          `UPDATE expert_ticket_permissions
           SET is_active = FALSE
           WHERE expert_id = ? AND permission_type = 'all_tickets'`,
          [expertId]
        );

        // Check for duplicate specific permission
        if (permission_type === 'specific_customers') {
          const [existing] = await connection.query(
            `SELECT id FROM expert_ticket_permissions
             WHERE expert_id = ? AND permission_type = 'specific_customers'
             AND customer_id = ? AND is_active = TRUE`,
            [expertId, customer_id]
          );

          if (existing.length > 0) {
            return res.status(400).json({
              success: false,
              error: 'Permission for this customer already exists'
            });
          }
        }
      }

      // Insert new permission
      const [result] = await connection.query(
        `INSERT INTO expert_ticket_permissions
         (expert_id, permission_type, customer_id, title_pattern)
         VALUES (?, ?, ?, ?)`,
        [expertId, permission_type, customer_id || null, title_pattern || null]
      );

      // Fetch the created permission with details
      const [created] = await connection.query(
        `SELECT ep.*,
                u.username as customer_username,
                u.full_name as customer_name,
                c.company_name
         FROM expert_ticket_permissions ep
         LEFT JOIN users u ON ep.customer_id = u.id
         LEFT JOIN customers c ON u.id = c.user_id
         WHERE ep.id = ?`,
        [result.insertId]
      );

      res.status(201).json({
        success: true,
        message: 'Permission created successfully',
        permission: created[0]
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error creating permission:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create permission',
      message: error.message
    });
  }
});

// Update permission
router.put('/:tenantId/:permissionId', requireRole(['admin']), async (req, res) => {
  try {
    const { tenantId, permissionId } = req.params;
    const { title_pattern, is_active } = req.body;

    const connection = await getTenantConnection(tenantId);

    try {
      const updates = [];
      const values = [];

      if (title_pattern !== undefined) {
        updates.push('title_pattern = ?');
        values.push(title_pattern);
      }

      if (is_active !== undefined) {
        updates.push('is_active = ?');
        values.push(is_active);
      }

      if (updates.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No fields to update'
        });
      }

      values.push(permissionId);

      await connection.query(
        `UPDATE expert_ticket_permissions
         SET ${updates.join(', ')}
         WHERE id = ?`,
        values
      );

      res.json({
        success: true,
        message: 'Permission updated successfully'
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error updating permission:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update permission',
      message: error.message
    });
  }
});

// Delete permission (soft delete)
router.delete('/:tenantId/:permissionId', requireRole(['admin']), async (req, res) => {
  try {
    const { tenantId, permissionId } = req.params;
    const connection = await getTenantConnection(tenantId);

    try {
      await connection.query(
        'UPDATE expert_ticket_permissions SET is_active = FALSE WHERE id = ?',
        [permissionId]
      );

      res.json({
        success: true,
        message: 'Permission deleted successfully'
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error deleting permission:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete permission',
      message: error.message
    });
  }
});

module.exports = router;
