/**
 * Database Configuration and Connection Management
 *
 * This module provides backward-compatible access to MySQL pools while
 * using the hardened pool implementation from db/pool.js.
 *
 * MIGRATION GUIDE:
 * - OLD: const conn = await getTenantConnection(tenant); try { ... } finally { conn.release(); }
 * - NEW: const rows = await tenantQuery(tenant, sql, params);
 *
 * The new methods (masterQuery, tenantQuery) handle connection lifecycle automatically.
 */

const mysql = require('mysql2/promise');
const hardenedPool = require('../db/pool');

// Log database environment for debugging (once at startup)
console.log('🔧 Database environment check:');
console.log(`   MYSQLHOST: ${process.env.MYSQLHOST || '(not set)'}`);
console.log(`   MYSQL_HOST: ${process.env.MYSQL_HOST || '(not set)'}`);
console.log(`   MYSQLPORT: ${process.env.MYSQLPORT || '(not set)'}`);
console.log(`   MYSQLUSER: ${process.env.MYSQLUSER || '(not set)'}`);
console.log(`   MYSQL_USER: ${process.env.MYSQL_USER || '(not set)'}`);
console.log(`   MYSQLDATABASE: ${process.env.MYSQLDATABASE || '(not set)'}`);
console.log(`   MYSQL_DATABASE: ${process.env.MYSQL_DATABASE || '(not set)'}`);

// Derive config for logging
const dbHost = process.env.MASTER_DB_HOST || process.env.MYSQLHOST || process.env.MYSQL_HOST || 'localhost';
const dbPort = process.env.MASTER_DB_PORT || process.env.MYSQLPORT || process.env.MYSQL_PORT || 3306;
console.log(`🔧 Using database host: ${dbHost}:${dbPort}`);

/**
 * Get master database connection (LEGACY - prefer masterQuery)
 *
 * @deprecated Use masterQuery() for automatic connection management
 * @returns {Promise<PoolConnection>} Connection that MUST be released
 */
async function getMasterConnection() {
  const pool = await hardenedPool.getMasterPool();
  return pool.getConnection();
}

/**
 * Get tenant database connection (LEGACY - prefer tenantQuery)
 *
 * @deprecated Use tenantQuery() for automatic connection management
 * @param {string} tenantCode - Tenant identifier
 * @returns {Promise<PoolConnection>} Connection that MUST be released
 */
async function getTenantConnection(tenantCode) {
  const pool = await hardenedPool.getTenantPool(tenantCode);
  return pool.getConnection();
}

/**
 * Execute a query on master database (RECOMMENDED)
 * Handles connection lifecycle and error recovery automatically.
 *
 * @param {string} sql - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<Array>} Query results
 */
async function masterQuery(sql, params = []) {
  return hardenedPool.masterQuery(sql, params);
}

/**
 * Execute a query on tenant database (RECOMMENDED)
 * Handles connection lifecycle and error recovery automatically.
 *
 * @param {string} tenantCode - Tenant identifier
 * @param {string} sql - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<Array>} Query results
 */
async function tenantQuery(tenantCode, sql, params = []) {
  return hardenedPool.tenantQuery(tenantCode, sql, params);
}

/**
 * Execute multiple queries in a transaction
 *
 * @param {string} tenantCode - Tenant identifier
 * @param {Function} callback - Async function receiving connection
 * @returns {Promise<any>} Transaction result
 */
async function tenantTransaction(tenantCode, callback) {
  return hardenedPool.tenantTransaction(tenantCode, callback);
}

/**
 * Get tenant pool directly (for pool.query without manual getConnection)
 *
 * @param {string} tenantCode - Tenant identifier
 * @returns {Promise<Pool>} The mysql2 pool (auto-manages connections per query)
 */
async function getTenantPool(tenantCode) {
  return hardenedPool.getTenantPool(tenantCode);
}

/**
 * Acquire a connection for a short block, then release automatically.
 * Use this instead of getTenantConnection when you need a connection
 * for multiple related queries but NOT across async API calls.
 *
 * @param {string} tenantCode - Tenant identifier
 * @param {Function} fn - Async function receiving the connection
 * @returns {Promise<any>} Result of fn
 */
async function withTenantConnection(tenantCode, fn) {
  const pool = await hardenedPool.getTenantPool(tenantCode);
  const conn = await pool.getConnection();
  try {
    return await fn(conn);
  } finally {
    conn.release();
  }
}

