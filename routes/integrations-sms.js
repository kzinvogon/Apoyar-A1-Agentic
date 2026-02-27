/**
 * SMS Integration Routes
 * Self-service setup for Twilio SMS integration
 *
 * Feature flag: integrations.sms (Professional+ plan required)
 */

const express = require('express');
const router = express.Router();
const { getMasterConnection, getTenantConnection } = require('../config/database');
const { requireFeature } = require('../middleware/featureGuard');
const { hasFeature } = require('../services/feature-flags');
const { applyTenantMatch } = require('../middleware/tenantMatch');

applyTenantMatch(router);

const APP_BASE_URL = process.env.APP_BASE_URL || 'https://web-production-11114.up.railway.app';
const SMS_CONNECTOR_URL = process.env.SMS_CONNECTOR_URL || 'http://localhost:3980';

/**
 * GET /api/integrations/:tenantCode/sms/status
 * Check SMS integration status for a tenant
 */
router.get('/:tenantCode/sms/status', async (req, res) => {
  const { tenantCode } = req.params;
  let masterConn;

  try {
    // Check if feature is enabled for this tenant
    let featureEnabled = false;
    try {
      featureEnabled = await hasFeature(tenantCode, 'integrations.sms');
    } catch (featureError) {
      console.warn('[SMS Integration] Feature check failed:', featureError.message);
    }

    masterConn = await getMasterConnection();

    // Check for existing mapping
    const [mappings] = await masterConn.query(
      `SELECT spm.*, t.company_name as tenant_name
       FROM sms_phone_tenant_mappings spm
       JOIN tenants t ON t.tenant_code COLLATE utf8mb4_unicode_ci = spm.tenant_code COLLATE utf8mb4_unicode_ci
       WHERE spm.tenant_code = ? AND spm.is_active = TRUE`,
      [tenantCode]
    );

    const response = {
      feature_enabled: featureEnabled,
      minimum_plan: 'professional',
      connected: false
    };

    if (mappings.length > 0) {
      response.connected = true;
      response.twilio_phone_number = mappings[0].twilio_phone_number;
      response.twilio_account_sid = mappings[0].twilio_account_sid;
      response.connected_at = mappings[0].created_at;
    }

    // Add upgrade hint if feature not enabled
    if (!featureEnabled) {
      response.upgrade_message = 'Upgrade to Professional plan to enable SMS integration';
      response.upgrade_url = '/pricing';
    }

    res.json(response);
  } catch (error) {
    console.error('[SMS Integration] Status error:', error);
    res.status(500).json({ error: 'Failed to check SMS integration status' });
  }
});

/**
 * POST /api/integrations/:tenantCode/sms/connect
 * Connect Twilio SMS to a tenant
 * Requires: integrations.sms feature (Professional+ plan)
 */
router.post('/:tenantCode/sms/connect', requireFeature('integrations.sms'), async (req, res) => {
  const { tenantCode } = req.params;
  const { twilio_phone_number, twilio_account_sid } = req.body;

  if (!twilio_phone_number) {
    return res.status(400).json({ error: 'twilio_phone_number is required (E.164 format, e.g. +14155551234)' });
  }

  // Basic E.164 validation
  if (!/^\+[1-9]\d{1,14}$/.test(twilio_phone_number)) {
    return res.status(400).json({ error: 'Invalid phone number format. Use E.164 format (e.g. +14155551234)' });
  }

  let masterConn;

  try {
    masterConn = await getMasterConnection();

    // Check if phone number is already mapped to another tenant
    const [existing] = await masterConn.query(
      'SELECT tenant_code FROM sms_phone_tenant_mappings WHERE twilio_phone_number = ? AND is_active = TRUE',
      [twilio_phone_number]
    );

    if (existing.length > 0 && existing[0].tenant_code !== tenantCode) {
      return res.status(409).json({
        error: 'This phone number is already connected to another tenant'
      });
    }

    // Upsert mapping
    await masterConn.query(
      `INSERT INTO sms_phone_tenant_mappings (twilio_phone_number, tenant_code, twilio_account_sid)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE tenant_code = ?, twilio_account_sid = ?, is_active = TRUE, updated_at = NOW()`,
      [twilio_phone_number, tenantCode, twilio_account_sid || null, tenantCode, twilio_account_sid || null]
    );

    // Log the connection in tenant database
    let tenantConn;
    try {
      tenantConn = await getTenantConnection(tenantCode);
      await tenantConn.query(
        `INSERT INTO audit_log (user_id, action, entity_type, entity_id, details, created_at)
         VALUES (?, 'sms_connected', 'integration', 0, ?, NOW())`,
        [req.user?.id || null, JSON.stringify({
          twilio_phone_number,
          twilio_account_sid
        })]
      );
    } catch (e) {
      // Audit log is optional
    }

    console.log(`[SMS Integration] Connected: ${tenantCode} -> ${twilio_phone_number}`);

    res.json({
      success: true,
      message: 'SMS integration connected',
      twilio_phone_number,
      webhook_url: `${SMS_CONNECTOR_URL}/api/sms/incoming`
    });
  } catch (error) {
    console.error('[SMS Integration] Connect error:', error);
    res.status(500).json({ error: 'Failed to connect SMS integration' });
  }
});

