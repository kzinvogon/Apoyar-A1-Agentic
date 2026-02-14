/**
 * Housekeeping Service
 * Automated data retention & cleanup routines.
 *
 * Retention periods are subscription-tier-aware:
 *   Starter:      90 days logs, 365 days tickets
 *   Professional: 180 days logs, 548 days tickets (18 months)
 *   MSP/Enterprise: 365 days logs, 730 days tickets (2 years)
 *
 * Per-tenant overrides via tenant_settings key 'data_retention_days'.
 */

const { masterQuery, tenantQuery, closeTenantPool, getOpenTenantCodes } = require('../config/database');

// Batch size for DELETE to avoid long table locks
const BATCH_LIMIT = 5000;

// ---------------------------------------------------------------------------
// Retention configuration
// ---------------------------------------------------------------------------

const RETENTION_DEFAULTS = {
  starter:      { logDays: 90,  ticketDays: 365 },
  professional: { logDays: 180, ticketDays: 548 },
  msp:          { logDays: 365, ticketDays: 730 },
  enterprise:   { logDays: 365, ticketDays: 730 },
};

// Fixed retention (not tier-dependent)
const FIXED_RETENTION = {
  expiredTokensDays: 30,
  stripeWebhookDays: 90,
  masterAuditDays: 90,
  signupSessionsDays: 30,
};

/**
 * Resolve retention config for a tenant.
 * @param {string} planSlug - subscription plan slug (starter, professional, msp, enterprise)
 * @param {number|null} tenantOverrideDays - optional per-tenant override for log retention
 * @returns {{ logDays: number, ticketDays: number }}
 */
function getRetentionConfig(planSlug, tenantOverrideDays) {
  const slug = (planSlug || 'starter').toLowerCase();
  const base = RETENTION_DEFAULTS[slug] || RETENTION_DEFAULTS.starter;

  if (tenantOverrideDays && tenantOverrideDays > 0) {
    return { logDays: tenantOverrideDays, ticketDays: base.ticketDays };
  }

  return { ...base };
}

// ---------------------------------------------------------------------------
// Batched delete helper
// ---------------------------------------------------------------------------

/**
 * Delete rows in batches to avoid long locks.
 * Returns total rows deleted across all batches.
 */
async function batchDelete(queryFn, sql, params) {
  let totalDeleted = 0;
  let deleted;
  do {
    const result = await queryFn(sql, params);
    deleted = result.affectedRows || 0;
    totalDeleted += deleted;
  } while (deleted >= BATCH_LIMIT);
  return totalDeleted;
}

// ---------------------------------------------------------------------------
// Tenant log pruning
// ---------------------------------------------------------------------------

/**
 * Prune log/audit tables for a single tenant.
 * @param {string} tenantCode
 * @param {{ logDays: number, ticketDays: number }} config
 * @returns {Promise<Object>} summary of rows pruned per table
 */
async function pruneLogsForTenant(tenantCode, config) {
  const summary = {};
  const q = (sql, params) => tenantQuery(tenantCode, sql, params);

  // Helper: safely delete — table might not exist on older tenants
  async function safePrune(tableName, sql, params) {
    try {
      const count = await batchDelete(q, sql, params);
      summary[tableName] = count;
    } catch (err) {
      if (err.code === 'ER_NO_SUCH_TABLE' || (err.message && err.message.includes("doesn't exist"))) {
        summary[tableName] = 'table_not_found';
      } else {
        throw err;
      }
    }
  }

  // ticket_activity — only for closed/resolved tickets older than log retention
  // Use subquery because MySQL doesn't support LIMIT with multi-table DELETE
  await safePrune('ticket_activity',
    `DELETE FROM ticket_activity WHERE id IN (
       SELECT id FROM (
         SELECT ta.id FROM ticket_activity ta
         JOIN tickets t ON ta.ticket_id = t.id
         WHERE t.status IN ('Closed', 'Resolved')
           AND ta.created_at < DATE_SUB(NOW(), INTERVAL ? DAY)
         LIMIT ?
       ) tmp
     )`,
    [config.logDays, BATCH_LIMIT]
  );

  // tenant_audit_log
  await safePrune('tenant_audit_log',
    `DELETE FROM tenant_audit_log WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT ?`,
    [config.logDays, BATCH_LIMIT]
  );

  // ai_action_log (uses executed_at)
  await safePrune('ai_action_log',
    `DELETE FROM ai_action_log WHERE executed_at < DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT ?`,
    [config.logDays, BATCH_LIMIT]
  );

  // ai_email_analysis (uses analysis_timestamp)
  await safePrune('ai_email_analysis',
    `DELETE FROM ai_email_analysis WHERE analysis_timestamp < DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT ?`,
    [config.logDays, BATCH_LIMIT]
  );

  // ai_insights — only resolved ones
  await safePrune('ai_insights',
    `DELETE FROM ai_insights WHERE status = 'resolved' AND created_at < DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT ?`,
    [config.logDays, BATCH_LIMIT]
  );

  // ticket_classification_events
  await safePrune('ticket_classification_events',
    `DELETE FROM ticket_classification_events WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT ?`,
    [config.logDays, BATCH_LIMIT]
  );

  // ticket_rule_executions
  await safePrune('ticket_rule_executions',
    `DELETE FROM ticket_rule_executions WHERE executed_at < DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT ?`,
    [config.logDays, BATCH_LIMIT]
  );

  // email_processed_messages — only non-error results
  await safePrune('email_processed_messages',
    `DELETE FROM email_processed_messages WHERE result != 'error' AND processed_at < DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT ?`,
    [config.logDays, BATCH_LIMIT]
  );

  // cmdb_change_history
  await safePrune('cmdb_change_history',
    `DELETE FROM cmdb_change_history WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT ?`,
    [config.logDays, BATCH_LIMIT]
  );

  // teams_notification_log (uses sent_at)
  await safePrune('teams_notification_log',
    `DELETE FROM teams_notification_log WHERE sent_at < DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT ?`,
    [config.logDays, BATCH_LIMIT]
  );

  // ticket_access_tokens — expired tokens
  await safePrune('ticket_access_tokens',
    `DELETE FROM ticket_access_tokens WHERE expires_at < DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT ?`,
    [FIXED_RETENTION.expiredTokensDays, BATCH_LIMIT]
  );

  return summary;
}

