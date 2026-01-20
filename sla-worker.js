#!/usr/bin/env node
/**
 * SLA Worker - Standalone SLA Notification Processor
 *
 * This script runs independently of the main web server and processes
 * SLA notifications for all active tenants.
 *
 * Usage:
 *   node sla-worker.js              # Run once and exit
 *   node sla-worker.js --daemon     # Run continuously with internal scheduler
 *
 * Environment Variables:
 *   SLA_CHECK_INTERVAL_MS  - Interval between checks in daemon mode (default: 180000 = 3 minutes)
 *   SLA_TENANT_TIMEOUT_MS  - Timeout per tenant processing (default: 60000 = 60 seconds)
 *
 * For Railway Cron:
 *   Set up a cron job to run "node sla-worker.js" every 2-3 minutes
 *
 * For Railway Separate Service:
 *   Run with --daemon flag as a separate service
 */

require('dotenv').config();

const { getMasterConnection, getTenantConnection, closeAllConnections } = require('./config/database');

// Configuration from environment or defaults
const SLA_CHECK_INTERVAL_MS = parseInt(process.env.SLA_CHECK_INTERVAL_MS) || 180000; // 3 minutes
const TENANT_TIMEOUT_MS = parseInt(process.env.SLA_TENANT_TIMEOUT_MS) || 60000; // 60 seconds
const DEFAULT_SLA_CHECK_INTERVAL_SECONDS = 300; // 5 minutes per-tenant default
const MIN_SLA_CHECK_INTERVAL_SECONDS = 60;

// Track last processing time per tenant (for daemon mode)
const tenantLastProcessed = new Map();

// Graceful shutdown flag
let isShuttingDown = false;

// Import SLA calculation utilities
const { elapsedBusinessMinutes, parseDaysOfWeek } = require('./services/sla-calculator');

// Notification types
const NOTIFICATION_TYPES = {
  RESPONSE_NEAR: 'SLA_RESPONSE_NEAR',
  RESPONSE_BREACHED: 'SLA_RESPONSE_BREACHED',
  RESPONSE_PAST: 'SLA_RESPONSE_PAST',
  RESOLVE_NEAR: 'SLA_RESOLVE_NEAR',
  RESOLVE_BREACHED: 'SLA_RESOLVE_BREACHED',
  RESOLVE_PAST: 'SLA_RESOLVE_PAST'
};

// Helpers
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const withTimeout = (promise, ms, operation = 'Operation') => {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${operation} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
};

/**
 * Build business hours profile from database row
 */
function buildProfileFromRow(row) {
  if (row.bh_is_24x7) {
    return { is24x7: true };
  }
  if (!row.bh_timezone || !row.bh_days_of_week || !row.bh_start_time || !row.bh_end_time) {
    return { is24x7: true }; // Default to 24x7 if no profile
  }
  return {
    is24x7: false,
    timezone: row.bh_timezone,
    daysOfWeek: parseDaysOfWeek(row.bh_days_of_week),
    startTime: row.bh_start_time,
    endTime: row.bh_end_time
  };
}

/**
 * Calculate response SLA percentage
 */
function calculateResponsePercent(ticket, profile) {
  if (!ticket.response_due_at || !ticket.created_at) return 0;
  const createdAt = new Date(ticket.created_at);
  const dueAt = new Date(ticket.response_due_at);
  const now = new Date();

  const totalMinutes = elapsedBusinessMinutes(createdAt, dueAt, profile);
  const elapsedMinutes = elapsedBusinessMinutes(createdAt, now, profile);

  if (totalMinutes <= 0) return 0;
  return Math.round((elapsedMinutes / totalMinutes) * 100);
}

/**
 * Calculate resolve SLA percentage
 */
