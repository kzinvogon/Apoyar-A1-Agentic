const https = require('https');

const MS_CLIENT_ID = process.env.MS_OAUTH_CLIENT_ID || '05c4ccac-2615-405f-af73-2ede3d344080';
const MS_CLIENT_SECRET = process.env.MS_OAUTH_CLIENT_SECRET || '';

/**
 * Get an access token using OAuth2 client credentials flow.
 * Used for app-only access with IMAP.AccessAsApp permission.
 * @param {string} tenantDomain - Azure AD tenant domain or ID (e.g., 'apoyar.eu')
 */
async function getClientCredentialsToken(tenantDomain) {
  const tokenUrl = `https://login.microsoftonline.com/${tenantDomain}/oauth2/v2.0/token`;

  const params = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    client_secret: MS_CLIENT_SECRET,
    grant_type: 'client_credentials',
    scope: 'https://outlook.office365.com/.default'
  });

  return postTokenRequest(params, tokenUrl);
}

/**
 * POST to Microsoft token endpoint
 */
function postTokenRequest(params, tokenUrl) {
  return new Promise((resolve, reject) => {
    const body = params.toString();
    const url = new URL(tokenUrl);

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
 * Get a valid access token for a tenant using client credentials.
 * Caches the token in DB and fetches a new one when expired.
 * @param {Object} connection - DB connection
 * @param {string} tenantCode - Tenant code (for logging)
 */
async function getValidAccessToken(connection, tenantCode) {
  const [rows] = await connection.query(
    'SELECT oauth2_access_token, oauth2_token_expiry, oauth2_email FROM email_ingest_settings ORDER BY id ASC LIMIT 1'
  );

  if (rows.length === 0 || !rows[0].oauth2_email) {
    throw new Error('No Microsoft 365 email configured for this tenant');
  }

  const settings = rows[0];
  const email = settings.oauth2_email;
  const tenantDomain = email.split('@')[1];
  const now = new Date();
  const expiry = settings.oauth2_token_expiry ? new Date(settings.oauth2_token_expiry) : null;

  // Use cached token if still valid (with 5 min buffer)
  if (settings.oauth2_access_token && expiry && now < new Date(expiry.getTime() - 5 * 60 * 1000)) {
    return { accessToken: settings.oauth2_access_token, email };
  }

  // Get new token via client credentials
  console.log(`[OAuth2] Getting client credentials token for ${tenantCode} (tenant: ${tenantDomain})`);
  const tokens = await getClientCredentialsToken(tenantDomain);
  const newExpiry = new Date(Date.now() + (tokens.expires_in || 3599) * 1000);

  // Cache in DB
  await connection.query(
    `UPDATE email_ingest_settings SET
      oauth2_access_token = ?,
      oauth2_token_expiry = ?,
      updated_at = NOW()
    ORDER BY id ASC LIMIT 1`,
    [tokens.access_token, newExpiry]
  );

  return { accessToken: tokens.access_token, email };
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
  getClientCredentialsToken,
  getValidAccessToken,
  buildXOAuth2Token,
  MS_CLIENT_ID
};
