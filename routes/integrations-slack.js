/**
 * Slack Integration Routes
 * Self-service setup for Slack bot integration
 *
 * Feature flag: integrations.slack (Professional+ plan required)
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getMasterConnection, getTenantConnection } = require('../config/database');
const { requireFeature } = require('../middleware/featureGuard');
const { hasFeature } = require('../services/feature-flags');
const { verifyToken, requireElevatedAdmin } = require('../middleware/auth');
const { applyTenantMatch, requireTenantMatch } = require('../middleware/tenantMatch');

applyTenantMatch(router);

// Slack OAuth endpoints
const SLACK_AUTH_URL = 'https://slack.com/oauth/v2/authorize';
const SLACK_TOKEN_URL = 'https://slack.com/api/oauth.v2.access';

// Required scopes for the bot
const BOT_SCOPES = [
  'chat:write',
  'commands',
  'users:read',
  'users:read.email',
  'im:history',
  'app_mentions:read'
].join(',');

// Get Slack App credentials from environment
const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID;
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://web-production-11114.up.railway.app';

/**
 * GET /api/integrations/:tenantCode/slack/status
 * Check Slack integration status for a tenant
 */
router.get('/:tenantCode/slack/status', async (req, res) => {
  const { tenantCode } = req.params;
  let masterConn;

  try {
    // Check if feature is enabled for this tenant
    let featureEnabled = false;
    try {
      featureEnabled = await hasFeature(tenantCode, 'integrations.slack');
    } catch (featureError) {
      console.warn('[Slack Integration] Feature check failed:', featureError.message);
    }

    masterConn = await getMasterConnection();

    // Check for existing mapping
    const [mappings] = await masterConn.query(
      `SELECT * FROM slack_workspace_mappings
       WHERE tenant_code = ? AND is_active = TRUE`,
      [tenantCode]
    );

    // Also check email domain mappings
    const [domainMappings] = await masterConn.query(
      `SELECT * FROM slack_email_domain_mappings
       WHERE tenant_code = ? AND is_active = TRUE`,
      [tenantCode]
    );

    const response = {
      feature_enabled: featureEnabled,
      minimum_plan: 'professional',
      connected: false,
      email_domains: domainMappings.map(d => d.email_domain)
    };

    if (mappings.length > 0) {
      response.connected = true;
      response.slack_workspace_id = mappings[0].slack_workspace_id;
      response.slack_workspace_name = mappings[0].slack_workspace_name;
      response.connected_at = mappings[0].created_at;
    }

    // Add upgrade hint if feature not enabled
    if (!featureEnabled) {
      response.upgrade_message = 'Upgrade to Professional plan to enable Slack integration';
      response.upgrade_url = '/pricing';
    }

    res.json(response);
  } catch (error) {
    console.error('[Slack Integration] Status error:', error);
    res.status(500).json({ error: 'Failed to check Slack integration status' });
  }
});

/**
 * GET /api/integrations/:tenantCode/slack/connect
 * Initiate Slack OAuth flow
 */
router.get('/:tenantCode/slack/connect', verifyToken, requireTenantMatch, requireElevatedAdmin, requireFeature('integrations.slack'), async (req, res) => {
  const { tenantCode } = req.params;

  if (!SLACK_CLIENT_ID) {
    return res.status(500).json({
      error: 'Slack Client ID not configured. Please contact administrator.'
    });
  }

  // Generate state token to prevent CSRF
  const state = crypto.randomBytes(32).toString('hex');

  // Encode tenant code in state
  const stateData = Buffer.from(JSON.stringify({
    tenantCode,
    nonce: state,
    timestamp: Date.now()
  })).toString('base64');

  // Build OAuth URL
  const redirectUri = `${APP_BASE_URL}/api/integrations/slack/callback`;
  const authUrl = new URL(SLACK_AUTH_URL);
  authUrl.searchParams.set('client_id', SLACK_CLIENT_ID);
  authUrl.searchParams.set('scope', BOT_SCOPES);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', stateData);

  res.json({
    auth_url: authUrl.toString(),
    message: 'Redirect user to auth_url to initiate Slack authentication'
  });
});

