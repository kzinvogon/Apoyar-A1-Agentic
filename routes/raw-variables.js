const express = require('express');
const router = express.Router();
const { getTenantConnection } = require('../config/database');
const { verifyToken, requireElevatedAdmin } = require('../middleware/auth');
const { applyTenantMatch } = require('../middleware/tenantMatch');
const { logAudit, AUDIT_ACTIONS } = require('../utils/auditLog');

// Apply authentication to all routes — system admin only
router.use(verifyToken);
applyTenantMatch(router);
router.use(requireElevatedAdmin);

// Get all variables for a tenant (aggregated from multiple sources)
router.get('/:tenantId', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const connection = await getTenantConnection(tenantId);

    try {
      const variables = {
        tenant_settings: [],
        email_imap: [],
        email_m365: [],
        email_outbound: [],
        company_profile: [],
        feature_flags: [],
        sla_config: [],
        automation: [],
        customers_config: [],
        cmdb_config: [],
        users_notifications: [],
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

      // 2. Get email_ingest_settings — split into IMAP, M365, Outbound groups
      try {
        const [emailSettings] = await connection.query(
          'SELECT * FROM email_ingest_settings LIMIT 1'
        );
        if (emailSettings.length > 0) {
          const es = emailSettings[0];
          const cat = 'email_ingest';

          // IMAP / General ingest settings
          variables.email_imap = [
            { key: 'email_ingest.enabled', value: String(es.enabled || false), category: cat, editable: true, deletable: false },
            { key: 'email_ingest.server_type', value: es.server_type || 'imap', category: cat, editable: true, deletable: false },
            { key: 'email_ingest.auth_method', value: es.auth_method || 'basic', category: cat, editable: true, deletable: false },
            { key: 'email_ingest.server_host', value: es.server_host || '', category: cat, editable: true, deletable: false },
            { key: 'email_ingest.server_port', value: String(es.server_port || 993), category: cat, editable: true, deletable: false },
            { key: 'email_ingest.use_ssl', value: String(es.use_ssl !== false), category: cat, editable: true, deletable: false },
            { key: 'email_ingest.username', value: es.username || '', category: cat, editable: true, deletable: false },
            { key: 'email_ingest.password', value: es.password ? '******' : '', category: cat, editable: true, deletable: false, sensitive: true },
            { key: 'email_ingest.check_interval_minutes', value: String(es.check_interval_minutes || 5), category: cat, editable: true, deletable: false },
            { key: 'email_ingest.last_checked_at', value: es.last_checked_at ? new Date(es.last_checked_at).toISOString() : 'Never', category: cat, editable: false, deletable: false },
            { key: 'email_ingest.imap_locked_by', value: es.imap_locked_by || '', category: cat, editable: false, deletable: false },
            { key: 'email_ingest.imap_lock_expires', value: es.imap_lock_expires ? new Date(es.imap_lock_expires).toISOString() : '', category: cat, editable: false, deletable: false }
          ];

          // Microsoft 365 / Graph API settings
          variables.email_m365 = [
            { key: 'email_ingest.m365_enabled', value: String(es.m365_enabled || false), category: cat, editable: true, deletable: false },
            { key: 'email_ingest.oauth2_email', value: es.oauth2_email || '', category: cat, editable: true, deletable: false },
            { key: 'email_ingest.oauth2_refresh_token', value: es.oauth2_refresh_token ? '******' : '', category: cat, editable: true, deletable: false, sensitive: true },
            { key: 'email_ingest.oauth2_access_token', value: es.oauth2_access_token ? '******' : '', category: cat, editable: false, deletable: false, sensitive: true },
            { key: 'email_ingest.oauth2_token_expiry', value: es.oauth2_token_expiry ? new Date(es.oauth2_token_expiry).toISOString() : '', category: cat, editable: false, deletable: false },
            { key: 'email_ingest.graph_delta_link', value: es.graph_delta_link ? '(set — ' + es.graph_delta_link.length + ' chars)' : '', category: cat, editable: false, deletable: false },
            { key: 'email_ingest.m365_use_for_outbound', value: String(es.m365_use_for_outbound || false), category: cat, editable: true, deletable: false }
          ];

          // Outbound / SMTP settings
          variables.email_outbound = [
            { key: 'email_ingest.use_for_outbound', value: String(es.use_for_outbound || false), category: cat, editable: true, deletable: false },
            { key: 'email_ingest.smtp_host', value: es.smtp_host || '', category: cat, editable: true, deletable: false },
            { key: 'email_ingest.smtp_port', value: String(es.smtp_port || 587), category: cat, editable: true, deletable: false }
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

      // 4. Get feature flags (tenant_features)
      try {
        const [features] = await connection.query(
          'SELECT feature_key, enabled, source, expires_at FROM tenant_features ORDER BY feature_key'
        );
        variables.feature_flags = features.map(f => ({
          key: `feature.${f.feature_key}`,
          value: String(f.enabled),
          category: 'feature_flags',
          editable: false,
          deletable: false,
          meta: `source: ${f.source || 'system'}${f.expires_at ? ', expires: ' + new Date(f.expires_at).toLocaleDateString() : ''}`
        }));
      } catch (e) {
        console.log('tenant_features table may not exist:', e.message);
      }

      // 5. Get SLA configuration (sla_definitions + business_hours_profiles)
      try {
        const [slas] = await connection.query(
          'SELECT id, name, response_target_minutes, resolve_target_minutes, near_breach_percent, is_active FROM sla_definitions ORDER BY name'
        );
        for (const s of slas) {
          variables.sla_config.push(
            { key: `sla.${s.name}.response_target`, value: `${s.response_target_minutes} min`, category: 'sla_config', editable: false, deletable: false },
            { key: `sla.${s.name}.resolve_target`, value: `${s.resolve_target_minutes} min`, category: 'sla_config', editable: false, deletable: false },
            { key: `sla.${s.name}.near_breach_pct`, value: `${s.near_breach_percent}%`, category: 'sla_config', editable: false, deletable: false },
            { key: `sla.${s.name}.active`, value: String(!!s.is_active), category: 'sla_config', editable: false, deletable: false }
          );
        }
      } catch (e) {
        console.log('sla_definitions may not exist:', e.message);
      }
      try {
        const [bh] = await connection.query(
          'SELECT id, name, timezone, is_24x7, start_time, end_time, is_active FROM business_hours_profiles ORDER BY name'
        );
        for (const h of bh) {
          const hours = h.is_24x7 ? '24x7' : `${h.start_time || '?'}-${h.end_time || '?'}`;
          variables.sla_config.push(
            { key: `hours.${h.name}.schedule`, value: hours, category: 'sla_config', editable: false, deletable: false },
            { key: `hours.${h.name}.timezone`, value: h.timezone || '', category: 'sla_config', editable: false, deletable: false },
            { key: `hours.${h.name}.active`, value: String(!!h.is_active), category: 'sla_config', editable: false, deletable: false }
          );
        }
      } catch (e) {
        console.log('business_hours_profiles may not exist:', e.message);
      }

      // 6. Get automation rules + chat canned responses
      try {
        const [rules] = await connection.query(
          'SELECT id, rule_name, enabled, action_type, search_in, search_text, times_triggered FROM ticket_processing_rules ORDER BY rule_name'
        );
        for (const r of rules) {
          variables.automation.push(
            { key: `rule.${r.rule_name}.enabled`, value: String(!!r.enabled), category: 'automation', editable: false, deletable: false },
            { key: `rule.${r.rule_name}.action`, value: r.action_type || '', category: 'automation', editable: false, deletable: false },
            { key: `rule.${r.rule_name}.match`, value: `${r.search_in || ''}:${r.search_text || ''}`, category: 'automation', editable: false, deletable: false },
            { key: `rule.${r.rule_name}.triggered`, value: String(r.times_triggered || 0), category: 'automation', editable: false, deletable: false }
          );
        }
      } catch (e) {
        console.log('ticket_processing_rules may not exist:', e.message);
      }
      try {
        const [canned] = await connection.query(
          'SELECT MIN(id) as id, label, action_type, MAX(is_active) as is_active FROM chat_canned_responses GROUP BY label, action_type ORDER BY MIN(sort_order)'
        );
        for (const c of canned) {
          variables.automation.push(
            { key: `canned.${c.label}`, value: `${c.action_type || 'text'} (${c.is_active ? 'active' : 'inactive'})`, category: 'automation', editable: false, deletable: false }
          );
        }
      } catch (e) {
        console.log('chat_canned_responses may not exist:', e.message);
      }

      // 7. Get customer companies config summary
      try {
        const [companies] = await connection.query(
          'SELECT id, company_name, sla_level, sla_definition_id, is_active, admin_receive_emails, members_receive_emails FROM customer_companies ORDER BY company_name'
        );
        for (const co of companies) {
          variables.customers_config.push(
            { key: `company.${co.company_name}.sla_level`, value: co.sla_level || 'basic', category: 'customers_config', editable: false, deletable: false },
            { key: `company.${co.company_name}.sla_definition_id`, value: co.sla_definition_id ? String(co.sla_definition_id) : 'default', category: 'customers_config', editable: false, deletable: false },
            { key: `company.${co.company_name}.active`, value: String(!!co.is_active), category: 'customers_config', editable: false, deletable: false },
            { key: `company.${co.company_name}.admin_emails`, value: String(co.admin_receive_emails !== false), category: 'customers_config', editable: false, deletable: false },
            { key: `company.${co.company_name}.member_emails`, value: String(co.members_receive_emails !== false), category: 'customers_config', editable: false, deletable: false }
          );
        }
      } catch (e) {
        console.log('customer_companies may not exist:', e.message);
      }

      // 8. Get CMDB configuration (asset categories + custom field counts)
      try {
        const [cats] = await connection.query(
          'SELECT id, name, is_active FROM asset_categories ORDER BY name'
        );
        for (const ac of cats) {
          variables.cmdb_config.push(
            { key: `asset_category.${ac.name}`, value: ac.is_active ? 'active' : 'inactive', category: 'cmdb_config', editable: false, deletable: false }
          );
        }
      } catch (e) {
        console.log('asset_categories may not exist:', e.message);
      }
      try {
        const [fields] = await connection.query(
          'SELECT asset_category, COUNT(*) as cnt FROM cmdb_custom_field_definitions WHERE is_active = 1 GROUP BY asset_category'
        );
        for (const f of fields) {
          variables.cmdb_config.push(
            { key: `custom_fields.${f.asset_category}.count`, value: String(f.cnt), category: 'cmdb_config', editable: false, deletable: false }
          );
        }
      } catch (e) {
        console.log('cmdb_custom_field_definitions may not exist:', e.message);
      }

      // 9. Get user notification settings (admin, experts, customers)
      try {
        const [users] = await connection.query(
          `SELECT u.username, u.role, u.full_name, u.receive_email_updates, u.email_notifications_enabled, u.is_active
           FROM users u WHERE u.role IN ('admin','expert') ORDER BY u.role, u.username`
        );
        for (const u of users) {
          const label = u.full_name || u.username;
          variables.users_notifications.push(
            { key: `${u.role}.${label}.email_updates`, value: String(!!u.receive_email_updates), category: 'users_notifications', editable: false, deletable: false },
            { key: `${u.role}.${label}.notifications_enabled`, value: String(!!u.email_notifications_enabled), category: 'users_notifications', editable: false, deletable: false },
            { key: `${u.role}.${label}.active`, value: String(!!u.is_active), category: 'users_notifications', editable: false, deletable: false }
          );
        }
      } catch (e) {
        console.log('users table query failed:', e.message);
      }

      // 10. Add safe environment variables (read-only)
      variables.environment = [
        { key: 'NODE_ENV', value: process.env.NODE_ENV || 'development', category: 'environment', editable: false, deletable: false },
        { key: 'BASE_URL', value: process.env.BASE_URL || 'https://serviflow.app', category: 'environment', editable: false, deletable: false },
        { key: 'DEFAULT_TENANT', value: process.env.DEFAULT_TENANT || 'apoyar', category: 'environment', editable: false, deletable: false },
        { key: 'PORT', value: process.env.PORT || '3000', category: 'environment', editable: false, deletable: false }
      ];

      // Audit log: Raw Variables opened
      const totalCount = Object.values(variables).reduce((sum, arr) => sum + arr.length, 0);
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
    res.status(500).json({ success: false, message: 'Internal server error' });
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
    res.status(500).json({ success: false, message: 'Internal server error' });
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
          'auth_method': 'auth_method',
          'server_host': 'server_host',
          'server_port': 'server_port',
          'use_ssl': 'use_ssl',
          'username': 'username',
          'password': 'password',
          'check_interval_minutes': 'check_interval_minutes',
          'm365_enabled': 'm365_enabled',
          'oauth2_email': 'oauth2_email',
          'oauth2_refresh_token': 'oauth2_refresh_token',
          'm365_use_for_outbound': 'm365_use_for_outbound',
          'use_for_outbound': 'use_for_outbound',
          'smtp_host': 'smtp_host',
          'smtp_port': 'smtp_port'
        };

        if (!fieldMap[field]) {
          return res.status(400).json({ success: false, message: 'Invalid email_ingest field' });
        }

        // Don't update sensitive fields if masked
        const sensitiveFields = ['password', 'oauth2_refresh_token'];
        if (sensitiveFields.includes(field) && value === '******') {
          return res.json({ success: true, message: 'Sensitive field unchanged' });
        }

        // Get old value before update
        try {
          const [oldSettings] = await connection.query(`SELECT ${fieldMap[field]} as val FROM email_ingest_settings LIMIT 1`);
          if (oldSettings.length > 0) {
            oldValue = sensitiveFields.includes(field) ? '[REDACTED]' : String(oldSettings[0].val);
          }
        } catch (e) { /* ignore */ }

        // Convert value types
        let dbValue = value;
        const boolFields = ['enabled', 'use_ssl', 'm365_enabled', 'm365_use_for_outbound', 'use_for_outbound'];
        const intFields = ['server_port', 'check_interval_minutes', 'smtp_port'];
        if (boolFields.includes(field)) {
          dbValue = value === 'true' || value === true;
        } else if (intFields.includes(field)) {
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
    res.status(500).json({ success: false, message: 'Internal server error' });
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
    res.status(500).json({ success: false, message: 'Internal server error' });
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
                'auth_method': 'auth_method',
                'server_host': 'server_host',
                'server_port': 'server_port',
                'use_ssl': 'use_ssl',
                'username': 'username',
                'password': 'password',
                'check_interval_minutes': 'check_interval_minutes',
                'm365_enabled': 'm365_enabled',
                'oauth2_email': 'oauth2_email',
                'oauth2_refresh_token': 'oauth2_refresh_token',
                'm365_use_for_outbound': 'm365_use_for_outbound',
                'use_for_outbound': 'use_for_outbound',
                'smtp_host': 'smtp_host',
                'smtp_port': 'smtp_port'
              };

              const sensitiveFields = ['password', 'oauth2_refresh_token'];
              if (fieldMap[field] && !(sensitiveFields.includes(field) && value === '******')) {
                let dbValue = value;
                const boolFields = ['enabled', 'use_ssl', 'm365_enabled', 'm365_use_for_outbound', 'use_for_outbound'];
                const intFields = ['server_port', 'check_interval_minutes', 'smtp_port'];
                if (boolFields.includes(field)) {
                  dbValue = value === 'true' || value === true;
                } else if (intFields.includes(field)) {
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
          results.errors.push({ key, error: 'Failed to import variable' });
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
    res.status(500).json({ success: false, message: 'Internal server error' });
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
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
