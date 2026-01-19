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

// Batch size limit - process 5 tickets at a time to avoid server overload
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 2000; // 2 second delay between batches

// Maximum run time before force-resetting the mutex (5 minutes)
const MAX_RUN_TIME_MS = 5 * 60 * 1000;

// Helper to delay execution
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
 */
function calculateResolvePercent(ticket, profile) {
  if (!ticket.resolve_due_at || !ticket.first_responded_at) return 0;

  const now = new Date();
  const responded = new Date(ticket.first_responded_at);
  const due = new Date(ticket.resolve_due_at);

  let elapsed, total;
  if (profile && !profile.is_24x7) {
    elapsed = elapsedBusinessMinutes(responded, now, profile);
    total = elapsedBusinessMinutes(responded, due, profile);
  } else {
    elapsed = (now.getTime() - responded.getTime()) / 60000;
    total = (due.getTime() - responded.getTime()) / 60000;
  }

  return total > 0 ? Math.round((elapsed / total) * 100) : 0;
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
 * Process a single tenant's tickets
 */
async function processTenant(tenantCode) {
  let connection;
  try {
    connection = await getTenantConnection(tenantCode);

    // Fetch candidate tickets with SLA and business hours in one query
    const [tickets] = await connection.query(`
      SELECT
        t.id, t.title, t.status, t.created_at,
        t.sla_definition_id, t.response_due_at, t.resolve_due_at,
        t.first_responded_at, t.resolved_at,
        t.notified_response_near_at, t.notified_response_breached_at, t.notified_response_past_at,
        t.notified_resolve_near_at, t.notified_resolve_breached_at, t.notified_resolve_past_at,
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
      ORDER BY t.id ASC
      LIMIT ?
    `, [BATCH_SIZE]);

    let notificationCount = 0;
    let ticketIndex = 0;

    for (const ticket of tickets) {
      ticketIndex++;

      // Add delay between tickets to prevent server overload
      if (ticketIndex > 1) {
        await delay(BATCH_DELAY_MS);
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

      // RESOLVE phase checks (only if responded but not resolved)
      if (ticket.first_responded_at && !ticket.resolved_at) {
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
 * Main scheduler run - processes all active tenants
 */
async function runScheduler() {
  // Check if stuck from a previous run
  if (isRunning) {
    const stuckTime = runStartTime ? Date.now() - runStartTime : 0;
    if (stuckTime > MAX_RUN_TIME_MS) {
      console.log(`[SLA_NOTIFY] Scheduler stuck for ${Math.round(stuckTime / 1000)}s, force-resetting`);
      isRunning = false;
    } else {
      console.log('[SLA_NOTIFY] Scheduler already running, skipping this cycle');
      return;
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

      for (const tenant of tenants) {
        try {
          await processTenant(tenant.tenant_code);
        } catch (tenantError) {
          // Log but don't stop processing other tenants
          console.error(`[SLA_NOTIFY] Error processing tenant ${tenant.tenant_code}:`, tenantError.message);
        }
      }

      const elapsed = Date.now() - runStartTime;
      if (tenants.length > 0) {
        console.log(`[SLA_NOTIFY] Scheduler completed for ${tenants.length} tenants in ${elapsed}ms`);
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
 */
let schedulerInterval = null;

function startScheduler(intervalMs = 5 * 60 * 1000) {
  if (schedulerInterval) {
    console.log('[SLA_NOTIFY] Scheduler already started');
    return;
  }

  console.log(`[SLA_NOTIFY] Starting scheduler (interval: ${intervalMs / 1000}s)`);

  // Run immediately on start
  setTimeout(() => runScheduler(), 5000);

  // Then run every intervalMs
  schedulerInterval = setInterval(runScheduler, intervalMs);
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
