#!/usr/bin/env node
/**
 * Email Processing Worker
 *
 * Standalone worker for IMAP email ingestion.
 * Runs separately from the web server to prevent:
 * - Connection pool starvation
 * - Web request blocking during email processing
 * - IMAP failures affecting HTTP traffic
 *
 * IMPORTANT: This worker uses its own isolated database pools.
 * It does NOT import config/database.js or db/pool.js to avoid
 * initializing the shared web server pool. No HTTP server is started.
 *
 * Usage:
 *   node email-worker.js
 *   # or
 *   APP_MODE=email-worker node entry.js
 *
 * ============================================================================
 * RAILWAY DEPLOYMENT
 * ============================================================================
 *
 * Deploy as a separate Railway service with these environment variables:
 *
 * Required:
 *   APP_MODE=email-worker          # Routes entry.js to this worker
 *   MYSQLHOST=<railway-mysql-host>
 *   MYSQLPORT=<railway-mysql-port>
 *   MYSQLUSER=<railway-mysql-user>
 *   MYSQLPASSWORD=<railway-mysql-password>
 *   MYSQLDATABASE=a1_master
 *
 * Optional:
 *   EMAIL_POLL_INTERVAL_MS=60000   # Polling interval (default: 1 minute)
 *   EMAIL_WORKER_POOL_LIMIT=3      # Max DB connections (default: 3)
 *
 * NOTE: The web service should set DISABLE_EMAIL_PROCESSING=true to prevent
 * duplicate email processing.
 * ============================================================================
 */

require('dotenv').config();

const mysql = require('mysql2/promise');
// Import EmailProcessor class directly, NOT the start/stop functions
// This avoids triggering shared pool initialization
const { EmailProcessor } = require('./services/email-processor');

// Worker-specific pool configuration (isolated from web server)
const WORKER_POOL_CONFIG = {
  connectionLimit: parseInt(process.env.EMAIL_WORKER_POOL_LIMIT || '3', 10),
  waitForConnections: true,
  queueLimit: 10,  // Limited queue to fail fast
  connectTimeout: 15000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  idleTimeout: 30000,
};

// Worker state - completely isolated pools
let masterPool = null;
let tenantPools = new Map();
let processors = new Map();
let isShuttingDown = false;
let pollInterval = null;

const { execSync } = require('child_process');

const log = {
  info: (msg, data = {}) => console.log(`[EMAIL-WORKER] ${msg}`, Object.keys(data).length ? JSON.stringify(data) : ''),
  warn: (msg, data = {}) => console.warn(`[EMAIL-WORKER] ⚠️  ${msg}`, Object.keys(data).length ? JSON.stringify(data) : ''),
  error: (msg, data = {}) => console.error(`[EMAIL-WORKER] ❌ ${msg}`, Object.keys(data).length ? JSON.stringify(data) : ''),
};

/**
 * Get current git commit hash
 */
function getGitCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Get runtime info for debugging environment confusion
 */
function getRuntimeInfo() {
  const dbConfig = getDbConfig();
  return {
    environment: process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV || 'local',
    service: process.env.RAILWAY_SERVICE_NAME || 'email-worker',
    appMode: process.env.APP_MODE || 'email-worker',
    dbHost: dbConfig.host,
    dbPort: dbConfig.port,
    gitCommit: getGitCommit(),
    pollIntervalMs: parseInt(process.env.EMAIL_POLL_INTERVAL_MS || '60000', 10),
    workerPoolLimit: parseInt(process.env.EMAIL_WORKER_POOL_LIMIT || '3', 10),
  };
}

/**
 * Get database config from environment
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
 * Create isolated master pool for email worker
 */
function createMasterPool() {
  const config = {
    ...getDbConfig(),
    database: process.env.MASTER_DB_NAME || process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE || 'a1_master',
    ...WORKER_POOL_CONFIG,
  };

  log.info('Creating master pool', { connectionLimit: config.connectionLimit });
  return mysql.createPool(config);
}

/**
 * Get or create isolated tenant pool
 */
function getTenantPool(tenantCode) {
  if (tenantPools.has(tenantCode)) {
    return tenantPools.get(tenantCode);
  }

  const config = {
    ...getDbConfig(),
    database: `a1_tenant_${tenantCode}`,
    ...WORKER_POOL_CONFIG,
  };

  log.info('Creating tenant pool', { tenant: tenantCode });
  const pool = mysql.createPool(config);
  tenantPools.set(tenantCode, pool);
  return pool;
}

/**
 * Get a connection from tenant pool (for injection into EmailProcessor)
 */
async function getTenantConnection(tenantCode) {
  const pool = getTenantPool(tenantCode);
  return pool.getConnection();
}

/**
 * Get active tenants from master database
 */
