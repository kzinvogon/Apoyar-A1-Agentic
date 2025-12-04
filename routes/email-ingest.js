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

// Apply verifyToken middleware to all routes
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
      const [settings] = await connection.query('SELECT * FROM email_ingest_settings LIMIT 1');

      if (settings.length === 0) {
        // Create default settings if none exist
        await connection.query(`
          INSERT INTO email_ingest_settings (enabled, server_type, server_host, server_port, use_ssl, username, password, check_interval_minutes)
          VALUES (FALSE, 'imap', 'imap.gmail.com', 993, TRUE, '', '', 5)
        `);

        const [newSettings] = await connection.query('SELECT * FROM email_ingest_settings LIMIT 1');
        // Don't send password to client
        const settingsData = { ...newSettings[0], password: '******' };
        res.json({ success: true, settings: settingsData });
      } else {
        // Don't send actual password to client
        const settingsData = { ...settings[0], password: settings[0].password ? '******' : '' };
        res.json({ success: true, settings: settingsData });
      }
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching email ingest settings:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

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
      check_interval_minutes
    } = req.body;

    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      // Check if settings exist
      const [existingSettings] = await connection.query('SELECT id, password FROM email_ingest_settings LIMIT 1');

      // If password is '******', keep existing password
      let actualPassword = password;
      if (password === '******' && existingSettings.length > 0) {
        actualPassword = existingSettings[0].password;
      }

      if (existingSettings.length === 0) {
        // Insert new settings
        await connection.query(`
          INSERT INTO email_ingest_settings (enabled, server_type, server_host, server_port, use_ssl, username, password, check_interval_minutes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [enabled, server_type, server_host, server_port, use_ssl, username, actualPassword, check_interval_minutes]);
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
            updated_at = NOW()
          WHERE id = ?
        `, [enabled, server_type, server_host, server_port, use_ssl, username, actualPassword, check_interval_minutes, existingSettings[0].id]);
      }

      res.json({ success: true, message: 'Email ingest settings updated successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error updating email ingest settings:', error);
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
      const [settings] = await connection.query('SELECT * FROM email_ingest_settings LIMIT 1');

      if (settings.length === 0 || !settings[0].enabled) {
        return res.json({ success: false, message: 'Email ingest is not enabled' });
      }

      // TODO: Implement actual email connection test using IMAP/POP3
      // For now, return success if settings exist
      res.json({
        success: true,
        message: 'Email connection test successful (demo mode)',
        details: {
          server: settings[0].server_host,
          port: settings[0].server_port,
          type: settings[0].server_type
        }
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error testing email connection:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