/**
 * Initialize master database (create if not exists)
 * Only runs during initial setup or when RUN_MIGRATIONS=true
 */
async function initializeMasterDatabase() {
  const pool = await hardenedPool.getMasterPool();

  // Try to connect first
  try {
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    console.log(`✅ Master database 'a1_master' ready`);
  } catch (error) {
    // Database might not exist, try to create it
    console.log('📋 Master database not accessible, attempting to create...');

    const tempConfig = {
      host: dbHost,
      port: parseInt(dbPort, 10),
      user: process.env.MASTER_DB_USER || process.env.MYSQLUSER || process.env.MYSQL_USER || 'root',
      password: process.env.MASTER_DB_PASSWORD || process.env.MYSQLPASSWORD || process.env.MYSQL_PASSWORD || '',
      waitForConnections: true,
      connectionLimit: 2,
    };

    const tempPool = mysql.createPool(tempConfig);
    const connection = await tempPool.getConnection();

    try {
      const dbName = process.env.MASTER_DB_NAME || process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE || 'a1_master';
      await connection.query(`CREATE DATABASE IF NOT EXISTS ${dbName}`);
      console.log(`✅ Master database '${dbName}' created`);
    } finally {
      connection.release();
      await tempPool.end();
    }
  }

  // Always ensure all master tables exist (IF NOT EXISTS is safe to re-run)
  console.log('📋 Ensuring master database tables...');
  await createMasterTables();
  console.log('✅ Master database tables ready');
}

/**
 * Create master database tables
 */
