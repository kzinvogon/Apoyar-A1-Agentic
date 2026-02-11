/**
 * KB Auto-Gen Job Queue
 *
 * In-process concurrency limiter that prevents KB article generation
 * from stampeding the MySQL connection pool.
 *
 * Limits:
 *   - Per-tenant concurrency: KB_TENANT_CONCURRENCY (default 1)
 *   - Global concurrency:     KB_GLOBAL_CONCURRENCY  (default 4)
 *   - Per-tenant queue max:   KB_QUEUE_MAX            (default 50)
 *
 * If a tenant's queue is full, the job is dropped with a log message.
 * Jobs never block the caller — enqueueKB returns immediately.
 */

const TENANT_LIMIT = parseInt(process.env.KB_TENANT_CONCURRENCY || '1', 10);
const GLOBAL_LIMIT = parseInt(process.env.KB_GLOBAL_CONCURRENCY || '4', 10);
const QUEUE_MAX    = parseInt(process.env.KB_QUEUE_MAX || '50', 10);

// Per-tenant state: { running: number, queue: Array<{ jobFn, meta }> }
const tenantState = new Map();
let globalRunning = 0;

// Metrics counters
const metrics = {
  enqueued: 0,
  running: 0,
  completed: 0,
  failed: 0,
  dropped: 0,
  suppressed: 0,
};

/**
 * Enqueue a KB auto-gen job. Returns immediately (fire-and-forget).
 *
 * @param {string} tenantCode
 * @param {Function} jobFn - async () => result
 * @param {object} meta - { ticketId, userId, ... } for logging
 */
function enqueueKB(tenantCode, jobFn, meta = {}) {
  if (!tenantState.has(tenantCode)) {
    tenantState.set(tenantCode, { running: 0, queue: [] });
  }

  const state = tenantState.get(tenantCode);

  if (state.queue.length >= QUEUE_MAX) {
    metrics.dropped++;
    console.log(`[KB-Queue] Dropped KB auto-gen for tenant ${tenantCode} ticket #${meta.ticketId || '?'} (queue full: ${state.queue.length}/${QUEUE_MAX}) [dropped=${metrics.dropped}]`);
    return;
  }

  metrics.enqueued++;
  state.queue.push({ jobFn, meta });
  console.log(`[KB-Queue] Enqueued ticket #${meta.ticketId || '?'} (tenant: ${tenantCode}) [enqueued=${metrics.enqueued} globalRunning=${globalRunning}/${GLOBAL_LIMIT}]`);
  drain(tenantCode);
}

/**
 * Start queued jobs while within concurrency limits.
 */
function drain(tenantCode) {
  const state = tenantState.get(tenantCode);
  if (!state) return;

  while (
    state.queue.length > 0 &&
    state.running < TENANT_LIMIT &&
    globalRunning < GLOBAL_LIMIT
  ) {
    const { jobFn, meta } = state.queue.shift();
    state.running++;
    globalRunning++;

    const jobStart = Date.now();
    metrics.running++;

    jobFn()
      .then(result => {
        metrics.completed++;
        const durationMs = Date.now() - jobStart;
        if (result && result.success && result.article_id && !result.skipped) {
          console.log(`[KB-Queue] Generated ${result.article_id} from ticket #${meta.ticketId || '?'} (tenant: ${tenantCode}) [${durationMs}ms]`);
        } else if (result && result.skipped) {
          metrics.suppressed++;
          console.log(`[KB-Queue] Skipped ticket #${meta.ticketId || '?'}: ${result.reason || 'already exists'} [${durationMs}ms suppressed=${metrics.suppressed}]`);
        }
      })
      .catch(err => {
        metrics.failed++;
        console.error(`[KB-Queue] Failed for tenant ${tenantCode} ticket #${meta.ticketId || '?'}:`, err.message, `[failed=${metrics.failed}]`);
      })
      .finally(() => {
        metrics.running--;
        state.running--;
        globalRunning--;
        drain(tenantCode);
      });
  }
}

/**
 * Get queue statistics for observability.
 */
function getQueueStats() {
  const stats = { globalRunning, metrics: { ...metrics }, tenants: {} };
  for (const [tenant, state] of tenantState) {
    stats.tenants[tenant] = {
      running: state.running,
      queued: state.queue.length,
    };
  }
  return stats;
}

module.exports = { enqueueKB, getQueueStats };
