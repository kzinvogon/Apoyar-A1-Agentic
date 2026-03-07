/**
 * Admin Routes
 * Admin-only endpoints for system management
 */

const express = require('express');
const router = express.Router();
const { masterQuery } = require('../config/database');
const { verifyToken, requireRole, requireElevatedAdmin } = require('../middleware/auth');
const { runHousekeepingForTenant, getRetentionConfig } = require('../services/housekeeping');
const { getTenantConnection } = require('../config/database');

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
    const countResult = await masterQuery(
      `SELECT COUNT(*) as total FROM audit_log ${whereClause}`,
      params
    );
    const total = countResult[0].total;

    // Get paginated results
    const rows = await masterQuery(
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

    const rows = await masterQuery(
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

/**
 * POST /api/admin/housekeeping/run
 * Manually trigger housekeeping for the current tenant
 */
router.post('/housekeeping/run', requireElevatedAdmin, async (req, res) => {
  try {
    const tenantCode = req.user.tenantCode;

    // Look up the tenant's plan slug
    const rows = await masterQuery(
      `SELECT sp.slug as plan_slug
       FROM tenants t
       LEFT JOIN tenant_subscriptions ts ON t.id = ts.tenant_id
       LEFT JOIN subscription_plans sp ON ts.plan_id = sp.id
       WHERE t.tenant_code = ?`,
      [tenantCode]
    );
    const planSlug = rows.length > 0 ? rows[0].plan_slug : null;

    const result = await runHousekeepingForTenant(tenantCode, planSlug);

    res.json({ success: true, tenantCode, ...result });
  } catch (error) {
    console.error('[Admin] Housekeeping error:', error);
    res.status(500).json({ success: false, error: 'Housekeeping failed' });
  }
});

/**
 * GET /api/admin/housekeeping/info
 * Return plan name, retention config, and tenant override
 */
router.get('/housekeeping/info', requireElevatedAdmin, async (req, res) => {
  try {
    const tenantCode = req.user.tenantCode;

    // Look up plan slug
    const rows = await masterQuery(
      `SELECT sp.slug as plan_slug, sp.name as plan_name
       FROM tenants t
       LEFT JOIN tenant_subscriptions ts ON t.id = ts.tenant_id
       LEFT JOIN subscription_plans sp ON ts.plan_id = sp.id
       WHERE t.tenant_code = ?`,
      [tenantCode]
    );
    const planSlug = rows.length > 0 ? rows[0].plan_slug : null;
    const planName = rows.length > 0 ? rows[0].plan_name : 'Unknown';

    // Look up tenant override
    let override = null;
    try {
      const conn = await getTenantConnection(tenantCode);
      try {
        const [settings] = await conn.query(
          `SELECT setting_value FROM tenant_settings WHERE setting_key = 'data_retention_days'`
        );
        if (settings.length > 0 && settings[0].setting_value) {
          override = parseInt(settings[0].setting_value, 10) || null;
        }
      } finally {
        conn.release();
      }
    } catch (e) {
      // tenant_settings may not exist — fine
    }

    const retention = getRetentionConfig(planSlug, override);

    res.json({ success: true, plan: planName, planSlug, retention, override });
  } catch (error) {
    console.error('[Admin] Housekeeping info error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/admin/housekeeping/override
 * Save or clear the data_retention_days override
 */
router.post('/housekeeping/override', requireElevatedAdmin, async (req, res) => {
  try {
    const tenantCode = req.user.tenantCode;
    const { days } = req.body;
    const conn = await getTenantConnection(tenantCode);
    try {
      if (days && parseInt(days, 10) > 0) {
        await conn.query(
          `INSERT INTO tenant_settings (setting_key, setting_value, setting_type, description)
           VALUES ('data_retention_days', ?, 'number', 'Custom log retention days override')
           ON DUPLICATE KEY UPDATE setting_value = ?, updated_at = NOW()`,
          [String(days), String(days)]
        );
      } else {
        await conn.query(`DELETE FROM tenant_settings WHERE setting_key = 'data_retention_days'`);
      }
    } finally {
      conn.release();
    }
    res.json({ success: true });
  } catch (error) {
    console.error('[Admin] Housekeeping override error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
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

/**
 * POST /api/admin/reconcile-backfill
 * TEMPORARY: Replay specific message_ids through processEmail via Graph API fetch.
 * Body: { messageIds: ['<msg1>', '<msg2>'] }
 * Remove after reconciliation is complete.
 */
router.post('/reconcile-backfill', async (req, res) => {
  const { messageIds } = req.body;
  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    return res.status(400).json({ error: 'messageIds array required' });
  }
  if (messageIds.length > 20) {
    return res.status(400).json({ error: 'Max 20 messages per call' });
  }

  const tenantCode = req.user.tenantCode;
  const { EmailProcessor } = require('../services/email-processor');
  const { simpleParser } = require('mailparser');

  let connection;
  try {
    connection = await getTenantConnection(tenantCode);

    // Get mailbox config
    const [settingsRows] = await connection.query(
      'SELECT id, oauth2_email, auth_method FROM email_ingest_settings ORDER BY id ASC LIMIT 1'
    );
    if (settingsRows.length === 0) {
      return res.status(404).json({ error: 'No email_ingest_settings found' });
    }
    const mailboxId = settingsRows[0].id;
    const userEmail = settingsRows[0].oauth2_email;

    if (settingsRows[0].auth_method !== 'oauth2') {
      return res.status(400).json({ error: 'Only oauth2 mailboxes supported' });
    }

    // Get Graph API token
    const { getValidAccessToken } = require('../services/oauth2-helper');
    const { accessToken } = await getValidAccessToken(connection, tenantCode);

    const processor = new EmailProcessor(tenantCode, {
      getConnection: () => getTenantConnection(tenantCode),
    });

    const results = [];
    for (const msgId of messageIds) {
      try {
        // Fetch by internetMessageId
        const filterUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userEmail)}/messages?$filter=internetMessageId eq '${encodeURIComponent(msgId)}'&$select=id,internetMessageId`;
        const searchRes = await fetch(filterUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!searchRes.ok) {
          results.push({ message_id: msgId, status: 'error', detail: `Graph search: ${searchRes.status}` });
          continue;
        }
        const searchData = await searchRes.json();
        if (!searchData.value || searchData.value.length === 0) {
          results.push({ message_id: msgId, status: 'not_found', detail: 'Not in mailbox' });
          continue;
        }
        const graphId = searchData.value[0].id;

        // Fetch MIME
        const mimeRes = await fetch(
          `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userEmail)}/messages/${graphId}/$value`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!mimeRes.ok) {
          results.push({ message_id: msgId, status: 'error', detail: `MIME fetch: ${mimeRes.status}` });
          continue;
        }
        const mimeBuffer = Buffer.from(await mimeRes.arrayBuffer());
        const parsed = await simpleParser(mimeBuffer);

        const emailData = {
          from: parsed.from?.text || parsed.from?.value?.[0]?.address || '',
          subject: parsed.subject || '(No Subject)',
          body: parsed.text || parsed.html || '(No content)',
          html: parsed.html || '',
          text: parsed.text || '',
          messageId: msgId,
          date: parsed.date || new Date(),
          uid: null,
          inReplyTo: parsed.inReplyTo || null,
          references: parsed.references || [],
          graphMessageId: graphId
        };

        // Replay
        const procConn = await getTenantConnection(tenantCode);
        try {
          const result = await processor.processEmail(procConn, emailData);
          let resultType = 'ticket_created';
          if (!result.success) {
            if (result.reason === 'bounce_notification_skipped') resultType = 'skipped_bounce';
            else if (result.reason === 'domain_not_found') resultType = 'skipped_domain';
            else if (result.reason === 'skipped_system') resultType = 'skipped_system';
            else resultType = 'error';
          } else if (result.wasReply) {
            resultType = 'ticket_updated';
          }

          await processor.recordProcessedMessage(procConn, mailboxId, msgId, null, result.ticketId || null, resultType);

          results.push({
            message_id: msgId,
            status: resultType,
            ticketId: result.ticketId || null,
            from: emailData.from,
            subject: emailData.subject
          });
        } finally {
          procConn.release();
        }
      } catch (err) {
        results.push({ message_id: msgId, status: 'error', detail: err.message });
      }

      // Rate limit
      await new Promise(r => setTimeout(r, 2000));
    }

    res.json({ backfilled: results.filter(r => ['ticket_created','ticket_updated'].includes(r.status)).length, total: results.length, results });
  } catch (err) {
    console.error('Reconcile backfill error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
