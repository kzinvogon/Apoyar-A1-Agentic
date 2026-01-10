/**
 * Notifications API Routes
 * Admin access to SLA notifications
 */

const express = require('express');
const router = express.Router();
const { getTenantConnection } = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');

/**
 * GET /api/notifications/:tenantCode
 * Fetch notifications with filtering and pagination
 *
 * Query params:
 * - limit (default 50, max 200)
 * - offset (default 0)
 * - severity (optional: info|warning|critical)
 * - type (optional: e.g. SLA_RESPONSE_NEAR)
 * - delivered (optional: 0|1)
 * - from (optional ISO date)
 * - to (optional ISO date)
 * - ticket_id (optional)
 */
router.get('/:tenantCode', verifyToken, requireRole(['admin']), async (req, res) => {
  const { tenantCode } = req.params;
  const {
    limit = 50,
    offset = 0,
    severity,
    type,
    delivered,
    from,
    to,
    ticket_id
  } = req.query;

  // Validate and sanitize limit/offset
  const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const parsedOffset = Math.max(parseInt(offset, 10) || 0, 0);

  let connection;
  try {
    connection = await getTenantConnection(tenantCode);

    // Build WHERE clause dynamically
    const conditions = [];
    const params = [];

    if (severity && ['info', 'warning', 'critical'].includes(severity)) {
      conditions.push('severity = ?');
      params.push(severity);
    }

    if (type) {
      conditions.push('type = ?');
      params.push(type);
    }

    if (delivered !== undefined) {
      if (delivered === '1' || delivered === 'true') {
        conditions.push('delivered_at IS NOT NULL');
      } else if (delivered === '0' || delivered === 'false') {
        conditions.push('delivered_at IS NULL');
      }
    }

    if (from) {
      conditions.push('created_at >= ?');
      params.push(from);
    }

    if (to) {
      conditions.push('created_at <= ?');
      params.push(to);
    }

    if (ticket_id) {
      const parsedTicketId = parseInt(ticket_id, 10);
      if (!isNaN(parsedTicketId)) {
        conditions.push('ticket_id = ?');
        params.push(parsedTicketId);
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const [countResult] = await connection.query(
      `SELECT COUNT(*) as total FROM notifications ${whereClause}`,
      params
    );
    const total = countResult[0].total;

    // Get notifications
    const [notifications] = await connection.query(
      `SELECT id, ticket_id, type, severity, message, payload_json, created_at, delivered_at
       FROM notifications
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parsedLimit, parsedOffset]
    );

    res.json({
      success: true,
      total,
      limit: parsedLimit,
      offset: parsedOffset,
      notifications
    });

  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  } finally {
    if (connection) connection.release();
  }
});

/**
 * PATCH /api/notifications/:tenantCode/:id/deliver
 * Mark a single notification as delivered
 */
router.patch('/:tenantCode/:id/deliver', verifyToken, requireRole(['admin']), async (req, res) => {
  const { tenantCode, id } = req.params;
  const notificationId = parseInt(id, 10);

  if (isNaN(notificationId)) {
    return res.status(400).json({ success: false, message: 'Invalid notification ID' });
  }

  let connection;
  try {
    connection = await getTenantConnection(tenantCode);

    // Check if notification exists
    const [existing] = await connection.query(
      'SELECT id, delivered_at FROM notifications WHERE id = ?',
      [notificationId]
    );

    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }

    // If already delivered, return idempotent success
    if (existing[0].delivered_at) {
      return res.json({
        success: true,
        message: 'Already delivered',
        id: notificationId,
        delivered_at: existing[0].delivered_at
      });
    }

    // Mark as delivered
    await connection.query(
      'UPDATE notifications SET delivered_at = NOW() WHERE id = ?',
      [notificationId]
    );

    // Get the updated timestamp
    const [updated] = await connection.query(
      'SELECT delivered_at FROM notifications WHERE id = ?',
      [notificationId]
    );

    res.json({
      success: true,
      id: notificationId,
      delivered_at: updated[0].delivered_at
    });

  } catch (error) {
    console.error('Error marking notification delivered:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  } finally {
    if (connection) connection.release();
  }
});

/**
 * PATCH /api/notifications/:tenantCode/deliver-bulk
 * Mark multiple notifications as delivered by IDs
 * Body: { ids: [1, 2, 3] }
 */
router.patch('/:tenantCode/deliver-bulk', verifyToken, requireRole(['admin']), async (req, res) => {
  const { tenantCode } = req.params;
  const { ids } = req.body;

  // Validate ids array
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ success: false, message: 'ids must be a non-empty array' });
  }

  // Parse and validate all IDs
  const parsedIds = ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
  if (parsedIds.length === 0) {
    return res.status(400).json({ success: false, message: 'No valid IDs provided' });
  }

  // Limit bulk operations
  if (parsedIds.length > 100) {
    return res.status(400).json({ success: false, message: 'Maximum 100 IDs per bulk operation' });
  }

  let connection;
  try {
    connection = await getTenantConnection(tenantCode);

    // Update all matching notifications that haven't been delivered yet
    const placeholders = parsedIds.map(() => '?').join(',');
    const [result] = await connection.query(
      `UPDATE notifications SET delivered_at = NOW() WHERE id IN (${placeholders}) AND delivered_at IS NULL`,
      parsedIds
    );

    res.json({
      success: true,
      updated_count: result.affectedRows
    });

  } catch (error) {
    console.error('Error bulk marking notifications delivered:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
