const express = require('express');
const router = express.Router();
const { validateTicketAccessToken } = require('../utils/tokenGenerator');

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

    // Generate and return ticket view page
    return res.send(generateTicketViewPage(ticket, tokenData, tenantCode));

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
function generateTicketViewPage(ticket, tokenData, tenantCode) {
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
      <h1>🎫 Support Ticket</h1>
      <p>Ticket #${ticket.id}</p>
    </div>

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
        ${ticket.requester_name ? `
        <div class="metadata-item">
          <span class="metadata-label">Requester</span>
          <span class="metadata-value">${ticket.requester_name}</span>
        </div>
        ` : ''}
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
