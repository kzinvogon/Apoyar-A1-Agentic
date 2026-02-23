const express = require('express');
const router = express.Router();
const { getTenantConnection } = require('../config/database');
const { verifyToken, requireElevatedAdmin } = require('../middleware/auth');
const { logAudit, AUDIT_ACTIONS } = require('../utils/auditLog');

// Apply authentication to all routes — system admin only
router.use(verifyToken);
router.use(requireElevatedAdmin);

// Get all variables for a tenant (aggregated from multiple sources)
router.get('/:tenantId', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const connection = await getTenantConnection(tenantId);

    try {
      const variables = {
        tenant_settings: [],
        email_ingest: [],
        company_profile: [],
        environment: []
      };

      // 1. Get tenant_settings (key-value pairs)
      try {
        const [settings] = await connection.query(
          'SELECT setting_key, setting_value, created_at, updated_at FROM tenant_settings ORDER BY setting_key'
        );
        variables.tenant_settings = settings.map(s => ({
          key: s.setting_key,
          value: s.setting_value,
          category: 'tenant_settings',
          editable: true,
          deletable: true,
          created_at: s.created_at,
          updated_at: s.updated_at
        }));
      } catch (e) {
        console.log('tenant_settings table may not exist:', e.message);
      }

      // 2. Get email_ingest_settings
      try {
        const [emailSettings] = await connection.query(
          'SELECT * FROM email_ingest_settings LIMIT 1'
        );
        if (emailSettings.length > 0) {
          const es = emailSettings[0];
          variables.email_ingest = [
            { key: 'email_ingest.enabled', value: String(es.enabled || false), category: 'email_ingest', editable: true, deletable: false },
            { key: 'email_ingest.server_type', value: es.server_type || 'imap', category: 'email_ingest', editable: true, deletable: false },
            { key: 'email_ingest.server_host', value: es.server_host || '', category: 'email_ingest', editable: true, deletable: false },
            { key: 'email_ingest.server_port', value: String(es.server_port || 993), category: 'email_ingest', editable: true, deletable: false },
            { key: 'email_ingest.use_ssl', value: String(es.use_ssl !== false), category: 'email_ingest', editable: true, deletable: false },
            { key: 'email_ingest.username', value: es.username || '', category: 'email_ingest', editable: true, deletable: false },
            { key: 'email_ingest.password', value: es.password ? '******' : '', category: 'email_ingest', editable: true, deletable: false, sensitive: true },
            { key: 'email_ingest.check_interval_minutes', value: String(es.check_interval_minutes || 5), category: 'email_ingest', editable: true, deletable: false },
            { key: 'email_ingest.last_checked_at', value: es.last_checked_at ? new Date(es.last_checked_at).toISOString() : 'Never', category: 'email_ingest', editable: false, deletable: false }
          ];
        }
      } catch (e) {
        console.log('email_ingest_settings table may not exist:', e.message);
      }

      // 3. Get company_profile
      try {
        const [profile] = await connection.query(
          'SELECT * FROM company_profile LIMIT 1'
        );
        if (profile.length > 0) {
          const p = profile[0];
          variables.company_profile = [
            { key: 'company.name', value: p.company_name || '', category: 'company_profile', editable: true, deletable: false },
            { key: 'company.contact_phone', value: p.contact_phone || '', category: 'company_profile', editable: true, deletable: false },
            { key: 'company.mail_from_email', value: p.mail_from_email || '', category: 'company_profile', editable: true, deletable: false },
            { key: 'company.url_domain', value: p.company_url_domain || '', category: 'company_profile', editable: true, deletable: false }
          ];
        }
      } catch (e) {
        console.log('company_profile table may not exist:', e.message);
      }

      // 4. Add safe environment variables (read-only)
      variables.environment = [
        { key: 'NODE_ENV', value: process.env.NODE_ENV || 'development', category: 'environment', editable: false, deletable: false },
        { key: 'BASE_URL', value: process.env.BASE_URL || 'https://serviflow.app', category: 'environment', editable: false, deletable: false },
        { key: 'DEFAULT_TENANT', value: process.env.DEFAULT_TENANT || 'apoyar', category: 'environment', editable: false, deletable: false },
        { key: 'PORT', value: process.env.PORT || '3000', category: 'environment', editable: false, deletable: false }
      ];

      // Audit log: Raw Variables opened
      const totalCount = variables.tenant_settings.length + variables.email_ingest.length +
                        variables.company_profile.length + variables.environment.length;
      logAudit({
        tenantCode: tenantId,
        user: req.user,
        action: AUDIT_ACTIONS.RAW_VARS_OPEN,
        entityType: 'RAW_VARIABLE',
        details: { countReturned: totalCount },
        req
      });

      res.json({ success: true, variables });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching raw variables:', error);
    res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
});

