/**
 * Tenant Settings Routes
 *
 * Manages tenant-level configuration settings stored in tenant_settings table.
 * Used for feature flags like customer_billing_enabled and enhanced_sla_billing_mode.
 */

const express = require('express');
const router = express.Router();
const { getTenantConnection } = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');
const { applyTenantMatch } = require('../middleware/tenantMatch');
const { body, param, validationResult } = require('express-validator');

// Apply verifyToken middleware to all routes
router.use(verifyToken);
applyTenantMatch(router);

/**
 * GET /:tenantId/settings
 * Get all tenant settings
 * Access: All authenticated users (customers see limited set)
 */
router.get('/:tenantId/settings', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      const [settings] = await connection.query(`
        SELECT setting_key, setting_value, setting_type, description
        FROM tenant_settings
        ORDER BY setting_key
      `);

      // Convert to object format for easier use
      const settingsObj = {};
      settings.forEach(s => {
        let value = s.setting_value;
        // Parse value based on type
        if (s.setting_type === 'boolean') {
          value = s.setting_value === 'true';
        } else if (s.setting_type === 'number') {
          value = parseFloat(s.setting_value);
        } else if (s.setting_type === 'json') {
          try {
            value = JSON.parse(s.setting_value);
          } catch (e) {
            value = s.setting_value;
          }
        }
        settingsObj[s.setting_key] = value;
      });

      // For customers, only return relevant settings
      if (req.user.role === 'customer') {
        const customerSettings = {
          customer_billing_enabled: settingsObj.customer_billing_enabled || false
        };
        return res.json({ success: true, settings: customerSettings });
      }

      res.json({ success: true, settings: settingsObj, raw: settings });

    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching tenant settings:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

/**
 * GET /:tenantId/settings/:key
 * Get a single tenant setting
 * Access: All authenticated users
 */
router.get('/:tenantId/settings/:key',
  param('key').isString().trim().notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { tenantId, key } = req.params;
      const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
      const connection = await getTenantConnection(tenantCode);

      try {
        const [settings] = await connection.query(`
          SELECT setting_key, setting_value, setting_type, description
          FROM tenant_settings
          WHERE setting_key = ?
        `, [key]);

        if (settings.length === 0) {
          return res.status(404).json({ success: false, message: 'Setting not found' });
        }

        const s = settings[0];
        let value = s.setting_value;

        // Parse value based on type
        if (s.setting_type === 'boolean') {
          value = s.setting_value === 'true';
        } else if (s.setting_type === 'number') {
          value = parseFloat(s.setting_value);
        } else if (s.setting_type === 'json') {
          try {
            value = JSON.parse(s.setting_value);
          } catch (e) {
            value = s.setting_value;
          }
        }

        res.json({
          success: true,
          setting: {
            key: s.setting_key,
            value: value,
            type: s.setting_type,
            description: s.description
          }
        });

      } finally {
        connection.release();
      }
    } catch (error) {
      console.error('Error fetching tenant setting:', error);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  }
);

/**
 * PUT /:tenantId/settings/:key
 * Update a tenant setting
 * Access: Admin only
 */
router.put('/:tenantId/settings/:key',
  requireRole(['admin']),
  param('key').isString().trim().notEmpty(),
  body('value').exists().withMessage('Value is required'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { tenantId, key } = req.params;
      const { value } = req.body;
      const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
      const connection = await getTenantConnection(tenantCode);

      try {
        // Check if setting exists
        const [existing] = await connection.query(`
          SELECT id, setting_type FROM tenant_settings WHERE setting_key = ?
        `, [key]);

        if (existing.length === 0) {
          return res.status(404).json({ success: false, message: 'Setting not found' });
        }

        // Validate value based on type
        const settingType = existing[0].setting_type;
        let stringValue;

        if (settingType === 'boolean') {
          if (typeof value !== 'boolean' && value !== 'true' && value !== 'false') {
            return res.status(400).json({ success: false, message: 'Value must be a boolean' });
          }
          stringValue = String(value);
        } else if (settingType === 'number') {
          if (isNaN(value)) {
            return res.status(400).json({ success: false, message: 'Value must be a number' });
          }
          stringValue = String(value);
        } else if (settingType === 'json') {
          try {
            stringValue = typeof value === 'string' ? value : JSON.stringify(value);
            JSON.parse(stringValue); // Validate JSON
          } catch (e) {
            return res.status(400).json({ success: false, message: 'Value must be valid JSON' });
          }
        } else {
          stringValue = String(value);
        }

        // Update the setting
        await connection.query(`
          UPDATE tenant_settings
          SET setting_value = ?, updated_at = NOW()
          WHERE setting_key = ?
        `, [stringValue, key]);

        // Log the change to audit log
        try {
          await connection.query(`
            INSERT INTO audit_log (user_id, action, entity_type, entity_id, details)
            VALUES (?, 'SETTING_UPDATED', 'tenant_settings', ?, ?)
          `, [
            req.user.userId,
            key,
            JSON.stringify({ key, old_value: 'redacted', new_value: stringValue })
          ]);
        } catch (auditError) {
          console.error('Could not log to audit:', auditError.message);
        }

        res.json({
          success: true,
          message: 'Setting updated successfully',
          setting: { key, value: settingType === 'boolean' ? stringValue === 'true' : stringValue }
        });

      } finally {
        connection.release();
      }
    } catch (error) {
      console.error('Error updating tenant setting:', error);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  }
);

/**
 * POST /:tenantId/settings
 * Create a new tenant setting (admin only)
 * Access: Admin only
 */
router.post('/:tenantId/settings',
  requireRole(['admin']),
  body('key').isString().trim().notEmpty().withMessage('Key is required'),
  body('value').exists().withMessage('Value is required'),
  body('type').optional().isIn(['boolean', 'string', 'number', 'json']),
  body('description').optional().isString(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { tenantId } = req.params;
      const { key, value, type = 'string', description = '' } = req.body;
      const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
      const connection = await getTenantConnection(tenantCode);

      try {
        // Check if setting already exists
        const [existing] = await connection.query(`
          SELECT id FROM tenant_settings WHERE setting_key = ?
        `, [key]);

        if (existing.length > 0) {
          return res.status(409).json({ success: false, message: 'Setting already exists' });
        }

        // Convert value to string for storage
        let stringValue;
        if (type === 'json' && typeof value !== 'string') {
          stringValue = JSON.stringify(value);
        } else {
          stringValue = String(value);
        }

        // Insert the new setting
        await connection.query(`
          INSERT INTO tenant_settings (setting_key, setting_value, setting_type, description)
          VALUES (?, ?, ?, ?)
        `, [key, stringValue, type, description]);

        res.status(201).json({
          success: true,
          message: 'Setting created successfully',
          setting: { key, value: stringValue, type, description }
        });

      } finally {
        connection.release();
      }
    } catch (error) {
      console.error('Error creating tenant setting:', error);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  }
);

module.exports = router;
