/**
 * Teams Integration Routes
 * Self-service setup for Microsoft Teams bot integration
 *
 * Feature flag: integrations.teams (Professional+ plan required)
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

// Microsoft OAuth endpoints
const MICROSOFT_AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

// Required scopes - minimal permissions to get tenant info
const OAUTH_SCOPES = 'openid profile User.Read';

// Get Microsoft App credentials from environment
const MS_CLIENT_ID = process.env.MICROSOFT_APP_ID;
const MS_CLIENT_SECRET = process.env.MICROSOFT_APP_PASSWORD;
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://web-production-11114.up.railway.app';

/**
 * GET /api/integrations/:tenantCode/teams/status
 * Check Teams integration status for a tenant
 * Includes feature availability (no auth required for status check)
 */
router.get('/:tenantCode/teams/status', async (req, res) => {
  const { tenantCode } = req.params;
  let masterConn;

  try {
    // Check if feature is enabled for this tenant
    let featureEnabled = false;
    try {
      featureEnabled = await hasFeature(tenantCode, 'integrations.teams');
    } catch (featureError) {
      // Feature check failed - continue with default
      console.warn('[Teams Integration] Feature check failed:', featureError.message);
    }

    masterConn = await getMasterConnection();

    // Check for existing mapping (use COLLATE to handle mixed collations)
    const [mappings] = await masterConn.query(
      `SELECT ttm.*, t.company_name as tenant_name
       FROM teams_tenant_mappings ttm
       JOIN tenants t ON t.tenant_code COLLATE utf8mb4_unicode_ci = ttm.tenant_code COLLATE utf8mb4_unicode_ci
       WHERE ttm.tenant_code = ? AND ttm.is_active = TRUE`,
      [tenantCode]
    );

    // Also check email domain mappings
    const [domainMappings] = await masterConn.query(
      `SELECT * FROM teams_email_domain_mappings
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
      response.teams_tenant_id = mappings[0].teams_tenant_id;
      response.teams_tenant_name = mappings[0].teams_tenant_name;
      response.connected_at = mappings[0].created_at;
    }

    // Add upgrade hint if feature not enabled
    if (!featureEnabled) {
      response.upgrade_message = 'Upgrade to Professional plan to enable Microsoft Teams integration';
      response.upgrade_url = '/pricing';
    }

    res.json(response);
  } catch (error) {
    console.error('[Teams Integration] Status error:', error);
    res.status(500).json({ error: 'Failed to check Teams integration status' });
  } finally {
    if (masterConn) masterConn.release();
  }
});

/**
 * GET /api/integrations/:tenantCode/teams/connect
 * Initiate Microsoft OAuth flow
 * Requires: integrations.teams feature (Professional+ plan)
 */
router.get('/:tenantCode/teams/connect', verifyToken, requireTenantMatch, requireElevatedAdmin, requireFeature('integrations.teams'), async (req, res) => {
  const { tenantCode } = req.params;

  if (!MS_CLIENT_ID) {
    return res.status(500).json({
      error: 'Microsoft App ID not configured. Please contact administrator.'
    });
  }

  // Generate state token to prevent CSRF
  const state = crypto.randomBytes(32).toString('hex');

  // Store state in session or temporary storage
  // For simplicity, encoding tenant code in state
  const stateData = Buffer.from(JSON.stringify({
    tenantCode,
    nonce: state,
    timestamp: Date.now()
  })).toString('base64');

  // Build OAuth URL
  const redirectUri = `${APP_BASE_URL}/api/integrations/teams/callback`;
  const authUrl = new URL(MICROSOFT_AUTH_URL);
  authUrl.searchParams.set('client_id', MS_CLIENT_ID);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_mode', 'query');
  authUrl.searchParams.set('scope', OAUTH_SCOPES);
  authUrl.searchParams.set('state', stateData);
  authUrl.searchParams.set('prompt', 'consent');

  res.json({
    auth_url: authUrl.toString(),
    message: 'Redirect user to auth_url to initiate Microsoft authentication'
  });
});

/**
 * GET /api/integrations/teams/callback
 * Microsoft OAuth callback - extracts tenant ID and creates mapping
 */
router.get('/teams/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  // Handle OAuth errors
  if (error) {
    console.error('[Teams Integration] OAuth error:', error, error_description);
    return res.redirect(`${APP_BASE_URL}/settings/integrations?teams_error=${encodeURIComponent(error_description || error)}`);
  }

  if (!code || !state) {
    return res.redirect(`${APP_BASE_URL}/settings/integrations?teams_error=missing_params`);
  }

  // Decode state
  let stateData;
  try {
    stateData = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
  } catch (e) {
    return res.redirect(`${APP_BASE_URL}/settings/integrations?teams_error=invalid_state`);
  }

  const { tenantCode, timestamp } = stateData;

  // Check state age (max 10 minutes)
  if (Date.now() - timestamp > 10 * 60 * 1000) {
    return res.redirect(`${APP_BASE_URL}/settings/integrations?teams_error=state_expired`);
  }

  try {
    // Exchange code for token
    const redirectUri = `${APP_BASE_URL}/api/integrations/teams/callback`;
    const tokenResponse = await fetch(MICROSOFT_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: MS_CLIENT_ID,
        client_secret: MS_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        scope: OAUTH_SCOPES
      })
    });

    const tokenData = await tokenResponse.json();

    if (tokenData.error) {
      console.error('[Teams Integration] Token error:', tokenData);
      return res.redirect(`${APP_BASE_URL}/settings/integrations?teams_error=${encodeURIComponent(tokenData.error_description || tokenData.error)}`);
    }

    // Decode ID token to get tenant ID
    const idToken = tokenData.id_token;
    if (!idToken) {
      return res.redirect(`${APP_BASE_URL}/settings/integrations?teams_error=no_id_token`);
    }

    // Parse JWT (id_token) to extract claims
    const tokenParts = idToken.split('.');
    const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64').toString('utf8'));

    const teamsTenantId = payload.tid; // Microsoft 365 Tenant ID
    const userEmail = payload.preferred_username || payload.email;
    const userName = payload.name;

    if (!teamsTenantId) {
      return res.redirect(`${APP_BASE_URL}/settings/integrations?teams_error=no_tenant_id`);
    }

    // Get tenant name from Microsoft Graph (optional)
    let teamsTenantName = 'Unknown Organization';
    try {
      const graphResponse = await fetch('https://graph.microsoft.com/v1.0/organization', {
        headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
      });
      const graphData = await graphResponse.json();
      if (graphData.value && graphData.value[0]) {
        teamsTenantName = graphData.value[0].displayName;
      }
    } catch (e) {
      // Use email domain as fallback name
      if (userEmail) {
        teamsTenantName = userEmail.split('@')[1];
      }
    }

    // Create or update the mapping
    let masterConn;
    try {
      masterConn = await getMasterConnection();

      // Check if mapping already exists
      const [existing] = await masterConn.query(
        'SELECT id FROM teams_tenant_mappings WHERE teams_tenant_id = ?',
        [teamsTenantId]
      );

      if (existing.length > 0) {
        // Update existing mapping
        await masterConn.query(
          `UPDATE teams_tenant_mappings
           SET tenant_code = ?, teams_tenant_name = ?, is_active = TRUE, updated_at = NOW()
           WHERE teams_tenant_id = ?`,
          [tenantCode, teamsTenantName, teamsTenantId]
        );
      } else {
        // Insert new mapping
        await masterConn.query(
          `INSERT INTO teams_tenant_mappings (teams_tenant_id, teams_tenant_name, tenant_code)
           VALUES (?, ?, ?)`,
          [teamsTenantId, teamsTenantName, tenantCode]
        );
      }

      // Also add email domain mapping if we have the email
      if (userEmail) {
        const emailDomain = userEmail.split('@')[1]?.toLowerCase();
        if (emailDomain) {
          try {
            await masterConn.query(
              `INSERT INTO teams_email_domain_mappings (email_domain, tenant_code)
               VALUES (?, ?)
               ON DUPLICATE KEY UPDATE tenant_code = ?, is_active = TRUE`,
              [emailDomain, tenantCode, tenantCode]
            );
          } catch (e) {
            // Domain might already be mapped to different tenant
            console.log('[Teams Integration] Email domain mapping skipped:', e.message);
          }
        }
      }
    } finally {
      if (masterConn) masterConn.release();
    }

    // Log the connection in tenant database
    let tenantConn;
    try {
      tenantConn = await getTenantConnection(tenantCode);
      await tenantConn.query(
        `INSERT INTO audit_log (user_id, action, entity_type, entity_id, details, created_at)
         VALUES (?, 'teams_connected', 'integration', 0, ?, NOW())`,
        [req.user?.id || null, JSON.stringify({
          teams_tenant_id: teamsTenantId,
          teams_tenant_name: teamsTenantName,
          connected_by: userName || userEmail
        })]
      );
    } catch (e) {
      // Audit log is optional
    } finally {
      if (tenantConn) tenantConn.release();
    }

    console.log(`[Teams Integration] Connected: ${tenantCode} -> ${teamsTenantId} (${teamsTenantName})`);

    // Redirect to success page
    res.redirect(`${APP_BASE_URL}/settings/integrations?teams_connected=true&teams_tenant=${encodeURIComponent(teamsTenantName)}`);

  } catch (error) {
    console.error('[Teams Integration] Callback error:', error);
    res.redirect(`${APP_BASE_URL}/settings/integrations?teams_error=${encodeURIComponent(error.message)}`);
  }
});

/**
 * DELETE /api/integrations/:tenantCode/teams/disconnect
 * Remove Teams integration
 * Requires: integrations.teams feature (Professional+ plan)
 */
router.delete('/:tenantCode/teams/disconnect', verifyToken, requireTenantMatch, requireElevatedAdmin, requireFeature('integrations.teams'), async (req, res) => {
  const { tenantCode } = req.params;
  let masterConn;

  try {
    masterConn = await getMasterConnection();

    // Soft delete the mapping
    await masterConn.query(
      'UPDATE teams_tenant_mappings SET is_active = FALSE WHERE tenant_code = ?',
      [tenantCode]
    );

    // Also deactivate email domain mappings
    await masterConn.query(
      'UPDATE teams_email_domain_mappings SET is_active = FALSE WHERE tenant_code = ?',
      [tenantCode]
    );

    res.json({ success: true, message: 'Teams integration disconnected' });
  } catch (error) {
    console.error('[Teams Integration] Disconnect error:', error);
    res.status(500).json({ error: 'Failed to disconnect Teams integration' });
  } finally {
    if (masterConn) masterConn.release();
  }
});

/**
 * POST /api/integrations/:tenantCode/teams/email-domain
 * Add additional email domain mapping
 * Requires: integrations.teams feature (Professional+ plan)
 */
router.post('/:tenantCode/teams/email-domain', verifyToken, requireTenantMatch, requireElevatedAdmin, requireFeature('integrations.teams'), async (req, res) => {
  const { tenantCode } = req.params;
  const { email_domain } = req.body;

  if (!email_domain) {
    return res.status(400).json({ error: 'email_domain is required' });
  }

  const domain = email_domain.toLowerCase().replace('@', '');
  let masterConn;

  try {
    masterConn = await getMasterConnection();

    await masterConn.query(
      `INSERT INTO teams_email_domain_mappings (email_domain, tenant_code)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE tenant_code = ?, is_active = TRUE`,
      [domain, tenantCode, tenantCode]
    );

    res.json({ success: true, email_domain: domain });
  } catch (error) {
    console.error('[Teams Integration] Add domain error:', error);
    res.status(500).json({ error: 'Failed to add email domain' });
  } finally {
    if (masterConn) masterConn.release();
  }
});

/**
 * DELETE /api/integrations/:tenantCode/teams/email-domain/:domain
 * Remove email domain mapping
 * Requires: integrations.teams feature (Professional+ plan)
 */
router.delete('/:tenantCode/teams/email-domain/:domain', verifyToken, requireTenantMatch, requireElevatedAdmin, requireFeature('integrations.teams'), async (req, res) => {
  const { tenantCode, domain } = req.params;
  let masterConn;

  try {
    masterConn = await getMasterConnection();

    await masterConn.query(
      'DELETE FROM teams_email_domain_mappings WHERE tenant_code = ? AND email_domain = ?',
      [tenantCode, domain.toLowerCase()]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('[Teams Integration] Remove domain error:', error);
    res.status(500).json({ error: 'Failed to remove email domain' });
  } finally {
    if (masterConn) masterConn.release();
  }
});

/**
 * GET /api/integrations/:tenantCode/teams/manifest
 * Download Teams app manifest
 * Requires: integrations.teams feature (Professional+ plan)
 */
router.get('/:tenantCode/teams/manifest', verifyToken, requireTenantMatch, requireElevatedAdmin, requireFeature('integrations.teams'), async (req, res) => {
  const { tenantCode } = req.params;
  let masterConn;

  // Check if tenant is connected
  try {
    masterConn = await getMasterConnection();
    const [mappings] = await masterConn.query(
      'SELECT * FROM teams_tenant_mappings WHERE tenant_code = ? AND is_active = TRUE',
      [tenantCode]
    );

    if (mappings.length === 0) {
      return res.status(400).json({
        error: 'Please connect to Teams first before downloading the manifest'
      });
    }

    // Return info about how to get the manifest
    // In production, you might generate a custom manifest or provide a direct download
    res.json({
      message: 'Install ServiFlow bot in your Teams',
      instructions: [
        '1. Download the ServiFlow Teams app package',
        '2. In Microsoft Teams, go to Apps > Manage your apps',
        '3. Click "Upload an app" > "Upload a custom app"',
        '4. Select the downloaded manifest.zip file',
        '5. Add the bot to your desired teams/channels'
      ],
      download_url: `${APP_BASE_URL}/teams-manifest.zip`,
      teams_admin_url: 'https://admin.teams.microsoft.com/policies/app-setup'
    });
  } catch (error) {
    console.error('[Teams Integration] Manifest error:', error);
    res.status(500).json({ error: 'Failed to get manifest info' });
  } finally {
    if (masterConn) masterConn.release();
  }
});

/**
 * GET /api/integrations/:tenantCode/teams/requirements
 * Get requirements/prerequisites for Teams integration
 */
router.get('/:tenantCode/teams/requirements', async (req, res) => {
  res.json({
    title: 'Microsoft Teams Integration Requirements',
    requirements: [
      {
        id: 'custom_apps',
        title: 'Custom App Permissions',
        description: 'Your Microsoft 365 tenant must allow custom Teams apps (sideloading). This is typically enabled by your IT administrator.',
        check_url: 'https://admin.teams.microsoft.com/policies/app-setup',
        required: true
      },
      {
        id: 'admin_consent',
        title: 'Admin Consent',
        description: 'An administrator may need to consent to the ServiFlow app permissions on behalf of your organization.',
        required: false
      },
      {
        id: 'teams_license',
        title: 'Microsoft Teams License',
        description: 'Users must have a Microsoft Teams license to interact with the bot.',
        required: true
      }
    ],
    permissions_needed: [
      'User.Read - To identify your Microsoft 365 tenant and user email'
    ],
    note: 'ServiFlow does not store your Microsoft credentials. We only store your tenant ID to route messages to the correct ServiFlow account.'
  });
});

module.exports = router;