function calculateResolvePercent(ticket, profile) {
  if (!ticket.resolve_due_at || !ticket.first_responded_at) return 0;
  const respondedAt = new Date(ticket.first_responded_at);
  const dueAt = new Date(ticket.resolve_due_at);
  const now = new Date();

  const totalMinutes = elapsedBusinessMinutes(respondedAt, dueAt, profile);
  const elapsedMinutes = elapsedBusinessMinutes(respondedAt, now, profile);

  if (totalMinutes <= 0) return 0;
  return Math.round((elapsedMinutes / totalMinutes) * 100);
}

/**
 * Create a notification in the database
 */
async function createNotification(connection, ticketId, type, message, payload) {
  await connection.query(`
    INSERT INTO notifications (ticket_id, type, severity, message, payload_json, created_at)
    VALUES (?, ?, 'warning', ?, ?, NOW())
  `, [ticketId, type, message, JSON.stringify(payload)]);
}

/**
 * Mark ticket as notified for a specific threshold
 */
async function markNotified(connection, ticketId, column) {
  await connection.query(`UPDATE tickets SET ${column} = NOW() WHERE id = ?`, [ticketId]);
}

/**
 * Get tenant's SLA check interval
 */
async function getSlaCheckInterval(connection) {
  try {
    const [settings] = await connection.query(`
      SELECT setting_value FROM tenant_settings WHERE setting_key = 'sla_check_interval_seconds'
    `);
    if (settings.length > 0) {
      const value = parseInt(settings[0].setting_value, 10);
      if (!isNaN(value) && value >= MIN_SLA_CHECK_INTERVAL_SECONDS) {
        return value * 1000;
      }
    }
  } catch (e) {
    // Ignore errors, use default
  }
  return DEFAULT_SLA_CHECK_INTERVAL_SECONDS * 1000;
}

/**
 * Process a single tenant's SLA notifications
 */
async function processTenant(tenantCode) {
  let connection;
  try {
    connection = await getTenantConnection(tenantCode);

    // Fetch tickets with active SLAs
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
        AND t.resolved_at IS NULL
      ORDER BY t.id ASC
    `);

    let notificationCount = 0;

    for (const ticket of tickets) {
      if (isShuttingDown) break;

      const profile = buildProfileFromRow(ticket);
      const nearPercent = ticket.near_breach_percent || 85;
      const pastPercent = ticket.past_breach_percent || 120;

      // RESPONSE phase checks
      if (!ticket.first_responded_at) {
        const responsePercent = calculateResponsePercent(ticket, profile);

        if (responsePercent >= pastPercent && !ticket.notified_response_past_at) {
          await createNotification(connection, ticket.id, NOTIFICATION_TYPES.RESPONSE_PAST,
            `SLA response past breach for Ticket #${ticket.id} (${responsePercent}%)`,
            { tenantCode, ticketId: ticket.id, percentUsed: responsePercent, phase: 'response' });
          await markNotified(connection, ticket.id, 'notified_response_past_at');
          notificationCount++;
        } else if (responsePercent >= 100 && !ticket.notified_response_breached_at) {
          await createNotification(connection, ticket.id, NOTIFICATION_TYPES.RESPONSE_BREACHED,
            `SLA response breached for Ticket #${ticket.id} (${responsePercent}%)`,
            { tenantCode, ticketId: ticket.id, percentUsed: responsePercent, phase: 'response' });
          await markNotified(connection, ticket.id, 'notified_response_breached_at');
          notificationCount++;
        } else if (responsePercent >= nearPercent && !ticket.notified_response_near_at) {
          await createNotification(connection, ticket.id, NOTIFICATION_TYPES.RESPONSE_NEAR,
            `SLA response near breach for Ticket #${ticket.id} (${responsePercent}%)`,
            { tenantCode, ticketId: ticket.id, percentUsed: responsePercent, phase: 'response' });
          await markNotified(connection, ticket.id, 'notified_response_near_at');
          notificationCount++;
        }
      }

      // RESOLVE phase checks
      if (ticket.first_responded_at && !ticket.resolved_at) {
        const resolvePercent = calculateResolvePercent(ticket, profile);

        if (resolvePercent >= pastPercent && !ticket.notified_resolve_past_at) {
          await createNotification(connection, ticket.id, NOTIFICATION_TYPES.RESOLVE_PAST,
            `SLA resolution past breach for Ticket #${ticket.id} (${resolvePercent}%)`,
            { tenantCode, ticketId: ticket.id, percentUsed: resolvePercent, phase: 'resolve' });
          await markNotified(connection, ticket.id, 'notified_resolve_past_at');
          notificationCount++;
        } else if (resolvePercent >= 100 && !ticket.notified_resolve_breached_at) {
          await createNotification(connection, ticket.id, NOTIFICATION_TYPES.RESOLVE_BREACHED,
            `SLA resolution breached for Ticket #${ticket.id} (${resolvePercent}%)`,
            { tenantCode, ticketId: ticket.id, percentUsed: resolvePercent, phase: 'resolve' });
          await markNotified(connection, ticket.id, 'notified_resolve_breached_at');
          notificationCount++;
        } else if (resolvePercent >= nearPercent && !ticket.notified_resolve_near_at) {
          await createNotification(connection, ticket.id, NOTIFICATION_TYPES.RESOLVE_NEAR,
            `SLA resolution near breach for Ticket #${ticket.id} (${resolvePercent}%)`,
            { tenantCode, ticketId: ticket.id, percentUsed: resolvePercent, phase: 'resolve' });
          await markNotified(connection, ticket.id, 'notified_resolve_near_at');
          notificationCount++;
        }
      }
    }

    return { tickets: tickets.length, notifications: notificationCount };
  } finally {
    if (connection) connection.release();
  }
}