// ---------------------------------------------------------------------------
// Old ticket pruning
// ---------------------------------------------------------------------------

/**
 * Delete Closed/Resolved tickets older than retention period,
 * along with their activity records.
 */
async function pruneOldTickets(tenantCode, ticketRetentionDays) {
  const q = (sql, params) => tenantQuery(tenantCode, sql, params);
  let activityDeleted = 0;
  let ticketsDeleted = 0;

  try {
    // Delete activity for old closed tickets
    const actResult = await q(
      `DELETE FROM ticket_activity WHERE id IN (
         SELECT id FROM (
           SELECT ta.id FROM ticket_activity ta
           JOIN tickets t ON ta.ticket_id = t.id
           WHERE t.status IN ('Closed', 'Resolved')
             AND t.updated_at < DATE_SUB(NOW(), INTERVAL ? DAY)
           LIMIT ?
         ) tmp
       )`,
      [ticketRetentionDays, BATCH_LIMIT]
    );
    activityDeleted = actResult.affectedRows || 0;

    // Delete the tickets themselves (only those with no remaining activity)
    const tktResult = await q(
      `DELETE FROM tickets WHERE id IN (
         SELECT id FROM (
           SELECT t.id FROM tickets t
           LEFT JOIN ticket_activity ta ON ta.ticket_id = t.id
           WHERE t.status IN ('Closed', 'Resolved')
             AND t.updated_at < DATE_SUB(NOW(), INTERVAL ? DAY)
             AND ta.id IS NULL
           LIMIT ?
         ) tmp
       )`,
      [ticketRetentionDays, BATCH_LIMIT]
    );
    ticketsDeleted = tktResult.affectedRows || 0;
  } catch (err) {
    if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
  }

  return { activityDeleted, ticketsDeleted };
}

// ---------------------------------------------------------------------------
// Master DB log pruning
// ---------------------------------------------------------------------------

/**
 * Prune master-level tables (fixed retention, not tier-dependent).
 */