async function getActiveTenants() {
  if (!masterPool) {
    masterPool = createMasterPool();
  }

  try {
    const [rows] = await masterPool.query(
      "SELECT tenant_code FROM tenants WHERE status = 'active'"
    );
    return rows.map(r => r.tenant_code);
  } catch (error) {
    log.error('Failed to get active tenants', { error: error.message });
    return [];
  }
}

/**
 * Get or create EmailProcessor for tenant (with isolated pool)
 */
function getProcessor(tenantCode) {
  if (processors.has(tenantCode)) {
    return processors.get(tenantCode);
  }

  // Create processor with injected connection getter (uses worker's isolated pool)
  const processor = new EmailProcessor(tenantCode, {
    getConnection: () => getTenantConnection(tenantCode),
  });
  processors.set(tenantCode, processor);
  return processor;
}

/**
 * Process emails for all tenants
 */
async function processAllTenants() {
  if (isShuttingDown) return;

  const tenants = await getActiveTenants();
  log.info(`Processing emails for ${tenants.length} tenant(s)`);

  for (const tenantCode of tenants) {
    if (isShuttingDown) break;

    try {
      const processor = getProcessor(tenantCode);
      await processor.processEmails();
    } catch (error) {
      log.error(`Email processing failed for tenant`, { tenant: tenantCode, error: error.message });
    }
  }
}

/**
 * Start the email worker
 */
async function startWorker() {
  log.info('Starting email worker...');

  // ============================================================
  // RUNTIME TRUTH - Log exactly what environment we're running in
  // ============================================================
  const runtimeInfo = getRuntimeInfo();
  console.log('\n' + '='.repeat(70));
  console.log('[EMAIL-WORKER] RUNTIME TRUTH - Environment Configuration');
  console.log('='.repeat(70));
  console.log(`  Environment:      ${runtimeInfo.environment}`);
  console.log(`  Service:          ${runtimeInfo.service}`);
  console.log(`  APP_MODE:         ${runtimeInfo.appMode}`);
  console.log(`  DB Host:          ${runtimeInfo.dbHost}:${runtimeInfo.dbPort}`);
  console.log(`  Git Commit:       ${runtimeInfo.gitCommit}`);
  console.log(`  Poll Interval:    ${runtimeInfo.pollIntervalMs}ms`);
  console.log(`  Pool Limit:       ${runtimeInfo.workerPoolLimit}`);
  console.log('='.repeat(70) + '\n');

  const pollIntervalMs = parseInt(process.env.EMAIL_POLL_INTERVAL_MS || '60000', 10);

  // Create master pool
  masterPool = createMasterPool();

  // Verify connection
  try {
    const conn = await masterPool.getConnection();
    await conn.ping();
    conn.release();
    log.info('Database connection verified');
  } catch (error) {
    log.error('Failed to connect to database', { error: error.message });
    process.exit(1);
  }

  // Log mailbox configurations for each tenant
  const tenants = await getActiveTenants();
  for (const tenantCode of tenants) {
    try {
      const pool = getTenantPool(tenantCode);
      const [mailboxes] = await pool.query(
        'SELECT id, email_address, enabled FROM email_ingest_settings'
      );
      for (const mb of mailboxes) {
        console.log(`[EMAIL-WORKER] Tenant: ${tenantCode} | Mailbox ID: ${mb.id} | Email: ${mb.email_address} | Enabled: ${mb.enabled}`);
      }
    } catch (err) {
      // Table may not exist for all tenants
    }
  }
  console.log('');

  // Initial processing
  await processAllTenants();

  // Schedule periodic processing
  pollInterval = setInterval(async () => {
    if (!isShuttingDown) {
      await processAllTenants();
    }
  }, pollIntervalMs);

  log.info('Email worker started successfully');
}

/**
 * Graceful shutdown
 */
async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log.info(`Received ${signal}, shutting down...`);

  // Stop polling
  if (pollInterval) {
    clearInterval(pollInterval);
  }

  // Stop all processors
  for (const [tenantCode, processor] of processors) {
    try {
      if (processor.stop) {
        await processor.stop();
      }
    } catch (e) {
      // Ignore errors during shutdown
    }
  }
  processors.clear();

  // Close all tenant pools
  for (const [tenantCode, pool] of tenantPools) {
    try {
      await pool.end();
      log.info('Tenant pool closed', { tenant: tenantCode });
    } catch (error) {
      log.error('Error closing tenant pool', { tenant: tenantCode, error: error.message });
    }
  }
  tenantPools.clear();

  // Close master pool
  if (masterPool) {
    try {
      await masterPool.end();
      log.info('Master pool closed');
    } catch (error) {
      log.error('Error closing master pool', { error: error.message });
    }
  }

  log.info('Email worker stopped');
  process.exit(0);
}

// Register shutdown handlers
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception', { error: error.message, stack: error.stack });
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  log.error('Unhandled rejection', { reason: String(reason) });
});

// Start the worker
startWorker().catch((error) => {
  log.error('Failed to start worker', { error: error.message });
  process.exit(1);
});
