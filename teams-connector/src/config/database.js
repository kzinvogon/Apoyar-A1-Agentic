/**
 * Database configuration for Teams Connector
 * Standalone version for Railway deployment
 *
 * Uses fresh connections per query instead of persistent pools.
 * The Teams bot is low-traffic (a few messages per hour), so pooling
 * is counterproductive — idle connections get killed by Railway's
 * MySQL proxy, causing PROTOCOL_CONNECTION_LOST on every first query.
 */

const mysql = require('mysql2/promise');

const MAX_RETRIES = 2;

function getConnectionConfig(databaseName) {
  return {
    host: process.env.MYSQLHOST || process.env.MYSQL_HOST || 'localhost',
    port: parseInt(process.env.MYSQLPORT || process.env.MYSQL_PORT || '3306'),
    user: process.env.MYSQLUSER || process.env.MYSQL_USER || 'root',
    password: process.env.MYSQLPASSWORD || process.env.MYSQL_PASSWORD || '',
    database: databaseName,
    connectTimeout: 10000
  };
}

/**
 * Execute a query with a fresh connection. Retries on connection errors.
 */
async function queryWithRetry(databaseName, sql, params = []) {
  const config = getConnectionConfig(databaseName);
  let lastErr;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let conn;
    try {
      conn = await mysql.createConnection(config);
      const result = await conn.query(sql, params);
      await conn.end();
      return result;
    } catch (err) {
      lastErr = err;
      if (conn) {
        try { await conn.end(); } catch (_) {}
      }
      const retriable = ['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED'].includes(err.code);
      if (retriable && attempt < MAX_RETRIES) {
        const delay = (attempt + 1) * 500;
        console.log(`[DB] ${databaseName}: ${err.code}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Create a pool-like wrapper that uses fresh connections per query.
 * Matches the mysql2 pool interface so teamsBot.js doesn't need changes.
 */
function createWrapper(databaseName) {
  return {
    async query(sql, params) {
      return queryWithRetry(databaseName, sql, params);
    },
    async getConnection() {
      const config = getConnectionConfig(databaseName);
      const conn = await mysql.createConnection(config);
      // Add a release() method to match pool connection interface
      conn.release = async () => { try { await conn.end(); } catch (_) {} };
      return conn;
    },
    async end() { /* no-op for wrapper */ }
  };
}

// Cache wrappers (lightweight, no actual connections held open)
const wrappers = {};

/**
 * Get database interface for a tenant
 * @param {string} tenantCode
 * @returns {Promise<object>} Pool-compatible wrapper
 */
async function getTenantConnection(tenantCode) {
  const databaseName = `a1_tenant_${tenantCode}`;
  if (!wrappers[databaseName]) {
    wrappers[databaseName] = createWrapper(databaseName);
  }
  return wrappers[databaseName];
}

/**
 * Get master database interface
 * @returns {Promise<object>} Pool-compatible wrapper
 */
async function getMasterConnection() {
  const databaseName = process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE || 'master_tenant';
  if (!wrappers[databaseName]) {
    wrappers[databaseName] = createWrapper(databaseName);
  }
  return wrappers[databaseName];
}

module.exports = {
  getTenantConnection,
  getMasterConnection
};
