/**
 * Database configuration for Teams Connector
 * Standalone version for Railway deployment
 */

const mysql = require('mysql2/promise');

// Connection pool cache
const connectionPools = {};

/**
 * Create a pool with keep-alive and auto-recovery on dropped connections.
 */
function createResilientPool(databaseName) {
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

  const pool = mysql.createPool(config);
  pool.on('error', (err) => {
    console.error(`[DB] Pool error for ${databaseName}:`, err.message);
    if (err.code === 'PROTOCOL_CONNECTION_LOST' || err.code === 'ECONNRESET' || err.code === 'EPIPE') {
      delete connectionPools[databaseName];
    }
  });
  return pool;
}

/**
 * Get database connection for a tenant
 * @param {string} tenantCode - The tenant code (e.g., 'apoyar')
 * @returns {Promise<mysql.Pool>}
 */
async function getTenantConnection(tenantCode) {
  const databaseName = `a1_tenant_${tenantCode}`;

  if (!connectionPools[databaseName]) {
    connectionPools[databaseName] = createResilientPool(databaseName);
  }

  return connectionPools[databaseName];
}

/**
 * Get master database connection
 * @returns {Promise<mysql.Pool>}
 */
async function getMasterConnection() {
  const databaseName = process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE || 'master_tenant';

  if (!connectionPools[databaseName]) {
    connectionPools[databaseName] = createResilientPool(databaseName);
  }

  return connectionPools[databaseName];
}

module.exports = {
  getTenantConnection,
  getMasterConnection
};
