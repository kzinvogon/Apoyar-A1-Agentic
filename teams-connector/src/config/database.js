/**
 * Database configuration for Teams Connector
 * Standalone version for Railway deployment
 */

const mysql = require('mysql2/promise');

// Connection pool cache
const connectionPools = {};

/**
 * Get database connection for a tenant
 * @param {string} tenantCode - The tenant code (e.g., 'apoyar')
 * @returns {Promise<mysql.Connection>}
 */
async function getTenantConnection(tenantCode) {
  const databaseName = `a1_tenant_${tenantCode}`;

  if (!connectionPools[databaseName]) {
    const config = {
      host: process.env.MYSQLHOST || process.env.MYSQL_HOST || 'localhost',
      port: parseInt(process.env.MYSQLPORT || process.env.MYSQL_PORT || '3306'),
      user: process.env.MYSQLUSER || process.env.MYSQL_USER || 'root',
      password: process.env.MYSQLPASSWORD || process.env.MYSQL_PASSWORD || '',
      database: databaseName,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0
    };

    connectionPools[databaseName] = mysql.createPool(config);
  }

  return connectionPools[databaseName];
}

/**
 * Get master database connection
 * @returns {Promise<mysql.Connection>}
 */
async function getMasterConnection() {
  const databaseName = process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE || 'master_tenant';

  if (!connectionPools[databaseName]) {
    const config = {
      host: process.env.MYSQLHOST || process.env.MYSQL_HOST || 'localhost',
      port: parseInt(process.env.MYSQLPORT || process.env.MYSQL_PORT || '3306'),
      user: process.env.MYSQLUSER || process.env.MYSQL_USER || 'root',
      password: process.env.MYSQLPASSWORD || process.env.MYSQL_PASSWORD || '',
      database: databaseName,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0
    };

    connectionPools[databaseName] = mysql.createPool(config);
  }

  return connectionPools[databaseName];
}

module.exports = {
  getTenantConnection,
  getMasterConnection
};
