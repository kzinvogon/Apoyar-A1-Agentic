/**
 * SLA Notification Scheduler
 *
 * Runs every 5 minutes to check for SLA threshold crossings and generate notifications.
 * Thresholds: near (85%), breached (100%), past (120%)
 */

const { getMasterConnection, getTenantConnection } = require('../config/database');
const {
  elapsedBusinessMinutes,
  buildProfile,
  parseDaysOfWeek
} = require('./sla-calculator');

// Mutex to prevent overlapping runs
let isRunning = false;
let runStartTime = null;
let runGeneration = 0; // Track run generation to detect stale runs

// Track last processing time per tenant for configurable intervals
const tenantLastProcessed = new Map();

// Default batch processing values (can be overridden by tenant settings)
const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_BATCH_DELAY_SECONDS = 2;
const MIN_BATCH_DELAY_SECONDS = 3;
const MAX_BATCH_SIZE = 10;
const DEFAULT_SLA_CHECK_INTERVAL_SECONDS = 300;
const MIN_SLA_CHECK_INTERVAL_SECONDS = 60;

// Maximum run time before force-resetting the mutex (2 minutes - reduced since we have per-tenant timeouts)
const MAX_RUN_TIME_MS = 2 * 60 * 1000;

// Helper to delay execution
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Timeout wrapper - rejects if operation takes too long
const withTimeout = (promise, ms, operation = 'Operation') => {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${operation} timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
};

// Per-tenant timeout (60 seconds max per tenant)
const TENANT_TIMEOUT_MS = 60 * 1000;

/**
 * Fetch SLA check interval from tenant_settings table
 * Note: Batch processing uses fixed internal values for the SLA notifier
 * The batch_delay_seconds and batch_size settings are for user-triggered bulk operations only
 */
async function getSlaCheckInterval(connection) {
  try {
    const [settings] = await connection.query(`
      SELECT setting_value
      FROM tenant_settings
      WHERE setting_key = 'sla_check_interval_seconds'
    `);

    if (settings.length > 0) {
      const value = parseInt(settings[0].setting_value, 10);
      if (!isNaN(value) && value >= MIN_SLA_CHECK_INTERVAL_SECONDS) {
        return value * 1000;
      } else if (!isNaN(value) && value > 0) {
        return MIN_SLA_CHECK_INTERVAL_SECONDS * 1000;
      }
    }

    return DEFAULT_SLA_CHECK_INTERVAL_SECONDS * 1000;
  } catch (error) {
    // If settings table doesn't exist or error, use default
    return DEFAULT_SLA_CHECK_INTERVAL_SECONDS * 1000;
  }
}

/**
 * Notification type definitions
 */
const NOTIFICATION_TYPES = {
  RESPONSE_NEAR: { type: 'SLA_RESPONSE_NEAR', severity: 'warning', field: 'notified_response_near_at' },
  RESPONSE_BREACHED: { type: 'SLA_RESPONSE_BREACHED', severity: 'critical', field: 'notified_response_breached_at' },
  RESPONSE_PAST: { type: 'SLA_RESPONSE_PAST', severity: 'critical', field: 'notified_response_past_at' },
  RESOLVE_NEAR: { type: 'SLA_RESOLVE_NEAR', severity: 'warning', field: 'notified_resolve_near_at' },
  RESOLVE_BREACHED: { type: 'SLA_RESOLVE_BREACHED', severity: 'critical', field: 'notified_resolve_breached_at' },
  RESOLVE_PAST: { type: 'SLA_RESOLVE_PAST', severity: 'critical', field: 'notified_resolve_past_at' }
};

/**
 * Build a business hours profile object from row data
 */
function buildProfileFromRow(row) {
  if (!row.business_hours_profile_id) return null;
  return {
    timezone: row.bh_timezone || 'UTC',
    days_of_week: row.bh_days_of_week,
    start_time: row.bh_start_time,
    end_time: row.bh_end_time,
    is_24x7: Boolean(row.bh_is_24x7)
  };
}

/**
 * Calculate percent used for response phase
 */