/**
 * GET /api/integrations/slack/callback
 * Slack OAuth callback - extracts workspace ID and creates mapping
 */
router.get('/slack/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  // Handle OAuth errors
  if (oauthError) {
    console.error('[Slack Integration] OAuth error:', oauthError);
    return res.redirect(`${APP_BASE_URL}/settings/integrations?slack_error=${encodeURIComponent(oauthError)}`);
  }

  if (!code || !state) {
    return res.redirect(`${APP_BASE_URL}/settings/integrations?slack_error=missing_params`);
  }

  // Decode state
  let stateData;
  try {
    stateData = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
  } catch (e) {
    return res.redirect(`${APP_BASE_URL}/settings/integrations?slack_error=invalid_state`);
  }

  const { tenantCode, timestamp } = stateData;

  // Check state age (max 10 minutes)
  if (Date.now() - timestamp > 10 * 60 * 1000) {
    return res.redirect(`${APP_BASE_URL}/settings/integrations?slack_error=state_expired`);
  }

  try {
    // Exchange code for token
    const redirectUri = `${APP_BASE_URL}/api/integrations/slack/callback`;
    const tokenResponse = await fetch(SLACK_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: SLACK_CLIENT_ID,
        client_secret: SLACK_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri
      })
    });

    const tokenData = await tokenResponse.json();

    if (!tokenData.ok) {
      console.error('[Slack Integration] Token error:', tokenData);
      return res.redirect(`${APP_BASE_URL}/settings/integrations?slack_error=${encodeURIComponent(tokenData.error)}`);
    }

    const slackWorkspaceId = tokenData.team?.id;
    const slackWorkspaceName = tokenData.team?.name || 'Unknown Workspace';
    const botToken = tokenData.access_token;

    if (!slackWorkspaceId) {
      return res.redirect(`${APP_BASE_URL}/settings/integrations?slack_error=no_workspace_id`);
    }

    // Create or update the mapping
    let masterConn;
    try {
      masterConn = await getMasterConnection();

      // Check if mapping already exists
      const [existing] = await masterConn.query(
        'SELECT id FROM slack_workspace_mappings WHERE slack_workspace_id = ?',
        [slackWorkspaceId]
      );

      if (existing.length > 0) {
        // Update existing mapping
        await masterConn.query(
          `UPDATE slack_workspace_mappings
           SET tenant_code = ?, slack_workspace_name = ?, slack_bot_token = ?, is_active = TRUE, updated_at = NOW()
           WHERE slack_workspace_id = ?`,
          [tenantCode, slackWorkspaceName, botToken, slackWorkspaceId]
        );
      } else {
        // Insert new mapping
        await masterConn.query(
          `INSERT INTO slack_workspace_mappings (slack_workspace_id, slack_workspace_name, tenant_code, slack_bot_token)
           VALUES (?, ?, ?, ?)`,
          [slackWorkspaceId, slackWorkspaceName, tenantCode, botToken]
        );
      }
    } finally {
      // Pool connections don't need manual release
    }

    // Log the connection in tenant database
    try {
      const tenantConn = await getTenantConnection(tenantCode);
      await tenantConn.query(
        `INSERT INTO audit_log (user_id, action, entity_type, entity_id, details, created_at)
         VALUES (?, 'slack_connected', 'integration', 0, ?, NOW())`,
        [req.user?.id || null, JSON.stringify({
          slack_workspace_id: slackWorkspaceId,
          slack_workspace_name: slackWorkspaceName
        })]
      );
    } catch (e) {
      // Audit log is optional
    }

    console.log(`[Slack Integration] Connected: ${tenantCode} -> ${slackWorkspaceId} (${slackWorkspaceName})`);

    // Redirect to success page
    res.redirect(`${APP_BASE_URL}/settings/integrations?slack_connected=true&slack_workspace=${encodeURIComponent(slackWorkspaceName)}`);

  } catch (error) {
    console.error('[Slack Integration] Callback error:', error);
    res.redirect(`${APP_BASE_URL}/settings/integrations?slack_error=${encodeURIComponent(error.message)}`);
  }
});

