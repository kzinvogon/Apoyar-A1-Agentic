const nodemailer = require('nodemailer');
const { createTicketAccessToken } = require('../utils/tokenGenerator');
const { getTenantConnection } = require('./database');
const { sendMailViaGraph } = require('../services/oauth2-helper');

// Only create transporter if credentials are configured
let transporter = null;
const smtpEmail = process.env.SMTP_EMAIL;
const smtpPassword = process.env.SMTP_PASSWORD;

// Helper function to check if email sending is enabled for a tenant
// emailType can be 'experts', 'customers', or null (legacy - checks send_emails)
async function isEmailSendingEnabled(tenantCode, emailType = null) {
  try {
    const connection = await getTenantConnection(tenantCode);
    try {
      // Determine which setting to check
      let settingKey = 'send_emails';
      if (emailType === 'experts') {
        settingKey = 'send_emails_experts';
      } else if (emailType === 'customers') {
        settingKey = 'send_emails_customers';
      }

      const [settings] = await connection.query(
        'SELECT setting_value FROM tenant_settings WHERE setting_key = ?',
        [settingKey]
      );
      // Default to enabled if setting not found
      if (settings.length === 0) return true;
      return settings[0].setting_value !== 'false';
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error checking email sending setting:', error);
    return true; // Default to enabled if check fails
  }
}

// Helper function to check if email notifications are enabled for a specific user
// Uses the receive_email_updates column (default ON for normal users, OFF for system users)
async function isUserEmailNotificationsEnabled(tenantCode, userEmail) {
  try {
    const connection = await getTenantConnection(tenantCode);
    try {
      // Check company-level override first
      try {
        const [companyRows] = await connection.query(`
          SELECT cc.members_receive_emails
          FROM customers c
          JOIN customer_companies cc ON c.customer_company_id = cc.id
          JOIN users u ON c.user_id = u.id
          WHERE u.email = ? AND cc.is_active = 1
          LIMIT 1
        `, [userEmail]);

        if (companyRows.length > 0 && companyRows[0].members_receive_emails === 0) {
          return false; // Company-wide emails disabled — overrides individual setting
        }
      } catch (companyErr) {
        // Column may not exist yet on older tenants — skip check
        console.error('Company email check skipped:', companyErr.message);
      }

      // First check if column exists to avoid query errors
      const [cols] = await connection.query(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'receive_email_updates'
      `, [`a1_tenant_${tenantCode}`]);

      // If column doesn't exist, default to enabled
      if (cols.length === 0) {
        return true;
      }

      const [users] = await connection.query(
        'SELECT receive_email_updates FROM users WHERE email = ?',
        [userEmail]
      );
      // Default to enabled if user not found
      if (users.length === 0) return true;
      // If value is null, default to enabled
      if (users[0].receive_email_updates === undefined || users[0].receive_email_updates === null) return true;
      return users[0].receive_email_updates === 1;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error checking user email notification setting:', error);
    return true; // Default to enabled if check fails
  }
}

if (smtpEmail && smtpPassword && smtpEmail !== 'your-email@gmail.com' && smtpPassword !== 'your-app-password') {
  transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, // Use STARTTLS
    requireTLS: true,
    auth: {
      user: smtpEmail,
      pass: smtpPassword // Use App Password for Gmail
    },
    connectionTimeout: 30000, // 30 seconds
    greetingTimeout: 30000,
    socketTimeout: 30000,
    tls: {
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2'
    }
  });

  console.log(`📧 SMTP configured: ${smtpEmail} via smtp.gmail.com:587 (STARTTLS)`);

  // Verify transporter configuration
  transporter.verify((error, success) => {
    if (error) {
      console.log('❌ Email server configuration error:', error.message);
    } else {
      console.log('✅ Email server is ready to send messages');
    }
  });
} else {
  console.log('⚠️  SMTP credentials not configured. Email sending disabled.');
  console.log('📧 To enable email notifications, set SMTP_EMAIL and SMTP_PASSWORD environment variables');
  if (smtpEmail) console.log('   SMTP_EMAIL is set to:', smtpEmail);
  if (!smtpPassword) console.log('   SMTP_PASSWORD is NOT set');
}

// Tenant-specific SMTP transporter cache (key: tenantCode, value: { transporter, from, expiresAt })
const tenantTransporterCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get an email sender for a tenant.
 * Returns { send(to, subject, html), from } — uses O365 Graph, tenant SMTP, or global Gmail.
 */
async function getTenantEmailSender(tenantCode) {
  if (!tenantCode) return null;

  // Check cache first
  const cached = tenantTransporterCache.get(tenantCode);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.sender;
  }

  let connection;
  try {
    connection = await getTenantConnection(tenantCode);
    const [rows] = await connection.query(
      'SELECT auth_method, oauth2_email, use_for_outbound, smtp_host, smtp_port, username, password FROM email_ingest_settings ORDER BY id ASC LIMIT 1'
    );

    if (rows.length === 0 || !rows[0].use_for_outbound) {
      return null; // Fallback to global
    }

    const settings = rows[0];

    // Get company name for "From" display name
    let companyName = 'Support';
    try {
      const [profile] = await connection.query(
        'SELECT company_name, mail_from_email FROM company_profile LIMIT 1'
      );
      if (profile.length > 0 && profile[0].company_name) {
        companyName = profile[0].company_name;
      }
    } catch (_) { /* table may not exist */ }

    let sender = null;

    if (settings.auth_method === 'oauth2' && settings.oauth2_email) {
      // O365 via Graph API
      const fromEmail = settings.oauth2_email;
      const fromAddr = `"${companyName}" <${fromEmail}>`;
      sender = {
        from: fromAddr,
        send: async (to, subject, html) => {
          const conn = await getTenantConnection(tenantCode);
          try {
            await sendMailViaGraph(conn, tenantCode, fromEmail, to, subject, html);
          } finally {
            conn.release();
          }
          return { messageId: `graph-${Date.now()}@${fromEmail}` };
        }
      };
    } else if (settings.auth_method === 'basic' && settings.smtp_host && settings.username) {
      // Tenant-specific SMTP
      const fromEmail = settings.username;
      const fromAddr = `"${companyName}" <${fromEmail}>`;
      const tenantSmtp = nodemailer.createTransport({
        host: settings.smtp_host,
        port: settings.smtp_port || 587,
        secure: (settings.smtp_port || 587) === 465,
        auth: {
          user: settings.username,
          pass: settings.password
        },
        connectionTimeout: 30000,
        greetingTimeout: 30000,
        socketTimeout: 30000,
        tls: { rejectUnauthorized: false }
      });
      sender = {
        from: fromAddr,
        send: async (to, subject, html) => {
          const info = await tenantSmtp.sendMail({ from: fromAddr, to, subject, html });
          return { messageId: info.messageId };
        }
      };
    }

    if (sender) {
      tenantTransporterCache.set(tenantCode, {
        sender,
        expiresAt: Date.now() + CACHE_TTL_MS
      });
    }

    return sender;
  } catch (error) {
    console.error(`[Email] Failed to get tenant sender for ${tenantCode}:`, error.message);
    return null; // Fallback to global
  } finally {
    if (connection) connection.release();
  }
}

// Function to send ticket notification email
async function sendTicketNotificationEmail(ticketData, action, details = {}) {
  try {
    const { ticket, customer_email, customer_name, tenantCode } = ticketData;

    // Check if email sending is enabled (kill switch)
    // Determine email type based on action:
    // - 'assigned' action sends to experts/assignees
    // - All other actions (created, resolved, status_changed) send to customers
    const emailType = action === 'assigned' ? 'experts' : 'customers';
    if (tenantCode) {
      const emailEnabled = await isEmailSendingEnabled(tenantCode, emailType);
      if (!emailEnabled) {
        console.log(`🔴 KILL SWITCH: Email sending is disabled (send_emails_${emailType}) for tenant:`, tenantCode);
        console.log('📧 Would have sent email for:', action, 'to:', customer_email);
        return { success: false, message: 'Email sending disabled by kill switch' };
      }
    }

    if (!customer_email) {
      console.log('⚠️  Skipping email - no customer email found for ticket', ticket.id);
      return { success: false, message: 'No customer email' };
    }

    // Check if user has email notifications enabled
    if (tenantCode) {
      const userEmailEnabled = await isUserEmailNotificationsEnabled(tenantCode, customer_email);
      if (!userEmailEnabled) {
        console.log('🔕 Email notifications disabled for user:', customer_email);
        console.log('📧 Would have sent email for:', action, 'to:', customer_email);
        return { success: false, message: 'User email notifications disabled' };
      }
    }

    // Generate secure access token for ticket
    let token = null;
    if (tenantCode && ticket.id) {
      try {
        token = await createTicketAccessToken(tenantCode, ticket.id, 30); // 30 days expiration
        console.log(`🔐 Generated access token for ticket #${ticket.id}`);
      } catch (error) {
        console.error('⚠️  Failed to generate access token:', error.message);
        // Continue without token - will fall back to login-required access
      }
    }

    // Build ticket URL - use token if available, otherwise use ticket ID
    const ticketUrl = token
      ? `${process.env.BASE_URL || 'https://serviflow.app'}/ticket/view/${token}`
      : `${process.env.BASE_URL || 'https://serviflow.app'}/ticket/${ticket.id}`;

    // Build email subject
    const subject = `[Ticket #${ticket.id}] ${ticket.title} - ${action}`;

    // Build email body based on action
    let emailBody = '';
    let actionDescription = '';

    if (action === 'resolved') {
      const loginUrl = `${process.env.BASE_URL || 'https://serviflow.app'}/?username=${encodeURIComponent(ticket.requester_username || ticket.requester_email)}&role=${ticket.requester_role || 'customer'}`;

      emailBody = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #28a745;">Your Support Ticket Has Been Resolved</h2>
          <p><strong>Ticket #${ticket.id}</strong></p>
          <p><strong>Status:</strong> <span style="color: #28a745;">Resolved</span></p>
          <p><strong>Title:</strong> ${ticket.title}</p>
          ${details.comment ? `<p><strong>Resolution Comment:</strong> ${details.comment}</p>` : ''}

          <hr style="border: 1px solid #ddd; margin: 20px 0;">

          <h3>View & Respond to Your Ticket</h3>
          <p>You can view your ticket details and respond to the resolution:</p>
          <p style="text-align: center;">
            <a href="${ticketUrl}"
               style="background-color: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block; margin: 5px;">
              View Ticket (No Login)
            </a>
            <a href="${loginUrl}"
               style="background-color: #28a745; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block; margin: 5px;">
              Login to Dashboard
            </a>
          </p>

          <p><small>Or copy this link: ${ticketUrl}</small></p>
          ${token ? '<p style="color: #666; font-size: 12px;"><em>The "View Ticket" link is a secure access link that expires in 30 days. No login required.</em></p>' : ''}
          <p style="color: #666; font-size: 12px;"><em>The "Login to Dashboard" button will take you to the login page with your username pre-filled.</em></p>
        </div>
      `;
    } else if (action === 'status_changed') {
      const loginUrl = `${process.env.BASE_URL || 'https://serviflow.app'}/?username=${encodeURIComponent(ticket.requester_username || ticket.requester_email)}&role=${ticket.requester_role || 'customer'}`;

      emailBody = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #007bff;">Your Support Ticket Has Been Updated</h2>
          <p><strong>Ticket #${ticket.id}</strong></p>
          <p><strong>Status:</strong> <span style="color: #007bff;">${details.newStatus}</span></p>
          <p><strong>Previous Status:</strong> ${details.oldStatus}</p>
          <p><strong>Title:</strong> ${ticket.title}</p>

          <hr style="border: 1px solid #ddd; margin: 20px 0;">

          <h3>View Your Ticket</h3>
          <p style="text-align: center;">
            <a href="${ticketUrl}"
               style="background-color: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block; margin: 5px;">
              View Ticket (No Login)
            </a>
            <a href="${loginUrl}"
               style="background-color: #28a745; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block; margin: 5px;">
              Login to Dashboard
            </a>
          </p>

          <p><small>Or copy this link: ${ticketUrl}</small></p>
          ${token ? '<p style="color: #666; font-size: 12px;"><em>The "View Ticket" link is a secure access link that expires in 30 days. No login required.</em></p>' : ''}
          <p style="color: #666; font-size: 12px;"><em>The "Login to Dashboard" button will take you to the login page with your username pre-filled.</em></p>
        </div>
      `;
    } else if (action === 'created') {
      const loginUrl = `${process.env.BASE_URL || 'https://serviflow.app'}/?username=${encodeURIComponent(ticket.requester_username || ticket.requester_email)}&role=${ticket.requester_role || 'customer'}`;

      emailBody = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #17a2b8;">Your Support Ticket Has Been Created</h2>
          <p><strong>Ticket #${ticket.id}</strong></p>
          <p><strong>Status:</strong> ${ticket.status}</p>
          <p><strong>Title:</strong> ${ticket.title}</p>
          <p><strong>Description:</strong> ${ticket.description}</p>

          <hr style="border: 1px solid #ddd; margin: 20px 0;">

          <h3>Track Your Ticket</h3>
          <p style="text-align: center;">
            <a href="${ticketUrl}"
               style="background-color: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block; margin: 5px;">
              View Ticket (No Login)
            </a>
            <a href="${loginUrl}"
               style="background-color: #28a745; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block; margin: 5px;">
              Login to Dashboard
            </a>
          </p>

          <p><small>Or copy this link: ${ticketUrl}</small></p>
          ${token ? '<p style="color: #666; font-size: 12px;"><em>The "View Ticket" link is a secure access link that expires in 30 days. No login required.</em></p>' : ''}
          <p style="color: #666; font-size: 12px;"><em>The "Login to Dashboard" button will take you to the login page with your username pre-filled.</em></p>
          <p><small>We will keep you updated on any changes to your ticket.</small></p>
        </div>
      `;
    } else if (action === 'assigned') {
      const loginUrl = `${process.env.BASE_URL || 'https://serviflow.app'}/?username=${encodeURIComponent(details.assignee_username || details.assignee_email)}&role=${details.assignee_role || 'expert'}`;

      emailBody = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #007bff;">New Ticket Assigned to You</h2>
          <p><strong>Ticket #${ticket.id}</strong></p>
          <p><strong>Status:</strong> <span style="color: #007bff;">${ticket.status}</span></p>
          <p><strong>Priority:</strong> <span style="color: ${ticket.priority === 'high' || ticket.priority === 'critical' ? '#dc3545' : ticket.priority === 'medium' ? '#ffc107' : '#28a745'};">${ticket.priority}</span></p>
          <p><strong>Title:</strong> ${ticket.title}</p>
          <p><strong>Description:</strong> ${ticket.description || '(No description provided)'}</p>
          ${details.comment ? `<p><strong>Assignment Note:</strong> ${details.comment}</p>` : ''}
          ${ticket.requester_name ? `<p><strong>Requester:</strong> ${ticket.requester_name}</p>` : ''}

          <hr style="border: 1px solid #ddd; margin: 20px 0;">

          <h3>Access Your Ticket</h3>
          <p>This ticket has been assigned to you. Please review and take action:</p>
          <p style="text-align: center;">
            <a href="${ticketUrl}"
               style="background-color: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block; margin: 5px;">
              View Ticket (No Login)
            </a>
            <a href="${loginUrl}"
               style="background-color: #28a745; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block; margin: 5px;">
              Login to Dashboard
            </a>
          </p>

          <p><small>Or copy this link: ${ticketUrl}</small></p>
          ${token ? '<p style="color: #666; font-size: 12px;"><em>The "View Ticket" link is a secure access link that expires in 30 days. No login required.</em></p>' : ''}
          <p style="color: #666; font-size: 12px;"><em>The "Login to Dashboard" button will take you to the login page with your username pre-filled.</em></p>
        </div>
      `;
    }

    // Try tenant-specific sender first, fall back to global
    let tenantSender = null;
    if (tenantCode) {
      try {
        tenantSender = await getTenantEmailSender(tenantCode);
      } catch (err) {
        console.warn(`[Email] Tenant sender failed for ${tenantCode}, using global:`, err.message);
      }
    }

    if (tenantSender) {
      const result = await tenantSender.send(customer_email, subject, emailBody);
      console.log(`📧 Email sent via tenant sender to ${customer_email} - Message ID: ${result.messageId}`);
      return { success: true, messageId: result.messageId };
    }

    if (!transporter) {
      console.log('⚠️  Skipping email notification - SMTP not configured');
      return { success: false, message: 'SMTP not configured' };
    }

    const info = await transporter.sendMail({
      from: `"A1 Support" <${process.env.SMTP_EMAIL || 'support@a1support.com'}>`,
      to: customer_email,
      subject: subject,
      html: emailBody
    });

    console.log(`📧 Email sent successfully to ${customer_email} - Message ID: ${info.messageId}`);
    return { success: true, messageId: info.messageId };

  } catch (error) {
    console.error('❌ Error sending email:', error);
    return { success: false, error: error.message };
  }
}

// Function to send generic notification email
// tenantCode and emailType are optional - if provided, checks kill switch
async function sendNotificationEmail(to, subject, htmlContent, tenantCode = null, emailType = 'customers') {
  try {
    // Check kill switch if tenantCode provided
    if (tenantCode) {
      const emailEnabled = await isEmailSendingEnabled(tenantCode, emailType);
      if (!emailEnabled) {
        const settingName = `send_emails_${emailType}`;
        console.log(`🔴 KILL SWITCH: Email sending is disabled (${settingName}) for tenant:`, tenantCode);
        console.log('📧 Would have sent email to:', to, 'Subject:', subject);
        return { success: false, message: 'Email sending disabled by kill switch' };
      }
    }

    // Try tenant-specific sender first
    let tenantSender = null;
    if (tenantCode) {
      try {
        tenantSender = await getTenantEmailSender(tenantCode);
      } catch (err) {
        console.warn(`[Email] Tenant sender failed for ${tenantCode}, using global:`, err.message);
      }
    }

    if (tenantSender) {
      const result = await tenantSender.send(to, subject, htmlContent);
      console.log(`📧 Notification email sent via tenant sender to ${to}`);
      return { success: true, messageId: result.messageId };
    }

    if (!transporter) {
      console.log('⚠️  Skipping notification email - SMTP not configured');
      console.log('📧 Would have sent to:', to, 'Subject:', subject);
      return { success: false, message: 'SMTP not configured' };
    }

    const info = await transporter.sendMail({
      from: `"A1 Support" <${process.env.SMTP_EMAIL || 'support@a1support.com'}>`,
      to: to,
      subject: subject,
      html: htmlContent
    });

    console.log(`📧 Notification email sent successfully to ${to}`);
    return { success: true, messageId: info.messageId };

  } catch (error) {
    console.error('❌ Error sending notification email:', error);
    return { success: false, error: error.message };
  }
}

// Function to send generic email (used by password reset, etc.)
// options.emailType can be 'experts' or 'customers' to check granular kill switches
// options.skipKillSwitch - if true, bypasses kill switch (for security-critical emails like password reset)
async function sendEmail(tenantCode, options) {
  try {
    // Check if email sending is enabled (kill switch)
    // Skip this check for security-critical emails (password reset, etc.)
    if (tenantCode && !options.skipKillSwitch) {
      const emailType = options.emailType || null;
      const emailEnabled = await isEmailSendingEnabled(tenantCode, emailType);
      if (!emailEnabled) {
        const settingName = emailType ? `send_emails_${emailType}` : 'send_emails';
        console.log(`🔴 KILL SWITCH: Email sending is disabled (${settingName}) for tenant:`, tenantCode);
        console.log('📧 Would have sent email to:', options.to);
        return { success: false, message: 'Email sending disabled by kill switch' };
      }
    }

    const { to, subject, html, skipUserCheck } = options;

    // Check if user has email notifications enabled (unless skipped)
    if (tenantCode && to && !skipUserCheck) {
      const userEmailEnabled = await isUserEmailNotificationsEnabled(tenantCode, to);
      if (!userEmailEnabled) {
        console.log('🔕 Email notifications disabled for user:', to);
        console.log('📧 Would have sent email to:', to, 'Subject:', subject);
        return { success: false, message: 'User email notifications disabled' };
      }
    }

    if (!to || !subject || !html) {
      throw new Error('Missing required email parameters: to, subject, html');
    }

    // Try tenant-specific sender first
    let tenantSender = null;
    if (tenantCode) {
      try {
        tenantSender = await getTenantEmailSender(tenantCode);
      } catch (err) {
        console.warn(`[Email] Tenant sender failed for ${tenantCode}, using global:`, err.message);
      }
    }

    if (tenantSender) {
      const result = await tenantSender.send(to, subject, html);
      console.log(`📧 Email sent via tenant sender to ${to} - Message ID: ${result.messageId}`);
      return { success: true, messageId: result.messageId };
    }

    if (!transporter) {
      console.log('⚠️  Skipping email - SMTP not configured');
      return { success: false, message: 'SMTP not configured' };
    }

    const info = await transporter.sendMail({
      from: `"A1 Support" <${process.env.SMTP_EMAIL || 'support@a1support.com'}>`,
      to: to,
      subject: subject,
      html: html
    });

    console.log(`📧 Email sent successfully to ${to} - Message ID: ${info.messageId}`);
    return { success: true, messageId: info.messageId };

  } catch (error) {
    console.error('❌ Error sending email:', error);
    return { success: false, error: error.message };
  }
}

// Function to test email connection
async function testEmailConnection(testEmail) {
  try {
    // Check if transporter is configured
    if (!transporter) {
      return {
        success: false,
        message: 'SMTP not configured. Please add SMTP_EMAIL and SMTP_PASSWORD to .env file',
        configured: false
      };
    }

    // First verify the connection
    await transporter.verify();
    console.log('✅ SMTP connection verified successfully');

    // If test email is provided, send a test email
    if (testEmail) {
      const testEmailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
          <h2 style="color: #28a745;">Email Connection Test Successful!</h2>
          <p>This is a test email from the A1 Support Dashboard.</p>
          <p><strong>SMTP Configuration:</strong></p>
          <ul>
            <li><strong>Service:</strong> Gmail</li>
            <li><strong>From:</strong> ${process.env.SMTP_EMAIL}</li>
            <li><strong>Test Sent:</strong> ${new Date().toLocaleString()}</li>
          </ul>
          <hr style="border: 1px solid #ddd; margin: 20px 0;">
          <p style="color: #666; font-size: 12px;">
            If you received this email, your email configuration is working correctly.
          </p>
        </div>
      `;

      const info = await transporter.sendMail({
        from: `"A1 Support" <${process.env.SMTP_EMAIL}>`,
        to: testEmail,
        subject: 'A1 Support - Email Connection Test',
        html: testEmailHtml
      });

      console.log(`✅ Test email sent successfully to ${testEmail} - Message ID: ${info.messageId}`);

      return {
        success: true,
        configured: true,
        message: `Test email sent successfully to ${testEmail}`,
        messageId: info.messageId,
        smtpEmail: process.env.SMTP_EMAIL
      };
    }

    // If no test email provided, just verify connection
    return {
      success: true,
      configured: true,
      message: 'SMTP connection verified successfully',
      smtpEmail: process.env.SMTP_EMAIL
    };

  } catch (error) {
    console.error('❌ Email connection test failed:', error);
    return {
      success: false,
      configured: true,
      message: error.message,
      error: error.code || 'Unknown error'
    };
  }
}

module.exports = {
  transporter,
  sendTicketNotificationEmail,
  sendNotificationEmail,
  sendEmail,
  testEmailConnection
};