/**
 * Check if tenant should be processed (for daemon mode with per-tenant intervals)
 */
async function shouldProcessTenant(tenantCode) {
  const now = Date.now();
  const lastProcessed = tenantLastProcessed.get(tenantCode) || 0;

  let checkIntervalMs = DEFAULT_SLA_CHECK_INTERVAL_SECONDS * 1000;
  try {
    const connection = await getTenantConnection(tenantCode);
    try {
      checkIntervalMs = await getSlaCheckInterval(connection);
    } finally {
      connection.release();
    }
  } catch (e) {
    // Use default
  }

  return {
    shouldProcess: (now - lastProcessed) >= checkIntervalMs,
    checkIntervalMs
  };
}

/**
 * Run SLA check for all tenants once
 */
async function runOnce() {
  const startTime = Date.now();
  console.log(`[SLA-WORKER] Starting SLA check at ${new Date().toISOString()}`);

  let masterConnection;
  try {
    masterConnection = await getMasterConnection();
    const [tenants] = await masterConnection.query(`
      SELECT tenant_code FROM tenants WHERE status = 'active'
    `);

    let totalTickets = 0;
    let totalNotifications = 0;
    let processedCount = 0;
    let errorCount = 0;

    for (const tenant of tenants) {
      if (isShuttingDown) {
        console.log('[SLA-WORKER] Shutdown requested, stopping...');
        break;
      }

      try {
        const result = await withTimeout(
          processTenant(tenant.tenant_code),
          TENANT_TIMEOUT_MS,
          `Processing ${tenant.tenant_code}`
        );
        totalTickets += result.tickets;
        totalNotifications += result.notifications;
        processedCount++;

        if (result.notifications > 0) {
          console.log(`[SLA-WORKER] ${tenant.tenant_code}: ${result.tickets} tickets, ${result.notifications} notifications`);
        }
      } catch (err) {
        errorCount++;
        console.error(`[SLA-WORKER] Error processing ${tenant.tenant_code}: ${err.message}`);
      }
    }

    const elapsed = Date.now() - startTime;
    console.log(`[SLA-WORKER] Completed: ${processedCount}/${tenants.length} tenants, ${totalTickets} tickets, ${totalNotifications} notifications, ${errorCount} errors (${elapsed}ms)`);

    return { processedCount, totalTickets, totalNotifications, errorCount, elapsed };
  } finally {
    if (masterConnection) masterConnection.release();
  }
}