/**
 * DELETE /api/integrations/:tenantCode/slack/disconnect
 * Remove Slack integration
 */
router.delete('/:tenantCode/slack/disconnect', verifyToken, requireTenantMatch, requireElevatedAdmin, requireFeature('integrations.slack'), async (req, res) => {
  const { tenantCode } = req.params;

  try {
    const masterConn = await getMasterConnection();

    // Soft delete the mapping
    await masterConn.query(
      'UPDATE slack_workspace_mappings SET is_active = FALSE WHERE tenant_code = ?',
      [tenantCode]
    );

    // Also deactivate email domain mappings
    await masterConn.query(
      'UPDATE slack_email_domain_mappings SET is_active = FALSE WHERE tenant_code = ?',
      [tenantCode]
    );

    res.json({ success: true, message: 'Slack integration disconnected' });
  } catch (error) {
    console.error('[Slack Integration] Disconnect error:', error);
    res.status(500).json({ error: 'Failed to disconnect Slack integration' });
  }
});

/**
 * POST /api/integrations/:tenantCode/slack/email-domain
 * Add additional email domain mapping
 */
router.post('/:tenantCode/slack/email-domain', verifyToken, requireTenantMatch, requireElevatedAdmin, requireFeature('integrations.slack'), async (req, res) => {
  const { tenantCode } = req.params;
  const { email_domain } = req.body;

  if (!email_domain) {
    return res.status(400).json({ error: 'email_domain is required' });
  }

  const domain = email_domain.toLowerCase().replace('@', '');

  try {
    const masterConn = await getMasterConnection();

    await masterConn.query(
      `INSERT INTO slack_email_domain_mappings (email_domain, tenant_code)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE tenant_code = ?, is_active = TRUE`,
      [domain, tenantCode, tenantCode]
    );

    res.json({ success: true, email_domain: domain });
  } catch (error) {
    console.error('[Slack Integration] Add domain error:', error);
    res.status(500).json({ error: 'Failed to add email domain' });
  }
});

/**
 * DELETE /api/integrations/:tenantCode/slack/email-domain/:domain
 * Remove email domain mapping
 */
router.delete('/:tenantCode/slack/email-domain/:domain', verifyToken, requireTenantMatch, requireElevatedAdmin, requireFeature('integrations.slack'), async (req, res) => {
  const { tenantCode, domain } = req.params;

  try {
    const masterConn = await getMasterConnection();

    await masterConn.query(
      'DELETE FROM slack_email_domain_mappings WHERE tenant_code = ? AND email_domain = ?',
      [tenantCode, domain.toLowerCase()]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('[Slack Integration] Remove domain error:', error);
    res.status(500).json({ error: 'Failed to remove email domain' });
  }
});

/**
 * GET /api/integrations/:tenantCode/slack/requirements
 * Get requirements/prerequisites for Slack integration
 */
router.get('/:tenantCode/slack/requirements', async (req, res) => {
  res.json({
    title: 'Slack Integration Requirements',
    requirements: [
      {
        id: 'workspace_admin',
        title: 'Workspace Admin',
        description: 'You need to be a Slack workspace admin or have permission to install apps.',
        required: true
      },
      {
        id: 'app_approval',
        title: 'App Approval',
        description: 'If your workspace requires app approval, an admin will need to approve ServiFlow.',
        required: false
      }
    ],
    permissions_needed: [
      'chat:write - To send ticket notifications and responses',
      'commands - To use slash commands like /ticket',
      'users:read - To identify users',
      'users:read.email - To match users to ServiFlow accounts'
    ],
    note: 'ServiFlow stores a bot token to send messages to your workspace. This token is only used for ServiFlow functionality.'
  });
});

module.exports = router;
