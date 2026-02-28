/**
 * CMDB History Routes
 * Provides access to CMDB change history and audit trail
 */

const express = require('express');
const router = express.Router();
const { getTenantConnection } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { applyTenantMatch } = require('../middleware/tenantMatch');
const { requireAdmin } = require('../utils/cmdb-helpers');

// Apply authentication to all routes
router.use(verifyToken);
applyTenantMatch(router);

// Change type labels for display
const CHANGE_TYPE_LABELS = {
  created: 'Created',
  updated: 'Updated',
  deleted: 'Deleted',
  relationship_added: 'Relationship Added',
  relationship_removed: 'Relationship Removed',
  custom_field_updated: 'Custom Field Updated'
};

// ============================================================================
// HISTORY ENDPOINTS
// ============================================================================

/**
 * GET /:tenantCode/items/:cmdbId/history
 * Get change history for a specific CMDB item
 */
router.get('/:tenantCode/items/:cmdbId/history', async (req, res) => {
  try {
    const { tenantCode, cmdbId } = req.params;
    const {
      change_type,
      from_date,
      to_date,
      limit = 50,
      offset = 0
    } = req.query;

    const connection = await getTenantConnection(tenantCode);

    try {
      // Get the CMDB item
      const [items] = await connection.query(
        'SELECT id, cmdb_id, asset_name FROM cmdb_items WHERE cmdb_id = ?',
        [cmdbId]
      );

      if (items.length === 0) {
        return res.status(404).json({ success: false, message: 'CMDB item not found' });
      }

      const item = items[0];

      // Build query
      let query = `
        SELECT h.*, u.full_name as user_full_name, u.username as user_username
        FROM cmdb_change_history h
        LEFT JOIN users u ON h.changed_by = u.id
        WHERE h.cmdb_item_id = ?
      `;
      const params = [item.id];

      // Filter by change type
      if (change_type) {
        query += ' AND h.change_type = ?';
        params.push(change_type);
      }

      // Filter by date range
      if (from_date) {
        query += ' AND h.created_at >= ?';
        params.push(from_date);
      }

      if (to_date) {
        query += ' AND h.created_at <= ?';
        params.push(to_date);
      }

      // Get total count
      const countQuery = query.replace('SELECT h.*, u.full_name as user_full_name, u.username as user_username', 'SELECT COUNT(*) as total');
      const [countResult] = await connection.query(countQuery, params);
      const total = countResult[0].total;

      // Add ordering and pagination
      query += ' ORDER BY h.created_at DESC LIMIT ? OFFSET ?';
      params.push(parseInt(limit), parseInt(offset));

      const [history] = await connection.query(query, params);

      // Format the history entries
      const formattedHistory = history.map(entry => ({
        id: entry.id,
        change_type: entry.change_type,
        change_type_label: CHANGE_TYPE_LABELS[entry.change_type] || entry.change_type,
        field_name: entry.field_name,
        old_value: entry.old_value,
        new_value: entry.new_value,
        changed_by: entry.changed_by,
        changed_by_name: entry.changed_by_name || entry.user_full_name || entry.user_username || 'Unknown',
        ip_address: entry.ip_address,
        created_at: entry.created_at
      }));

      res.json({
        success: true,
        item: {
          id: item.id,
          cmdb_id: item.cmdb_id,
          asset_name: item.asset_name
        },
        history: formattedHistory,
        pagination: {
          total,
          limit: parseInt(limit),
          offset: parseInt(offset),
          has_more: parseInt(offset) + history.length < total
        },
        change_types: Object.entries(CHANGE_TYPE_LABELS).map(([value, label]) => ({ value, label }))
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching CMDB history:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

/**
 * GET /:tenantCode/history
 * Get recent change history across all CMDB items (Admin)
 */
router.get('/:tenantCode/history', async (req, res) => {
  try {
    const { tenantCode } = req.params;
    const {
      change_type,
      from_date,
      to_date,
      user_id,
      limit = 100,
      offset = 0
    } = req.query;

    const connection = await getTenantConnection(tenantCode);

    try {
      // Build query
      let query = `
        SELECT h.*,
               cm.cmdb_id, cm.asset_name, cm.asset_category,
               u.full_name as user_full_name, u.username as user_username
        FROM cmdb_change_history h
        JOIN cmdb_items cm ON h.cmdb_item_id = cm.id
        LEFT JOIN users u ON h.changed_by = u.id
        WHERE 1=1
      `;
      const params = [];

      // Filter by change type
      if (change_type) {
        query += ' AND h.change_type = ?';
        params.push(change_type);
      }

      // Filter by date range
      if (from_date) {
        query += ' AND h.created_at >= ?';
        params.push(from_date);
      }

      if (to_date) {
        query += ' AND h.created_at <= ?';
        params.push(to_date);
      }

      // Filter by user
      if (user_id) {
        query += ' AND h.changed_by = ?';
        params.push(user_id);
      }

      // Get total count
      const countQuery = query.replace(
        'SELECT h.*, cm.cmdb_id, cm.asset_name, cm.asset_category, u.full_name as user_full_name, u.username as user_username',
        'SELECT COUNT(*) as total'
      );
      const [countResult] = await connection.query(countQuery, params);
      const total = countResult[0].total;

      // Add ordering and pagination
      query += ' ORDER BY h.created_at DESC LIMIT ? OFFSET ?';
      params.push(parseInt(limit), parseInt(offset));

      const [history] = await connection.query(query, params);

      // Format the history entries
      const formattedHistory = history.map(entry => ({
        id: entry.id,
        cmdb_item_id: entry.cmdb_item_id,
        cmdb_id: entry.cmdb_id,
        asset_name: entry.asset_name,
        asset_category: entry.asset_category,
        change_type: entry.change_type,
        change_type_label: CHANGE_TYPE_LABELS[entry.change_type] || entry.change_type,
        field_name: entry.field_name,
        old_value: entry.old_value,
        new_value: entry.new_value,
        changed_by: entry.changed_by,
        changed_by_name: entry.changed_by_name || entry.user_full_name || entry.user_username || 'Unknown',
        ip_address: entry.ip_address,
        created_at: entry.created_at
      }));

      res.json({
        success: true,
        history: formattedHistory,
        pagination: {
          total,
          limit: parseInt(limit),
          offset: parseInt(offset),
          has_more: parseInt(offset) + history.length < total
        },
        change_types: Object.entries(CHANGE_TYPE_LABELS).map(([value, label]) => ({ value, label }))
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching CMDB history:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

/**
 * GET /:tenantCode/history/export
 * Export audit log as CSV (Admin only)
 */
router.get('/:tenantCode/history/export', requireAdmin, async (req, res) => {
  try {
    const { tenantCode } = req.params;
    const {
      from_date,
      to_date
    } = req.query;

    const connection = await getTenantConnection(tenantCode);

    try {
      // Build query
      let query = `
        SELECT h.*,
               cm.cmdb_id, cm.asset_name, cm.asset_category,
               u.full_name as user_full_name, u.username as user_username
        FROM cmdb_change_history h
        JOIN cmdb_items cm ON h.cmdb_item_id = cm.id
        LEFT JOIN users u ON h.changed_by = u.id
        WHERE 1=1
      `;
      const params = [];

      // Filter by date range
      if (from_date) {
        query += ' AND h.created_at >= ?';
        params.push(from_date);
      }

      if (to_date) {
        query += ' AND h.created_at <= ?';
        params.push(to_date);
      }

      query += ' ORDER BY h.created_at DESC';

      const [history] = await connection.query(query, params);

      // Build CSV
      const csvHeaders = [
        'Timestamp',
        'CMDB ID',
        'Asset Name',
        'Asset Category',
        'Change Type',
        'Field Name',
        'Old Value',
        'New Value',
        'Changed By',
        'IP Address'
      ];

      const csvRows = history.map(entry => [
        entry.created_at ? new Date(entry.created_at).toISOString() : '',
        entry.cmdb_id || '',
        entry.asset_name || '',
        entry.asset_category || '',
        CHANGE_TYPE_LABELS[entry.change_type] || entry.change_type || '',
        entry.field_name || '',
        (entry.old_value || '').replace(/"/g, '""'),
        (entry.new_value || '').replace(/"/g, '""'),
        entry.changed_by_name || entry.user_full_name || entry.user_username || '',
        entry.ip_address || ''
      ]);

      // Escape CSV values
      const escapeCSV = (value) => {
        if (value === null || value === undefined) return '';
        const str = String(value);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };

      const csvContent = [
        csvHeaders.join(','),
        ...csvRows.map(row => row.map(escapeCSV).join(','))
      ].join('\n');

      const filename = `cmdb_audit_log_${tenantCode}_${new Date().toISOString().split('T')[0]}.csv`;

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csvContent);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error exporting CMDB history:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

/**
 * GET /:tenantCode/history/stats
 * Get change history statistics (Admin)
 */
router.get('/:tenantCode/history/stats', requireAdmin, async (req, res) => {
  try {
    const { tenantCode } = req.params;
    const { days = 30 } = req.query;

    const connection = await getTenantConnection(tenantCode);

    try {
      // Changes by type
      const [byType] = await connection.query(
        `SELECT change_type, COUNT(*) as count
         FROM cmdb_change_history
         WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         GROUP BY change_type
         ORDER BY count DESC`,
        [parseInt(days)]
      );

      // Changes by user
      const [byUser] = await connection.query(
        `SELECT h.changed_by, h.changed_by_name, u.full_name, u.username, COUNT(*) as count
         FROM cmdb_change_history h
         LEFT JOIN users u ON h.changed_by = u.id
         WHERE h.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         GROUP BY h.changed_by, h.changed_by_name, u.full_name, u.username
         ORDER BY count DESC
         LIMIT 10`,
        [parseInt(days)]
      );

      // Changes by day
      const [byDay] = await connection.query(
        `SELECT DATE(created_at) as date, COUNT(*) as count
         FROM cmdb_change_history
         WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         GROUP BY DATE(created_at)
         ORDER BY date DESC`,
        [parseInt(days)]
      );

      // Most changed items
      const [topItems] = await connection.query(
        `SELECT h.cmdb_item_id, cm.cmdb_id, cm.asset_name, cm.asset_category, COUNT(*) as change_count
         FROM cmdb_change_history h
         JOIN cmdb_items cm ON h.cmdb_item_id = cm.id
         WHERE h.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         GROUP BY h.cmdb_item_id, cm.cmdb_id, cm.asset_name, cm.asset_category
         ORDER BY change_count DESC
         LIMIT 10`,
        [parseInt(days)]
      );

      // Total count
      const [totalResult] = await connection.query(
        `SELECT COUNT(*) as total FROM cmdb_change_history
         WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
        [parseInt(days)]
      );

      res.json({
        success: true,
        period_days: parseInt(days),
        total_changes: totalResult[0].total,
        by_type: byType.map(t => ({
          change_type: t.change_type,
          change_type_label: CHANGE_TYPE_LABELS[t.change_type] || t.change_type,
          count: t.count
        })),
        by_user: byUser.map(u => ({
          user_id: u.changed_by,
          user_name: u.changed_by_name || u.full_name || u.username || 'Unknown',
          count: u.count
        })),
        by_day: byDay,
        top_changed_items: topItems
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching CMDB history stats:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
