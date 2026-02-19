const express = require('express');
const router = express.Router();
const { getTenantConnection } = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');
const { body } = require('express-validator');
const { handleValidationErrors } = require('../middleware/validation');
const {
  writeOperationsLimiter,
  readOperationsLimiter
} = require('../middleware/rateLimiter');
const {
  getValidAccessToken,
  buildXOAuth2Token
} = require('../services/oauth2-helper');

// ============================================================================
// All routes require authentication
// ============================================================================
router.use(verifyToken);

// Validation for email ingest settings
const validateEmailIngestSettings = [
  body('enabled')
    .optional()
    .isBoolean().withMessage('Enabled must be a boolean'),
  body('server_type')
    .optional()
    .isIn(['imap', 'pop3']).withMessage('Server type must be imap or pop3'),
  body('server_host')
    .optional()
    .trim()
    .isLength({ min: 3, max: 255 }).withMessage('Server host must be between 3 and 255 characters'),
  body('server_port')
    .optional()
    .isInt({ min: 1, max: 65535 }).withMessage('Server port must be between 1 and 65535'),
  body('use_ssl')
    .optional()
    .isBoolean().withMessage('Use SSL must be a boolean'),
  body('username')
    .optional()
    .trim()
    .isLength({ max: 255 }).withMessage('Username must not exceed 255 characters'),
  body('password')
    .optional()
    .trim()
    .isLength({ max: 255 }).withMessage('Password must not exceed 255 characters'),
  body('check_interval_minutes')
    .optional()
    .isInt({ min: 1, max: 60 }).withMessage('Check interval must be between 1 and 60 minutes'),
  handleValidationErrors
];

// Get email ingest settings
router.get('/:tenantId/settings', readOperationsLimiter, async (req, res) => {
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
  // Keep oauth2_email, auth_method, oauth2_token_expiry for status display
  return safe;
}

// Update email ingest settings
router.put('/:tenantId/settings', requireRole(['admin']), writeOperationsLimiter, validateEmailIngestSettings, async (req, res) => {
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
      oauth2_email
    } = req.body;

    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      // Check if settings exist
      const [existingSettings] = await connection.query('SELECT id, password FROM email_ingest_settings ORDER BY id ASC LIMIT 1');

      // If password is '******', keep existing password
      let actualPassword = password;
      if (password === '******' && existingSettings.length > 0) {
        actualPassword = existingSettings[0].password;
      }

      if (existingSettings.length === 0) {
        // Insert new settings
        await connection.query(`
          INSERT INTO email_ingest_settings (enabled, server_type, server_host, server_port, use_ssl, username, password, check_interval_minutes, auth_method, oauth2_email)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [enabled, server_type, server_host, server_port, use_ssl, username, actualPassword, check_interval_minutes, auth_method || 'basic', oauth2_email || null]);
      } else {
        // Update existing settings
        await connection.query(`
          UPDATE email_ingest_settings SET
            enabled = COALESCE(?, enabled),
            server_type = COALESCE(?, server_type),
            server_host = COALESCE(?, server_host),
            server_port = COALESCE(?, server_port),
            use_ssl = COALESCE(?, use_ssl),
            username = COALESCE(?, username),
            password = COALESCE(?, password),
            check_interval_minutes = COALESCE(?, check_interval_minutes),
            auth_method = COALESCE(?, auth_method),
            oauth2_email = COALESCE(?, oauth2_email),
            updated_at = NOW()
          WHERE id = ?
        `, [enabled, server_type, server_host, server_port, use_ssl, username, actualPassword, check_interval_minutes, auth_method || null, oauth2_email || null, existingSettings[0].id]);
      }

      // Fetch updated settings to return current state
      const [updatedSettings] = await connection.query('SELECT enabled FROM email_ingest_settings ORDER BY id ASC LIMIT 1');
      const currentEnabled = updatedSettings.length > 0 ? !!updatedSettings[0].enabled : false;

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

// Manually trigger email processing
router.post('/:tenantId/process-now', requireRole(['admin']), writeOperationsLimiter, async (req, res) => {
  try {
    const { tenantId } = req.params;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');

    // Import EmailProcessor
    const { EmailProcessor } = require('../services/email-processor');
    const processor = new EmailProcessor(tenantCode);

    console.log(`Manual email processing triggered for tenant: ${tenantCode}`);

    // Process emails immediately (don't await to avoid timeout)
    processor.processEmails().then(result => {
      console.log(`Manual email processing completed for tenant: ${tenantCode}`);
    }).catch(error => {
      console.error(`Manual email processing failed for tenant: ${tenantCode}`, error);
    });

    res.json({
      success: true,
      message: 'Email processing triggered. Check server logs for details.'
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

      // OAuth2 test connection (client credentials flow)
      if (config.auth_method === 'oauth2') {
        if (!config.oauth2_email) {
          return res.json({ success: false, message: 'Microsoft 365 email address not configured. Enter the mailbox email and save settings first.' });
        }

        const { accessToken, email } = await getValidAccessToken(connection, tenantCode);

        // Decode and log JWT claims for diagnostics
        try {
          const jwtParts = accessToken.split('.');
          if (jwtParts.length === 3) {
            const payload = JSON.parse(Buffer.from(jwtParts[1], 'base64').toString());
            console.log('[OAuth2 Token Diagnostics]', JSON.stringify({
              aud: payload.aud,
              appid: payload.appid,
              tid: payload.tid,
              roles: payload.roles,
              scp: payload.scp,
              iss: payload.iss,
              exp: payload.exp,
              iat: payload.iat
            }, null, 2));
          }
        } catch (decodeErr) {
          console.log('[OAuth2] Could not decode token for diagnostics:', decodeErr.message);
        }

        const xoauth2Token = buildXOAuth2Token(email, accessToken);

        const result = await testImapConnection({
          user: email,
          xoauth2: xoauth2Token,
          host: 'outlook.office365.com',
          port: 993,
          tls: true
        });

        return res.json({
          success: true,
          message: 'Microsoft 365 connection test successful',
          details: {
            server: 'outlook.office365.com',
            port: 993,
            type: 'OAuth2 / Client Credentials',
            email: email,
            totalMessages: result.totalMessages,
            unseenMessages: result.unseenMessages
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
        tls: config.use_ssl === true || config.use_ssl === 1 || config.use_ssl === '1'
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
 * Test IMAP connection with either password or XOAUTH2 auth
 */
function testImapConnection({ user, password, xoauth2, host, port, tls }) {
  return new Promise((resolve, reject) => {
    const Imap = require('imap');
    console.log(`[Email Test] Connecting to ${host}:${port} TLS=${tls} user=${user} auth=${xoauth2 ? 'xoauth2' : 'password'}`);

    const imapConfig = {
      user,
      host,
      port,
      tls,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 15000,
      authTimeout: 15000,
      debug: (msg) => console.log(`[IMAP Debug] ${msg}`)
    };

    if (xoauth2) {
      imapConfig.xoauth2 = xoauth2;
    } else {
      imapConfig.password = password;
    }

    const imap = new Imap(imapConfig);

    const timeout = setTimeout(() => {
      imap.destroy();
      reject(new Error('Connection timeout'));
    }, 20000);

    imap.once('ready', () => {
      clearTimeout(timeout);
      imap.openBox('INBOX', true, (err, box) => {
        if (err) {
          imap.end();
          reject(err);
        } else {
          const result = {
            totalMessages: box.messages.total,
            unseenMessages: box.messages.unseen
          };
          imap.end();
          resolve(result);
        }
      });
    });

    imap.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    imap.connect();
  });
}

module.exports = router;