/**
 * DELETE /api/integrations/:tenantCode/sms/disconnect
 * Remove SMS integration
 * Requires: integrations.sms feature (Professional+ plan)
 */
router.delete('/:tenantCode/sms/disconnect', requireFeature('integrations.sms'), async (req, res) => {
  const { tenantCode } = req.params;
  let masterConn;

  try {
    masterConn = await getMasterConnection();

    // Soft delete the mapping
    await masterConn.query(
      'UPDATE sms_phone_tenant_mappings SET is_active = FALSE WHERE tenant_code = ?',
      [tenantCode]
    );

    res.json({ success: true, message: 'SMS integration disconnected' });
  } catch (error) {
    console.error('[SMS Integration] Disconnect error:', error);
    res.status(500).json({ error: 'Failed to disconnect SMS integration' });
  }
});

/**
 * POST /api/integrations/:tenantCode/sms/test
 * Send a test SMS via the connector
 * Requires: integrations.sms feature (Professional+ plan)
 */
router.post('/:tenantCode/sms/test', requireFeature('integrations.sms'), async (req, res) => {
  const { tenantCode } = req.params;
  const { to_phone_number } = req.body;

  if (!to_phone_number) {
    return res.status(400).json({ error: 'to_phone_number is required' });
  }

  try {
    // Forward test request to SMS connector
    const fetch = require('node-fetch');
    const response = await fetch(`${SMS_CONNECTOR_URL}/api/sms/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantCode, to_phone_number }),
      timeout: 10000
    });

    const result = await response.json();

    if (response.ok) {
      res.json({ success: true, message: 'Test SMS sent', ...result });
    } else {
      res.status(response.status).json(result);
    }
  } catch (error) {
    console.error('[SMS Integration] Test error:', error);
    res.status(500).json({ error: 'Failed to send test SMS. Is the SMS connector running?' });
  }
});

/**
 * GET /api/integrations/:tenantCode/sms/requirements
 * Get requirements/prerequisites for SMS integration
 */
router.get('/:tenantCode/sms/requirements', async (req, res) => {
  res.json({
    title: 'SMS Integration Requirements',
    requirements: [
      {
        id: 'twilio_account',
        title: 'Twilio Account',
        description: 'Create a Twilio account at twilio.com and get your Account SID and Auth Token from the Console Dashboard.',
        required: true
      },
      {
        id: 'phone_number',
        title: 'Twilio Phone Number',
        description: 'Purchase an SMS-capable phone number from Twilio (~$1.15/month for US local numbers).',
        required: true
      },
      {
        id: 'a2p_registration',
        title: 'A2P 10DLC Registration (US Numbers)',
        description: 'US numbers require A2P 10DLC registration: register your business profile, create a brand, and register a campaign. This takes 3-7 business days.',
        required: true
      },
      {
        id: 'webhook_config',
        title: 'Webhook Configuration',
        description: 'Configure your Twilio phone number\'s messaging webhook to point to the SMS connector URL.',
        required: true
      }
    ],
    cost_estimate: {
      phone_number: '$1.15/month',
      outbound_sms: '$0.0079/message (US)',
      inbound_sms: '$0.0075/message (US)',
      example: 'For 1000 messages/month: ~$9/month total'
    }
  });
});

module.exports = router;