function calculateResponsePercent(ticket, profile) {
  if (!ticket.response_due_at || !ticket.created_at) return 0;

  const now = new Date();
  const created = new Date(ticket.created_at);
  const due = new Date(ticket.response_due_at);

  let elapsed, total;
  if (profile && !profile.is_24x7) {
    elapsed = elapsedBusinessMinutes(created, now, profile);
    total = elapsedBusinessMinutes(created, due, profile);
  } else {
    elapsed = (now.getTime() - created.getTime()) / 60000;
    total = (due.getTime() - created.getTime()) / 60000;
  }

  return total > 0 ? Math.round((elapsed / total) * 100) : 0;
}

/**
 * Calculate percent used for resolve phase
 * Supports both traditional workflow (first_responded_at) and ownership workflow (ownership_started_at)
 * Also accounts for SLA pause time
 */
function calculateResolvePercent(ticket, profile) {
  // Use ownership_started_at if available (pool workflow), otherwise fall back to first_responded_at
  const resolveStartTime = ticket.ownership_started_at || ticket.first_responded_at;
  if (!ticket.resolve_due_at || !resolveStartTime) return 0;

  const now = new Date();
  const started = new Date(resolveStartTime);

  // Apply pause time to due date
  const pauseSeconds = ticket.sla_pause_total_seconds || 0;
  const originalDue = new Date(ticket.resolve_due_at);
  const adjustedDue = new Date(originalDue.getTime() + pauseSeconds * 1000);

  let elapsed, total;
  if (profile && !profile.is_24x7) {
    elapsed = elapsedBusinessMinutes(started, now, profile);
    total = elapsedBusinessMinutes(started, adjustedDue, profile);
  } else {
    elapsed = (now.getTime() - started.getTime()) / 60000;
    total = (adjustedDue.getTime() - started.getTime()) / 60000;
  }

  return total > 0 ? Math.round((elapsed / total) * 100) : 0;
}

/**
 * Check if ticket SLA is currently paused (Waiting on Customer)
 */
function isSlaPaused(ticket) {
  // Check pool_status or sla_paused_at
  if (ticket.pool_status === 'WAITING_CUSTOMER') return true;
  if (ticket.sla_paused_at) return true;
  return false;
}

/**
 * Create a notification record
 */
async function createNotification(connection, ticketId, notifDef, message, payload) {
  await connection.query(`
    INSERT INTO notifications (ticket_id, type, severity, message, payload_json)
    VALUES (?, ?, ?, ?, ?)
  `, [ticketId, notifDef.type, notifDef.severity, message, JSON.stringify(payload)]);
}

/**
 * Update the notified_* timestamp on the ticket
 */
async function markNotified(connection, ticketId, field) {
  await connection.query(`UPDATE tickets SET ${field} = NOW() WHERE id = ?`, [ticketId]);
}

/**
 * Check if SLA processing is enabled (kill switch)
 */
async function isSlaProcessingEnabled(connection) {
  try {
    const [settings] = await connection.query(
      'SELECT setting_value FROM tenant_settings WHERE setting_key = ?',
      ['process_sla']
    );
    // Default to enabled if setting not found
    if (settings.length === 0) return true;
    return settings[0].setting_value !== 'false';
  } catch (error) {
    // Default to enabled if error (table doesn't exist, etc.)
    return true;
  }
}

/**
 * Process a single tenant's tickets
 */