async function createMasterTables() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS master_users (
      id INT PRIMARY KEY AUTO_INCREMENT,
      username VARCHAR(50) UNIQUE NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      full_name VARCHAR(100) NOT NULL,
      role ENUM('super_admin', 'master_admin') NOT NULL DEFAULT 'master_admin',
      is_active BOOLEAN DEFAULT TRUE,
      last_login DATETIME,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS tenants (
      id INT PRIMARY KEY AUTO_INCREMENT,
      tenant_code VARCHAR(20) UNIQUE NOT NULL,
      company_name VARCHAR(100) NOT NULL,
      display_name VARCHAR(100) NOT NULL,
      database_name VARCHAR(50) NOT NULL,
      database_host VARCHAR(100) DEFAULT 'localhost',
      database_port INT DEFAULT 3306,
      database_user VARCHAR(50) NOT NULL,
      database_password VARCHAR(255) NOT NULL,
      status ENUM('active', 'inactive', 'suspended') DEFAULT 'active',
      is_demo TINYINT(1) NOT NULL DEFAULT 0,
      max_users INT DEFAULT 100,
      max_tickets INT DEFAULT 1000,
      subscription_plan ENUM('basic', 'professional', 'enterprise') DEFAULT 'basic',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      created_by INT,
      FOREIGN KEY (created_by) REFERENCES master_users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS tenant_admins (
      id INT PRIMARY KEY AUTO_INCREMENT,
      tenant_id INT NOT NULL,
      username VARCHAR(50) NOT NULL,
      email VARCHAR(100) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      full_name VARCHAR(100) NOT NULL,
      role ENUM('tenant_admin', 'tenant_manager') NOT NULL DEFAULT 'tenant_admin',
      is_active BOOLEAN DEFAULT TRUE,
      last_login DATETIME,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (tenant_id) REFERENCES tenants(id),
      UNIQUE KEY unique_tenant_user (tenant_id, username),
      UNIQUE KEY unique_tenant_email (tenant_id, email)
    )`,
    `CREATE TABLE IF NOT EXISTS master_audit_log (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT,
      user_type ENUM('master_user', 'tenant_admin') NOT NULL,
      action VARCHAR(100) NOT NULL,
      details TEXT,
      ip_address VARCHAR(45),
      user_agent TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES master_users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS audit_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_code VARCHAR(50) NOT NULL,
      user_id INT NULL,
      username VARCHAR(100) NULL,
      action VARCHAR(50) NOT NULL,
      entity_type VARCHAR(50) NOT NULL,
      entity_id VARCHAR(100) NULL,
      details_json JSON NULL,
      ip VARCHAR(64) NULL,
      user_agent VARCHAR(255) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_tenant_code (tenant_code),
      INDEX idx_action (action),
      INDEX idx_created_at (created_at)
    )`,
    `CREATE TABLE IF NOT EXISTS subscription_plans (
      id INT PRIMARY KEY AUTO_INCREMENT,
      slug VARCHAR(50) NOT NULL UNIQUE,
      name VARCHAR(100),
      display_name VARCHAR(100) NOT NULL,
      tagline VARCHAR(255),
      description TEXT,
      price_monthly DECIMAL(10,2) NOT NULL DEFAULT 0,
      price_yearly DECIMAL(10,2) NOT NULL DEFAULT 0,
      price_per_user DECIMAL(10,2) DEFAULT 0,
      features JSON,
      feature_limits JSON,
      is_active TINYINT(1) DEFAULT 1,
      is_featured TINYINT(1) DEFAULT 0,
      badge_text VARCHAR(50),
      display_order INT DEFAULT 0,
      stripe_product_id VARCHAR(255),
      stripe_price_monthly VARCHAR(255),
      stripe_price_yearly VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS tenant_subscriptions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      plan_id INT NOT NULL,
      status ENUM('trial', 'active', 'past_due', 'cancelled', 'expired') DEFAULT 'trial',
      billing_cycle ENUM('monthly', 'yearly') DEFAULT 'monthly',
      current_period_start DATE,
      current_period_end DATE,
      trial_start DATE,
      trial_end DATE,
      user_count INT DEFAULT 0,
      ticket_count_this_period INT DEFAULT 0,
      storage_used_gb DECIMAL(10,2) DEFAULT 0,
      stripe_subscription_id VARCHAR(255),
      stripe_customer_id VARCHAR(255),
      previous_plan_id INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant_id (tenant_id)
    )`,
  ];

  for (const sql of statements) {
    await hardenedPool.masterQuery(sql);
  }

  // Insert default master admin
  const existingAdmin = await hardenedPool.masterQuery('SELECT id FROM master_users WHERE username = ?', ['admin']);
  if (existingAdmin.length === 0) {
    const bcrypt = require('bcrypt');
    const defaultPassword = process.env.DEFAULT_MASTER_PASSWORD || 'admin123';
    const hashedPassword = await bcrypt.hash(defaultPassword, 10);
    await hardenedPool.masterQuery(
      'INSERT INTO master_users (username, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?)',
      ['admin', 'admin@a1master.com', hashedPassword, 'Master Administrator', 'super_admin']
    );
    console.log('👑 Default master admin created (username: admin)');
  }
}

/**
 * Initialize tenant database
 * Only runs during initial setup or when RUN_MIGRATIONS=true
 */
async function initializeTenantDatabase(tenantCode) {
  // Get tenant configuration from master
  const rows = await hardenedPool.masterQuery(
    'SELECT * FROM tenants WHERE tenant_code = ?',
    [tenantCode]
  );

  if (rows.length === 0) {
    throw new Error(`Tenant ${tenantCode} not found in master database`);
  }

  const tenant = rows[0];

  // Create tenant database if it doesn't exist
  const tempConfig = {
    host: dbHost,
    port: parseInt(dbPort, 10),
    user: process.env.MASTER_DB_USER || process.env.MYSQLUSER || process.env.MYSQL_USER || 'root',
    password: process.env.MASTER_DB_PASSWORD || process.env.MYSQLPASSWORD || process.env.MYSQL_PASSWORD || '',
    waitForConnections: true,
    connectionLimit: 2,
  };

  const tempPool = mysql.createPool(tempConfig);
  const tempConn = await tempPool.getConnection();

  try {
    await tempConn.query(`CREATE DATABASE IF NOT EXISTS ${tenant.database_name}`);
    console.log(`✅ Tenant database '${tenant.database_name}' ready`);

    // Create tenant database user if it doesn't exist (localhost only)
    try {
      await tempConn.query(`CREATE USER IF NOT EXISTS '${tenant.database_user}'@'localhost' IDENTIFIED BY '${tenant.database_password}'`);
      await tempConn.query(`GRANT ALL PRIVILEGES ON ${tenant.database_name}.* TO '${tenant.database_user}'@'localhost'`);
      await tempConn.query('FLUSH PRIVILEGES');
      console.log(`✅ Tenant database user '${tenant.database_user}' created`);
    } catch (userError) {
      // User creation might fail on Railway/cloud - that's OK, we use root
      console.log(`ℹ️  Tenant database user creation skipped (using root)`);
    }
  } finally {
    tempConn.release();
    await tempPool.end();
  }

  // Create tenant database tables using hardened pool
  const pool = await hardenedPool.getTenantPool(tenantCode);
  const conn = await pool.getConnection();
  try {
    await createTenantTables(conn, tenantCode);
    console.log(`✅ Tenant ${tenantCode} database tables created`);
  } finally {
    conn.release();
  }
}

/**
 * Create tenant database tables
 */
async function createTenantTables(connection, tenantCode) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id INT PRIMARY KEY AUTO_INCREMENT,
      username VARCHAR(50) UNIQUE NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NULL,
      full_name VARCHAR(100) NOT NULL,
      role ENUM('admin', 'expert', 'customer') NOT NULL,
      auth_method ENUM('password','magic_link','both') DEFAULT 'password',
      is_active BOOLEAN DEFAULT TRUE,
      last_login DATETIME,
      phone VARCHAR(50),
      department VARCHAR(100),
      location VARCHAR(100),
      street_address VARCHAR(255),
      city VARCHAR(100),
      state VARCHAR(100),
      postcode VARCHAR(20),
      country VARCHAR(100),
      timezone VARCHAR(50),
      language VARCHAR(50),
      email_notifications_enabled TINYINT(1) DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS experts (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL,
      skills JSON,
      department VARCHAR(100),
      manager_id INT,
      hire_date DATE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (manager_id) REFERENCES experts(id)
    )`,
    `CREATE TABLE IF NOT EXISTS customer_companies (
      id INT AUTO_INCREMENT PRIMARY KEY,
      company_name VARCHAR(100) NOT NULL,
      company_domain VARCHAR(100),
      contact_email VARCHAR(255),
      contact_phone VARCHAR(20),
      address TEXT,
      sla_level ENUM('basic', 'premium', 'enterprise') DEFAULT 'basic',
      sla_definition_id INT,
      notes TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_company_domain (company_domain),
      INDEX idx_is_active (is_active)
    )`,
    `CREATE TABLE IF NOT EXISTS customers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      customer_company_id INT,
      is_company_admin BOOLEAN DEFAULT FALSE,
      job_title VARCHAR(100),
      company_name VARCHAR(100),
      company_domain VARCHAR(100),
      contact_phone VARCHAR(20),
      address TEXT,
      sla_level ENUM('basic', 'premium', 'enterprise') DEFAULT 'basic',
      sla_override_id INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (customer_company_id) REFERENCES customer_companies(id) ON DELETE SET NULL,
      INDEX idx_customer_company_id (customer_company_id)
    )`,
    `CREATE TABLE IF NOT EXISTS cmdb_items (
      id INT PRIMARY KEY AUTO_INCREMENT,
      cmdb_id VARCHAR(50) UNIQUE NOT NULL,
      asset_name VARCHAR(255) NOT NULL,
      asset_category VARCHAR(100) NOT NULL,
      category_field_value VARCHAR(255),
      brand_name VARCHAR(100),
      model_name VARCHAR(100),
      customer_name VARCHAR(255),
      employee_of VARCHAR(255),
      asset_location VARCHAR(255),
      comment TEXT,
      status ENUM('active', 'inactive', 'maintenance') DEFAULT 'active',
      created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id),
      INDEX idx_customer_name (customer_name),
      INDEX idx_asset_category (asset_category)
    )`,
    `CREATE TABLE IF NOT EXISTS configuration_items (
      id INT PRIMARY KEY AUTO_INCREMENT,
      ci_id VARCHAR(50) UNIQUE NOT NULL,
      cmdb_item_id INT NOT NULL,
      ci_name VARCHAR(255) NOT NULL,
      asset_category VARCHAR(100),
      category_field_value VARCHAR(255),
      brand_name VARCHAR(100),
      model_name VARCHAR(100),
      serial_number VARCHAR(100),
      asset_location VARCHAR(255),
      employee_of VARCHAR(255),
      comment TEXT,
      status ENUM('active', 'inactive', 'maintenance') DEFAULT 'active',
      created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (cmdb_item_id) REFERENCES cmdb_items(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id),
      INDEX idx_cmdb_item (cmdb_item_id),
      INDEX idx_asset_category (asset_category)
    )`,
    `CREATE TABLE IF NOT EXISTS tickets (
      id INT PRIMARY KEY AUTO_INCREMENT,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      priority ENUM('low', 'medium', 'high', 'critical') DEFAULT 'medium',
      status ENUM('Open', 'In Progress', 'Pending', 'Resolved', 'Closed') DEFAULT 'Open',
      assignee_id INT,
      requester_id INT,
      cmdb_item_id INT,
      created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (assignee_id) REFERENCES users(id),
      FOREIGN KEY (requester_id) REFERENCES users(id),
      FOREIGN KEY (cmdb_item_id) REFERENCES cmdb_items(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS ticket_activity (
      id INT PRIMARY KEY AUTO_INCREMENT,
      ticket_id INT NOT NULL,
      user_id INT,
      activity_type VARCHAR(50) NOT NULL,
      description TEXT,
      source VARCHAR(20) NOT NULL DEFAULT 'web',
      actor_type VARCHAR(20) NOT NULL DEFAULT 'user',
      actor_id INT NULL,
      event_key VARCHAR(50) NOT NULL DEFAULT 'ticket.activity',
      meta JSON NULL,
      request_id VARCHAR(64) NULL,
      is_public BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ticket_id) REFERENCES tickets(id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      INDEX idx_ticket_activity_ticket_created (ticket_id, created_at),
      INDEX idx_ticket_activity_ticket_public_created (ticket_id, is_public, created_at),
      INDEX idx_ticket_activity_event_created (event_key, created_at),
      INDEX idx_ticket_activity_actor_created (actor_id, created_at)
    )`,
    `CREATE TABLE IF NOT EXISTS tenant_audit_log (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT,
      action VARCHAR(100) NOT NULL,
      details TEXT,
      ip_address VARCHAR(45),
      user_agent TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS tenant_settings (
      id INT PRIMARY KEY AUTO_INCREMENT,
      setting_key VARCHAR(100) UNIQUE NOT NULL,
      setting_value TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_setting_key (setting_key)
    )`,
    `CREATE TABLE IF NOT EXISTS tenant_user_roles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_user_id INT NOT NULL,
      role_key ENUM('admin','expert','customer') NOT NULL,
      granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      granted_by INT NULL,
      UNIQUE KEY unique_user_role (tenant_user_id, role_key),
      FOREIGN KEY (tenant_user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS tenant_user_company_memberships (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_user_id INT NOT NULL,
      company_id INT NOT NULL,
      membership_role ENUM('member','admin') DEFAULT 'member',
      joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_user_company (tenant_user_id, company_id),
      FOREIGN KEY (tenant_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (company_id) REFERENCES customer_companies(id) ON DELETE CASCADE
    )`,
  ];

  for (const sql of statements) {
    await connection.query(sql);
  }

  // Insert default tenant users if they don't exist
  const [existingUsers] = await connection.query('SELECT COUNT(*) as count FROM users');
  if (existingUsers[0].count === 0) {
    const bcrypt = require('bcrypt');
    const defaultPassword = process.env.DEFAULT_TENANT_PASSWORD || 'password123';
    const hashedPassword = await bcrypt.hash(defaultPassword, 10);

    await connection.query(
      'INSERT INTO users (username, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?)',
      ['admin', `admin@${tenantCode}.com`, hashedPassword, `${tenantCode} Administrator`, 'admin']
    );
    await connection.query(
      'INSERT INTO users (username, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?)',
      ['expert', `expert@${tenantCode}.com`, hashedPassword, `${tenantCode} Expert`, 'expert']
    );
    await connection.query(
      'INSERT INTO users (username, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?)',
      ['customer', `customer@${tenantCode}.com`, hashedPassword, `${tenantCode} Customer`, 'customer']
    );

    console.log(`👥 Default users created for tenant ${tenantCode}`);
  }
}

/**
 * Close all database connections
 * Delegates to hardened pool shutdown
 */
async function closeAllConnections() {
  await hardenedPool.shutdown();
}

/**
 * Get pool statistics for monitoring
 */
function getPoolStats() {
  return hardenedPool.getPoolStats();
}

/**
 * Health check for database connectivity
 */
async function healthCheck() {
  return hardenedPool.healthCheck();
}

// Export all functions
module.exports = {
  // Legacy connection methods (backward compatible)
  getMasterConnection,
  getTenantConnection,

  // New recommended query methods
  masterQuery,
  tenantQuery,
  tenantTransaction,
  getTenantPool,
  withTenantConnection,

  // Initialization
  initializeMasterDatabase,
  initializeTenantDatabase,

  // Lifecycle
  closeAllConnections,
  closeTenantPool: hardenedPool.closeTenantPool,
  getOpenTenantCodes: hardenedPool.getOpenTenantCodes,

  // Observability
  getPoolStats,
  healthCheck,

  // For advanced use cases
  getMasterPool: hardenedPool.getMasterPool,
  getTenantPool: hardenedPool.getTenantPool,
};