// Add new tenant_setting variable
router.post('/:tenantId', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { key, value } = req.body;

    if (!key || key.trim() === '') {
      return res.status(400).json({ success: false, message: 'Key is required' });
    }

    // Validate key format (alphanumeric, underscores, dots)
    if (!/^[a-zA-Z][a-zA-Z0-9_\.]*$/.test(key)) {
      return res.status(400).json({ success: false, message: 'Key must start with a letter and contain only letters, numbers, underscores, and dots' });
    }

    // Don't allow creating keys in reserved categories
    if (key.startsWith('email_ingest.') || key.startsWith('company.')) {
      return res.status(400).json({ success: false, message: 'Cannot create variables in reserved categories (email_ingest, company)' });
    }

    const connection = await getTenantConnection(tenantId);

    try {
      // Check if key already exists
      const [existing] = await connection.query(
        'SELECT id FROM tenant_settings WHERE setting_key = ?',
        [key]
      );

      if (existing.length > 0) {
        return res.status(409).json({ success: false, message: 'Variable already exists' });
      }

      await connection.query(
        'INSERT INTO tenant_settings (setting_key, setting_value) VALUES (?, ?)',
        [key, value || '']
      );

      // Audit log: Variable created
      logAudit({
        tenantCode: tenantId,
        user: req.user,
        action: AUDIT_ACTIONS.RAW_VAR_CREATE,
        entityType: 'RAW_VARIABLE',
        entityId: key,
        details: { key, value: value || '', scope: 'tenant_settings' },
        req
      });

      res.status(201).json({ success: true, message: 'Variable created successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error creating variable:', error);
    res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
});

// Update a variable
router.put('/:tenantId/:key', async (req, res) => {
  try {
    const { tenantId, key } = req.params;
    const { value } = req.body;

    const connection = await getTenantConnection(tenantId);

    try {
      let oldValue = null;
      let scope = 'tenant_settings';

      // Handle different categories
      if (key.startsWith('email_ingest.')) {
        scope = 'email_ingest';
        // Update email_ingest_settings
        const field = key.replace('email_ingest.', '');
        const fieldMap = {
          'enabled': 'enabled',
          'server_type': 'server_type',
          'server_host': 'server_host',
          'server_port': 'server_port',
          'use_ssl': 'use_ssl',
          'username': 'username',
          'password': 'password',
          'check_interval_minutes': 'check_interval_minutes'
        };

        if (!fieldMap[field]) {
          return res.status(400).json({ success: false, message: 'Invalid email_ingest field' });
        }

        // Don't update password if it's the masked value
        if (field === 'password' && value === '******') {
          return res.json({ success: true, message: 'Password unchanged' });
        }

        // Get old value before update
        try {
          const [oldSettings] = await connection.query(`SELECT ${fieldMap[field]} as val FROM email_ingest_settings LIMIT 1`);
          if (oldSettings.length > 0) {
            oldValue = field === 'password' ? '[REDACTED]' : String(oldSettings[0].val);
          }
        } catch (e) { /* ignore */ }

        // Convert value types
        let dbValue = value;
        if (field === 'enabled' || field === 'use_ssl') {
          dbValue = value === 'true' || value === true;
        } else if (field === 'server_port' || field === 'check_interval_minutes') {
          dbValue = parseInt(value, 10) || 0;
        }

        await connection.query(
          `UPDATE email_ingest_settings SET ${fieldMap[field]} = ?`,
          [dbValue]
        );

      } else if (key.startsWith('company.')) {
        scope = 'company_profile';
        // Update company_profile
        const field = key.replace('company.', '');
        const fieldMap = {
          'name': 'company_name',
          'contact_phone': 'contact_phone',
          'mail_from_email': 'mail_from_email',
          'url_domain': 'company_url_domain'
        };

        if (!fieldMap[field]) {
          return res.status(400).json({ success: false, message: 'Invalid company field' });
        }

        // Get old value and check if profile exists
        const [existing] = await connection.query('SELECT * FROM company_profile LIMIT 1');
        if (existing.length === 0) {
          await connection.query(
            `INSERT INTO company_profile (${fieldMap[field]}) VALUES (?)`,
            [value]
          );
        } else {
          oldValue = existing[0][fieldMap[field]] || '';
          await connection.query(
            `UPDATE company_profile SET ${fieldMap[field]} = ?`,
            [value]
          );
        }

      } else {
        // Update tenant_settings
        const [existing] = await connection.query(
          'SELECT id, setting_value FROM tenant_settings WHERE setting_key = ?',
          [key]
        );

        if (existing.length === 0) {
          // Insert if doesn't exist
          await connection.query(
            'INSERT INTO tenant_settings (setting_key, setting_value) VALUES (?, ?)',
            [key, value]
          );
        } else {
          oldValue = existing[0].setting_value;
          // Update existing
          await connection.query(
            'UPDATE tenant_settings SET setting_value = ? WHERE setting_key = ?',
            [value, key]
          );
        }
      }

      // Audit log: Variable updated
      const newValueForLog = key.includes('password') ? '[REDACTED]' : value;
      logAudit({
        tenantCode: tenantId,
        user: req.user,
        action: AUDIT_ACTIONS.RAW_VAR_UPDATE,
        entityType: 'RAW_VARIABLE',
        entityId: key,
        details: { key, oldValue, newValue: newValueForLog, scope },
        req
      });

      res.json({ success: true, message: 'Variable updated successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error updating variable:', error);
    res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
});

// Delete a tenant_setting variable
router.delete('/:tenantId/:key', async (req, res) => {
  try {
    const { tenantId, key } = req.params;

    // Only allow deleting tenant_settings
    if (key.startsWith('email_ingest.') || key.startsWith('company.')) {
      return res.status(400).json({ success: false, message: 'Cannot delete system variables' });
    }

    const connection = await getTenantConnection(tenantId);

    try {
      // Get old value before deleting
      let oldValue = null;
      const [existing] = await connection.query(
        'SELECT setting_value FROM tenant_settings WHERE setting_key = ?',
        [key]
      );
      if (existing.length > 0) {
        oldValue = existing[0].setting_value;
      }

      const [result] = await connection.query(
        'DELETE FROM tenant_settings WHERE setting_key = ?',
        [key]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: 'Variable not found' });
      }

      // Audit log: Variable deleted
      logAudit({
        tenantCode: tenantId,
        user: req.user,
        action: AUDIT_ACTIONS.RAW_VAR_DELETE,
        entityType: 'RAW_VARIABLE',
        entityId: key,
        details: { key, oldValue, scope: 'tenant_settings' },
        req
      });

      res.json({ success: true, message: 'Variable deleted successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error deleting variable:', error);
    res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
});

// Bulk update variables from JSON
router.post('/:tenantId/bulk', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { variables } = req.body;

    if (!variables || typeof variables !== 'object') {
      return res.status(400).json({ success: false, message: 'Variables object is required' });
    }

    const connection = await getTenantConnection(tenantId);

    try {
      const results = { updated: 0, created: 0, errors: [] };

      for (const [key, value] of Object.entries(variables)) {
        try {
          // Skip environment and read-only variables
          if (key.startsWith('NODE_ENV') || key.startsWith('BASE_URL') || key.startsWith('DEFAULT_TENANT') || key.startsWith('PORT')) {
            results.errors.push({ key, error: 'Cannot modify environment variables' });
            continue;
          }

          // Handle email_ingest and company variables via PUT logic
          if (key.startsWith('email_ingest.') || key.startsWith('company.')) {
            // Use same logic as PUT endpoint
            if (key.startsWith('email_ingest.')) {
              const field = key.replace('email_ingest.', '');
              const fieldMap = {
                'enabled': 'enabled',
                'server_type': 'server_type',
                'server_host': 'server_host',
                'server_port': 'server_port',
                'use_ssl': 'use_ssl',
                'username': 'username',
                'password': 'password',
                'check_interval_minutes': 'check_interval_minutes'
              };

              if (fieldMap[field] && !(field === 'password' && value === '******')) {
                let dbValue = value;
                if (field === 'enabled' || field === 'use_ssl') {
                  dbValue = value === 'true' || value === true;
                } else if (field === 'server_port' || field === 'check_interval_minutes') {
                  dbValue = parseInt(value, 10) || 0;
                }
                await connection.query(`UPDATE email_ingest_settings SET ${fieldMap[field]} = ?`, [dbValue]);
                results.updated++;
              }
            } else if (key.startsWith('company.')) {
              const field = key.replace('company.', '');
              const fieldMap = {
                'name': 'company_name',
                'contact_phone': 'contact_phone',
                'mail_from_email': 'mail_from_email',
                'url_domain': 'company_url_domain'
              };

              if (fieldMap[field]) {
                const [existing] = await connection.query('SELECT id FROM company_profile LIMIT 1');
                if (existing.length === 0) {
                  await connection.query(`INSERT INTO company_profile (${fieldMap[field]}) VALUES (?)`, [value]);
                } else {
                  await connection.query(`UPDATE company_profile SET ${fieldMap[field]} = ?`, [value]);
                }
                results.updated++;
              }
            }
          } else {
            // Tenant settings - upsert
            const [existing] = await connection.query(
              'SELECT id FROM tenant_settings WHERE setting_key = ?',
              [key]
            );

            if (existing.length === 0) {
              await connection.query(
                'INSERT INTO tenant_settings (setting_key, setting_value) VALUES (?, ?)',
                [key, String(value)]
              );
              results.created++;
            } else {
              await connection.query(
                'UPDATE tenant_settings SET setting_value = ? WHERE setting_key = ?',
                [String(value), key]
              );
              results.updated++;
            }
          }
        } catch (err) {
          results.errors.push({ key, error: err.message });
        }
      }

      // Audit log: Bulk import
      logAudit({
        tenantCode: tenantId,
        user: req.user,
        action: AUDIT_ACTIONS.RAW_VARS_IMPORT,
        entityType: 'RAW_VARIABLE',
        details: {
          keysImported: Object.keys(variables),
          created: results.created,
          updated: results.updated,
          errors: results.errors.length
        },
        req
      });

      res.json({
        success: true,
        message: `Bulk update complete: ${results.updated} updated, ${results.created} created`,
        results
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error bulk updating variables:', error);
    res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
});

// Export variables as JSON (for audit logging)
router.get('/:tenantId/export', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const connection = await getTenantConnection(tenantId);

    try {
      const variables = {};

      // Get tenant_settings
      try {
        const [settings] = await connection.query(
          'SELECT setting_key, setting_value FROM tenant_settings ORDER BY setting_key'
        );
        settings.forEach(s => {
          variables[s.setting_key] = s.setting_value;
        });
      } catch (e) { /* ignore */ }

      // Audit log: Export
      logAudit({
        tenantCode: tenantId,
        user: req.user,
        action: AUDIT_ACTIONS.RAW_VARS_EXPORT,
        entityType: 'RAW_VARIABLE',
        details: { countExported: Object.keys(variables).length },
        req
      });

      res.json({ success: true, variables });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error exporting variables:', error);
    res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
});

module.exports = router;
