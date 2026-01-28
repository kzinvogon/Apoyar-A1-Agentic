// Lazy-load shared pool only when needed (not in worker mode)
let _sharedGetTenantConnection = null;
function getSharedTenantConnection(tenantCode) {
  if (!_sharedGetTenantConnection) {
    _sharedGetTenantConnection = require('../config/database').getTenantConnection;
  }
  return _sharedGetTenantConnection(tenantCode);
}

const { sendNotificationEmail } = require('../config/email');
const { createTicketAccessToken } = require('../utils/tokenGenerator');
const { resolveApplicableSLA } = require('./sla-selector');
const { computeInitialDeadlines } = require('./sla-calculator');
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

// ============================================================================
// MONITORING ALERT PARSING (Step 3.1)
// ============================================================================

/**
 * Normalise a correlation key from host and service
 * - Trims whitespace
 * - Collapses multiple spaces to single space
 * - Strips surrounding quotes (single or double)
 * - Lowercases the result
 *
 * @param {string} host - Host name from alert
 * @param {string} service - Service name from alert
 * @returns {string} Normalised correlation key in format "host:service"
 */
function normaliseCorrelationKey(host, service) {
  const normalise = (str) => {
    if (!str) return 'unknown';
    return str
      .trim()                          // Remove leading/trailing whitespace
      .replace(/^["']|["']$/g, '')     // Strip surrounding quotes
      .trim()                          // Trim again (quotes may have contained spaces)
      .replace(/\s+/g, ' ')            // Collapse multiple spaces to single
      .toLowerCase();                   // Lowercase
  };

  const normHost = normalise(host);
  const normService = normalise(service);

  return `${normHost}:${normService}`;
}

/**
 * Parse monitoring alert fields from email subject and body
 * Supports Nagios, Zabbix, and similar monitoring systems
 *
 * @param {Object} email - Email object with subject and body (text)
 * @returns {Object} Parsed alert with host, service, alert_type, state, correlation_key
 */
function parseMonitoringAlert(email) {
  const subject = email.subject || '';
  const body = email.body || email.text || '';
  const combined = `${subject}\n${body}`;

  // Default values
  let host = null;
  let service = null;
  let alertType = 'UNKNOWN';
  let state = 'UNKNOWN';

  // Pattern matchers for various formats
  // Nagios: "Host: FreeNAS" or "Host=FreeNAS"
  // Zabbix: "Host: server01" or in JSON
  const hostPatterns = [
    /Host:\s*([^\r\n]+)/i,
    /Host=\s*([^\r\n]+)/i,
    /Hostname:\s*([^\r\n]+)/i,
    /hostname=\s*([^\r\n]+)/i
  ];

  const servicePatterns = [
    /Service:\s*([^\r\n]+)/i,
    /Service=\s*([^\r\n]+)/i,
    /Service Name:\s*([^\r\n]+)/i,
    /Check:\s*([^\r\n]+)/i
  ];

  // Alert type patterns (Nagios notification types)
  const alertTypePatterns = [
    /Notification Type:\s*(PROBLEM|RECOVERY|ACKNOWLEDGEMENT|FLAPPINGSTART|FLAPPINGSTOP|FLAPPINGDISABLED|DOWNTIMESTART|DOWNTIMEEND|DOWNTIMECANCELLED)/i,
    /\*\*\s*(PROBLEM|RECOVERY)\s+Service Alert/i,
    /\*\*\s*(PROBLEM|RECOVERY)\s+Host Alert/i,
    /\[(FIRING|RESOLVED)\]/i,  // Prometheus/Alertmanager
    /Status:\s*(PROBLEM|OK|RECOVERY)/i
  ];

  // State patterns (CRITICAL, WARNING, OK, etc.)
  const statePatterns = [
    /State:\s*(CRITICAL|WARNING|OK|UNKNOWN|UP|DOWN|UNREACHABLE)/i,
    /Status:\s*(CRITICAL|WARNING|OK|UNKNOWN|UP|DOWN)/i,
    /is\s+(CRITICAL|WARNING|OK|DOWN|UP)/i
  ];

  // Extract host
  for (const pattern of hostPatterns) {
    const match = combined.match(pattern);
    if (match && match[1]) {
      host = match[1].trim();
      break;
    }
  }

  // Extract service
  for (const pattern of servicePatterns) {
    const match = combined.match(pattern);
    if (match && match[1]) {
      service = match[1].trim();
      break;
    }
  }

  // Extract alert type
  for (const pattern of alertTypePatterns) {
    const match = combined.match(pattern);
    if (match && match[1]) {
      const type = match[1].toUpperCase();
      // Normalise Prometheus format
      if (type === 'FIRING') alertType = 'PROBLEM';
      else if (type === 'RESOLVED') alertType = 'RECOVERY';
      else alertType = type;
      break;
    }
  }

  // Extract state
  for (const pattern of statePatterns) {
    const match = combined.match(pattern);
    if (match && match[1]) {
      state = match[1].toUpperCase();
      break;
    }
  }

  // Generate correlation key
  const correlationKey = normaliseCorrelationKey(host, service);

  return {
    host: host || 'unknown',
    service: service || 'unknown',
    alert_type: alertType,
    state: state,
    correlation_key: correlationKey
  };
}

// ============================================================================

/**
 * Email Processor Service
 * Handles fetching emails from inbox and creating tickets
 *
 * Supports dependency injection of connection getter for worker isolation:
 *   new EmailProcessor(tenantCode, { getConnection: myGetterFn })
 */

class EmailProcessor {
  constructor(tenantCode, options = {}) {
    this.tenantCode = tenantCode;
    this.isProcessing = false;
    this.imap = null;
    // Use injected getter or fall back to shared pool (lazy-loaded)
    this._getConnection = options.getConnection || (() => getSharedTenantConnection(this.tenantCode));
  }

  /**
   * Get a database connection (uses injected getter or shared pool)
   */
  async getConnection() {
    return this._getConnection();
  }

  /**
   * Check if email processing is enabled (kill switch)
   * Reads from email_ingest_settings.enabled column
   * Returns { enabled: boolean, reason: string }
   */
  async isEmailProcessingEnabled() {
    try {
      const connection = await this.getConnection();
      try {
        const [settings] = await connection.query(
          'SELECT enabled FROM email_ingest_settings ORDER BY id ASC LIMIT 1'
        );
        // No settings row = not configured = disabled
        if (settings.length === 0) {
          return { enabled: false, reason: 'no_config' };
        }
        // Check enabled column (0 = disabled, 1 = enabled)
        const isEnabled = !!settings[0].enabled;
        return {
          enabled: isEnabled,
          reason: isEnabled ? 'enabled' : 'kill_switch_off'
        };
      } finally {
        connection.release();
      }
    } catch (error) {
      console.error('Error checking email processing setting:', error);
      // Default to disabled on error (fail safe)
      return { enabled: false, reason: 'error' };
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

    // KILL SWITCH CHECK - at the very start before any IMAP connection
    const killSwitchStatus = await this.isEmailProcessingEnabled();
    if (!killSwitchStatus.enabled) {
      console.log(`🔴 KILL SWITCH OFF: Skipping mailbox poll for tenant ${this.tenantCode} (reason: ${killSwitchStatus.reason})`);
      return;
    }

    this.isProcessing = true;

    try {
      const connection = await this.getConnection();

      try {
        // Get email ingest settings (already confirmed enabled by kill switch check)
        const [settings] = await connection.query(
          'SELECT * FROM email_ingest_settings ORDER BY id ASC LIMIT 1'
        );

        if (settings.length === 0) {
          console.log(`Email ingest not configured for tenant: ${this.tenantCode}`);
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
   *
   * IMPORTANT: Uses queue-based sequential processing to prevent DB pool exhaustion.
   * 1. Collect phase: Parse all emails from IMAP (no DB operations)
   * 2. Process phase: Process emails one-by-one with delays using single DB connection
   */
  async fetchEmailsViaIMAP(connection, config) {
    const self = this;
    const EMAIL_PROCESS_DELAY_MS = parseInt(process.env.EMAIL_PROCESS_DELAY_MS) || 2000; // 2 second delay between emails

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

      // Queue to collect emails before processing
      const emailQueue = [];
      const processedEmails = [];
      let pendingParses = 0;
      let fetchEnded = false;

      // Helper to delay execution
      const delay = (ms) => new Promise(r => setTimeout(r, ms));

      // Process queue sequentially after all emails are collected
      const processQueue = async () => {
        if (emailQueue.length === 0) {
          console.log(`No emails in queue to process for tenant: ${self.tenantCode}`);
          return;
        }

        console.log(`📋 Processing queue of ${emailQueue.length} email(s) sequentially...`);

        for (let i = 0; i < emailQueue.length; i++) {
          const emailData = emailQueue[i];

          try {
            console.log(`📧 [${i + 1}/${emailQueue.length}] Processing: ${emailData.subject}`);
            const result = await self.processEmail(connection, emailData);
            processedEmails.push(result);
          } catch (processError) {
            console.error(`Error processing email ${i + 1}:`, processError.message);
            processedEmails.push({ success: false, error: processError.message });
          }

          // Delay between emails (except after the last one)
          if (i < emailQueue.length - 1) {
            console.log(`⏳ Waiting ${EMAIL_PROCESS_DELAY_MS}ms before next email...`);
            await delay(EMAIL_PROCESS_DELAY_MS);
          }
        }

        console.log(`✅ Finished processing ${processedEmails.length} email(s)`);
      };

      // Check if we should start processing (all emails collected and parsed)
      const checkAndProcess = async () => {
        if (fetchEnded && pendingParses === 0) {
          try {
            await processQueue();
          } catch (err) {
            console.error('Error in queue processing:', err);
          }
          imap.end();
        }
      };

      imap.once('ready', () => {
        console.log(`✅ IMAP connected for tenant: ${self.tenantCode}`);

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
              console.log(`No new emails found for tenant: ${self.tenantCode}`);
              imap.end();
              return resolve(processedEmails);
            }

            console.log(`📧 Found ${results.length} new email(s) for tenant: ${self.tenantCode}`);

            // Fetch email messages - COLLECT PHASE (no DB operations)
            const fetch = imap.fetch(results, { bodies: '', markSeen: true });

            fetch.on('message', (msg, seqno) => {
              pendingParses++;

              msg.on('body', (stream, info) => {
                let buffer = '';

                stream.on('data', (chunk) => {
                  buffer += chunk.toString('utf8');
                });

                stream.once('end', async () => {
                  try {
                    // Parse the email (no DB operations here)
                    const parsed = await simpleParser(buffer);

                    const emailData = {
                      from: parsed.from?.text || parsed.from?.value?.[0]?.address || '',
                      subject: parsed.subject || '(No Subject)',
                      body: parsed.text || parsed.html || '(No content)',
                      messageId: parsed.messageId || `msg-${Date.now()}`,
                      date: parsed.date,
                      seqno: seqno
                    };

                    console.log(`📨 Queued email #${seqno}: ${emailData.from} - ${emailData.subject}`);
                    emailQueue.push(emailData);

                  } catch (parseError) {
                    console.error(`Error parsing email #${seqno}:`, parseError);
                  } finally {
                    pendingParses--;
                    checkAndProcess();
                  }
                });
              });
            });

            fetch.once('error', (err) => {
              console.error('Fetch error:', err);
              reject(err);
            });

            fetch.once('end', () => {
              console.log(`📥 All emails fetched from IMAP, waiting for parsing to complete...`);
              fetchEnded = true;
              checkAndProcess();
            });
          });
        });
      });

      imap.once('error', (err) => {
        console.error(`❌ IMAP connection error for tenant ${self.tenantCode}:`, err.message);
        reject(err);
      });

      imap.once('end', () => {
        console.log(`IMAP connection closed for tenant: ${self.tenantCode}`);
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
   * Get or create System user for system-sourced tickets
   * Returns the user ID of the System user
   */
  async getOrCreateSystemUser(connection) {
    try {
      // Check if System user already exists
      const [existing] = await connection.query(
        'SELECT id FROM users WHERE username = ? OR email = ?',
        ['system', 'system@tenant.local']
      );

      if (existing.length > 0) {
        return existing[0].id;
      }

      // Create System user with random password (never used for login)
      const randomPassword = crypto.randomBytes(32).toString('hex');
      const passwordHash = await bcrypt.hash(randomPassword, 10);

      const [result] = await connection.query(
        `INSERT INTO users (username, email, password_hash, full_name, role, is_active)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['system', 'system@tenant.local', passwordHash, 'System', 'customer', true]
      );

      console.log(`✅ Created System user for tenant ${this.tenantCode} (ID: ${result.insertId})`);
      return result.insertId;
    } catch (error) {
      console.error('Error getting/creating System user:', error);
      throw error;
    }
  }

  /**
   * Get system senders allowlist from tenant settings
   * Returns array of exact email addresses to treat as system sources (highest priority)
   */
  async getSystemSenders(connection) {
    try {
      const [settings] = await connection.query(
        'SELECT setting_value FROM tenant_settings WHERE setting_key = ?',
        ['system_senders']
      );
      if (settings.length > 0 && settings[0].setting_value) {
        try {
          return JSON.parse(settings[0].setting_value).map(s => s.toLowerCase());
        } catch (e) {
          // If not valid JSON, treat as comma-separated list
          return settings[0].setting_value.split(',').map(s => s.trim().toLowerCase());
        }
      }
      return [];
    } catch (error) {
      console.error('Error getting system senders:', error);
      return [];
    }
  }

  /**
   * Get system domains from tenant settings
   * Returns array of domains to treat as system/monitoring sources
   */
  async getSystemDomains(connection) {
    try {
      const [settings] = await connection.query(
        'SELECT setting_value FROM tenant_settings WHERE setting_key = ?',
        ['system_domains']
      );
      if (settings.length > 0 && settings[0].setting_value) {
        try {
          return JSON.parse(settings[0].setting_value);
        } catch (e) {
          // If not valid JSON, treat as comma-separated list
          return settings[0].setting_value.split(',').map(d => d.trim().toLowerCase());
        }
      }
      return [];
    } catch (error) {
      console.error('Error getting system domains:', error);
      return [];
    }
  }

  /**
   * Classify if sender is a system/monitoring source
   * Returns { isSystemSource: boolean, reason: string|null }
   *
   * Reasons:
   * - 'system_senders_allowlist': Exact email match in admin-configured allowlist (highest priority)
   * - 'system_domains_setting': Email domain matches admin-configured system domains
   * - 'monitoring_pattern_strong': Known monitoring system (nagios, zabbix, etc.)
   * - 'monitoring_pattern_weak': Generic pattern (noreply, alerts) + alert subject match
   * - null: Not a system source
   */
  classifySystemSource(fromEmail, displayName, subject, systemSenders, systemDomains) {
    const emailLower = fromEmail.toLowerCase();
    const domain = emailLower.split('@')[1];

    // Check 1: Admin-configured system senders allowlist (exact email match, highest priority)
    if (systemSenders && systemSenders.length > 0) {
      if (systemSenders.includes(emailLower)) {
        return { isSystemSource: true, reason: 'system_senders_allowlist' };
      }
    }

    // Check 2: Admin-configured system domains
    if (systemDomains && systemDomains.length > 0) {
      const matchedDomain = systemDomains.find(sd => domain === sd.toLowerCase());
      if (matchedDomain) {
        return { isSystemSource: true, reason: 'system_domains_setting' };
      }
    }

    // Strong monitoring patterns - these alone are enough to classify as system
    const strongPatterns = [
      'nagios', 'zabbix', 'prtg', 'datadog', 'prometheus', 'alertmanager',
      'pagerduty', 'opsgenie', 'servicenow', 'icinga', 'checkmk', 'sensu',
      'newrelic', 'splunk', 'dynatrace', 'grafana', 'pingdom', 'uptime',
      'mailer-daemon', 'postmaster'
    ];

    // Weak patterns - only match if subject also looks like an alert
    const weakPatterns = [
      'noreply', 'no-reply', 'donotreply', 'do-not-reply',
      'alerts', 'monitoring', 'monitor', 'notification', 'notify'
    ];

    // Alert subject patterns
    const alertSubjectPatterns = [
      'CRITICAL', 'WARNING', 'OK', 'PROBLEM', 'RECOVERY', 'ALERT',
      'TRIGGER', 'HOST DOWN', 'SERVICE DOWN', 'DOWN:', 'UP:',
      '[FIRING]', '[RESOLVED]', 'DEGRADED', 'OUTAGE'
    ];

    const checkString = (fromEmail + ' ' + (displayName || '')).toLowerCase();
    const subjectUpper = (subject || '').toUpperCase();

    // Check 3: Strong monitoring pattern match
    if (strongPatterns.some(pattern => checkString.includes(pattern))) {
      return { isSystemSource: true, reason: 'monitoring_pattern_strong' };
    }

    // Check 4: Weak pattern + alert subject match
    const hasWeakPattern = weakPatterns.some(pattern => checkString.includes(pattern));
    const hasAlertSubject = alertSubjectPatterns.some(pattern => subjectUpper.includes(pattern));

    if (hasWeakPattern && hasAlertSubject) {
      return { isSystemSource: true, reason: 'monitoring_pattern_weak' };
    }

    // Not a system source
    return { isSystemSource: false, reason: null };
  }

  /**
   * Legacy method for backward compatibility
   * @deprecated Use classifySystemSource instead
   */
  isMonitoringSource(fromEmail, displayName) {
    const result = this.classifySystemSource(fromEmail, displayName, '', [], []);
    return result.isSystemSource;
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
        'SELECT id, role, is_active FROM users WHERE email = ?',
        [fromEmail]
      );

      if (existingUsers.length > 0) {
        const existingUser = existingUsers[0];
        console.log(`User ${fromEmail} already exists with role: ${existingUser.role}, is_active: ${existingUser.is_active}`);

        // If user is already an expert or admin
        if (existingUser.role === 'expert' || existingUser.role === 'admin') {
          // If inactive, reactivate them
          if (!existingUser.is_active) {
            console.log(`🔄 Reactivating inactive expert ${fromEmail}`);
            await connection.query(
              'UPDATE users SET is_active = TRUE WHERE id = ?',
              [existingUser.id]
            );

            // Log the activity
            await connection.query(
              `INSERT INTO tenant_audit_log (user_id, action, details) VALUES (?, ?, ?)`,
              [existingUser.id, 'expert_reactivated_via_email', JSON.stringify({
                message: `Expert account reactivated via "Register_Expert" email`,
                email: fromEmail
              })]
            );

            const loginUrl = process.env.BASE_URL || 'https://serviflow.app';
            sendNotificationEmail(
              fromEmail,
              'Your Expert Account Has Been Reactivated - A1 Support',
              `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                  <h2 style="color: #2563eb;">Account Reactivated!</h2>
                  <p>Hello,</p>
                  <p>Your expert account has been reactivated. You can now log in to the support dashboard.</p>
                  <p><a href="${loginUrl}" style="background-color:#2563eb;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;display:inline-block">Login to Dashboard</a></p>
                  <p>Use your existing login credentials to access your account.</p>
                  <hr>
                  <p style="color:#666;font-size:12px">This is an automated message from A1 Support.</p>
                </div>
              `
            ).catch(err => console.log('📧 Could not send reactivation email (non-critical):', err.message));

            console.log(`✅ Reactivated expert ${fromEmail}`);
            return { success: true, reactivated: true, userId: existingUser.id };
          }

          // Already active expert/admin
          console.log(`User ${fromEmail} is already an active expert/admin`);
          sendNotificationEmail(
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
          ).catch(err => console.log('📧 Could not send already-expert email (non-critical):', err.message));
          return { success: false, reason: 'already_expert' };
        }

        // Upgrade customer to expert (also reactivate if inactive)
        console.log(`🔄 Upgrading user ${fromEmail} from ${existingUser.role} to expert`);
        await connection.query(
          'UPDATE users SET role = ?, is_active = TRUE WHERE id = ?',
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

        console.log(`✅ Upgraded ${fromEmail} to expert role`);

        // Send upgrade confirmation email (non-blocking)
        const loginUrl = process.env.BASE_URL || 'https://serviflow.app';
        sendNotificationEmail(
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
        ).catch(err => console.log('📧 Could not send upgrade email (non-critical):', err.message));
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

      // Log the activity
      await connection.query(
        `INSERT INTO tenant_audit_log (user_id, action, details) VALUES (?, ?, ?)`,
        [userId, 'expert_created_via_email', JSON.stringify({ message: `Expert account created via "Register_Expert" email`, email: fromEmail })]
      );

      console.log(`✅ Created expert account for ${fromEmail} (userId=${userId})`);

      // Send welcome email with credentials (non-blocking)
      const loginUrl = process.env.BASE_URL || 'https://serviflow.app';
      sendNotificationEmail(
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
      ).then(() => console.log(`📧 Sent welcome email to: ${fromEmail}`))
       .catch(err => console.log('📧 Could not send welcome email (non-critical):', err.message));

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
   * Check if email is a bounce/delivery notification that should be ignored
   */
  isBounceNotification(fromEmail, subject) {
    const emailLower = fromEmail.toLowerCase();
    const subjectLower = (subject || '').toLowerCase();

    // Common bounce sender patterns
    const bounceSenders = [
      'mailer-daemon@', 'postmaster@', 'mail-daemon@',
      'mailerdaemon@', 'postoffice@', 'bounces@',
      'bounce@', 'ndr@', 'returned@'
    ];

    // Bounce subject patterns
    const bounceSubjects = [
      'delivery status notification',
      'undeliverable', 'undelivered',
      'mail delivery failed',
      'delivery failure',
      'returned mail',
      'mail system error',
      'message not delivered',
      'delivery report',
      'non-delivery',
      'failed delivery',
      'delivery problem',
      'could not be delivered',
      'automatic reply'
    ];

    // Check sender
    if (bounceSenders.some(pattern => emailLower.includes(pattern))) {
      return true;
    }

    // Check subject
    if (bounceSubjects.some(pattern => subjectLower.includes(pattern))) {
      return true;
    }

    return false;
  }

  /**
   * Check if email address is a noreply address that shouldn't receive confirmations
   */
  isNoReplyAddress(email) {
    const emailLower = email.toLowerCase();
    const noReplyPatterns = [
      'noreply@', 'no-reply@', 'donotreply@', 'do-not-reply@',
      'no_reply@', 'do_not_reply@', 'noreply-', 'no-reply-',
      'mailer-daemon@', 'postmaster@', 'bounces@', 'bounce@'
    ];
    return noReplyPatterns.some(pattern => emailLower.includes(pattern));
  }

  /**
   * Process a single email message
   */
  async processEmail(connection, email) {
    try {
      // Extract email address and display name from "Name <email@domain.com>" format
      let fromEmail = email.from.toLowerCase().trim();
      let displayName = '';
      const emailMatch = fromEmail.match(/^([^<]*)<(.+?)>/);
      if (emailMatch) {
        displayName = emailMatch[1].trim();
        fromEmail = emailMatch[2];
      }

      const domain = fromEmail.split('@')[1];

      if (!domain) {
        console.log(`Invalid email format: ${email.from}`);
        return { success: false, reason: 'invalid_email_format' };
      }

      console.log(`Processing email from: ${fromEmail}, domain: ${domain}, displayName: ${displayName}`);

      // Check if this is a bounce/delivery notification - skip entirely to prevent loops
      if (this.isBounceNotification(fromEmail, email.subject)) {
        console.log(`🚫 Skipping bounce/delivery notification from: ${fromEmail}, subject: ${email.subject}`);
        return { success: false, reason: 'bounce_notification_skipped' };
      }

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

      // ============================================
      // SYSTEM SOURCE DETECTION
      // Check if this is from a monitoring/integration system
      // Uses safer heuristics with strong/weak pattern matching
      // ============================================
      const systemSenders = await this.getSystemSenders(connection);
      const systemDomains = await this.getSystemDomains(connection);

      // Classify the source with reason
      const classification = this.classifySystemSource(
        fromEmail,
        displayName,
        email.subject,
        systemSenders,
        systemDomains
      );

      if (classification.isSystemSource) {
        console.log(`🤖 System source detected: reason=${classification.reason}, email=${fromEmail}`);

        // Use System user for system-sourced tickets
        const systemUserId = await this.getOrCreateSystemUser(connection);

        // Determine if this is a monitoring source (for skipping confirmation email)
        const isMonitoringType = ['monitoring_pattern_strong', 'monitoring_pattern_weak'].includes(classification.reason);

        // Create ticket with System user as requester, no customer company
        const ticketId = await this.createTicketFromEmail(connection, email, systemUserId, {
          sourceType: 'system',
          sourceEmail: fromEmail,
          classificationReason: classification.reason,
          createdVia: isMonitoringType ? 'monitoring' : 'email'
        });

        // AI Analysis to try to detect customer/CMDB from content
        this.runAIAnalysis(ticketId, email).catch(err => {
          console.error(`AI analysis failed for ticket #${ticketId}:`, err.message);
        });

        // Don't send confirmation email to monitoring systems
        if (!isMonitoringType) {
          await this.sendTicketConfirmation(fromEmail, ticketId, email.subject);
        }

        console.log(`✅ Created ticket #${ticketId} from system source [${classification.reason}] (no auto-customer)`);

        return {
          success: true,
          ticketId,
          customerId: null,
          sourceType: 'system',
          classificationReason: classification.reason,
          wasNewCustomer: false
        };
      }

      // ============================================
      // REGULAR CUSTOMER EMAIL PROCESSING
      // ============================================

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
      const ticketId = await this.createTicketFromEmail(connection, email, userId, {
        sourceType: 'customer',
        sourceEmail: fromEmail,
        createdVia: 'email'
      });

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
        sourceType: 'customer',
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

    // Send welcome email with credentials (non-blocking)
    const loginUrl = process.env.BASE_URL || 'https://serviflow.app';
    sendNotificationEmail(
      email,
      'Welcome to A1 Support - Your Account is Ready',
      `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2563eb;">Welcome to A1 Support!</h2>
          <p>Hello ${username},</p>
          <p>Your customer account has been created. You can now submit and track support requests.</p>

          <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 0 0 10px 0;"><strong>Login Details:</strong></p>
            <p style="margin: 0 0 5px 0;">Username: <code style="background: #e5e7eb; padding: 2px 6px; border-radius: 4px;">${username}</code></p>
            <p style="margin: 0 0 5px 0;">Temporary Password: <code style="background: #e5e7eb; padding: 2px 6px; border-radius: 4px;">${tempPassword}</code></p>
            <p style="margin: 10px 0 0 0; color: #dc2626; font-size: 14px;">Please change your password after first login.</p>
          </div>

          <p>
            <a href="${loginUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 500;">
              Login to Portal
            </a>
          </p>

          <p style="color: #6b7280; font-size: 14px; margin-top: 30px;">
            If you did not request this account, please ignore this email.
          </p>
        </div>
      `
    ).then(() => console.log(`📧 Sent customer welcome email to: ${email}`))
     .catch(err => console.log('📧 Could not send customer welcome email (non-critical):', err.message));

    return {
      userId,
      customerId: customerResult.insertId
    };
  }

  /**
   * Create ticket from email content
   * @param {Object} connection - Database connection
   * @param {Object} email - Email data (from, subject, body)
   * @param {number} requesterId - User ID of requester
   * @param {Object} sourceMetadata - Optional source info {sourceType, sourceEmail, createdVia}
   */
  async createTicketFromEmail(connection, email, requesterId, sourceMetadata = {}) {
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

    // Build source metadata JSON for system-sourced tickets
    let sourceMetadataJson = null;
    if (sourceMetadata.sourceType === 'system') {
      sourceMetadataJson = JSON.stringify({
        type: 'monitoring',
        reason: sourceMetadata.classificationReason,
        source_email: sourceMetadata.sourceEmail,
        created_via: sourceMetadata.createdVia
      });
    }

    // Resolve applicable SLA using priority-based selector
    // Priority: ticket → user → company → category → cmdb → default
    let slaFields = {
      sla_definition_id: null,
      sla_source: null,
      sla_applied_at: null,
      response_due_at: null,
      resolve_due_at: null
    };

    try {
      const { slaId, source: slaSource } = await resolveApplicableSLA({
        tenantCode: this.tenantCode,
        ticketPayload: {
          requester_id: requesterId,
          category: 'Email'
        },
        connection  // Pass existing connection to avoid shared pool
      });

      if (slaId) {
        // Fetch full SLA definition with business hours for deadline calculation
        const [slaRows] = await connection.query(
          `SELECT s.*, b.timezone, b.days_of_week, b.start_time, b.end_time, b.is_24x7
           FROM sla_definitions s
           LEFT JOIN business_hours_profiles b ON s.business_hours_profile_id = b.id
           WHERE s.id = ? AND s.is_active = 1`,
          [slaId]
        );

        if (slaRows.length > 0) {
          const sla = slaRows[0];
          const now = new Date();
          const deadlines = computeInitialDeadlines(sla, now);
          slaFields = {
            sla_definition_id: sla.id,
            sla_source: slaSource,
            sla_applied_at: now,
            response_due_at: deadlines.response_due_at,
            resolve_due_at: deadlines.resolve_due_at
          };
        }
      }
    } catch (slaError) {
      console.error(`[EmailProcessor] Error resolving SLA for ticket:`, slaError.message);
      // Continue without SLA - ticket creation should not fail due to SLA issues
    }

    // Legacy SLA deadline fallback (for backwards compatibility)
    const slaHours = priority === 'high' ? 4 : priority === 'low' ? 48 : 24;
    const slaDeadline = new Date(Date.now() + slaHours * 60 * 60 * 1000);

    // Create ticket with SLA fields
    const [result] = await connection.query(
      `INSERT INTO tickets (title, description, status, priority, category, requester_id, sla_deadline, source_metadata,
                            sla_definition_id, sla_source, sla_applied_at, response_due_at, resolve_due_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [title, description, 'open', priority, 'Email', requesterId, slaDeadline, sourceMetadataJson,
       slaFields.sla_definition_id, slaFields.sla_source, slaFields.sla_applied_at, slaFields.response_due_at, slaFields.resolve_due_at]
    );

    const ticketId = result.insertId;

    // Log activity with source information including classification reason
    let sourceInfo;
    if (sourceMetadata.sourceType === 'system') {
      const reasonMap = {
        'system_senders_allowlist': 'sender in system_senders allowlist',
        'system_domains_setting': 'sender domain in system_domains setting',
        'monitoring_pattern_strong': 'known monitoring system pattern',
        'monitoring_pattern_weak': 'generic noreply + alert subject'
      };
      const reasonText = reasonMap[sourceMetadata.classificationReason] || sourceMetadata.classificationReason;
      sourceInfo = `Ticket created from system source: ${email.from} [Reason: ${reasonText}] (no customer auto-assigned)`;
    } else {
      sourceInfo = `Ticket created from email: ${email.from}`;
    }

    await connection.query(
      'INSERT INTO ticket_activity (ticket_id, user_id, activity_type, description) VALUES (?, ?, ?, ?)',
      [ticketId, requesterId, 'created', sourceInfo]
    );

    // Execute ticket processing rules (fire-and-forget)
    this.executeTicketRules(ticketId);

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
   * Execute ticket processing rules (async, non-blocking)
   */
  async executeTicketRules(ticketId) {
    try {
      const { TicketRulesService } = require('./ticket-rules-service');
      const rulesService = new TicketRulesService(this.tenantCode);

      const results = await rulesService.executeAllRulesOnTicket(ticketId);
      if (results.length > 0) {
        console.log(`[TicketRules] Executed ${results.length} rule(s) on ticket #${ticketId}:`,
          results.map(r => `${r.rule_name}: ${r.result}`).join(', '));
      }
    } catch (error) {
      // Don't throw - rule execution is non-critical
      console.error(`[TicketRules] Error executing rules on ticket #${ticketId}:`, error.message);
    }
  }

  /**
   * Send ticket confirmation email
   */
  async sendTicketConfirmation(toEmail, ticketId, subject) {
    // Skip sending to noreply addresses to prevent bounce loops
    if (this.isNoReplyAddress(toEmail)) {
      console.log(`📧 Skipping confirmation email to noreply address: ${toEmail}`);
      return;
    }

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
  startEmailProcessing,
  // Step 3.1: Monitoring alert parsing utilities
  parseMonitoringAlert,
  normaliseCorrelationKey
};
