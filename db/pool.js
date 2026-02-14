/**
 * Hardened MySQL Connection Pool
 *
 * Production-grade pool management with:
 * - Single global pool per process (no duplicate pools)
 * - Single-flight reconnection (concurrent errors share one reconnect)
 * - Automatic reconnection on fatal errors
 * - Structured logging for observability
 * - Clean shutdown handling
 * - Sentry-compatible error handling
 *
 * ============================================================================
 * CONNECTION MATH
 * ============================================================================
 *
 * Total max connections = WEB_POOL_LIMIT × (1 master + N active tenant pools)
 *
 * Example with WEB_POOL_LIMIT=6 and 3 active tenants:
 *   6 × (1 + 3) = 24 connections max
 *
 * NOTE: Tenant pools are NOT capped. Each unique tenant accessed creates a
 * new pool. For prod-hardening, consider adding MAX_TENANT_POOLS with LRU
 * eviction to bound total connections.
 *
 * ============================================================================
 * RAILWAY DEPLOYMENT - Web Service
 * ============================================================================
 *
 * Required environment variables:
 *   MYSQLHOST=<railway-mysql-host>
 *   MYSQLPORT=<railway-mysql-port>
 *   MYSQLUSER=<railway-mysql-user>
 *   MYSQLPASSWORD=<railway-mysql-password>
 *   MYSQLDATABASE=a1_master
 *
 * Optional:
 *   WEB_POOL_LIMIT=8                # Max DB connections per pool (default: 8)
 *   POOL_STATUS_KEY=<secret>        # Enables /api/pool/status endpoint
 *   DISABLE_EMAIL_PROCESSING=true   # Disable in-app email (use email-worker)
 *   DISABLE_SLA_SCHEDULER=true      # Disable in-app SLA scheduler
 *   RUN_MIGRATIONS=true             # Run migrations on startup (default: false)
 *
 * ============================================================================
 */

const mysql = require('mysql2/promise');

// Pool configuration - connectionLimit is configurable via env var
const DEFAULT_POOL_LIMIT = 8;
const CONFIGURED_POOL_LIMIT = parseInt(process.env.WEB_POOL_LIMIT || DEFAULT_POOL_LIMIT, 10);
const POOL_CONFIG = {
  connectionLimit: CONFIGURED_POOL_LIMIT,
  waitForConnections: true,        // Queue requests when pool exhausted
  queueLimit: 50,                  // Fail fast: reject after 50 queued requests
  connectTimeout: 10000,           // 10s to establish connection
  enableKeepAlive: true,           // Prevent idle connection drops
  keepAliveInitialDelay: 10000,    // 10s before first keepalive
  idleTimeout: 60000,              // Close idle connections after 60s
  maxIdle: Math.min(4, CONFIGURED_POOL_LIMIT),
};

// Log pool configuration at startup
console.log(`[POOL] connectionLimit=${CONFIGURED_POOL_LIMIT} per pool (master + each tenant). Total max connections = ${CONFIGURED_POOL_LIMIT} × active_pools`);

// Fatal error codes that require pool recreation
const FATAL_ERROR_CODES = [
  'PROTOCOL_CONNECTION_LOST',
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ER_CON_COUNT_ERROR',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'PROTOCOL_ENQUEUE_AFTER_QUIT',
];

// Schema error codes - these are configuration errors, NOT retryable
const SCHEMA_ERROR_CODES = [
  'ER_BAD_FIELD_ERROR',      // Unknown column
  'ER_NO_SUCH_TABLE',        // Table doesn't exist
  'ER_BAD_TABLE_ERROR',      // Unknown table
  'ER_CANT_DROP_FIELD_OR_KEY', // Can't drop column
  'ER_DUP_FIELDNAME',        // Duplicate column name
  'ER_WRONG_FIELD_WITH_GROUP', // Wrong field with GROUP BY
  'ER_UNKNOWN_TABLE',        // Unknown table in query
];

// Pool state
let masterPool = null;
let tenantPools = new Map();
let isShuttingDown = false;