async function processTenant(tenantCode) {
  let connection;
  try {
    connection = await getTenantConnection(tenantCode);

    // Check if SLA processing is enabled (kill switch)
    const processingEnabled = await isSlaProcessingEnabled(connection);
    if (!processingEnabled) {
      console.log(`🔴 KILL SWITCH: SLA processing is disabled for tenant: ${tenantCode}`);
      return;
    }

    // Use fixed internal batch values for SLA notifier (not user-configurable)
    // User-configurable batch settings are only for bulk operations like ticket rules
    const batchSize = DEFAULT_BATCH_SIZE;
    const batchDelayMs = DEFAULT_BATCH_DELAY_SECONDS * 1000;

    // Fetch candidate tickets with SLA and business hours in one query
    // Includes ownership workflow columns and excludes paused tickets
    const [tickets] = await connection.query(`
      SELECT
        t.id, t.title, t.status, t.created_at,
        t.sla_definition_id, t.response_due_at, t.resolve_due_at,
        t.first_responded_at, t.resolved_at,
        t.notified_response_near_at, t.notified_response_breached_at, t.notified_response_past_at,
        t.notified_resolve_near_at, t.notified_resolve_breached_at, t.notified_resolve_past_at,
        t.pool_status, t.ownership_started_at, t.sla_paused_at, t.sla_pause_total_seconds,
        s.name AS sla_name, s.near_breach_percent, s.past_breach_percent,
        s.business_hours_profile_id,
        b.timezone AS bh_timezone, b.days_of_week AS bh_days_of_week,
        b.start_time AS bh_start_time, b.end_time AS bh_end_time, b.is_24x7 AS bh_is_24x7
      FROM tickets t
      JOIN sla_definitions s ON t.sla_definition_id = s.id
      LEFT JOIN business_hours_profiles b ON s.business_hours_profile_id = b.id
      WHERE t.sla_definition_id IS NOT NULL
        AND t.status NOT IN ('Resolved', 'Closed')
        AND (t.resolved_at IS NULL)
        AND (t.pool_status IS NULL OR t.pool_status != 'WAITING_CUSTOMER')
        AND t.sla_paused_at IS NULL
      ORDER BY t.id ASC
      LIMIT ?
    `, [batchSize]);

    let notificationCount = 0;
    let ticketIndex = 0;

    for (const ticket of tickets) {
      ticketIndex++;

      // Add delay between tickets to prevent server overload
      if (ticketIndex > 1) {
        await delay(batchDelayMs);
      }

      const profile = buildProfileFromRow(ticket);
      const nearPercent = ticket.near_breach_percent || 85;
      const pastPercent = ticket.past_breach_percent || 120;

      // RESPONSE phase checks (only if not yet responded)
      if (!ticket.first_responded_at) {
        const responsePercent = calculateResponsePercent(ticket, profile);

        // Check thresholds in order: past > breached > near
        if (responsePercent >= pastPercent && !ticket.notified_response_past_at) {
          const msg = `SLA response past breach for Ticket #${ticket.id} (${responsePercent}%)`;
          const payload = {
            tenantCode,
            ticketId: ticket.id,
            percentUsed: responsePercent,
            dueAt: ticket.response_due_at,
            slaName: ticket.sla_name,
            phase: 'response'
          };
          await createNotification(connection, ticket.id, NOTIFICATION_TYPES.RESPONSE_PAST, msg, payload);
          await markNotified(connection, ticket.id, 'notified_response_past_at');
          console.log(`[SLA_NOTIFY] ${tenantCode} ticket=${ticket.id} type=SLA_RESPONSE_PAST percent=${responsePercent}`);
          notificationCount++;
        }

        if (responsePercent >= 100 && !ticket.notified_response_breached_at) {
          const msg = `SLA response breached for Ticket #${ticket.id} (${responsePercent}%)`;
          const payload = {
            tenantCode,
            ticketId: ticket.id,
            percentUsed: responsePercent,
            dueAt: ticket.response_due_at,
            slaName: ticket.sla_name,
            phase: 'response'
          };
          await createNotification(connection, ticket.id, NOTIFICATION_TYPES.RESPONSE_BREACHED, msg, payload);
          await markNotified(connection, ticket.id, 'notified_response_breached_at');
          console.log(`[SLA_NOTIFY] ${tenantCode} ticket=${ticket.id} type=SLA_RESPONSE_BREACHED percent=${responsePercent}`);
          notificationCount++;
        }

        if (responsePercent >= nearPercent && !ticket.notified_response_near_at) {
          const msg = `SLA response near breach for Ticket #${ticket.id} (${responsePercent}%)`;
          const payload = {
            tenantCode,
            ticketId: ticket.id,
            percentUsed: responsePercent,
            dueAt: ticket.response_due_at,
            slaName: ticket.sla_name,
            phase: 'response'
          };
          await createNotification(connection, ticket.id, NOTIFICATION_TYPES.RESPONSE_NEAR, msg, payload);
          await markNotified(connection, ticket.id, 'notified_response_near_at');
          console.log(`[SLA_NOTIFY] ${tenantCode} ticket=${ticket.id} type=SLA_RESPONSE_NEAR percent=${responsePercent}`);
          notificationCount++;
        }
      }

      // RESOLVE phase checks (only if ownership accepted or responded, but not resolved)
      // Use ownership_started_at for pool workflow, first_responded_at for traditional workflow
      const resolveStarted = ticket.ownership_started_at || ticket.first_responded_at;
      if (resolveStarted && !ticket.resolved_at && !isSlaPaused(ticket)) {
        const resolvePercent = calculateResolvePercent(ticket, profile);

        // Check thresholds in order: past > breached > near
        if (resolvePercent >= pastPercent && !ticket.notified_resolve_past_at) {
          const msg = `SLA resolution past breach for Ticket #${ticket.id} (${resolvePercent}%)`;
          const payload = {
            tenantCode,
            ticketId: ticket.id,
            percentUsed: resolvePercent,
            dueAt: ticket.resolve_due_at,
            slaName: ticket.sla_name,
            phase: 'resolve'
          };
          await createNotification(connection, ticket.id, NOTIFICATION_TYPES.RESOLVE_PAST, msg, payload);
          await markNotified(connection, ticket.id, 'notified_resolve_past_at');
          console.log(`[SLA_NOTIFY] ${tenantCode} ticket=${ticket.id} type=SLA_RESOLVE_PAST percent=${resolvePercent}`);
          notificationCount++;
        }

        if (resolvePercent >= 100 && !ticket.notified_resolve_breached_at) {
          const msg = `SLA resolution breached for Ticket #${ticket.id} (${resolvePercent}%)`;
          const payload = {
            tenantCode,
            ticketId: ticket.id,
            percentUsed: resolvePercent,
            dueAt: ticket.resolve_due_at,
            slaName: ticket.sla_name,
            phase: 'resolve'
          };
          await createNotification(connection, ticket.id, NOTIFICATION_TYPES.RESOLVE_BREACHED, msg, payload);
          await markNotified(connection, ticket.id, 'notified_resolve_breached_at');
          console.log(`[SLA_NOTIFY] ${tenantCode} ticket=${ticket.id} type=SLA_RESOLVE_BREACHED percent=${resolvePercent}`);
          notificationCount++;
        }

        if (resolvePercent >= nearPercent && !ticket.notified_resolve_near_at) {
          const msg = `SLA resolution near breach for Ticket #${ticket.id} (${resolvePercent}%)`;
          const payload = {
            tenantCode,
            ticketId: ticket.id,
            percentUsed: resolvePercent,
            dueAt: ticket.resolve_due_at,
            slaName: ticket.sla_name,
            phase: 'resolve'
          };
          await createNotification(connection, ticket.id, NOTIFICATION_TYPES.RESOLVE_NEAR, msg, payload);
          await markNotified(connection, ticket.id, 'notified_resolve_near_at');
          console.log(`[SLA_NOTIFY] ${tenantCode} ticket=${ticket.id} type=SLA_RESOLVE_NEAR percent=${resolvePercent}`);
          notificationCount++;
        }
      }
    }

    if (notificationCount > 0) {
      console.log(`[SLA_NOTIFY] ${tenantCode}: processed ${tickets.length} tickets, created ${notificationCount} notifications`);
    }

  } catch (error) {
    console.error(`[SLA_NOTIFY] Error processing tenant ${tenantCode}:`, error.message);
  } finally {
    if (connection) connection.release();
  }
}

