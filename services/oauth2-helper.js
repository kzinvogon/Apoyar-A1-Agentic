const https = require('https');

const MS_CLIENT_ID = process.env.MS_OAUTH_CLIENT_ID || '05c4ccac-2615-405f-af73-2ede3d344080';
const MS_CLIENT_SECRET = process.env.MS_OAUTH_CLIENT_SECRET || '';
const MS_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

/**
 * Exchange an authorization code for tokens
 */
async function exchangeCodeForTokens(code, redirectUri) {
  const params = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    client_secret: MS_CLIENT_SECRET,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    scope: 'https://outlook.office365.com/IMAP.AccessAsUser.All offline_access'
  });

  return postTokenRequest(params);
}

/**
 * Refresh an access token using a refresh token
 */
async function refreshAccessToken(refreshToken) {
  const params = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    client_secret: MS_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    scope: 'https://outlook.office365.com/IMAP.AccessAsUser.All offline_access'
  });

  return postTokenRequest(params);
}

/**
 * POST to Microsoft token endpoint
 */
function postTokenRequest(params) {
  return new Promise((resolve, reject) => {
    const body = params.toString();
    const url = new URL(MS_TOKEN_URL);

    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(`${parsed.error}: ${parsed.error_description || 'Unknown error'}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error('Failed to parse token response'));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Get a valid access token for a tenant, refreshing if expired.
 * Requires a DB connection to the tenant database.
 */
async function getValidAccessToken(connection, tenantCode) {
  const [rows] = await connection.query(
    'SELECT oauth2_access_token, oauth2_refresh_token, oauth2_token_expiry, oauth2_email FROM email_ingest_settings ORDER BY id ASC LIMIT 1'
  );

  if (rows.length === 0 || !rows[0].oauth2_refresh_token) {
    throw new Error('No OAuth2 tokens configured for this tenant');
  }

  const settings = rows[0];
  const now = new Date();
  const expiry = settings.oauth2_token_expiry ? new Date(settings.oauth2_token_expiry) : null;

  // Refresh if expired or expiring within 5 minutes
  if (!expiry || now >= new Date(expiry.getTime() - 5 * 60 * 1000)) {
    console.log(`[OAuth2] Token expired for ${tenantCode}, refreshing...`);
    const tokens = await refreshAccessToken(settings.oauth2_refresh_token);

    const newExpiry = new Date(Date.now() + (tokens.expires_in || 3599) * 1000);

    await connection.query(
      `UPDATE email_ingest_settings SET
        oauth2_access_token = ?,
        oauth2_token_expiry = ?,
        oauth2_refresh_token = COALESCE(?, oauth2_refresh_token),
        updated_at = NOW()
      ORDER BY id ASC LIMIT 1`,
      [tokens.access_token, newExpiry, tokens.refresh_token || null]
    );

    return { accessToken: tokens.access_token, email: settings.oauth2_email };
  }

  return { accessToken: settings.oauth2_access_token, email: settings.oauth2_email };
}

/**
 * Build the XOAUTH2 string for IMAP authentication.
 * Format: user=<email>\x01auth=Bearer <token>\x01\x01
 */
function buildXOAuth2Token(email, accessToken) {
  return Buffer.from(
    `user=${email}\x01auth=Bearer ${accessToken}\x01\x01`
  ).toString('base64');
}

module.exports = {
  exchangeCodeForTokens,
  refreshAccessToken,
  getValidAccessToken,
  buildXOAuth2Token,
  MS_CLIENT_ID
};