async function pruneMasterLogs() {
  const summary = {};

  async function safePrune(tableName, sql, params) {
    try {
      const count = await batchDelete(masterQuery, sql, params);
      summary[tableName] = count;
    } catch (err) {
      if (err.code === 'ER_NO_SUCH_TABLE' || (err.message && err.message.includes("doesn't exist"))) {
        summary[tableName] = 'table_not_found';
      } else {
        throw err;
      }
    }
  }

  await safePrune('audit_log',
    `DELETE FROM audit_log WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT ?`,
    [FIXED_RETENTION.masterAuditDays, BATCH_LIMIT]
  );

  await safePrune('master_audit_log',
    `DELETE FROM master_audit_log WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT ?`,
    [FIXED_RETENTION.masterAuditDays, BATCH_LIMIT]
  );

  await safePrune('stripe_webhook_events',
    `DELETE FROM stripe_webhook_events WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT ?`,
    [FIXED_RETENTION.stripeWebhookDays, BATCH_LIMIT]
  );

  await safePrune('signup_sessions',
    `DELETE FROM signup_sessions WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT ?`,
    [FIXED_RETENTION.signupSessionsDays, BATCH_LIMIT]
  );

  return summary;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run full housekeeping across all active tenants + master DB.
 * @returns {Promise<Object>} summary keyed by tenant code + 'master'
 */
async function runHousekeeping() {
  const startTime = Date.now();
  const results = {};

  console.log('🧹 [Housekeeping] Starting data retention cleanup...');

  // Snapshot which tenant pools are already open so we can close the ones we created
  const poolsBefore = getOpenTenantCodes();

  // 1. Get all active tenants with their plan slug
  let tenants;
  try {
    tenants = await masterQuery(
      `SELECT t.tenant_code, sp.slug as plan_slug
       FROM tenants t
       LEFT JOIN tenant_subscriptions ts ON t.id = ts.tenant_id
       LEFT JOIN subscription_plans sp ON ts.plan_id = sp.id
       WHERE t.status = 'active'`
    );
  } catch (err) {
    console.error('🧹 [Housekeeping] Failed to query tenants:', err.message);
    return { error: err.message };
  }

  // 2. Process each tenant
  for (const tenant of tenants) {
    const { tenant_code: code, plan_slug: planSlug } = tenant;
    try {
      // Check for per-tenant override
      let overrideDays = null;
      try {
        const settings = await tenantQuery(code,
          `SELECT setting_value FROM tenant_settings WHERE setting_key = 'data_retention_days'`
        );
        if (settings.length > 0 && settings[0].setting_value) {
          overrideDays = parseInt(settings[0].setting_value, 10);
        }
      } catch {
        // tenant_settings may not exist — fine
      }

      const config = getRetentionConfig(planSlug, overrideDays);

      const logs = await pruneLogsForTenant(code, config);
      const tickets = await pruneOldTickets(code, config.ticketDays);

      results[code] = { plan: planSlug || 'starter', retention: config, logs, tickets };
      console.log(`🧹 [Housekeeping] ${code} (${planSlug || 'starter'}): done`);
    } catch (err) {
      results[code] = { error: err.message };
      console.error(`🧹 [Housekeeping] ${code}: FAILED — ${err.message}`);
    }
  }

  // 3. Prune master logs
  try {
    results.master = await pruneMasterLogs();
    console.log('🧹 [Housekeeping] Master DB: done');
  } catch (err) {
    results.master = { error: err.message };
    console.error('🧹 [Housekeeping] Master DB: FAILED —', err.message);
  }

  // 4. Close tenant pools that were opened just for housekeeping
  let poolsClosed = 0;
  for (const tenant of tenants) {
    const code = tenant.tenant_code.toLowerCase();
    if (!poolsBefore.has(code)) {
      await closeTenantPool(code);
      poolsClosed++;
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`🧹 [Housekeeping] Complete in ${elapsed}s — ${tenants.length} tenant(s) processed, ${poolsClosed} temp pool(s) closed`);

  return results;
}

// ---------------------------------------------------------------------------
// Single-tenant housekeeping (for manual admin trigger)
// ---------------------------------------------------------------------------

/**
 * Run housekeeping for a single tenant.
 * @param {string} tenantCode
 * @param {string|null} planSlug
 * @returns {Promise<Object>}
 */
async function runHousekeepingForTenant(tenantCode, planSlug) {
  let overrideDays = null;
  try {
    const settings = await tenantQuery(tenantCode,
      `SELECT setting_value FROM tenant_settings WHERE setting_key = 'data_retention_days'`
    );
    if (settings.length > 0 && settings[0].setting_value) {
      overrideDays = parseInt(settings[0].setting_value, 10);
    }
  } catch {
    // tenant_settings may not exist
  }

  const config = getRetentionConfig(planSlug, overrideDays);
  const logs = await pruneLogsForTenant(tenantCode, config);
  const tickets = await pruneOldTickets(tenantCode, config.ticketDays);

  return { plan: planSlug || 'starter', retention: config, logs, tickets };
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let schedulerTimeout = null;
let schedulerInterval = null;

/**
 * Start the daily housekeeping scheduler (runs at 3:00 AM).
 */
function startScheduler() {
  const now = new Date();
  const next3AM = new Date(now);
  next3AM.setHours(3, 0, 0, 0);
  if (next3AM <= now) {
    next3AM.setDate(next3AM.getDate() + 1);
  }

  const msUntilNext = next3AM.getTime() - now.getTime();
  const hoursUntil = (msUntilNext / 3600000).toFixed(1);
  console.log(`🧹 [Housekeeping] Scheduler armed — next run in ${hoursUntil}h (3:00 AM)`);

  schedulerTimeout = setTimeout(() => {
    // First run
    runHousekeeping().catch(err => console.error('🧹 [Housekeeping] Scheduled run failed:', err.message));

    // Then every 24h
    schedulerInterval = setInterval(() => {
      runHousekeeping().catch(err => console.error('🧹 [Housekeeping] Scheduled run failed:', err.message));
    }, 24 * 60 * 60 * 1000);
  }, msUntilNext);
}

/**
 * Stop the scheduler (for graceful shutdown).
 */
function stopScheduler() {
  if (schedulerTimeout) { clearTimeout(schedulerTimeout); schedulerTimeout = null; }
  if (schedulerInterval) { clearInterval(schedulerInterval); schedulerInterval = null; }
}

module.exports = {
  getRetentionConfig,
  pruneLogsForTenant,
  pruneOldTickets,
  pruneMasterLogs,
  runHousekeeping,
  runHousekeepingForTenant,
  startScheduler,
  stopScheduler,
};