// Single-flight promises for pool creation and reconnection
let masterPoolPromise = null;
let masterReconnectPromise = null;
let tenantPoolPromises = new Map();
let tenantReconnectPromises = new Map();

// Logging with structured output for observability
// Format: [POOL] [timestamp] [level] message {data}
const log = {
  _format: (level, msg, data) => {
    const timestamp = new Date().toISOString();
    const dataStr = Object.keys(data).length ? ` ${JSON.stringify(data)}` : '';
    return `[POOL] [${timestamp}] [${level}] ${msg}${dataStr}`;
  },
  info: (msg, data = {}) => console.log(log._format('INFO', msg, data)),
  warn: (msg, data = {}) => console.warn(log._format('WARN', `⚠️  ${msg}`, data)),
  error: (msg, data = {}) => console.error(log._format('ERROR', `❌ ${msg}`, data)),
  // Pool-specific events for monitoring systems
  poolCreated: (name, config) => log.info('Pool created', { event: 'pool_created', pool: name, host: config.host, connectionLimit: POOL_CONFIG.connectionLimit }),
  poolError: (name, err) => log.error('Pool error', { event: 'pool_error', pool: name, code: err.code, message: err.message }),
  poolExhausted: (name) => log.warn('Pool queue growing - possible exhaustion', { event: 'pool_exhaustion_warning', pool: name }),
  reconnectAttempt: (name) => log.info('Attempting to reconnect pool', { event: 'pool_reconnect_attempt', pool: name }),
  reconnectSuccess: (name) => log.info('Pool reconnection successful', { event: 'pool_reconnect_success', pool: name }),
  reconnectFailed: (name, err) => log.error('Pool reconnection failed', { event: 'pool_reconnect_failed', pool: name, code: err.code, message: err.message }),
  schemaError: (pool, sql, err) => log.error('Schema error - requires migration', { event: 'schema_error', pool, code: err.code, message: err.sqlMessage || err.message, sql_preview: sql.substring(0, 100) }),
};

/**
 * Get database configuration from environment
 */
function getDbConfig() {
  return {
    host: process.env.MASTER_DB_HOST || process.env.MYSQLHOST || process.env.MYSQL_HOST || 'localhost',
    port: parseInt(process.env.MASTER_DB_PORT || process.env.MYSQLPORT || process.env.MYSQL_PORT || '3306', 10),
    user: process.env.MASTER_DB_USER || process.env.MYSQLUSER || process.env.MYSQL_USER || 'root',
    password: process.env.MASTER_DB_PASSWORD || process.env.MYSQLPASSWORD || process.env.MYSQL_PASSWORD || '',
  };
}

/**
 * Create a pool with error handling and observability
 */
function createPoolWithHandlers(config, poolName) {
  const pool = mysql.createPool({
    ...config,
    ...POOL_CONFIG,
  });

  // Track pool statistics
  const stats = {
    created: Date.now(),
    queries: 0,
    errors: 0,
    reconnects: 0,
    schemaErrors: 0,
    lastQuery: null,
    lastError: null,
    queueWarnings: 0,
  };

  // Handle pool errors
  pool.on('error', (err) => {
    stats.errors++;
    stats.lastError = { code: err.code, message: err.message, time: Date.now() };
    log.poolError(poolName, err);

    // Don't swallow errors - let them propagate to Sentry if configured
    // The error event is for background pool maintenance errors
  });

  // Monitor for connection acquisition (detect potential exhaustion)
  pool.on('acquire', (connection) => {
    stats.lastQuery = Date.now();
  });

  // Monitor for enqueue events (connection queue growing = potential exhaustion)
  pool.on('enqueue', () => {
    stats.queueWarnings++;
    // Only log every 10th warning to avoid spam
    if (stats.queueWarnings % 10 === 1) {
      log.poolExhausted(poolName);
    }
  });

  // Log pool creation
  log.poolCreated(poolName, config);

  // Attach stats to pool for observability
  pool._stats = stats;
  pool._name = poolName;

  return pool;
}

/**
 * Check if an error is fatal and requires pool recreation
 */
