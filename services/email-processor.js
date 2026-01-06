const { getTenantConnection } = require('../config/database');
const { sendNotificationEmail } = require('../config/email');
const { createTicketAccessToken } = require('../utils/tokenGenerator');
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

/**
 * Email Processor Service
 * Handles fetching emails from inbox and creating tickets
 */

class EmailProcessor {
  constructor(tenantCode) {
    this.tenantCode = tenantCode;
    this.isProcessing = false;
    this.imap = null;
  }

  /**
   * Check if email processing is enabled (kill switch)
   */
  async isEmailProcessingEnabled() {
    try {
      const connection = await getTenantConnection(this.tenantCode);
      try {
        const [settings] = await connection.query(
          'SELECT setting_value FROM tenant_settings WHERE setting_key = ?',
          ['process_emails']
        );
        // Default to enabled if setting not found
        if (settings.length === 0) return true;
        return settings[0].setting_value !== 'false';
      } finally {
        connection.release();
      }
    } catch (error) {
      console.error('Error checking email processing setting:', error);
      return true; // Default to enabled if check fails
    }
  }

  /**
   * Process incoming emails
   */
  async processEmails() {
    if (this.isProcessing) {
      console.log(`Email processing already in progress for tenant: ${this.tenantCode}`);
      return;
    }

    // Check if email processing is enabled (kill switch)
    const processingEnabled = await this.isEmailProcessingEnabled();
    if (!processingEnabled) {
      console.log(`🔴 KILL SWITCH: Email processing is disabled for tenant: ${this.tenantCode}`);
      return;
    }

    this.isProcessing = true;

    try {
      const connection = await getTenantConnection(this.tenantCode);

      try {
        // Get email ingest settings
        const [settings] = await connection.query(
          'SELECT * FROM email_ingest_settings WHERE enabled = TRUE LIMIT 1'
        );

        if (settings.length === 0) {
          console.log(`Email ingest not enabled for tenant: ${this.tenantCode}`);
          return;
        }

        const config = settings[0];

        console.log(`Connecting to email server for ${this.tenantCode}:`, {
          server: config.server_host,
          port: config.server_port,
          type: config.server_type
        });

        // Fetch emails using IMAP
        await this.fetchEmailsViaIMAP(connection, config);

        // Update last checked timestamp
        await connection.query(
          'UPDATE email_ingest_settings SET last_checked_at = NOW() WHERE id = ?',
          [config.id]
        );

      } finally {
        connection.release();
      }
    } catch (error) {
      console.error(`Error processing emails for tenant ${this.tenantCode}:`, error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Fetch emails via IMAP
   */
  async fetchEmailsViaIMAP(connection, config) {
    return new Promise((resolve, reject) => {
      // Configure IMAP connection
      const imap = new Imap({
        user: config.username,
        password: config.password,
        host: config.server_host,
        port: config.server_port,
        tls: config.use_ssl,
        tlsOptions: { rejectUnauthorized: false }
      });

      const processedEmails = [];

      imap.once('ready', () => {
        console.log(`✅ IMAP connected for tenant: ${this.tenantCode}`);

        // Open [Gmail]/All Mail to catch emails filtered by Gmail screener
        imap.openBox('[Gmail]/All Mail', false, (err, box) => {
          if (err) {
            console.error('Error opening [Gmail]/All Mail:', err);
            imap.end();
            return reject(err);
          }

          // Search for unseen (unread) emails in All Mail
          imap.search(['UNSEEN'], (err, results) => {
            if (err) {
              console.error('Error searching emails:', err);
              imap.end();
              return reject(err);
            }

            if (!results || results.length === 0) {
              console.log(`No new emails found for tenant: ${this.tenantCode}`);
              imap.end();
              return resolve(processedEmails);
            }

            console.log(`📧 Found ${results.length} new email(s) for tenant: ${this.tenantCode}`);

            // Fetch email messages
            const fetch = imap.fetch(results, { bodies: '', markSeen: true });

            fetch.on('message', (msg, seqno) => {
              console.log(`Processing email #${seqno}`);

              msg.on('body', (stream, info) => {
                let buffer = '';

                stream.on('data', (chunk) => {
                  buffer += chunk.toString('utf8');
                });

                stream.once('end', async () => {
                  try {
                    // Parse the email
                    const parsed = await simpleParser(buffer);

                    const emailData = {
                      from: parsed.from?.text || parsed.from?.value?.[0]?.address || '',
                      subject: parsed.subject || '(No Subject)',
                      body: parsed.text || parsed.html || '(No content)',
                      messageId: parsed.messageId || `msg-${Date.now()}`,
                      date: parsed.date
                    };

                    console.log(`📨 Email from: ${emailData.from}, Subject: ${emailData.subject}`);

                    // Process the email using existing logic
                    const result = await this.processEmail(connection, emailData);
                    processedEmails.push(result);

                  } catch (parseError) {
                    console.error(`Error parsing email #${seqno}:`, parseError);
                  }
                });
              });
            });

            fetch.once('error', (err) => {
              console.error('Fetch error:', err);
              reject(err);
            });

            fetch.once('end', () => {
              console.log(`✅ Finished processing ${processedEmails.length} email(s)`);
              imap.end();
            });
          });
        });
      });

      imap.once('error', (err) => {
        console.error(`❌ IMAP connection error for tenant ${this.tenantCode}:`, err.message);
        reject(err);
      });

      imap.once('end', () => {
        console.log(`IMAP connection closed for tenant: ${this.tenantCode}`);
        resolve(processedEmails);
      });

      // Connect to IMAP server
      imap.connect();
    });
  }

  /**
   * Get the tenant's domain from settings
   */
  async getTenantDomain(connection) {
    try {
      const [settings] = await connection.query(
        'SELECT setting_value FROM tenant_settings WHERE setting_key = ?',
        ['tenant_domain']
      );
      return settings.length > 0 ? settings[0].setting_value : null;
    } catch (error) {
      console.error('Error getting tenant domain:', error);
      return null;
    }
  }

  /**
   * Check if email subject matches expert registration pattern
   */
  isExpertRequestEmail(subject) {
    if (!subject) return false;
    const normalizedSubject = subject.toLowerCase().trim().replace(/[_\-\s]+/g, '');
    return normalizedSubject === 'registerexpert' ||
           normalizedSubject.startsWith('registerexpert');
  }

  /**
   * Process expert registration request email
   * Creates a new expert account and sends credentials
   */
  async processExpertRequest(connection, email, fromEmail, domain) {
    console.log(`🆕 Processing expert registration request from: ${fromEmail}`);

    try {
      // Check if user already exists
      const [existingUsers] = await connection.query(
        'SELECT id, role FROM users WHERE email = ?',
        [fromEmail]
      );

      if (existingUsers.length > 0) {
        const existingUser = existingUsers[0];
        console.log(`User ${fromEmail} already exists with role: ${existingUser.role}`);

        // If user is already an expert or admin, just inform them
        if (existingUser.role === 'expert' || existingUser.role === 'admin') {
          console.log(`User ${fromEmail} is already an expert/admin, no upgrade needed`);
          await sendNotificationEmail(
            fromEmail,
            'You Already Have Expert Access - A1 Support',
            `
              <h2>Expert Access Confirmed</h2>
              <p>Hello,</p>
              <p>You already have <strong>${existingUser.role}</strong> access in our system.</p>
              <p>Please use the login page to access your account. If you've forgotten your password, use the "Forgot Password" feature.</p>
              <hr>
              <p style="color:#666;font-size:12px">This is an automated message from A1 Support.</p>
            `
          );
          return { success: false, reason: 'already_expert' };
        }

        // Upgrade customer to expert
        console.log(`🔄 Upgrading user ${fromEmail} from ${existingUser.role} to expert`);
        await connection.query(
          'UPDATE users SET role = ? WHERE id = ?',
          ['expert', existingUser.id]
        );

        // Log the activity
        await connection.query(
          `INSERT INTO tenant_audit_log (user_id, action, details) VALUES (?, ?, ?)`,
          [existingUser.id, 'expert_upgrade_via_email', JSON.stringify({
            message: `User upgraded from ${existingUser.role} to expert via "Register_Expert" email`,
            email: fromEmail,
            previousRole: existingUser.role
          })]
        );

        const loginUrl = process.env.BASE_URL || 'https://serviflow.app';

        // Send upgrade confirmation email
        await sendNotificationEmail(
          fromEmail,
          'Your Account Has Been Upgraded to Expert - A1 Support',
          `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #2563eb;">Account Upgraded!</h2>
              <p>Hello,</p>
              <p>Your account has been upgraded from <strong>${existingUser.role}</strong> to <strong>expert</strong>.</p>
              <p>You now have access to the expert dashboard where you can:</p>
              <ul>
                <li>View and manage support tickets</li>
                <li>Respond to customer requests</li>
                <li>Access expert-only features</li>
              </ul>
              <p><a href="${loginUrl}" style="background-color:#2563eb;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;display:inline-block">Login to Dashboard</a></p>
              <p>Use your existing login credentials to access your upgraded account.</p>
              <hr>
              <p style="color:#666;font-size:12px">This is an automated message from A1 Support.</p>
            </div>
          `
        );

        console.log(`✅ Upgraded ${fromEmail} to expert role`);
        return { success: true, upgraded: true, userId: existingUser.id };
      }

      // Extract name from email body or email prefix
      let fullName = this.extractNameFromEmail(email, fromEmail);

      // Use full email address as username
      let username = fromEmail.toLowerCase();

      // Generate temporary password
      const tempPassword = crypto.randomBytes(8).toString('hex');
      const passwordHash = await bcrypt.hash(tempPassword, 10);

      // Create the expert user with must_reset_password flag
      const [result] = await connection.query(
        `INSERT INTO users (username, email, password_hash, full_name, role, is_active, must_reset_password)
         VALUES (?, ?, ?, ?, 'expert', TRUE, TRUE)`,
        [username, fromEmail, passwordHash, fullName]
      );

      const userId = result.insertId;
      console.log(`✅ Created expert account for ${fromEmail} (userId=${userId})`);

      // Log the activity
      await connection.query(
        `INSERT INTO tenant_audit_log (user_id, action, details) VALUES (?, ?, ?)`,
        [userId, 'expert_created_via_email', JSON.stringify({ message: `Expert account created via "Register_Expert" email`, email: fromEmail })]
      );

      // Send welcome email with credentials
      const loginUrl = process.env.BASE_URL || 'https://serviflow.app';

      await sendNotificationEmail(
        fromEmail,
        'Welcome to A1 Support - Your Expert Account is Ready',
        `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #2563eb;">Welcome to A1 Support!</h2>
            <p>Hello ${fullName},</p>
            <p>Your expert account has been created successfully. You can now log in to the support dashboard.</p>

            <div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0; color: #374151;">Your Login Credentials</h3>
              <p><strong>Username:</strong> ${username}</p>
              <p><strong>Temporary Password:</strong> <code style="background:#e5e7eb;padding:4px 8px;border-radius:4px;">${tempPassword}</code></p>
              <p><strong>Login URL:</strong> <a href="${loginUrl}">${loginUrl}</a></p>
            </div>

            <div style="background-color: #fef3c7; padding: 15px; border-radius: 8px; border-left: 4px solid #f59e0b; margin: 20px 0;">
              <p style="margin: 0; color: #92400e;"><strong>⚠️ Important:</strong> You will be required to change your password on first login.</p>
            </div>

            <p>As an expert, you will be able to:</p>
            <ul>
              <li>View and manage support tickets</li>
              <li>Respond to customer inquiries</li>
              <li>Track SLA deadlines</li>
              <li>Access the CMDB and knowledge base</li>
            </ul>

            <p>If you have any questions, please contact your administrator.</p>

            <hr style="border: 1px solid #e5e7eb; margin: 20px 0;">
            <p style="color:#666;font-size:12px">This is an automated message from A1 Support. Please do not reply to this email.</p>
          </div>
        `
      );

      console.log(`📧 Sent welcome email with credentials to: ${fromEmail}`);

      return {
        success: true,
        type: 'expert_created',
        userId,
        username,
        email: fromEmail
      };

    } catch (error) {
      console.error('Error processing expert request:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Extract full name from email content or email address
   */
  extractNameFromEmail(email, fromEmail) {
    // Try to extract from email "From" header (Name <email@domain.com>)
    const fromMatch = email.from.match(/^([^<]+)</);
    if (fromMatch && fromMatch[1].trim()) {
      return fromMatch[1].trim();
    }

    // Try to extract from email body if it contains name
    const body = email.body || '';
    const nameMatch = body.match(/(?:my name is|i am|i'm)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
    if (nameMatch) {
      return nameMatch[1];
    }

    // Fall back to generating name from email prefix
    const emailPrefix = fromEmail.split('@')[0];
    return emailPrefix.replace(/[._-]/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  }

  /**
   * Process a single email message
   */
  async processEmail(connection, email) {
    try {
      // Extract email address from "Name <email@domain.com>" format
      let fromEmail = email.from.toLowerCase().trim();
      const emailMatch = fromEmail.match(/<(.+?)>/);
      if (emailMatch) {
        fromEmail = emailMatch[1];
      }

      const domain = fromEmail.split('@')[1];

      if (!domain) {
        console.log(`Invalid email format: ${email.from}`);
        return { success: false, reason: 'invalid_email_format' };
      }

      console.log(`Processing email from: ${fromEmail}, domain: ${domain}`);

      // Check if this is a "Register_Expert" expert registration request
      if (this.isExpertRequestEmail(email.subject)) {
        // Get tenant domain
        const tenantDomain = await this.getTenantDomain(connection);

        if (tenantDomain && domain.toLowerCase() === tenantDomain.toLowerCase()) {
          console.log(`📝 "Register_Expert" request detected from tenant domain: ${domain}`);
          return await this.processExpertRequest(connection, email, fromEmail, domain);
        } else {
          console.log(`⚠️ "Register_Expert" email from non-tenant domain: ${domain} (expected: ${tenantDomain || 'not configured'})`);
          // Continue with normal ticket processing if domain doesn't match
        }
      }

      // Step 1: Check if domain exists in customer profiles
      const [domainCustomers] = await connection.query(
        'SELECT * FROM customers WHERE company_domain = ?',
        [domain]
      );

      if (domainCustomers.length === 0) {
        console.log(`Domain ${domain} not found in customers. Ignoring email.`);
        return { success: false, reason: 'domain_not_found' };
      }

      // Step 2: Check if email address exists in users
      const [existingUsers] = await connection.query(
        'SELECT u.id as user_id, u.email, u.username, c.id as customer_id FROM users u ' +
        'LEFT JOIN customers c ON u.id = c.user_id ' +
        'WHERE u.email = ? AND u.role = "customer"',
        [fromEmail]
      );

      let customerId;
      let userId;

      if (existingUsers.length > 0) {
        // Email exists - use existing customer
        userId = existingUsers[0].user_id;
        customerId = existingUsers[0].customer_id;
        console.log(`Found existing customer: ${fromEmail} (userId=${userId}, customerId=${customerId})`);
      } else {
        // Email doesn't exist but domain exists - create new customer
        console.log(`Creating new customer for: ${fromEmail}`);
        const result = await this.createCustomerFromEmail(connection, fromEmail, domain);
        userId = result.userId;
        customerId = result.customerId;
      }

      // Step 3: Create ticket from email
      const ticketId = await this.createTicketFromEmail(connection, email, userId);

      // Step 4: AI Analysis (async, non-blocking)
      this.runAIAnalysis(ticketId, email).catch(err => {
        console.error(`AI analysis failed for ticket #${ticketId}:`, err.message);
      });

      // Step 5: Send confirmation email with ticket link
      await this.sendTicketConfirmation(fromEmail, ticketId, email.subject);

      console.log(`Successfully processed email and created ticket #${ticketId}`);

      return {
        success: true,
        ticketId,
        customerId,
        wasNewCustomer: existingUsers.length === 0
      };

    } catch (error) {
      console.error('Error processing individual email:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Create a new customer from email address
   */
  async createCustomerFromEmail(connection, email, domain) {
    // Extract name from email (before @)
    const emailPrefix = email.split('@')[0];
    const fullName = emailPrefix.replace(/[._-]/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

    // Generate username from email
    let username = emailPrefix.replace(/[^a-z0-9]/g, '_');

    // Generate random password
    const bcrypt = require('bcrypt');
    const tempPassword = Math.random().toString(36).slice(-10);
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    let userId;
    try {
      // Try to create user
      const [userResult] = await connection.query(
        'INSERT INTO users (username, password_hash, role, email, full_name) VALUES (?, ?, ?, ?, ?)',
        [username, passwordHash, 'customer', email, fullName]
      );
      userId = userResult.insertId;
    } catch (error) {
      // If duplicate email, handle it gracefully
      if (error.code === 'ER_DUP_ENTRY') {
        console.log(`Email ${email} already exists. Skipping user creation - email constraint enforced.`);
        throw new Error(`Cannot create customer: Email address ${email} is already registered. Each customer must have a unique email address.`);
      }
      // Re-throw other errors
      throw error;
    }

    // Get company name from domain (capitalize first letter)
    const companyName = domain.split('.')[0].charAt(0).toUpperCase() + domain.split('.')[0].slice(1);

    // Create customer profile
    const [customerResult] = await connection.query(
      'INSERT INTO customers (user_id, company_name, company_domain, sla_level) VALUES (?, ?, ?, ?)',
      [userId, companyName, domain, 'basic']
    );

    console.log(`Created new customer: ${username} (${email}) for domain: ${domain}`);

    // TODO: Send welcome email with temporary password
    // await this.sendWelcomeEmail(email, username, tempPassword);

    return {
      userId,
      customerId: customerResult.insertId
    };
  }

  /**
   * Create ticket from email content
   */
  async createTicketFromEmail(connection, email, requesterId) {
    const title = email.subject || 'Email Request';
    const description = email.body || '(No content)';

    // Determine priority based on keywords
    let priority = 'medium';
    const urgentKeywords = ['urgent', 'critical', 'emergency', 'asap', 'down'];
    const lowKeywords = ['question', 'info', 'information'];

    const emailText = (title + ' ' + description).toLowerCase();

    if (urgentKeywords.some(keyword => emailText.includes(keyword))) {
      priority = 'high';
    } else if (lowKeywords.some(keyword => emailText.includes(keyword))) {
      priority = 'low';
    }

    // Calculate SLA deadline (24 hours for medium priority)
    const slaHours = priority === 'high' ? 4 : priority === 'low' ? 48 : 24;
    const slaDeadline = new Date(Date.now() + slaHours * 60 * 60 * 1000);

    // Create ticket
    const [result] = await connection.query(
      'INSERT INTO tickets (title, description, status, priority, category, requester_id, sla_deadline) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [title, description, 'open', priority, 'Email', requesterId, slaDeadline]
    );

    const ticketId = result.insertId;

    // Log activity
    await connection.query(
      'INSERT INTO ticket_activity (ticket_id, user_id, activity_type, description) VALUES (?, ?, ?, ?)',
      [ticketId, requesterId, 'created', `Ticket created from email: ${email.from}`]
    );

    return ticketId;
  }

  /**
   * Run AI analysis on ticket (async, non-blocking)
   */
  async runAIAnalysis(ticketId, emailData) {
    try {
      const { AIAnalysisService } = require('./ai-analysis-service');
      const aiService = new AIAnalysisService(this.tenantCode);

      await aiService.analyzeTicket(ticketId, emailData);
    } catch (error) {
      // Don't throw - AI analysis is non-critical
      console.error(`AI analysis error for ticket #${ticketId}:`, error.message);
    }
  }

  /**
   * Send ticket confirmation email
   */
  async sendTicketConfirmation(toEmail, ticketId, subject) {
    // Generate secure access token for the ticket
    const token = await createTicketAccessToken(this.tenantCode, ticketId, 30);
    const ticketUrl = `${process.env.BASE_URL || 'https://serviflow.app'}/ticket/view/${token}`;
    console.log(`🔐 Generated access token for ticket #${ticketId}`);

    const htmlContent = `
      <h2>Ticket Created</h2>
      <p>Thank you for contacting support. Your ticket has been created.</p>
      <p><strong>Ticket ID:</strong> #${ticketId}</p>
      <p><strong>Subject:</strong> ${subject}</p>
      <p><strong>Status:</strong> Open</p>
      <p>You can track your ticket here:</p>
      <p><a href="${ticketUrl}" style="background-color:#2563eb;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;display:inline-block">View Ticket</a></p>
      <p style="color:#666;font-size:12px"><em>This is a secure access link that expires in 30 days. No login required.</em></p>
      <p>Our team will respond to your request shortly.</p>
      <hr>
      <p style="color:#666;font-size:12px">This is an automated message. Please do not reply to this email.</p>
    `;

    try {
      await sendNotificationEmail(
        toEmail,
        `Ticket #${ticketId} Created: ${subject}`,
        htmlContent
      );
      console.log(`Sent ticket confirmation email to: ${toEmail}`);
    } catch (error) {
      console.error(`Failed to send confirmation email to ${toEmail}:`, error);
    }
  }
}

/**
 * Start email processing for a tenant
 */
async function startEmailProcessing(tenantCode) {
  const processor = new EmailProcessor(tenantCode);

  // Process emails immediately
  await processor.processEmails();

  // Then set up interval checking
  setInterval(async () => {
    await processor.processEmails();
  }, 5 * 60 * 1000); // Check every 5 minutes

  console.log(`Email processing started for tenant: ${tenantCode}`);
}

module.exports = {
  EmailProcessor,
  startEmailProcessing
};
