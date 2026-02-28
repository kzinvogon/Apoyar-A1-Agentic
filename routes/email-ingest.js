const express = require('express');
const router = express.Router();
const { getTenantConnection } = require('../config/database');
const { verifyToken, requireRole, requireElevatedAdmin } = require('../middleware/auth');
const { applyTenantMatch } = require('../middleware/tenantMatch');
const { body } = require('express-validator');
const { handleValidationErrors } = require('../middleware/validation');
const {
  writeOperationsLimiter,
  readOperationsLimiter
} = require('../middleware/rateLimiter');
const {
  getValidAccessToken
} = require('../services/oauth2-helper');
const { tryLock, unlock } = require('../services/imap-lock');
const { ImapFlow } = require('imapflow');
const fetch = require('node-fetch');

// ============================================================================
// All routes require authentication
// ============================================================================
router.use(verifyToken);
applyTenantMatch(router);

// Validation for email ingest settings
const validateEmailIngestSettings = [
  body('enabled')
    .optional()
    .isBoolean().withMessage('Enabled must be a boolean'),
  body('server_type')
    .optional({ checkFalsy: true })
    .isIn(['imap', 'pop3']).withMessage('Server type must be imap or pop3'),
  body('server_host')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ min: 3, max: 255 }).withMessage('Server host must be between 3 and 255 characters'),
  body('server_port')
    .optional({ checkFalsy: true })
    .isInt({ min: 1, max: 65535 }).withMessage('Server port must be between 1 and 65535'),
  body('use_ssl')
    .optional()
    .isBoolean().withMessage('Use SSL must be a boolean'),
  body('username')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 255 }).withMessage('Username must not exceed 255 characters'),
  body('password')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 255 }).withMessage('Password must not exceed 255 characters'),
  body('check_interval_minutes')
    .optional()
    .isInt({ min: 1, max: 60 }).withMessage('Check interval must be between 1 and 60 minutes'),
  body('m365_enabled')
    .optional()
    .isBoolean().withMessage('m365_enabled must be a boolean'),
  body('m365_use_for_outbound')
    .optional()
    .isBoolean().withMessage('m365_use_for_outbound must be a boolean'),
  handleValidationErrors
];