function isFatalError(err) {
  return FATAL_ERROR_CODES.includes(err.code) ||
         (err.message && err.message.includes('Connection lost'));
}

/**
 * Create the master database pool (internal, called once)
 */
async function createMasterPool() {
  const config = getDbConfig();
  config.database = process.env.MASTER_DB_NAME || process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE || 'a1_master';

  const pool = createPoolWithHandlers(config, 'master');

  // Verify connection works
  const conn = await pool.getConnection();
  await conn.ping();
  conn.release();

  log.info('Master pool verified and ready');
  return pool;
}

/**
 * Get the master database pool (single-flight)
 */
async function getMasterPool() {
  if (isShuttingDown) {
    throw new Error('Pool is shutting down');
  }

  // Fast path: pool exists
  if (masterPool) {
    return masterPool;
  }

  // Single-flight: if creation in progress, wait for it
  if (masterPoolPromise) {
    return masterPoolPromise;
  }

  // Start pool creation
  masterPoolPromise = createMasterPool()
    .then(pool => {
      masterPool = pool;
      masterPoolPromise = null;
      return pool;
    })
    .catch(err => {
      log.error('Failed to create master pool', { error: err.message });
      masterPoolPromise = null;
      throw err;
    });

  return masterPoolPromise;
}

/**
 * Create a tenant database pool (internal, called once per tenant)
 */
async function createTenantPool(tenantCode) {
  const config = getDbConfig();
  config.database = `a1_tenant_${tenantCode}`;

  const pool = createPoolWithHandlers(config, `tenant:${tenantCode}`);

  // Verify connection works
  const conn = await pool.getConnection();
  await conn.ping();
  conn.release();

  log.info(`Tenant pool ready`, { tenant: tenantCode });
  return pool;
}

/**
 * Get a tenant database pool (single-flight per tenant)
 */
async function getTenantPool(tenantCode) {
  if (isShuttingDown) {
    throw new Error('Pool is shutting down');
  }

  // Normalize tenant code to lowercase (databases are a1_tenant_<lowercase>)
  const normalizedCode = tenantCode.toLowerCase();

  // Fast path: pool exists
  if (tenantPools.has(normalizedCode)) {
    return tenantPools.get(normalizedCode);
  }

  // Single-flight: if creation in progress for this tenant, wait for it
  if (tenantPoolPromises.has(normalizedCode)) {
    return tenantPoolPromises.get(normalizedCode);
  }

  // Start pool creation
  const promise = createTenantPool(normalizedCode)
    .then(pool => {
      tenantPools.set(normalizedCode, pool);
      tenantPoolPromises.delete(normalizedCode);
      return pool;
    })
    .catch(err => {
      log.error('Failed to create tenant pool', { tenant: normalizedCode, error: err.message });
      tenantPoolPromises.delete(normalizedCode);
      throw err;
    });

  tenantPoolPromises.set(normalizedCode, promise);
  return promise;
}

/**
 * Check if an error is a schema/configuration error (NOT retryable)
 */
function isSchemaError(err) {
  return SCHEMA_ERROR_CODES.includes(err.code);
}

/**
 * Create an enhanced error with context
 */
function enhanceError(err, context) {
  // Add context without modifying original error
  const enhanced = new Error(`${err.message} [${context}]`);
  enhanced.code = err.code;
  enhanced.errno = err.errno;
  enhanced.sqlState = err.sqlState;
  enhanced.sqlMessage = err.sqlMessage;
  enhanced.sql = err.sql;
  enhanced.originalError = err;
  enhanced.isSchemaError = isSchemaError(err);
  enhanced.isFatalConnectionError = isFatalError(err);
  return enhanced;
}

/**
 * Single-flight reconnection for master pool
 * Multiple concurrent fatal errors share one reconnection attempt
 */
