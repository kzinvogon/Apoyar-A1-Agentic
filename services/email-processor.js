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
const { logTicketActivity } = require('./activityLogger');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const os = require('os');
const fetch = require('node-fetch');
const { tryLock, unlock } = require('./imap-lock');

// ============================================================================
// EMAIL REPLY THREADING PATTERNS
// ============================================================================

// Pattern to match [Ticket #NNNN] in subject line
const TICKET_TOKEN_PATTERN = /\[Ticket\s*#?(\d+)\]/i;

// Pattern to extract ticket ID from secure access URLs
const TICKET_URL_PATTERN = /\/ticket\/view\/([a-zA-Z0-9_-]+)/g;

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
          'SELECT id, enabled FROM email_ingest_settings WHERE enabled = 1 ORDER BY id ASC LIMIT 1'
        );
        // No settings row = not configured = disabled
        if (settings.length === 0) {
          return { enabled: false, reason: 'no_config' };
        }
        // Check enabled column (0 = disabled, 1 = enabled)
        const isEnabled = !!settings[0].enabled;
        const settingsId = settings[0].id;
        return {
          enabled: isEnabled,
          reason: isEnabled ? 'enabled' : 'kill_switch_off',
          settingsId
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
          'SELECT * FROM email_ingest_settings WHERE enabled = 1 ORDER BY id ASC LIMIT 1'
        );

        if (settings.length === 0) {
          console.log(`Email ingest not configured for tenant: ${this.tenantCode}`);
          return;
        }

        const config = settings[0];

        console.log(`📬 [${this.tenantCode}] Selected mailbox config:`, {
          id: config.id,
          enabled: config.enabled,
          username: config.username,
          server: config.server_host,
          port: config.server_port,
          lastChecked: config.last_checked_at
        });

        // Fetch emails — Graph API for M365, IMAP for basic auth
        if (config.auth_method === 'oauth2') {
          await this.fetchEmailsViaGraph(connection, config);
        } else {
          await this.fetchEmailsViaIMAP(connection, config);
        }

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
   * Check if a message has already been processed (by message_id)
   */
  async isMessageProcessed(connection, mailboxId, messageId) {
    try {
      const [rows] = await connection.query(
        'SELECT id FROM email_processed_messages WHERE mailbox_id = ? AND message_id = ?',
        [mailboxId, messageId]
      );
      return rows.length > 0;
    } catch (error) {
      // Table might not exist yet (pre-migration), treat as not processed
      if (error.code === 'ER_NO_SUCH_TABLE') {
        return false;
      }
      throw error;
    }
  }

  /**
   * Record a processed message for deduplication
   * Returns { success: boolean, missingTable: boolean }
   *
   * IMPORTANT: If table is missing, caller should NOT mark email as seen
   * to ensure crash recovery can reprocess the email after migration.
   */
  async recordProcessedMessage(connection, mailboxId, messageId, uid, ticketId, result) {
    try {
      await connection.query(
        `INSERT INTO email_processed_messages (mailbox_id, message_id, uid, ticket_id, result)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE processed_at = NOW(), result = VALUES(result)`,
        [mailboxId, messageId, uid, ticketId, result]
      );
      return { success: true, missingTable: false };
    } catch (error) {
      // Table might not exist yet (pre-migration)
      // FAIL FAST: Don't mark email as seen so crash recovery works after migration
      if (error.code === 'ER_NO_SUCH_TABLE') {
        console.error(`❌ CRITICAL: email_processed_messages table not found! Run migration: node migrations/add-email-crash-recovery.js`);
        console.error(`   Email UID ${uid} will NOT be marked as seen (will be reprocessed after migration)`);
        return { success: false, missingTable: true };
      }
      throw error;
    }
  }

  /**
   * Update the last processed UID for a mailbox
   */
  async updateLastUidProcessed(connection, mailboxId, uid) {
    try {
      await connection.query(
        'UPDATE email_ingest_settings SET last_uid_processed = ? WHERE id = ? AND (last_uid_processed IS NULL OR last_uid_processed < ?)',
        [uid, mailboxId, uid]
      );
    } catch (error) {
      // Column might not exist yet (pre-migration), log and continue
      if (error.code === 'ER_BAD_FIELD_ERROR') {
        console.log(`last_uid_processed column not found, skipping update`);
        return;
      }
      throw error;
    }
  }

  /**
   * Fetch emails via Microsoft Graph API with delta sync.
   *
   * Uses the same queue-based sequential processing as IMAP:
   * 1. Delta sync: fetch new messages via Graph delta API
   * 2. Collect phase: fetch MIME for each new message, parse with simpleParser
   * 3. Process phase: dedup, processEmail, recordProcessedMessage, mark as read
   * 4. Persist deltaLink cursor for next cycle
   */
  async fetchEmailsViaGraph(connection, config) {
    const self = this;
    const EMAIL_PROCESS_DELAY_MS = parseInt(process.env.EMAIL_PROCESS_DELAY_MS) || 2000;
    const mailboxId = config.id;
    const mailboxAddr = config.oauth2_email || 'default';
    const lockKey = `graph:${self.tenantCode}:${mailboxAddr}`;

    // In-process lock
    if (!tryLock(lockKey)) {
      console.log(`🔒 [${self.tenantCode}] Skipping Graph cycle, mailbox locked: ${mailboxAddr}`);
      return [];
    }

    // DB-level lock
    const lockOwner = `${os.hostname()}:${process.pid}`;
    const [lockResult] = await connection.query(
      `UPDATE email_ingest_settings
       SET imap_locked_by = ?,
           imap_lock_expires = DATE_ADD(NOW(), INTERVAL 120 SECOND)
       WHERE id = ?
         AND (imap_lock_expires IS NULL OR imap_lock_expires < NOW())`,
      [lockOwner, mailboxId]
    );

    if (lockResult.affectedRows !== 1) {
      unlock(lockKey);
      console.log(`🔒 [${self.tenantCode}] Skipping Graph cycle, DB lock held by another replica`);
      return [];
    }

    try {

    const { getValidAccessToken } = require('./oauth2-helper');
    const { accessToken } = await getValidAccessToken(connection, self.tenantCode);
    const userEmail = config.oauth2_email;

    console.log(`📬 [${self.tenantCode}] Starting Graph delta sync for ${userEmail}`);

    // ── Helper: Graph API request ──
    const graphRequest = async (url, options = {}) => {
      const res = await fetch(url, {
        ...options,
        headers: { Authorization: `Bearer ${accessToken}`, ...options.headers }
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Graph API ${res.status}: ${body}`);
      }
      return options.raw ? res : res.json();
    };

    // ── Delta sync: collect message metadata ──
    let deltaUrl;
    if (config.graph_delta_link) {
      deltaUrl = config.graph_delta_link;
      console.log(`🔄 [${self.tenantCode}] Resuming from stored deltaLink`);
    } else {
      deltaUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userEmail)}/mailFolders/Inbox/messages/delta?$select=id,receivedDateTime,internetMessageId,from,subject,hasAttachments&$top=50`;
      console.log(`🆕 [${self.tenantCode}] Initial delta sync (no stored deltaLink)`);
    }

    const deltaItems = [];
    let newDeltaLink = null;
    let pageCount = 0;

    while (deltaUrl) {
      pageCount++;
      const data = await graphRequest(deltaUrl);

      for (const item of (data.value || [])) {
        // Skip deletions and items without id
        if (item['@removed'] || !item.id) continue;
        deltaItems.push(item);
      }

      if (data['@odata.nextLink']) {
        deltaUrl = data['@odata.nextLink'];
      } else {
        newDeltaLink = data['@odata.deltaLink'] || null;
        deltaUrl = null;
      }
    }

    console.log(`📊 [${self.tenantCode}] Delta sync: ${deltaItems.length} new message(s) across ${pageCount} page(s)`);

    // ── Collect phase: fetch MIME and parse ──
    const emailQueue = [];
    for (const item of deltaItems) {
      try {
        const mimeRes = await graphRequest(
          `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userEmail)}/messages/${item.id}/$value`,
          { raw: true }
        );
        const mimeBuffer = await mimeRes.buffer();
        const parsed = await simpleParser(mimeBuffer);

        const emailData = {
          from: parsed.from?.text || parsed.from?.value?.[0]?.address || '',
          subject: parsed.subject || '(No Subject)',
          body: parsed.text || parsed.html || '(No content)',
          html: parsed.html || '',
          text: parsed.text || '',
          messageId: item.internetMessageId || parsed.messageId || `graph-${item.id}`,
          date: parsed.date || (item.receivedDateTime ? new Date(item.receivedDateTime) : new Date()),
          uid: null,
          inReplyTo: parsed.inReplyTo || null,
          references: parsed.references || [],
          graphMessageId: item.id
        };

        console.log(`📨 Received email graph_id=${item.id} from: ${emailData.from} | Subject: ${emailData.subject}`);
        emailQueue.push(emailData);
      } catch (mimeErr) {
        console.error(`Error fetching MIME for graph_id=${item.id}:`, mimeErr.message);
      }
    }

    console.log(`📧 Found ${emailQueue.length} email(s) to check for tenant: ${self.tenantCode}`);

    // ── Process phase: sequential queue processing (identical to IMAP) ──
    const processedEmails = [];
    const delay = (ms) => new Promise(r => setTimeout(r, ms));

    const markAsRead = async (graphMessageId) => {
      if (!graphMessageId) return;
      try {
        await graphRequest(
          `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userEmail)}/messages/${graphMessageId}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isRead: true })
          }
        );
        console.log(`✓ Marked graph_id ${graphMessageId} as read`);
      } catch (err) {
        console.error(`Failed to mark graph_id ${graphMessageId} as read:`, err.message);
      }
    };

    const stats = {
      scanned: emailQueue.length,
      processed: 0,
      ticket_updated: 0,
      skipped_duplicate: 0,
      skipped_bounce: 0,
      skipped_domain: 0,
      skipped_system: 0,
      errors: 0,
      firstProcessedMessageId: null
    };

    if (emailQueue.length === 0) {
      console.log(`📊 [${self.tenantCode}] Graph cycle summary: scanned=0`);
    } else {
      console.log(`📋 Processing queue of ${emailQueue.length} email(s) sequentially...`);

      for (let i = 0; i < emailQueue.length; i++) {
        const emailData = emailQueue[i];
        const { messageId, graphMessageId } = emailData;

        try {
          const alreadyProcessed = await self.isMessageProcessed(connection, mailboxId, messageId);
          if (alreadyProcessed) {
            console.log(`⏭️ [${i + 1}/${emailQueue.length}] Skipping duplicate: ${messageId}`);
            stats.skipped_duplicate++;
            const dupRecordResult = await self.recordProcessedMessage(
              connection, mailboxId, messageId, null, null, 'skipped_duplicate'
            );
            if (dupRecordResult.success) {
              await markAsRead(graphMessageId);
            }
            continue;
          }

          console.log(`📧 [${i + 1}/${emailQueue.length}] Processing: ${emailData.subject}`);
          const result = await self.processEmail(connection, emailData);
          processedEmails.push(result);

          let resultType = 'ticket_created';
          if (!result.success) {
            if (result.reason === 'bounce_notification_skipped') {
              resultType = 'skipped_bounce';
              stats.skipped_bounce++;
            } else if (result.reason === 'domain_not_found') {
              resultType = 'skipped_domain';
              stats.skipped_domain++;
            } else if (result.reason === 'skipped_system') {
              resultType = 'skipped_system';
              stats.skipped_system++;
            } else {
              resultType = 'error';
              stats.errors++;
            }
          } else if (result.wasReply) {
            resultType = 'ticket_updated';
            stats.ticket_updated++;
            if (!stats.firstProcessedMessageId) stats.firstProcessedMessageId = messageId;
          } else {
            stats.processed++;
            if (!stats.firstProcessedMessageId) stats.firstProcessedMessageId = messageId;
          }

          const recordResult = await self.recordProcessedMessage(
            connection, mailboxId, messageId, null, result.ticketId || null, resultType
          );

          if (recordResult.success) {
            await markAsRead(graphMessageId);
          } else if (recordResult.missingTable) {
            console.error(`⚠️ Skipping markAsRead for graph_id ${graphMessageId} - table missing`);
          }

        } catch (processError) {
          console.error(`Error processing email ${i + 1}:`, processError.message);
          processedEmails.push({ success: false, error: processError.message });
          stats.errors++;

          await self.recordProcessedMessage(
            connection, mailboxId, messageId, null, null, 'error'
          );
        }

        if (i < emailQueue.length - 1) {
          console.log(`⏳ Waiting ${EMAIL_PROCESS_DELAY_MS}ms before next email...`);
          await delay(EMAIL_PROCESS_DELAY_MS);
        }
      }

      console.log(`📊 [${self.tenantCode}] Graph cycle summary: scanned=${stats.scanned}, created=${stats.processed}, updated=${stats.ticket_updated}, skipped_dup=${stats.skipped_duplicate}, skipped_bounce=${stats.skipped_bounce}, skipped_domain=${stats.skipped_domain}, skipped_system=${stats.skipped_system}, errors=${stats.errors}`);
      if (stats.firstProcessedMessageId) {
        console.log(`📧 First processed message_id: ${stats.firstProcessedMessageId}`);
      }
    }

    // ── Persist delta cursor ──
    if (newDeltaLink) {
      await connection.query(
        'UPDATE email_ingest_settings SET graph_delta_link = ? WHERE id = ?',
        [newDeltaLink, mailboxId]
      );
      console.log(`💾 [${self.tenantCode}] Stored new deltaLink`);
    }

    return processedEmails;

    } finally {
      // Always release both locks
      unlock(lockKey);
      try {
        await connection.query(
          `UPDATE email_ingest_settings
           SET imap_locked_by = NULL,
               imap_lock_expires = NULL
           WHERE id = ?
             AND imap_locked_by = ?`,
          [mailboxId, lockOwner]
        );
      } catch (dbUnlockErr) {
        console.error(`[${self.tenantCode}] Error releasing DB lock:`, dbUnlockErr.message);
      }
    }
  }

  /**
   * Fetch emails via IMAP with UID-based tracking
   *
   * IMPORTANT: Uses queue-based sequential processing to prevent DB pool exhaustion.
   * 1. Collect phase: Parse all emails from IMAP (no DB operations, markSeen=false)
   * 2. Process phase: Process emails one-by-one, mark as seen AFTER success
   * 3. Record phase: Track processed message_ids and update last_uid_processed
   *
   * UID-based recovery (no UNSEEN dependency):
   * - If last_uid_processed is NULL, initialize to (highest_uid - RECOVERY_WINDOW)
   * - Always search by UID range, not by UNSEEN flag
   * - Dedupe via message_id in email_processed_messages table
   *
   * This prevents data loss when the worker crashes mid-processing.
   */
  async fetchEmailsViaIMAP(connection, config) {
    const self = this;
    const EMAIL_PROCESS_DELAY_MS = parseInt(process.env.EMAIL_PROCESS_DELAY_MS) || 2000;
    const IMAP_TIMEOUT_MS = parseInt(process.env.IMAP_TIMEOUT_MS) || 120000;
    const mailboxId = config.id;
    let lastUidProcessed = config.last_uid_processed;

    // Determine mailbox for lock key
    const mailboxAddr = (config.auth_method === 'oauth2' ? config.oauth2_email : config.username) || 'default';
    const lockKey = `imap:${self.tenantCode}:${mailboxAddr}`;

    // In-process lock — prevent concurrent IMAP to same mailbox
    if (!tryLock(lockKey)) {
      console.log(`🔒 [${self.tenantCode}] Skipping cycle, mailbox locked: ${mailboxAddr}`);
      return [];
    }

    // DB-level lock — multi-replica safety (atomic UPDATE, proceed only if 1 row affected)
    const lockOwner = `${os.hostname()}:${process.pid}`;
    const [lockResult] = await connection.query(
      `UPDATE email_ingest_settings
       SET imap_locked_by = ?,
           imap_lock_expires = DATE_ADD(NOW(), INTERVAL 120 SECOND)
       WHERE id = ?
         AND (imap_lock_expires IS NULL OR imap_lock_expires < NOW())`,
      [lockOwner, mailboxId]
    );

    if (lockResult.affectedRows !== 1) {
      unlock(lockKey);
      console.log(`🔒 [${self.tenantCode}] Skipping cycle, DB lock held by another replica`);
      return [];
    }

    try {

    console.log(`📬 [${this.tenantCode}] Starting IMAP fetch, last_uid_processed: ${lastUidProcessed ?? 'NULL (will initialize)'}`);

    // Build ImapFlow config based on auth method
    let imapAuth, imapHost, imapPort, imapMailboxPath;

    if (config.auth_method === 'oauth2') {
      const { getValidAccessToken } = require('./oauth2-helper');
      const { accessToken } = await getValidAccessToken(connection, self.tenantCode);
      const imapUser = config.oauth2_email;
      imapAuth = { user: imapUser, accessToken };
      imapHost = 'outlook.office365.com';
      imapPort = 993;
      imapMailboxPath = 'INBOX';
      console.log(`[${self.tenantCode}] IMAP resolved: host=${imapHost}, auth.user=${imapUser}, oauth2_email=${config.oauth2_email}`);
    } else {
      imapAuth = { user: config.username, pass: config.password };
      imapHost = config.server_host;
      imapPort = config.server_port;
      imapMailboxPath = '[Gmail]/All Mail';
    }

    const client = new ImapFlow({
      host: imapHost,
      port: imapPort,
      secure: config.auth_method === 'oauth2' ? true : !!config.use_ssl,
      auth: imapAuth,
      tls: { rejectUnauthorized: false },
      logger: false
    });

    // Prevent unhandled 'error' events from crashing the process
    client.on('error', (err) => {
      console.error(`[${self.tenantCode}] IMAP socket error: ${err.message}`);
    });

    const processedEmails = [];

    // Master timeout — close connection if stuck
    const timeoutId = setTimeout(() => {
      console.error(`[${self.tenantCode}] IMAP operation timed out after ${IMAP_TIMEOUT_MS}ms`);
      client.close();
    }, IMAP_TIMEOUT_MS);

    try {
      await client.connect();
      console.log(`✅ IMAP connected for tenant: ${self.tenantCode}`);

      const mailbox = await client.mailboxOpen(imapMailboxPath);

      // Initialize last_uid_processed if NULL (first run or post-migration)
      if (lastUidProcessed === null || lastUidProcessed === undefined) {
        const RECOVERY_UID_WINDOW = parseInt(process.env.RECOVERY_UID_WINDOW) || 500;
        const highestUid = (mailbox.uidNext || 1) - 1;
        lastUidProcessed = Math.max(0, highestUid - RECOVERY_UID_WINDOW);
        console.log(`📍 Initialized last_uid_processed = ${lastUidProcessed} (uidNext=${mailbox.uidNext}, window=${RECOVERY_UID_WINDOW})`);
        try {
          await connection.query(
            'UPDATE email_ingest_settings SET last_uid_processed = ? WHERE id = ?',
            [lastUidProcessed, mailboxId]
          );
        } catch (uidErr) {
          if (uidErr.code !== 'ER_BAD_FIELD_ERROR') throw uidErr;
          console.log('last_uid_processed column not found, skipping initialization');
        }
      }

      // ── Collect phase: fetch all messages with UID > lastUidProcessed ──
      const emailQueue = [];
      const fetchRange = `${lastUidProcessed + 1}:*`;
      console.log(`🔍 Fetching UIDs > ${lastUidProcessed}`);

      for await (const msg of client.fetch(fetchRange, { source: true, uid: true }, { uid: true })) {
        // IMAP quirk: UID X:* always returns highest UID even if <= X
        if (msg.uid <= lastUidProcessed) continue;

        try {
          const parsed = await simpleParser(msg.source);
          const emailData = {
            from: parsed.from?.text || parsed.from?.value?.[0]?.address || '',
            subject: parsed.subject || '(No Subject)',
            body: parsed.text || parsed.html || '(No content)',
            html: parsed.html || '',
            text: parsed.text || '',
            messageId: parsed.messageId || `msg-${Date.now()}-${msg.uid}`,
            date: parsed.date,
            uid: msg.uid,
            inReplyTo: parsed.inReplyTo || null,
            references: parsed.references || []
          };
          console.log(`📨 Received email UID=${msg.uid} from: ${emailData.from} | Subject: ${emailData.subject}`);
          emailQueue.push(emailData);
        } catch (parseError) {
          console.error(`Error parsing email UID=${msg.uid}:`, parseError.message);
        }
      }

      console.log(`📧 Found ${emailQueue.length} email(s) to check for tenant: ${self.tenantCode}`);

      // ── Process phase: sequential queue processing ──
      const delay = (ms) => new Promise(r => setTimeout(r, ms));

      const markAsSeen = async (uid) => {
        if (!uid) {
          console.log('⚠️ Cannot mark as seen - UID is null/undefined');
          return;
        }
        if (!client.usable) {
          console.log(`Cannot mark UID ${uid} as seen - IMAP not connected`);
          return;
        }
        try {
          await client.messageFlagsAdd(`${uid}`, ['\\Seen'], { uid: true });
          console.log(`✓ Marked UID ${uid} as seen`);
        } catch (err) {
          console.error(`Failed to mark UID ${uid} as seen:`, err.message);
        }
      };

      const stats = {
        scanned: emailQueue.length,
        processed: 0,
        ticket_updated: 0,
        skipped_duplicate: 0,
        skipped_bounce: 0,
        skipped_domain: 0,
        skipped_system: 0,
        errors: 0,
        firstProcessedMessageId: null
      };

      if (emailQueue.length === 0) {
        console.log(`📊 [${self.tenantCode}] Cycle summary: scanned=0, last_uid=${lastUidProcessed}`);
      } else {
        console.log(`📋 Processing queue of ${emailQueue.length} email(s) sequentially...`);
        let maxUidProcessed = lastUidProcessed || 0;

        for (let i = 0; i < emailQueue.length; i++) {
          const emailData = emailQueue[i];
          const { uid, messageId } = emailData;

          try {
            const alreadyProcessed = await self.isMessageProcessed(connection, mailboxId, messageId);
            if (alreadyProcessed) {
              console.log(`⏭️ [${i + 1}/${emailQueue.length}] Skipping duplicate: ${messageId}`);
              stats.skipped_duplicate++;
              const dupRecordResult = await self.recordProcessedMessage(
                connection, mailboxId, messageId, uid, null, 'skipped_duplicate'
              );
              if (dupRecordResult.success) {
                await markAsSeen(uid);
                if (uid > maxUidProcessed) maxUidProcessed = uid;
              }
              continue;
            }

            console.log(`📧 [${i + 1}/${emailQueue.length}] Processing: ${emailData.subject}`);
            const result = await self.processEmail(connection, emailData);
            processedEmails.push(result);

            let resultType = 'ticket_created';
            if (!result.success) {
              if (result.reason === 'bounce_notification_skipped') {
                resultType = 'skipped_bounce';
                stats.skipped_bounce++;
              } else if (result.reason === 'domain_not_found') {
                resultType = 'skipped_domain';
                stats.skipped_domain++;
              } else if (result.reason === 'skipped_system') {
                resultType = 'skipped_system';
                stats.skipped_system++;
              } else {
                resultType = 'error';
                stats.errors++;
              }
            } else if (result.wasReply) {
              resultType = 'ticket_updated';
              stats.ticket_updated++;
              if (!stats.firstProcessedMessageId) {
                stats.firstProcessedMessageId = messageId;
              }
            } else {
              stats.processed++;
              if (!stats.firstProcessedMessageId) {
                stats.firstProcessedMessageId = messageId;
              }
            }

            const recordResult = await self.recordProcessedMessage(
              connection, mailboxId, messageId, uid,
              result.ticketId || null, resultType
            );

            if (recordResult.success) {
              await markAsSeen(uid);
              if (uid > maxUidProcessed) maxUidProcessed = uid;
            } else if (recordResult.missingTable) {
              console.error(`⚠️ Skipping markSeen for UID ${uid} - table missing, will retry after migration`);
            }

          } catch (processError) {
            console.error(`Error processing email ${i + 1}:`, processError.message);
            processedEmails.push({ success: false, error: processError.message });
            stats.errors++;

            const errorRecordResult = await self.recordProcessedMessage(
              connection, mailboxId, messageId, uid, null, 'error'
            );
            if (errorRecordResult.success && uid > maxUidProcessed) {
              maxUidProcessed = uid;
            }
          }

          if (i < emailQueue.length - 1) {
            console.log(`⏳ Waiting ${EMAIL_PROCESS_DELAY_MS}ms before next email...`);
            await delay(EMAIL_PROCESS_DELAY_MS);
          }
        }

        const startUid = lastUidProcessed || 0;
        if (maxUidProcessed > startUid) {
          await self.updateLastUidProcessed(connection, mailboxId, maxUidProcessed);
        }

        console.log(`📊 [${self.tenantCode}] Cycle summary: mailbox_id=${mailboxId}, last_uid=${startUid}→${maxUidProcessed}, scanned=${stats.scanned}, created=${stats.processed}, updated=${stats.ticket_updated}, skipped_dup=${stats.skipped_duplicate}, skipped_bounce=${stats.skipped_bounce}, skipped_domain=${stats.skipped_domain}, skipped_system=${stats.skipped_system}, errors=${stats.errors}`);
        if (stats.firstProcessedMessageId) {
          console.log(`📧 First processed message_id: ${stats.firstProcessedMessageId}`);
        }
      }

    } finally {
      clearTimeout(timeoutId);
      try { await client.logout(); } catch (_) {}
      console.log(`IMAP connection closed for tenant: ${self.tenantCode}`);
    }

    return processedEmails;

    } finally {
      // Always release both locks
      unlock(lockKey);
      try {
        await connection.query(
          `UPDATE email_ingest_settings
           SET imap_locked_by = NULL,
               imap_lock_expires = NULL
           WHERE id = ?
             AND imap_locked_by = ?`,
          [mailboxId, lockOwner]
        );
      } catch (dbUnlockErr) {
        console.error(`[${self.tenantCode}] Error releasing DB lock:`, dbUnlockErr.message);
      }
    }
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

            const loginUrl = process.env.BASE_URL || 'https://app.serviflow.app';
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
              `,
              this.tenantCode,
              'experts'
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
            `,
            this.tenantCode,
            'experts'
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
        const loginUrl = process.env.BASE_URL || 'https://app.serviflow.app';
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
          `,
          this.tenantCode,
          'experts'
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
      const loginUrl = process.env.BASE_URL || 'https://app.serviflow.app';
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
        `,
        this.tenantCode,
        'experts'
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

    // Bounce subject patterns (also includes auto-responders to prevent loops)
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
      // Auto-responder patterns (expanded to catch variations)
      'automatic reply',
      'automated reply',
      'auto reply',
      'auto-reply',
      'autoreply',
      'automated message',
      'automated response',
      'auto response',
      'auto-response',
      'out of office',
      'out-of-office',
      'ooo:',
      'i am out of the office',
      'i am currently out',
      'on vacation',
      'away from my desk',
      'thank you for your email',  // Generic autoresponder opener
      'this is an automated',
      'this mailbox is not monitored',
      'do not reply to this email'
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

  // ============================================================================
  // EMAIL REPLY THREADING DETECTION
  // ============================================================================

  /**
   * Get system email subject denylist from tenant settings
   * Returns array of subject patterns to skip (transactional emails)
   */
  async getSystemEmailSubjectDenylist(connection) {
    try {
      const [settings] = await connection.query(
        'SELECT setting_value FROM tenant_settings WHERE setting_key = ?',
        ['system_email_subject_denylist']
      );
      if (settings.length > 0 && settings[0].setting_value) {
        try {
          return JSON.parse(settings[0].setting_value);
        } catch (e) {
          // If not valid JSON, treat as comma-separated list
          return settings[0].setting_value.split(',').map(s => s.trim());
        }
      }
      // Default denylist
      return [
        'Password Reset Request',
        'Verify your email',
        'Email Verification',
        'Account Verification',
        'Confirm your account'
      ];
    } catch (error) {
      console.error('Error getting system email subject denylist:', error);
      return [];
    }
  }

  /**
   * Check if email subject matches the system/transactional denylist
   * Returns { isSystem: boolean, matchedPattern: string|null }
   */
  async isSystemTransactionalEmail(connection, subject) {
    const denylist = await this.getSystemEmailSubjectDenylist(connection);
    const subjectLower = (subject || '').toLowerCase();

    for (const pattern of denylist) {
      if (subjectLower.includes(pattern.toLowerCase())) {
        return { isSystem: true, matchedPattern: pattern };
      }
    }
    return { isSystem: false, matchedPattern: null };
  }

  /**
   * Detect if email is a reply to an existing ticket
   * Returns { ticketId: number|null, method: string|null, debugInfo: object }
   *
   * Detection priority:
   * 1. Header threading: In-Reply-To/References match email_ticket_threads.message_id
   * 2. Subject token: [Ticket #NNNN] pattern in subject
   * 3. URL parsing: Secure ticket link in body
   */
  async detectExistingTicket(connection, email) {
    const debugInfo = {
      inReplyTo: email.inReplyTo || null,
      references: email.references || [],
      subject: email.subject || ''
    };

    // Method 1: Header Threading (In-Reply-To / References)
    const headerMessageIds = [];
    if (email.inReplyTo) {
      headerMessageIds.push(email.inReplyTo);
    }
    if (email.references && Array.isArray(email.references)) {
      headerMessageIds.push(...email.references);
    } else if (email.references && typeof email.references === 'string') {
      // References can be a space-separated string
      headerMessageIds.push(...email.references.split(/\s+/).filter(Boolean));
    }

    if (headerMessageIds.length > 0) {
      try {
        // Clean message IDs (remove angle brackets if present)
        const cleanedIds = headerMessageIds.map(id =>
          id.replace(/^</, '').replace(/>$/, '')
        );

        const placeholders = cleanedIds.map(() => '?').join(',');
        const [rows] = await connection.query(
          `SELECT ticket_id FROM email_ticket_threads
           WHERE message_id IN (${placeholders})
           ORDER BY created_at DESC LIMIT 1`,
          cleanedIds
        );

        if (rows.length > 0) {
          console.log(`🔗 [Threading] Header match found: ticket #${rows[0].ticket_id}`);
          return {
            ticketId: rows[0].ticket_id,
            method: 'header_threading',
            debugInfo
          };
        }
      } catch (error) {
        if (error.code !== 'ER_NO_SUCH_TABLE') {
          console.error('Error checking header threading:', error.message);
        }
      }
    }

    // Method 2: Subject Token Parsing ([Ticket #NNNN])
    const subject = email.subject || '';
    const tokenMatch = subject.match(TICKET_TOKEN_PATTERN);
    if (tokenMatch) {
      const ticketId = parseInt(tokenMatch[1], 10);
      // Verify ticket exists
      const [rows] = await connection.query(
        'SELECT id FROM tickets WHERE id = ?',
        [ticketId]
      );
      if (rows.length > 0) {
        console.log(`🔗 [Threading] Subject token match: ticket #${ticketId}`);
        return {
          ticketId,
          method: 'subject_token',
          debugInfo
        };
      }
    }

    // Method 3: URL Parsing (secure ticket links in body)
    const body = email.body || email.text || email.html || '';
    const urlMatches = [...body.matchAll(TICKET_URL_PATTERN)];

    if (urlMatches.length > 0) {
      // Try to decode the token and extract ticket ID
      for (const match of urlMatches) {
        const token = match[1];
        try {
          // Decode the JWT-like token to get ticket ID
          const { verifyTicketAccessToken } = require('../utils/tokenGenerator');
          const decoded = await verifyTicketAccessToken(this.tenantCode, token);
          if (decoded && decoded.ticketId) {
            // Verify ticket exists
            const [rows] = await connection.query(
              'SELECT id FROM tickets WHERE id = ?',
              [decoded.ticketId]
            );
            if (rows.length > 0) {
              console.log(`🔗 [Threading] URL token match: ticket #${decoded.ticketId}`);
              return {
                ticketId: decoded.ticketId,
                method: 'url_parsing',
                debugInfo
              };
            }
          }
        } catch (tokenError) {
          // Token invalid or expired, try next URL
          continue;
        }
      }
    }

    // Method 4: Subject + Sender matching
    // Strip Re:/Fwd: prefixes and look for an existing ticket whose title
    // (also stripped) matches, created by someone at the same email domain.
    // This catches replies where the [Ticket #NNN] token was dropped and
    // In-Reply-To / References headers were not preserved.
    const REPLY_PREFIX_RE = /^(Re|Fwd|FW|RE|FWD):\s*/gi;
    const cleanSubject = subject.replace(REPLY_PREFIX_RE, '').trim();

    if (cleanSubject.length > 0 && email.from) {
      try {
        let senderEmail = email.from.toLowerCase().trim();
        const angleMatch = senderEmail.match(/<(.+?)>/);
        if (angleMatch) senderEmail = angleMatch[1];
        const senderDomain = senderEmail.split('@')[1];

        // Match against tickets whose title (after stripping Re:/Fwd:) equals
        // the cleaned subject, from any user at the same email domain.
        const [subjectRows] = await connection.query(
          `SELECT t.id FROM tickets t
           JOIN users u ON t.requester_id = u.id
           WHERE TRIM(LEADING 'Re: ' FROM TRIM(LEADING 'RE: ' FROM TRIM(LEADING 'Fwd: ' FROM TRIM(LEADING 'FW: ' FROM t.title)))) = ?
             AND u.email LIKE ?
             AND t.status NOT IN ('Closed', 'Cancelled')
           ORDER BY t.created_at ASC LIMIT 1`,
          [cleanSubject, `%@${senderDomain}`]
        );

        if (subjectRows.length > 0) {
          console.log(`🔗 [Threading] Subject+domain match: ticket #${subjectRows[0].id} (subject="${cleanSubject}", domain=${senderDomain})`);
          return {
            ticketId: subjectRows[0].id,
            method: 'subject_sender_match',
            debugInfo
          };
        }
      } catch (error) {
        console.error('Error in subject+sender matching:', error.message);
      }
    }

    // No match found
    return { ticketId: null, method: null, debugInfo };
  }

  /**
   * Add reply email content as activity to existing ticket
   * Returns { success: boolean, activityId: number|null }
   * @param {boolean} isAutomated - If true, marks as auto-reply (out of office, etc.)
   */
  async addReplyToTicket(connection, ticketId, email, requesterId, isAutomated = false) {
    try {
      // Get email body content
      const body = email.body || email.text || '(No content)';

      // Create activity entry with appropriate label
      const label = isAutomated ? 'Auto-Reply Received' : 'Email Reply Received';
      const activityType = isAutomated ? 'auto_reply' : 'email_reply';
      const activityDescription = `**${label}**\n\nFrom: ${email.from}\nSubject: ${email.subject || '(No subject)'}\n\n${body}`;

      const result = await logTicketActivity(connection, {
        ticketId,
        userId: requesterId,
        activityType,
        description: activityDescription,
        source: 'email',
        eventKey: isAutomated ? 'ticket.auto_reply' : 'ticket.email_reply'
      });

      const logLabel = isAutomated ? 'auto-reply' : 'email reply';
      console.log(`✅ [Threading] Added ${logLabel} as activity #${result.insertId} to ticket #${ticketId}`);

      return { success: true, activityId: result.insertId };
    } catch (error) {
      console.error(`Error adding reply to ticket #${ticketId}:`, error.message);
      return { success: false, activityId: null };
    }
  }

  /**
   * Store outbound email Message-ID for future reply threading
   */
  async storeOutboundMessageId(connection, ticketId, messageId, subject) {
    if (!messageId) {
      console.log(`⚠️ [Threading] No Message-ID to store for ticket #${ticketId}`);
      return;
    }

    try {
      // Clean Message-ID (remove angle brackets)
      const cleanMessageId = messageId.replace(/^</, '').replace(/>$/, '');

      await connection.query(
        `INSERT INTO email_ticket_threads (ticket_id, message_id, subject)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE ticket_id = VALUES(ticket_id)`,
        [ticketId, cleanMessageId, subject || null]
      );

      console.log(`📧 [Threading] Stored Message-ID for ticket #${ticketId}: ${cleanMessageId.substring(0, 40)}...`);
    } catch (error) {
      if (error.code !== 'ER_NO_SUCH_TABLE') {
        console.error(`Error storing Message-ID for ticket #${ticketId}:`, error.message);
      }
    }
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

      // ============================================
      // SELF-LOOP PREVENTION
      // Skip emails sent by our own SMTP address (outbound notifications)
      // ============================================
      const smtpEmail = (process.env.SMTP_EMAIL || '').toLowerCase().trim();
      if (smtpEmail && fromEmail === smtpEmail) {
        console.log(`🔁 [Self-Loop] Skipping own outbound notification from ${fromEmail}`);
        return { success: false, reason: 'skipped_self_loop' };
      }

      // ============================================
      // EMAIL REPLY THREADING DETECTION (CHECK FIRST)
      // Always check if this is a reply to an existing ticket BEFORE
      // bounce/automated checks, so replies get threaded even if automated
      // ============================================
      const threadingResult = await this.detectExistingTicket(connection, email);

      if (threadingResult.ticketId) {
        // Check if this is also a bounce/automated reply
        const isBounce = this.isBounceNotification(fromEmail, email.subject);

        if (isBounce) {
          console.log(`🔗 [Threading] Automated reply to ticket #${threadingResult.ticketId} - adding as activity (bounce/auto-reply)`);
        } else {
          console.log(`🔗 [Threading] Reply detected for ticket #${threadingResult.ticketId} via ${threadingResult.method}`);
        }

        // Find user ID for the sender
        let userId = null;
        const [existingUsers] = await connection.query(
          'SELECT id FROM users WHERE email = ?',
          [fromEmail]
        );

        if (existingUsers.length > 0) {
          userId = existingUsers[0].id;
        } else {
          // Use system user for unknown senders
          userId = await this.getOrCreateSystemUser(connection);
        }

        // Add reply as activity to existing ticket (mark if it's automated)
        const replyResult = await this.addReplyToTicket(connection, threadingResult.ticketId, email, userId, isBounce);

        return {
          success: true,
          ticketId: threadingResult.ticketId,
          wasReply: true,
          wasAutomated: isBounce,
          threadingMethod: threadingResult.method,
          activityId: replyResult.activityId
        };
      }

      // ============================================
      // BOUNCE/AUTOMATED CHECK (only for non-replies)
      // Skip bounce/delivery notifications to prevent loops
      // ============================================
      if (this.isBounceNotification(fromEmail, email.subject)) {
        console.log(`🚫 Skipping bounce/delivery notification (not a reply): ${fromEmail}, subject: ${email.subject}`);
        return { success: false, reason: 'bounce_notification_skipped' };
      }

      // ============================================
      // CHECK FOR SYSTEM/TRANSACTIONAL EMAIL (DENYLIST)
      // Skip emails matching the subject denylist
      // ============================================
      const systemCheck = await this.isSystemTransactionalEmail(connection, email.subject);
      if (systemCheck.isSystem) {
        console.log(`🚫 [Threading] Skipping system/transactional email: "${email.subject}" (matched: "${systemCheck.matchedPattern}")`);
        return { success: false, reason: 'skipped_system', matchedPattern: systemCheck.matchedPattern };
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

    // Use full email address as username
    let username = email.toLowerCase();

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
    const loginUrl = process.env.BASE_URL || 'https://app.serviflow.app';
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
      `,
      this.tenantCode,
      'customers'
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

    await logTicketActivity(connection, {
      ticketId,
      userId: requesterId,
      activityType: 'created',
      description: sourceInfo,
      source: 'email',
      eventKey: 'ticket.created'
    });

    // Execute ticket processing rules (fire-and-forget)
    this.executeTicketRules(ticketId);

    // Trigger AI-powered work type classification (fire-and-forget)
    this.triggerClassification(ticketId);

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
   * Trigger AI-powered work type classification (fire-and-forget)
   */
  triggerClassification(ticketId) {
    try {
      const { triggerClassification } = require('../scripts/classify-ticket');
      triggerClassification(this.tenantCode, ticketId);
    } catch (error) {
      // Don't throw - classification is non-critical
      console.error(`[Classification] Error triggering classification for ticket #${ticketId}:`, error.message);
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
    const ticketUrl = `${process.env.BASE_URL || 'https://app.serviflow.app'}/ticket/view/${token}`;
    console.log(`🔐 Generated access token for ticket #${ticketId}`);

    // Build email subject with ticket token for reply threading
    const emailSubject = `[Ticket #${ticketId}] Created: ${subject}`;

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
      <p style="color:#666;font-size:12px">You can reply to this email to add comments to your ticket.</p>
    `;

    try {
      const result = await sendNotificationEmail(
        toEmail,
        emailSubject,
        htmlContent,
        this.tenantCode,
        'customers'
      );
      console.log(`Sent ticket confirmation email to: ${toEmail}`);

      // Store outbound Message-ID for reply threading
      if (result.success && result.messageId) {
        try {
          const connection = await this.getConnection();
          try {
            await this.storeOutboundMessageId(connection, ticketId, result.messageId, emailSubject);
          } finally {
            connection.release();
          }
        } catch (storeError) {
          console.error(`Failed to store Message-ID for ticket #${ticketId}:`, storeError.message);
          // Non-critical - don't fail the email send
        }
      }
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
