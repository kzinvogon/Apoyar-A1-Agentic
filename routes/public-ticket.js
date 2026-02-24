const express = require('express');
const router = express.Router();
const { validateTicketAccessToken } = require('../utils/tokenGenerator');
const { getMasterConnection } = require('../config/database');

/**
 * Public ticket view route - No authentication required
 * Validates token and displays ticket details
 *
 * Route: GET /ticket/view/:token
 */
router.get('/view/:token', async (req, res) => {
  const { token } = req.params;

  // Extract tenant code from header or use default
  // In a real multi-tenant system, this would come from the domain or a tenant selector
  const tenantCode = req.headers['x-tenant-code'] || 'apoyar';

  try {
    // Validate token and fetch ticket data
    const ticketData = await validateTicketAccessToken(tenantCode, token);

    if (!ticketData) {
      // Token is invalid or expired
      return res.status(404).send(generateErrorPage(
        'Access Link Invalid or Expired',
        'This ticket access link is no longer valid. It may have expired or been used already.',
        'If you need access to this ticket, please contact support or log in to your account.'
      ));
    }

    const { ticket, token: tokenData } = ticketData;

    // Read context query params (cosmetic only — token still controls access)
    const action = req.query.action || null;
    const fromExpert = req.query.from || null;

    // Fetch tenant display name from master DB
    let tenantName = tenantCode;
    try {
      const masterConn = await getMasterConnection();
      const [tenantRows] = await masterConn.query(
        'SELECT company_name FROM tenants WHERE tenant_code = ?',
        [tenantCode]
      );
      if (tenantRows.length > 0 && tenantRows[0].company_name) {
        tenantName = tenantRows[0].company_name;
      }
    } catch (e) {
      // Fall back to tenant code if master DB lookup fails
    }

    // Generate and return ticket view page
    return res.send(generateTicketViewPage(ticket, tokenData, tenantCode, tenantName, action, fromExpert));

  } catch (error) {
    console.error('Error validating ticket token:', error);
    return res.status(500).send(generateErrorPage(
      'Error Loading Ticket',
      'An error occurred while loading the ticket details.',
      'Please try again later or contact support if the problem persists.'
    ));
  }
});

/**
 * Generate HTML for ticket view page
 */