async function ensureMasterReconnected() {
  // If reconnection already in progress, wait for it
  if (masterReconnectPromise) {
    return masterReconnectPromise;
  }

  log.reconnectAttempt('master');

  masterReconnectPromise = (async () => {
    // Close old pool
    if (masterPool) {
      try {
        await masterPool.end();
      } catch (e) {
        // Ignore errors during cleanup
      }
      masterPool = null;
    }

    // Create new pool
    const newPool = await getMasterPool();
    log.reconnectSuccess('master');
    return newPool;
  })()
    .catch(err => {
      log.reconnectFailed('master', err);
      throw err;
    })
    .finally(() => {
      masterReconnectPromise = null;
    });

  return masterReconnectPromise;
}

/**
 * Execute a query on the master database
 * Handles connection errors and automatic retry
 * Schema errors are NOT retried and are logged as configuration errors
 */
async function masterQuery(sql, params = []) {
  const pool = await getMasterPool();
  try {
    pool._stats.queries++;
    const [rows] = await pool.query(sql, params);
    return rows;
  } catch (err) {
    pool._stats.errors++;

    // Schema errors are configuration problems - do NOT retry
    if (isSchemaError(err)) {
      pool._stats.schemaErrors++;
      log.schemaError('master', sql, err);
      throw enhanceError(err, 'master:schema');
    }

    // Connection errors - single-flight reconnect then retry once
    if (isFatalError(err)) {
      try {
        const newPool = await ensureMasterReconnected();
        const [rows] = await newPool.query(sql, params);
        newPool._stats.reconnects++;
        return rows;
      } catch (retryErr) {
        throw enhanceError(retryErr, 'master:retry-failed');
      }
    }

    throw enhanceError(err, 'master');
  }
}

/**
 * Single-flight reconnection for tenant pool
 * Multiple concurrent fatal errors share one reconnection attempt
 */
async function ensureTenantReconnected(tenantCode) {
  // Normalize tenant code to lowercase
  const normalizedCode = tenantCode.toLowerCase();

  // If reconnection already in progress for this tenant, wait for it
  if (tenantReconnectPromises.has(normalizedCode)) {
    return tenantReconnectPromises.get(normalizedCode);
  }

  log.reconnectAttempt(`tenant:${normalizedCode}`);

  const promise = (async () => {
    // Close old pool
    const oldPool = tenantPools.get(normalizedCode);
    if (oldPool) {
      try {
        await oldPool.end();
      } catch (e) {
        // Ignore errors during cleanup
      }
      tenantPools.delete(normalizedCode);
    }

    // Create new pool
    const newPool = await getTenantPool(normalizedCode);
    log.reconnectSuccess(`tenant:${normalizedCode}`);
    return newPool;
  })()
    .catch(err => {
      log.reconnectFailed(`tenant:${normalizedCode}`, err);
      throw err;
    })
    .finally(() => {
      tenantReconnectPromises.delete(normalizedCode);
    });

  tenantReconnectPromises.set(normalizedCode, promise);
  return promise;
}

/**
 * Execute a query on a tenant database
 * Handles connection errors and automatic retry
 * Schema errors are NOT retried and are logged as configuration errors
 */
async function tenantQuery(tenantCode, sql, params = []) {
  const pool = await getTenantPool(tenantCode);
  try {
    pool._stats.queries++;
    const [rows] = await pool.query(sql, params);
    return rows;
  } catch (err) {
    pool._stats.errors++;

    // Schema errors are configuration problems - do NOT retry
    if (isSchemaError(err)) {
      pool._stats.schemaErrors++;
      log.schemaError(`tenant:${tenantCode}`, sql, err);
      throw enhanceError(err, `tenant:${tenantCode}:schema`);
    }

    // Connection errors - single-flight reconnect then retry once
    if (isFatalError(err)) {
      try {
        const newPool = await ensureTenantReconnected(tenantCode);
        const [rows] = await newPool.query(sql, params);
        newPool._stats.reconnects++;
        return rows;
      } catch (retryErr) {
        throw enhanceError(retryErr, `tenant:${tenantCode}:retry-failed`);
      }
    }

    throw enhanceError(err, `tenant:${tenantCode}`);
  }
}

/**
 * Execute multiple queries in a transaction
 */
