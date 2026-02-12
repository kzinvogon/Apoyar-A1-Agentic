/**
 * Admin Routes
 * Admin-only endpoints for system management
 */

const express = require('express');
const router = express.Router();
const { masterQuery } = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');

// Apply authentication to all routes
router.use(verifyToken);
router.use(requireRole(['admin']));

/**
 * GET /api/admin/audit-log
 * Retrieve audit log entries with pagination and filters
 */
router.get('/audit-log', async (req, res) => {
  try {
    const {
      limit = 50,
      offset = 0,
      user,
      action,
      dateFrom,
      dateTo
    } = req.query;

    // Get tenant code from authenticated user
    const tenantCode = req.user.tenantCode;

    // Build query with filters
    let whereClause = 'WHERE tenant_code = ?';
    const params = [tenantCode];

    if (user) {
      whereClause += ' AND username LIKE ?';
      params.push(`%${user}%`);
    }

    if (action) {
      whereClause += ' AND action = ?';
      params.push(action);
    }

    if (dateFrom) {
      whereClause += ' AND created_at >= ?';
      params.push(dateFrom);
    }

    if (dateTo) {
      whereClause += ' AND created_at <= ?';
      params.push(dateTo + ' 23:59:59');
    }

    // Get total count
    const [countResult] = await masterQuery(
      `SELECT COUNT(*) as total FROM audit_log ${whereClause}`,
      params
    );
    const total = countResult[0].total;

    // Get paginated results
    const [rows] = await masterQuery(
      `SELECT id, tenant_code, user_id, username, action, entity_type, entity_id,
              details_json, ip, created_at
       FROM audit_log
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    // Sanitize details_json - remove any potentially sensitive data
    const sanitizedRows = rows.map(row => ({
      ...row,
      details_json: row.details_json ? sanitizeDetails(row.details_json) : null,
      ip: row.ip ? maskIp(row.ip) : null
    }));

    res.json({
      success: true,
      data: sanitizedRows,
      pagination: {
        total,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: parseInt(offset) + sanitizedRows.length < total
      }
    });

  } catch (error) {
    console.error('[Admin] Audit log error:', error);
    res.status(500).json({ success: false, error: 'Failed to retrieve audit log' });
  }
});

/**
 * GET /api/admin/audit-log/actions
 * Get distinct action types for filter dropdown
 */
router.get('/audit-log/actions', async (req, res) => {
  try {
    const tenantCode = req.user.tenantCode;

    const [rows] = await masterQuery(
      `SELECT DISTINCT action FROM audit_log WHERE tenant_code = ? ORDER BY action`,
      [tenantCode]
    );

    res.json({
      success: true,
      actions: rows.map(r => r.action)
    });

  } catch (error) {
    console.error('[Admin] Audit actions error:', error);
    res.status(500).json({ success: false, error: 'Failed to retrieve actions' });
  }
});

// Helper: Sanitize details JSON
function sanitizeDetails(details) {
  if (!details) return null;
  // Already sanitized by auditLog.js, but double-check
  const safe = { ...details };
  const sensitiveKeys = ['password', 'token', 'secret', 'apiKey', 'oldValue', 'newValue'];
  for (const key of sensitiveKeys) {
    if (safe[key] !== undefined && typeof safe[key] === 'string' && safe[key].length > 0) {
      safe[key] = '[REDACTED]';
    }
  }
  return safe;
}

// Helper: Mask IP address for privacy
function maskIp(ip) {
  if (!ip) return null;
  // Show first part, mask the rest
  if (ip.includes('.')) {
    const parts = ip.split('.');
    return `${parts[0]}.${parts[1]}.*.*`;
  }
  return ip.substring(0, 10) + '...';
}

module.exports = router;
