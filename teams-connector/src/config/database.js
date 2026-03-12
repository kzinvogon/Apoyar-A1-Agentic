/**
 * Database configuration for Teams Connector
 * Standalone version for Railway deployment
 *
 * Wraps mysql2 pools with automatic retry on PROTOCOL_CONNECTION_LOST
 * so that idle connection drops (common on Railway proxy) self-heal.
 */

const mysql = require('mysql2/promise');

// Connection pool cache
const connectionPools = {};

const RETRIABLE_CODES = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ECONNREFUSED'
]);

/**
 * Create a raw mysql2 pool with keep-alive settings.
 */
function createRawPool(databaseName) {
  const config = {
    host: process.env.MYSQLHOST || process.env.MYSQL_HOST || 'localhost',
    port: parseInt(process.env.MYSQLPORT || process.env.MYSQL_PORT || '3306'),
    user: process.env.MYSQLUSER || process.env.MYSQL_USER || 'root',
    password: process.env.MYSQLPASSWORD || process.env.MYSQL_PASSWORD || '',
    database: databaseName,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    idleTimeout: 60000
  };

  return mysql.createPool(config);
}

/**
 * Get or create a pool, wrapped with retry-on-disconnect logic.
 * Returns an object with a .query() that retries once on connection loss.
 */
function getPool(databaseName) {
  if (connectionPools[databaseName]) {
    return connectionPools[databaseName];
  }

  let rawPool = createRawPool(databaseName);

  const wrapper = {
    /**
     * pool.query with one automatic retry on connection-lost errors.
     */
    async query(sql, params) {
      try {
        return await rawPool.query(sql, params);
      } catch (err) {
        if (RETRIABLE_CODES.has(err.code)) {
          console.log(`[DB] Connection lost for ${databaseName}, recreating pool and retrying...`);
          try { rawPool.end().catch(() => {}); } catch (_) {}
          rawPool = createRawPool(databaseName);
          // Update the wrapper's reference so future calls use the new pool
          return await rawPool.query(sql, params);
        }
        throw err;
      }
    },

    /** Expose getConnection for callers that need transactions */
    async getConnection() {
      try {
        return await rawPool.getConnection();
      } catch (err) {
        if (RETRIABLE_CODES.has(err.code)) {
          console.log(`[DB] Connection lost for ${databaseName}, recreating pool...`);
          try { rawPool.end().catch(() => {}); } catch (_) {}
          rawPool = createRawPool(databaseName);
          return await rawPool.getConnection();
        }
        throw err;
      }
    },

    /** Graceful shutdown */
    async end() {
      return rawPool.end();
    }
  };

  connectionPools[databaseName] = wrapper;
  return wrapper;
}

/**
 * Get database connection for a tenant
 * @param {string} tenantCode - The tenant code (e.g., 'apoyar')
 * @returns {Promise<object>} Pool wrapper with retry-capable .query()
 */
async function getTenantConnection(tenantCode) {
  const databaseName = `a1_tenant_${tenantCode}`;
  return getPool(databaseName);
}

/**
 * Get master database connection
 * @returns {Promise<object>} Pool wrapper with retry-capable .query()
 */
async function getMasterConnection() {
  const databaseName = process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE || 'master_tenant';
  return getPool(databaseName);
}

module.exports = {
  getTenantConnection,
  getMasterConnection
};