function generateTicketViewPage(ticket, tokenData, tenantCode, tenantName, action, fromExpert) {
  const statusColor = {
    'Open': '#17a2b8',
    'In Progress': '#007bff',
    'Pending': '#ffc107',
    'Resolved': '#28a745',
    'Closed': '#6c757d'
  }[ticket.status] || '#6c757d';

  const priorityColor = {
    'Low': '#28a745',
    'Normal': '#17a2b8',
    'High': '#ffc107',
    'Critical': '#dc3545'
  }[ticket.priority] || '#6c757d';

  const expiresAt = new Date(tokenData.expires_at);
  const accessCount = tokenData.access_count;

  // Build contextual banner based on action
  const bannerConfig = {
    assigned: { text: 'This ticket has been reassigned to you', color: '#007bff', icon: '&#x1f4e8;' },
    created: { text: 'A new support ticket has been created', color: '#17a2b8', icon: '&#x2728;' },
    resolved: { text: 'This ticket has been resolved', color: '#28a745', icon: '&#x2705;' },
    status_changed: { text: 'This ticket status has been updated', color: '#ffc107', icon: '&#x1f504;' }
  };
  const banner = action && bannerConfig[action] ? bannerConfig[action] : null;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ticket #${ticket.id} - ${ticket.title}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
      color: #333;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
      background: white;
      border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.1);
      overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 30px;
      text-align: center;
    }
    .header-logo {
      margin-bottom: 8px;
    }
    .header-logo svg {
      height: 40px;
      width: auto;
    }
    .header h1 {
      font-size: 24px;
      margin-bottom: 10px;
    }
    .header p {
      opacity: 0.9;
      font-size: 14px;
    }
    .content {
      padding: 30px;
    }
    .badge {
      display: inline-block;
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      color: white;
      margin-right: 10px;
      margin-bottom: 10px;
    }
    .section {
      margin-bottom: 30px;
    }
    .section-title {
      font-size: 14px;
      font-weight: 600;
      color: #667eea;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 10px;
    }
    .section-content {
      font-size: 16px;
      line-height: 1.6;
      color: #555;
    }
    .ticket-title {
      font-size: 24px;
      font-weight: 700;
      color: #333;
      margin-bottom: 20px;
    }
    .metadata {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
      padding: 20px;
      background: #f8f9fa;
      border-radius: 8px;
    }
    .metadata-item {
      display: flex;
      flex-direction: column;
    }
    .metadata-label {
      font-size: 12px;
      font-weight: 600;
      color: #667eea;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 5px;
    }
    .metadata-value {
      font-size: 16px;
      color: #333;
    }
    .description-box {
      background: #f8f9fa;
      border-left: 4px solid #667eea;
      padding: 20px;
      border-radius: 4px;
      margin-top: 10px;
    }
    .footer {
      background: #f8f9fa;
      padding: 20px 30px;
      border-top: 1px solid #dee2e6;
      font-size: 12px;
      color: #6c757d;
    }
    .footer-info {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
    }
    .warning-box {
      background: #fff3cd;
      border-left: 4px solid #ffc107;
      padding: 15px;
      border-radius: 4px;
      margin-top: 20px;
      font-size: 14px;
      color: #856404;
    }
    .info-icon {
      display: inline-block;
      width: 16px;
      height: 16px;
      background: #667eea;
      color: white;
      border-radius: 50%;
      text-align: center;
      line-height: 16px;
      font-size: 12px;
      font-weight: bold;
      margin-right: 5px;
    }
    .context-banner {
      padding: 14px 30px;
      font-size: 15px;
      font-weight: 600;
      color: white;
      text-align: center;
    }
    .context-banner .banner-icon {
      margin-right: 8px;
    }
    .people-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
      padding: 20px;
      background: #f0f4ff;
      border-radius: 8px;
      border: 1px solid #dde3f0;
    }
    .people-item {
      display: flex;
      flex-direction: column;
    }
    .people-label {
      font-size: 11px;
      font-weight: 600;
      color: #667eea;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }
    .people-value {
      font-size: 16px;
      font-weight: 600;
      color: #333;
    }
    .people-sub {
      font-size: 12px;
      color: #6c757d;
      margin-top: 2px;
    }
    @media (max-width: 600px) {
      .container {
        border-radius: 0;
      }
      .header, .content, .footer {
        padding: 20px;
      }
      .ticket-title {
        font-size: 20px;
      }
      .metadata {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <div class="header">
      <div class="header-logo">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 50">
          <defs>
            <linearGradient id="brandGradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" style="stop-color:#ffffff"/>
              <stop offset="100%" style="stop-color:#e0e7ff"/>
            </linearGradient>
          </defs>
          <g transform="translate(5, 5)">
            <path d="M12 2 C20 2, 26 8, 26 14 C26 20, 20 22, 14 22 C8 22, 2 28, 2 34 C2 40, 8 46, 16 46"
                  stroke="url(#brandGradient)" stroke-width="4" fill="none" stroke-linecap="round"/>
            <path d="M8 10 L22 10" stroke="url(#brandGradient)" stroke-width="2" stroke-linecap="round" opacity="0.6"/>
            <path d="M6 22 L22 22" stroke="url(#brandGradient)" stroke-width="2" stroke-linecap="round" opacity="0.8"/>
            <path d="M6 34 L20 34" stroke="url(#brandGradient)" stroke-width="2" stroke-linecap="round" opacity="0.6"/>
            <circle cx="28" cy="14" r="3" fill="#10b981"/>
          </g>
          <text x="50" y="35" font-family="Inter, system-ui, sans-serif" font-size="26" font-weight="700" fill="#ffffff">
            Servi<tspan fill="#e0e7ff">Flow</tspan>
          </text>
        </svg>
      </div>
      <h1>${tenantName}</h1>
      <p>Service Request #${ticket.id}</p>
    </div>

    ${banner ? `
    <!-- Contextual Banner -->
    <div class="context-banner" style="background-color: ${banner.color};">
      <span class="banner-icon">${banner.icon}</span>${banner.text}${fromExpert ? ` (previously: ${fromExpert})` : ''}
    </div>
    ` : ''}

    <!-- Content -->
    <div class="content">
      <!-- Title -->
      <h2 class="ticket-title">${ticket.title}</h2>

      <!-- Status and Priority Badges -->
      <div style="margin-bottom: 20px;">
        <span class="badge" style="background-color: ${statusColor};">
          ${ticket.status}
        </span>
        <span class="badge" style="background-color: ${priorityColor};">
          Priority: ${ticket.priority}
        </span>
        ${ticket.category ? `<span class="badge" style="background-color: #6c757d;">${ticket.category}</span>` : ''}
      </div>

      <!-- People -->
      <div class="people-grid">
        ${ticket.requester_name ? `
        <div class="people-item">
          <span class="people-label">Customer</span>
          <span class="people-value">${ticket.requester_name}</span>
          ${ticket.requester_email ? `<span class="people-sub">${ticket.requester_email}</span>` : ''}
        </div>
        ` : ''}
        ${ticket.assignee_name ? `
        <div class="people-item">
          <span class="people-label">Assigned To</span>
          <span class="people-value">${ticket.assignee_name}</span>
        </div>
        ` : ''}
        ${fromExpert ? `
        <div class="people-item">
          <span class="people-label">Previous Expert</span>
          <span class="people-value">${fromExpert}</span>
        </div>
        ` : ''}
      </div>

      <!-- Metadata -->
      <div class="metadata">
        <div class="metadata-item">
          <span class="metadata-label">Ticket Number</span>
          <span class="metadata-value">#${ticket.id}</span>
        </div>
        <div class="metadata-item">
          <span class="metadata-label">Created</span>
          <span class="metadata-value">${new Date(ticket.created_at).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
          })}</span>
        </div>
        <div class="metadata-item">
          <span class="metadata-label">Last Updated</span>
          <span class="metadata-value">${new Date(ticket.updated_at).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
          })}</span>
        </div>
      </div>

      <!-- Description -->
      <div class="section">
        <div class="section-title">Description</div>
        <div class="description-box">
          ${ticket.description || '<em>No description provided</em>'}
        </div>
      </div>

      <!-- Read-only Notice -->
      <div class="warning-box">
        <span class="info-icon">i</span>
        <strong>Read-Only Access:</strong> This is a secure view-only link. To update this ticket or add comments, please log in to your account.
      </div>

      <!-- Login Button -->
      ${ticket.requester_email && ticket.requester_username ? `
      <div style="text-align: center; margin-top: 25px;">
        <a href="/?username=${encodeURIComponent(ticket.requester_username || ticket.requester_email)}&role=${ticket.requester_role || 'customer'}&tenant=${encodeURIComponent(tenantCode)}"
           style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4); transition: transform 0.2s, box-shadow 0.2s;"
           onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 6px 20px rgba(102, 126, 234, 0.5)';"
           onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 4px 15px rgba(102, 126, 234, 0.4)';">
          🔐 Login to Dashboard
        </a>
        <p style="margin-top: 12px; font-size: 13px; color: #6c757d;">
          Your username will be pre-filled. Just enter your password to access the full dashboard.
        </p>
      </div>
      ` : ''}
    </div>

    <!-- Footer -->
    <div class="footer">
      <div class="footer-info">
        <div>
          <strong>Secure Access Link</strong><br>
          This link expires on ${expiresAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
        </div>
        <div style="text-align: right;">
          Access #${accessCount} • ${tenantCode.toUpperCase()}
        </div>
      </div>
    </div>
  </div>
</body>
</html>
  `;
}

/**
 * Generate HTML for error page
 */
function generateErrorPage(title, message, helpText) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .error-container {
      max-width: 500px;
      background: white;
      border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.1);
      padding: 40px;
      text-align: center;
    }
    .error-icon {
      font-size: 64px;
      margin-bottom: 20px;
    }
    h1 {
      font-size: 24px;
      color: #333;
      margin-bottom: 15px;
    }
    .message {
      font-size: 16px;
      color: #666;
      margin-bottom: 20px;
      line-height: 1.6;
    }
    .help-text {
      font-size: 14px;
      color: #999;
      padding-top: 20px;
      border-top: 1px solid #eee;
    }
  </style>
</head>
<body>
  <div class="error-container">
    <div class="error-icon">🔒</div>
    <h1>${title}</h1>
    <p class="message">${message}</p>
    <p class="help-text">${helpText}</p>
  </div>
</body>
</html>
  `;
}

module.exports = router;