async function tenantTransaction(tenantCode, callback) {
  const pool = await getTenantPool(tenantCode);
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();
    const result = await callback(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Recreate master pool (external API, uses single-flight internally)
 */
async function recreateMasterPool() {
  return ensureMasterReconnected();
}

/**
 * Recreate tenant pool (external API, uses single-flight internally)
 */
async function recreateTenantPool(tenantCode) {
  return ensureTenantReconnected(tenantCode);
}

/**
 * Get pool statistics for observability
 */
function getPoolStats() {
  const stats = {
    masterPool: masterPool ? {
      ...masterPool._stats,
      name: masterPool._name,
    } : null,
    tenantPools: {},
  };

  for (const [tenant, pool] of tenantPools) {
    stats.tenantPools[tenant] = {
      ...pool._stats,
      name: pool._name,
    };
  }

  return stats;
}

/**
 * Check if pools are healthy
 */
async function healthCheck() {
  const results = { master: false, tenants: {} };

  try {
    const pool = await getMasterPool();
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    results.master = true;
  } catch (e) {
    results.masterError = e.message;
  }

  for (const [tenant, pool] of tenantPools) {
    try {
      const conn = await pool.getConnection();
      await conn.ping();
      conn.release();
      results.tenants[tenant] = true;
    } catch (e) {
      results.tenants[tenant] = e.message;
    }
  }

  return results;
}

/**
 * Close a specific tenant pool (e.g. after housekeeping finishes with a tenant).
 * Returns true if a pool was closed, false if none existed.
 */
async function closeTenantPool(tenantCode) {
  const normalizedCode = tenantCode.toLowerCase();
  const pool = tenantPools.get(normalizedCode);
  if (!pool) return false;

  try {
    await pool.end();
    log.info('Tenant pool closed', { tenant: normalizedCode });
  } catch (err) {
    log.error('Error closing tenant pool', { tenant: normalizedCode, error: err.message });
  }
  tenantPools.delete(normalizedCode);
  tenantPoolPromises.delete(normalizedCode);
  tenantReconnectPromises.delete(normalizedCode);
  return true;
}

/**
 * Get the set of currently open tenant pool codes.
 */
function getOpenTenantCodes() {
  return new Set(tenantPools.keys());
}

/**
 * Graceful shutdown - close all pools
 */
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log.info('Shutting down pools...');

  const closePromises = [];

  if (masterPool) {
    closePromises.push(
      masterPool.end()
        .then(() => log.info('Master pool closed'))
        .catch(err => log.error('Error closing master pool', { error: err.message }))
    );
  }

  for (const [tenant, pool] of tenantPools) {
    closePromises.push(
      pool.end()
        .then(() => log.info('Tenant pool closed', { tenant }))
        .catch(err => log.error('Error closing tenant pool', { tenant, error: err.message }))
    );
  }

  await Promise.all(closePromises);
  tenantPools.clear();
  masterPool = null;

  // Clear single-flight promises
  masterPoolPromise = null;
  masterReconnectPromise = null;
  tenantPoolPromises.clear();
  tenantReconnectPromises.clear();

  log.info('All pools closed');
}

// Register shutdown handlers
process.on('SIGTERM', async () => {
  log.info('Received SIGTERM');
  await shutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  log.info('Received SIGINT');
  await shutdown();
  process.exit(0);
});

// Handle uncaught errors that might indicate pool issues
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception', { error: err.message, stack: err.stack });
  if (isFatalError(err)) {
    log.warn('Fatal DB error in uncaught exception, pools may need recreation');
  }
  // Let the process crash - Sentry will capture it
  throw err;
});

module.exports = {
  // Primary query methods - use these instead of getConnection
  masterQuery,
  tenantQuery,
  tenantTransaction,

  // Pool access for advanced use cases (migrations, etc.)
  getMasterPool,
  getTenantPool,

  // Lifecycle
  shutdown,
  closeTenantPool,
  getOpenTenantCodes,
  recreateMasterPool,
  recreateTenantPool,

  // Observability
  getPoolStats,
  healthCheck,

  // Error classification
  isFatalError,
  isSchemaError,

  // Constants
  POOL_CONFIG,
  FATAL_ERROR_CODES,
  SCHEMA_ERROR_CODES,
};