// Get email ingest settings (system admin only)
router.get('/:tenantId/settings', requireElevatedAdmin, readOperationsLimiter, async (req, res) => {
  try {
    const { tenantId } = req.params;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      const [settings] = await connection.query('SELECT * FROM email_ingest_settings ORDER BY id ASC LIMIT 1');

      if (settings.length === 0) {
        // Create default settings if none exist
        await connection.query(`
          INSERT INTO email_ingest_settings (enabled, server_type, server_host, server_port, use_ssl, username, password, check_interval_minutes)
          VALUES (FALSE, 'imap', 'imap.gmail.com', 993, TRUE, '', '', 5)
        `);

        const [newSettings] = await connection.query('SELECT * FROM email_ingest_settings LIMIT 1');
        const settingsData = { ...newSettings[0], password: '******' };
        res.json({ success: true, settings: sanitizeSettings(settingsData) });
      } else {
        const settingsData = { ...settings[0], password: settings[0].password ? '******' : '' };
        res.json({ success: true, settings: sanitizeSettings(settingsData) });
      }
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching email ingest settings:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

/**
 * Remove sensitive token values from settings before sending to client
 */
function sanitizeSettings(settings) {
  const safe = { ...settings };
  delete safe.oauth2_access_token;
  delete safe.oauth2_refresh_token;
  delete safe.graph_delta_link;
  // Keep oauth2_email, auth_method, oauth2_token_expiry for status display
  return safe;
}

// Update email ingest settings (system admin only)
router.put('/:tenantId/settings', requireElevatedAdmin, writeOperationsLimiter, validateEmailIngestSettings, async (req, res) => {
  try {
    const { tenantId } = req.params;
    const {
      enabled,
      server_type,
      server_host,
      server_port,
      use_ssl,
      username,
      password,
      check_interval_minutes,
      auth_method,
      oauth2_email,
      use_for_outbound,
      m365_enabled,
      m365_use_for_outbound,
      smtp_host,
      smtp_port
    } = req.body;

    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      // Check if settings exist — fetch all fields so we can preserve unset ones
      const [existingSettings] = await connection.query('SELECT * FROM email_ingest_settings ORDER BY id ASC LIMIT 1');
      const existing = existingSettings[0] || {};

      // If password is '******', keep existing password
      let actualPassword = password;
      if (password === '******' && existingSettings.length > 0) {
        actualPassword = existing.password;
      }

      if (existingSettings.length === 0) {
        // Insert new settings
        await connection.query(`
          INSERT INTO email_ingest_settings (enabled, server_type, server_host, server_port, use_ssl, username, password, check_interval_minutes, auth_method, oauth2_email, use_for_outbound, m365_enabled, m365_use_for_outbound, smtp_host, smtp_port)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [enabled, server_type, server_host, server_port, use_ssl, username, actualPassword, check_interval_minutes, auth_method || 'basic', oauth2_email || null, use_for_outbound || 0, m365_enabled || 0, m365_use_for_outbound || 0, smtp_host || null, smtp_port || 587]);
      } else {
        // System Settings "Process Emails" toggle sends only {enabled} without auth_method.
        // Detect this and update the correct per-provider flag.
        let effectiveEnabled = enabled;
        let effectiveM365Enabled = m365_enabled;

        if (enabled !== undefined && auth_method === undefined) {
          // System Settings toggle — route to the correct provider flag
          if (existing.auth_method === 'oauth2') {
            effectiveM365Enabled = enabled;
            effectiveEnabled = undefined; // don't touch IMAP enabled
          }
          // else: existing is basic/imap, effectiveEnabled already has the value
        }

        // Update existing settings — only overwrite fields that were explicitly sent
        await connection.query(`
          UPDATE email_ingest_settings SET
            enabled = ?,
            server_type = ?,
            server_host = ?,
            server_port = ?,
            use_ssl = ?,
            username = ?,
            password = ?,
            check_interval_minutes = ?,
            auth_method = ?,
            oauth2_email = ?,
            use_for_outbound = ?,
            m365_enabled = ?,
            m365_use_for_outbound = ?,
            smtp_host = ?,
            smtp_port = ?,
            updated_at = NOW()
          WHERE id = ?
        `, [
          effectiveEnabled !== undefined ? effectiveEnabled : existing.enabled,
          server_type !== undefined ? server_type : existing.server_type,
          server_host !== undefined ? server_host : existing.server_host,
          server_port !== undefined ? server_port : existing.server_port,
          use_ssl !== undefined ? use_ssl : existing.use_ssl,
          username !== undefined ? username : existing.username,
          actualPassword !== undefined ? actualPassword : existing.password,
          check_interval_minutes !== undefined ? check_interval_minutes : existing.check_interval_minutes,
          auth_method !== undefined ? auth_method : existing.auth_method,
          oauth2_email !== undefined ? oauth2_email : existing.oauth2_email,
          use_for_outbound !== undefined ? use_for_outbound : existing.use_for_outbound,
          effectiveM365Enabled !== undefined ? effectiveM365Enabled : existing.m365_enabled,
          m365_use_for_outbound !== undefined ? m365_use_for_outbound : existing.m365_use_for_outbound,
          smtp_host !== undefined ? smtp_host : existing.smtp_host,
          smtp_port !== undefined ? smtp_port : existing.smtp_port,
          existing.id
        ]);
      }

      // Fetch updated settings to return current state
      const [updatedSettings] = await connection.query('SELECT enabled, m365_enabled FROM email_ingest_settings ORDER BY id ASC LIMIT 1');
      const row = updatedSettings.length > 0 ? updatedSettings[0] : {};
      const currentEnabled = !!row.enabled || !!row.m365_enabled;

      res.json({
        success: true,
        message: 'Email ingest settings updated successfully',
        enabled: currentEnabled
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error updating email ingest settings:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Clear all email ingest settings (system admin only)
router.delete('/:tenantId/settings', requireElevatedAdmin, writeOperationsLimiter, async (req, res) => {
  try {
    const { tenantId } = req.params;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      await connection.query('DELETE FROM email_ingest_settings');
      console.log(`🗑️ Cleared all email ingest settings for tenant: ${tenantCode}`);
      res.json({ success: true, message: 'Email settings cleared. No emails will be sent.' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error clearing email ingest settings:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Manually trigger email processing
router.post('/:tenantId/process-now', requireRole(['admin']), writeOperationsLimiter, async (req, res) => {
  try {
    const { tenantId } = req.params;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');

    // Import EmailProcessor
    const { EmailProcessor } = require('../services/email-processor');
    const processor = new EmailProcessor(tenantCode);

    console.log(`Manual email processing triggered for tenant: ${tenantCode}`);

    // Capture log output during processing
    const logLines = [];
    const origLog = console.log;
    const origError = console.error;
    const capture = (...args) => {
      const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
      logLines.push(line);
    };
    console.log = (...args) => { capture(...args); origLog.apply(console, args); };
    console.error = (...args) => { capture('ERROR: ' + args[0], ...args.slice(1)); origError.apply(console, args); };

    try {
      await processor.processEmails();
    } finally {
      console.log = origLog;
      console.error = origError;
    }

    console.log(`Manual email processing completed for tenant: ${tenantCode}`);

    res.json({
      success: true,
      message: 'Email processing completed',
      log: logLines
    });
  } catch (error) {
    console.error('Error triggering email processing:', error);
    res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
});

// ============================================================================
// Microsoft 365 endpoints
// ============================================================================

// GET /:tenantId/oauth2/status - Get M365 connection status
router.get('/:tenantId/oauth2/status', readOperationsLimiter, async (req, res) => {
  try {
    const { tenantId } = req.params;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      const [rows] = await connection.query(
        'SELECT auth_method, oauth2_email, oauth2_token_expiry FROM email_ingest_settings ORDER BY id ASC LIMIT 1'
      );

      if (rows.length === 0) {
        return res.json({ success: true, connected: false });
      }

      const settings = rows[0];
      const connected = settings.auth_method === 'oauth2' && !!settings.oauth2_email;

      res.json({
        success: true,
        connected,
        email: connected ? settings.oauth2_email : null,
        tokenExpiry: connected ? settings.oauth2_token_expiry : null
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('[OAuth2] Status error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// POST /:tenantId/oauth2/disconnect - Remove M365 configuration
router.post('/:tenantId/oauth2/disconnect', requireRole(['admin']), writeOperationsLimiter, async (req, res) => {
  try {
    const { tenantId } = req.params;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      await connection.query(
        `UPDATE email_ingest_settings SET
          auth_method = 'basic',
          oauth2_access_token = NULL,
          oauth2_refresh_token = NULL,
          oauth2_token_expiry = NULL,
          oauth2_email = NULL,
          updated_at = NOW()
        ORDER BY id ASC LIMIT 1`
      );

      res.json({ success: true, message: 'Microsoft 365 disconnected' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('[OAuth2] Disconnect error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Test email connection
router.post('/:tenantId/test-connection', requireRole(['admin']), writeOperationsLimiter, async (req, res) => {
  try {
    const { tenantId } = req.params;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      const [settings] = await connection.query('SELECT * FROM email_ingest_settings ORDER BY id ASC LIMIT 1');

      if (settings.length === 0) {
        return res.json({ success: false, message: 'Email ingest settings not configured' });
      }

      const config = settings[0];

      // Determine mailbox email for lock key
      const mailbox = (config.auth_method === 'oauth2' ? config.oauth2_email : config.username) || 'default';
      const lockKey = `imap:${tenantCode}:${mailbox}`;

      if (!tryLock(lockKey)) {
        return res.status(409).json({
          success: false,
          message: 'Email ingest is currently processing. Please try again in a moment.'
        });
      }

      try {
        // OAuth2 test connection via Microsoft Graph API
        if (config.auth_method === 'oauth2') {
          if (!config.oauth2_email) {
            return res.json({ success: false, message: 'Microsoft 365 email address not configured. Enter the mailbox email and save settings first.' });
          }

          const { accessToken } = await getValidAccessToken(connection, tenantCode);
          const userEmail = config.oauth2_email;

          console.log(`[Email Test] Graph API test for ${userEmail}`);

          const graphRes = await fetch(
            `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userEmail)}/mailFolders/Inbox?$select=totalItemCount,unreadItemCount`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );

          if (!graphRes.ok) {
            const errBody = await graphRes.text();
            throw new Error(`Graph API ${graphRes.status}: ${errBody}`);
          }

          const folder = await graphRes.json();

          return res.json({
            success: true,
            message: 'Microsoft 365 connection test successful',
            details: {
              server: 'graph.microsoft.com',
              port: 443,
              type: 'Graph API / Client Credentials',
              email: userEmail,
              totalMessages: folder.totalItemCount || 0,
              unseenMessages: folder.unreadItemCount || 0
            }
          });
        }

        // Basic auth test connection (existing behavior)
        if (!config.server_host || !config.username || !config.password) {
          return res.json({ success: false, message: 'Email settings incomplete - server, username, and password required' });
        }

        const result = await testImapConnection({
          user: config.username,
          password: config.password,
          host: config.server_host,
          port: config.server_port || 993,
          secure: config.use_ssl === true || config.use_ssl === 1 || config.use_ssl === '1'
        });

        res.json({
          success: true,
          message: 'Email connection test successful',
          details: {
            server: config.server_host,
            port: config.server_port,
            type: config.server_type,
            totalMessages: result.totalMessages,
            unseenMessages: result.unseenMessages
          }
        });
      } finally {
        unlock(lockKey);
      }
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error testing email connection:', error);
    res.status(500).json({
      success: false,
      message: `Connection failed: ${error.message}`,
      details: {
        error: error.message,
        hint: error.message.includes('LOGIN failed') || error.message.includes('AUTHENTICATE failed')
          ? 'Authentication rejected by server. For Microsoft 365: ensure the Application Access Policy has been configured in Exchange Online (see setup instructions). For Gmail: ensure IMAP is enabled and use an App Password if MFA is on.'
          : error.message.includes('wrong version')
          ? 'SSL/TLS mismatch. Use port 993 with SSL enabled, or port 143 without SSL.'
          : undefined
      }
    });
  }
});

/**
 * Test IMAP connection with either password or OAuth2 accessToken
 */
async function testImapConnection({ user, password, accessToken, host, port, secure }) {
  console.log(`[Email Test] Connecting to ${host}:${port} secure=${secure} user=${user} auth=${accessToken ? 'oauth2' : 'password'}`);

  const auth = accessToken ? { user, accessToken } : { user, pass: password };

  const client = new ImapFlow({
    host,
    port,
    secure,
    auth,
    tls: { rejectUnauthorized: false },
    logger: false
  });

  // Prevent unhandled 'error' events from crashing the process
  client.on('error', (err) => {
    console.error(`[Email Test] IMAP socket error: ${err.message}`);
  });

  try {
    await client.connect();
    const mailbox = await client.mailboxOpen('INBOX');
    const status = await client.status('INBOX', { unseen: true });
    return {
      totalMessages: mailbox.exists || 0,
      unseenMessages: status.unseen || 0
    };
  } finally {
    try { await client.logout(); } catch (_) {}
  }
}

module.exports = router;