/**
 * Check if tenant should be processed based on their configured SLA check interval
 */
async function shouldProcessTenant(tenantCode) {
  const now = Date.now();
  const lastProcessed = tenantLastProcessed.get(tenantCode) || 0;

  // Get tenant's configured SLA check interval
  let checkIntervalMs = DEFAULT_SLA_CHECK_INTERVAL_SECONDS * 1000;

  try {
    const connection = await getTenantConnection(tenantCode);
    try {
      checkIntervalMs = await getSlaCheckInterval(connection);
    } finally {
      connection.release();
    }
  } catch (error) {
    // Use default if can't fetch settings
  }

  const timeSinceLastProcess = now - lastProcessed;
  return {
    shouldProcess: timeSinceLastProcess >= checkIntervalMs,
    checkIntervalMs,
    timeSinceLastProcess
  };
}

/**
 * Main scheduler run - processes all active tenants based on their individual intervals
 */
async function runScheduler() {
  // Check if stuck from a previous run
  if (isRunning) {
    const stuckTime = runStartTime ? Date.now() - runStartTime : 0;
    if (stuckTime > MAX_RUN_TIME_MS) {
      console.log(`[SLA_NOTIFY] Scheduler stuck for ${Math.round(stuckTime / 1000)}s, force-resetting`);
      isRunning = false;
    } else {
      return; // Silently skip if already running (scheduler runs frequently now)
    }
  }

  isRunning = true;
  runStartTime = Date.now();

  try {
    // Get all active tenants from master DB
    const masterConnection = await getMasterConnection();
    try {
      const [tenants] = await masterConnection.query(`
        SELECT tenant_code FROM tenants WHERE status = 'active'
      `);

      let processedCount = 0;
      for (const tenant of tenants) {
        try {
          // Check if this tenant is due for processing based on their interval
          const { shouldProcess, checkIntervalMs } = await shouldProcessTenant(tenant.tenant_code);

          if (shouldProcess) {
            // Wrap processTenant with timeout to prevent hanging
            await withTimeout(
              processTenant(tenant.tenant_code),
              TENANT_TIMEOUT_MS,
              `SLA processing for ${tenant.tenant_code}`
            );
            tenantLastProcessed.set(tenant.tenant_code, Date.now());
            processedCount++;
            console.log(`[SLA_NOTIFY] Processed ${tenant.tenant_code} (interval: ${checkIntervalMs / 1000}s)`);
          }
        } catch (tenantError) {
          // Log but don't stop processing other tenants
          console.error(`[SLA_NOTIFY] Error processing tenant ${tenant.tenant_code}:`, tenantError.message);
        }
      }

      const elapsed = Date.now() - runStartTime;
      if (processedCount > 0) {
        console.log(`[SLA_NOTIFY] Scheduler completed: ${processedCount}/${tenants.length} tenants processed in ${elapsed}ms`);
      }
    } finally {
      masterConnection.release();
    }
  } catch (error) {
    console.error('[SLA_NOTIFY] Scheduler error:', error.message);
  } finally {
    isRunning = false;
    runStartTime = null;
  }
}

/**
 * Start the scheduler (call from server.js)
 * The scheduler now runs every 30 seconds to check each tenant's individual interval
 */
let schedulerInterval = null;
const SCHEDULER_CHECK_INTERVAL_MS = 60 * 1000; // Check every 60 seconds (increased from 30 for stability)

function startScheduler() {
  if (schedulerInterval) {
    console.log('[SLA_NOTIFY] Scheduler already started');
    return;
  }

  console.log(`[SLA_NOTIFY] Starting scheduler (checking every ${SCHEDULER_CHECK_INTERVAL_MS / 1000}s, per-tenant intervals configurable)`);

  // Run immediately on start
  setTimeout(() => runScheduler(), 5000);

  // Check every 30 seconds - actual processing depends on each tenant's sla_check_interval_seconds
  schedulerInterval = setInterval(runScheduler, SCHEDULER_CHECK_INTERVAL_MS);
}

function stopScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('[SLA_NOTIFY] Scheduler stopped');
  }
}

module.exports = {
  startScheduler,
  stopScheduler,
  runScheduler // Export for manual testing
};
