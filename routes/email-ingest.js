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
  exchangeCodeForTokens,
  getValidAccessToken,
  buildXOAuth2Token,
  MS_CLIENT_ID
} = require('../services/oauth2-helper');

// ============================================================================
// OAuth2 routes (before verifyToken - browser redirects, not XHR)
// ============================================================================

// GET /:tenantId/oauth2/authorize - Redirect user to Microsoft login
// Must be before verifyToken since browser navigates here directly
router.get('/:tenantId/oauth2/authorize', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { email, token } = req.query;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');

    // Verify JWT from query param (can't use Authorization header in browser redirect)
    if (!token) {
      return res.status(401).send('Authentication required');
    }
    const jwt = require('jsonwebtoken');
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded.role !== 'admin') {
        return res.status(403).send('Admin access required');
      }
    } catch (e) {
      return res.status(401).send('Invalid or expired token');
    }

    // Optionally store the email they want to connect
    if (email) {
      const connection = await getTenantConnection(tenantCode);
      try {
        await connection.query(
          'UPDATE email_ingest_settings SET oauth2_email = ? ORDER BY id ASC LIMIT 1',
          [email]
        );
      } finally {
        connection.release();
      }
    }

    const redirectUri = `${req.protocol}://${req.get('host')}/api/email-ingest/oauth2/callback`;
    const nonce = Date.now().toString(36);
    const state = `${tenantCode}:${nonce}`;

    const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?` +
      `client_id=${MS_CLIENT_ID}` +
      `&response_type=code` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${encodeURIComponent('https://outlook.office365.com/IMAP.AccessAsUser.All offline_access')}` +
      `&state=${encodeURIComponent(state)}` +
      `&prompt=${req.query.admin_consent === 'true' ? 'admin_consent' : 'consent'}` +
      (email ? `&login_hint=${encodeURIComponent(email)}` : '');

    res.redirect(authUrl);
  } catch (error) {
    console.error('[OAuth2] Authorize error:', error);
    res.status(500).send('OAuth2 authorization failed: ' + error.message);
  }
});

// GET /api/email-ingest/oauth2/callback - Microsoft redirects here after consent
router.get('/oauth2/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      console.error(`[OAuth2] Callback error: ${error} - ${error_description}`);
      return res.send(buildCallbackHTML(false, error_description || error));
    }

    if (!code || !state) {
      return res.send(buildCallbackHTML(false, 'Missing authorization code or state'));
    }

    // state = tenantCode:nonce
    const parts = state.split(':');
    if (parts.length < 2) {
      return res.send(buildCallbackHTML(false, 'Invalid state parameter'));
    }
    const tenantCode = parts[0];

    const redirectUri = `${req.protocol}://${req.get('host')}/api/email-ingest/oauth2/callback`;

    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code, redirectUri);

    // Decode the access token to get the user's email (JWT payload)
    let email = '';
    try {
      const payload = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64').toString());
      email = payload.upn || payload.unique_name || payload.preferred_username || '';
    } catch (e) {
      console.warn('[OAuth2] Could not decode email from token, will use stored email');
    }

    const tokenExpiry = new Date(Date.now() + (tokens.expires_in || 3599) * 1000);

    // Store tokens in tenant DB
    const connection = await getTenantConnection(tenantCode);
    try {
      await connection.query(
        `UPDATE email_ingest_settings SET
          auth_method = 'oauth2',
          oauth2_access_token = ?,
          oauth2_refresh_token = ?,
          oauth2_token_expiry = ?,
          oauth2_email = COALESCE(NULLIF(?, ''), oauth2_email),
          updated_at = NOW()
        ORDER BY id ASC LIMIT 1`,
        [tokens.access_token, tokens.refresh_token, tokenExpiry, email]
      );
      console.log(`[OAuth2] Tokens stored for tenant ${tenantCode}, email: ${email}`);
    } finally {
      connection.release();
    }

    return res.send(buildCallbackHTML(true, null, email));
  } catch (error) {
    console.error('[OAuth2] Callback error:', error);
    return res.send(buildCallbackHTML(false, error.message));
  }
});

/**
 * Build HTML page shown in the OAuth popup after callback
 */
function buildCallbackHTML(success, errorMessage, email) {
  const message = success
    ? `Connected as ${email || 'Microsoft 365 account'}`
    : `Connection failed: ${errorMessage}`;
  const color = success ? '#16a34a' : '#b91c1c';

  return `<!DOCTYPE html>
<html><head><title>ServiFlow - Microsoft 365</title></head>
<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8fafc">
  <div style="text-align:center;max-width:400px;padding:32px">
    <div style="font-size:48px;margin-bottom:16px">${success ? '&#9989;' : '&#10060;'}</div>
    <h2 style="color:${color};margin:0 0 8px">${success ? 'Connected!' : 'Connection Failed'}</h2>
    <p style="color:#64748b">${message}</p>
    <p style="color:#94a3b8;font-size:14px">This window will close automatically...</p>
  </div>
  <script>
    if (window.opener) {
      window.opener.postMessage({ type: 'oauth2-callback', success: ${success}, email: '${email || ''}', error: '${(errorMessage || '').replace(/'/g, "\\'")}' }, '*');
      setTimeout(() => window.close(), 2000);
    }
  </script>
</body></html>`;
}

// ============================================================================
// Authenticated routes
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
      auth_method
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
          INSERT INTO email_ingest_settings (enabled, server_type, server_host, server_port, use_ssl, username, password, check_interval_minutes, auth_method)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [enabled, server_type, server_host, server_port, use_ssl, username, actualPassword, check_interval_minutes, auth_method || 'basic']);
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
            updated_at = NOW()
          WHERE id = ?
        `, [enabled, server_type, server_host, server_port, use_ssl, username, actualPassword, check_interval_minutes, auth_method || null, existingSettings[0].id]);
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
// OAuth2 authenticated endpoints
// ============================================================================

// GET /:tenantId/oauth2/status - Get OAuth2 connection status
router.get('/:tenantId/oauth2/status', readOperationsLimiter, async (req, res) => {
  try {
    const { tenantId } = req.params;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      const [rows] = await connection.query(
        'SELECT auth_method, oauth2_email, oauth2_token_expiry, oauth2_refresh_token IS NOT NULL as has_refresh_token FROM email_ingest_settings ORDER BY id ASC LIMIT 1'
      );

      if (rows.length === 0) {
        return res.json({ success: true, connected: false });
      }

      const settings = rows[0];
      const connected = settings.auth_method === 'oauth2' && settings.has_refresh_token;

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

// POST /:tenantId/oauth2/disconnect - Remove OAuth2 tokens
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

      // OAuth2 test connection
      if (config.auth_method === 'oauth2') {
        if (!config.oauth2_refresh_token) {
          return res.json({ success: false, message: 'Microsoft 365 not connected. Click "Connect with Microsoft" first.' });
        }

        const { accessToken, email } = await getValidAccessToken(connection, tenantCode);
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
            type: 'OAuth2 / XOAUTH2',
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
          ? 'Authentication rejected by server. For Microsoft 365: use the "Connect with Microsoft" button for OAuth2 authentication. For Gmail: ensure IMAP is enabled and use an App Password if MFA is on.'
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