/**
 * Run in daemon mode with internal scheduler
 */
async function runDaemon() {
  console.log(`[SLA-WORKER] Starting daemon mode (interval: ${SLA_CHECK_INTERVAL_MS}ms)`);

  const runCycle = async () => {
    if (isShuttingDown) return;

    const startTime = Date.now();
    let masterConnection;

    try {
      masterConnection = await getMasterConnection();
      const [tenants] = await masterConnection.query(`
        SELECT tenant_code FROM tenants WHERE status = 'active'
      `);

      let processedCount = 0;

      for (const tenant of tenants) {
        if (isShuttingDown) break;

        try {
          const { shouldProcess, checkIntervalMs } = await shouldProcessTenant(tenant.tenant_code);

          if (shouldProcess) {
            const result = await withTimeout(
              processTenant(tenant.tenant_code),
              TENANT_TIMEOUT_MS,
              `Processing ${tenant.tenant_code}`
            );
            tenantLastProcessed.set(tenant.tenant_code, Date.now());
            processedCount++;

            if (result.notifications > 0) {
              console.log(`[SLA-WORKER] ${tenant.tenant_code}: ${result.notifications} notifications (interval: ${checkIntervalMs / 1000}s)`);
            }
          }
        } catch (err) {
          console.error(`[SLA-WORKER] Error processing ${tenant.tenant_code}: ${err.message}`);
        }
      }

      if (processedCount > 0) {
        const elapsed = Date.now() - startTime;
        console.log(`[SLA-WORKER] Cycle completed: ${processedCount}/${tenants.length} tenants processed (${elapsed}ms)`);
      }
    } catch (err) {
      console.error('[SLA-WORKER] Cycle error:', err.message);
    } finally {
      if (masterConnection) masterConnection.release();
    }
  };

  // Run immediately
  await runCycle();

  // Schedule subsequent runs
  const intervalId = setInterval(runCycle, SLA_CHECK_INTERVAL_MS);

  // Return cleanup function
  return () => clearInterval(intervalId);
}

/**
 * Graceful shutdown handler
 */
function setupShutdownHandlers(cleanup) {
  const shutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[SLA-WORKER] Received ${signal}, shutting down gracefully...`);

    if (cleanup) cleanup();

    try {
      await closeAllConnections();
      console.log('[SLA-WORKER] Database connections closed');
    } catch (e) {
      console.error('[SLA-WORKER] Error closing connections:', e.message);
    }

    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/**
 * Main entry point
 */
async function main() {
  const isDaemon = process.argv.includes('--daemon');

  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║           ServiFlow SLA Notification Worker               ║');
  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log(`║  Mode: ${isDaemon ? 'Daemon (continuous)' : 'Single run'}                              ${isDaemon ? '' : ' '}║`);
  console.log(`║  Tenant timeout: ${TENANT_TIMEOUT_MS / 1000}s                                    ║`);
  if (isDaemon) {
    console.log(`║  Check interval: ${SLA_CHECK_INTERVAL_MS / 1000}s                                   ║`);
  }
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log('');

  try {
    if (isDaemon) {
      const cleanup = await runDaemon();
      setupShutdownHandlers(cleanup);
    } else {
      setupShutdownHandlers();
      await runOnce();
      await closeAllConnections();
      process.exit(0);
    }
  } catch (err) {
    console.error('[SLA-WORKER] Fatal error:', err);
    await closeAllConnections();
    process.exit(1);
  }
}

// Run - detect if called directly or via require/entry.js
// When APP_MODE=sla-worker, always run in daemon mode
if (require.main === module || process.env.APP_MODE === 'sla-worker') {
  // Force daemon mode when run via entry.js (Railway)
  if (process.env.APP_MODE === 'sla-worker' && !process.argv.includes('--daemon')) {
    process.argv.push('--daemon');
  }
  main();
}
