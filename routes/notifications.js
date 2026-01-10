/**
 * Notifications API Routes
 * Read-only admin access to SLA notifications
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

module.exports = router;
