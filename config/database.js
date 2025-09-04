const mysql = require('mysql2/promise');

// Master database configuration
const masterConfig = {
  host: process.env.MASTER_DB_HOST || 'localhost',
  port: process.env.MASTER_DB_PORT || 3306,
  user: process.env.MASTER_DB_USER || 'root',
  password: process.env.MASTER_DB_PASSWORD || '',
  database: process.env.MASTER_DB_NAME || 'a1_master',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

// Create master database connection pool
const masterPool = mysql.createPool(masterConfig);

// Store tenant database connections
const tenantPools = new Map();

// Get master database connection
async function getMasterConnection() {
  try {
    const connection = await masterPool.getConnection();
    return connection;
  } catch (error) {
    console.error('Error getting master database connection:', error);
    throw error;
  }
}

// Get tenant database connection
async function getTenantConnection(tenantCode) {
  try {
    // Check if we already have a connection pool for this tenant
    if (tenantPools.has(tenantCode)) {
      return await tenantPools.get(tenantCode).getConnection();
    }

    // Get tenant database configuration from master database
    const masterConn = await getMasterConnection();
    try {
      const [rows] = await masterConn.query(
        'SELECT database_name, database_user, database_password FROM tenants WHERE tenant_code = ? AND is_active = 1',
        [tenantCode]
      );

      if (rows.length === 0) {
        throw new Error(`Tenant ${tenantCode} not found or inactive`);
      }

      const tenant = rows[0];
      
      // Create tenant database connection pool
      const tenantConfig = {
        host: process.env.MASTER_DB_HOST || 'localhost',
        port: process.env.MASTER_DB_PORT || 3306,
        user: tenant.database_user,
        password: tenant.database_password,
        database: tenant.database_name,
        waitForConnections: true,
        connectionLimit: 5,
        queueLimit: 0
      };

      const tenantPool = mysql.createPool(tenantConfig);
      tenantPools.set(tenantCode, tenantPool);

      return await tenantPool.getConnection();
    } finally {
      masterConn.release();
    }
  } catch (error) {
    console.error(`Error getting tenant database connection for ${tenantCode}:`, error);
    throw error;
  }
}

// Initialize master database (create if not exists)
async function initializeMasterDatabase() {
  try {
    // Connect without specifying database first
    const tempConfig = { ...masterConfig };
    delete tempConfig.database;
    
    const tempPool = mysql.createPool(tempConfig);
    const connection = await tempPool.getConnection();
    
    try {
      // Create master database if it doesn't exist
      await connection.query(`CREATE DATABASE IF NOT EXISTS ${masterConfig.database}`);
      console.log(`✅ Master database '${masterConfig.database}' ready`);
      
      // Use the master database
      await connection.query(`USE ${masterConfig.database}`);
      
      // Check if tables exist, if not create them
      const [tables] = await connection.query('SHOW TABLES');
      if (tables.length === 0) {
        console.log('📋 Creating master database tables...');
        await createMasterTables(connection);
        console.log('✅ Master database tables created');
      } else {
        console.log('✅ Master database tables already exist');
        // Just ensure the default admin exists
        const [existingAdmin] = await connection.query('SELECT id FROM master_users WHERE username = ?', ['admin']);
        if (existingAdmin.length === 0) {
          const bcrypt = require('bcrypt');
          const hashedPassword = await bcrypt.hash('admin123', 10);
          await connection.query(
            'INSERT INTO master_users (username, password_hash, role, email, full_name) VALUES (?, ?, ?, ?, ?)',
            ['admin', hashedPassword, 'super_admin', 'admin@a1support.com', 'Master Administrator']
          );
          console.log('👑 Default master admin created (username: admin, password: admin123)');
        }
      }
      
    } finally {
      connection.release();
      tempPool.end();
    }
  } catch (error) {
    console.error('❌ Error initializing master database:', error);
    throw error;
  }
}

// Create master database tables
async function createMasterTables(connection) {
  const createTablesSQL = `
    CREATE TABLE IF NOT EXISTS master_users (
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
    );

    CREATE TABLE IF NOT EXISTS tenants (
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
      max_users INT DEFAULT 100,
      max_tickets INT DEFAULT 1000,
      subscription_plan ENUM('basic', 'professional', 'enterprise') DEFAULT 'basic',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      created_by INT,
      FOREIGN KEY (created_by) REFERENCES master_users(id)
    );

    CREATE TABLE IF NOT EXISTS tenant_admins (
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
    );

    CREATE TABLE IF NOT EXISTS master_audit_log (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT,
      user_type ENUM('master_user', 'tenant_admin') NOT NULL,
      action VARCHAR(100) NOT NULL,
      details TEXT,
      ip_address VARCHAR(45),
      user_agent TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES master_users(id)
    );
  `;

  const statements = createTablesSQL.split(';').filter(stmt => stmt.trim());
  for (const statement of statements) {
    if (statement.trim()) {
      await connection.query(statement);
    }
  }

  // Insert default master admin if not exists
  const [existingAdmin] = await connection.query('SELECT id FROM master_users WHERE username = ?', ['admin']);
  if (existingAdmin.length === 0) {
    const bcrypt = require('bcrypt');
    const hashedPassword = await bcrypt.hash('admin123', 10);
    await connection.query(
      'INSERT INTO master_users (username, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?)',
      ['admin', 'admin@a1master.com', hashedPassword, 'Master Administrator', 'super_admin']
    );
    console.log('👑 Default master admin created (username: admin, password: admin123)');
  }
}

// Initialize tenant database
async function initializeTenantDatabase(tenantCode) {
  try {
    const masterConn = await getMasterConnection();
    try {
      // Get tenant configuration
      const [rows] = await masterConn.query(
        'SELECT * FROM tenants WHERE tenant_code = ?',
        [tenantCode]
      );

      if (rows.length === 0) {
        throw new Error(`Tenant ${tenantCode} not found in master database`);
      }

      const tenant = rows[0];
      
      // Create tenant database if it doesn't exist
      const tempConfig = { ...masterConfig };
      delete tempConfig.database;
      
      const tempPool = mysql.createPool(tempConfig);
      const tempConn = await tempPool.getConnection();
      
      try {
        await tempConn.query(`CREATE DATABASE IF NOT EXISTS ${tenant.database_name}`);
        console.log(`✅ Tenant database '${tenant.database_name}' ready`);
        
        // Create tenant database user if it doesn't exist
        await tempConn.query(`CREATE USER IF NOT EXISTS '${tenant.database_user}'@'localhost' IDENTIFIED BY '${tenant.database_password}'`);
        await tempConn.query(`GRANT ALL PRIVILEGES ON ${tenant.database_name}.* TO '${tenant.database_user}'@'localhost'`);
        await tempConn.query('FLUSH PRIVILEGES');
        console.log(`✅ Tenant database user '${tenant.database_user}' created`);
        
      } finally {
        tempConn.release();
        tempPool.end();
      }

      // Create tenant database tables
      const tenantConn = await getTenantConnection(tenantCode);
      try {
        await createTenantTables(tenantConn, tenantCode);
        console.log(`✅ Tenant ${tenantCode} database tables created`);
      } finally {
        tenantConn.release();
      }
      
    } finally {
      masterConn.release();
    }
  } catch (error) {
    console.error(`❌ Error initializing tenant database for ${tenantCode}:`, error);
    throw error;
  }
}

// Create tenant database tables
async function createTenantTables(connection, tenantCode) {
  const createTablesSQL = `
    CREATE TABLE IF NOT EXISTS users (
      id INT PRIMARY KEY AUTO_INCREMENT,
      username VARCHAR(50) UNIQUE NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      full_name VARCHAR(100) NOT NULL,
      role ENUM('admin', 'expert', 'customer') NOT NULL,
      is_active BOOLEAN DEFAULT TRUE,
      last_login DATETIME,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS experts (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL,
      skills JSON,
      department VARCHAR(100),
      manager_id INT,
      hire_date DATE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (manager_id) REFERENCES experts(id)
    );

    CREATE TABLE IF NOT EXISTS customers (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL,
      company VARCHAR(100),
      phone VARCHAR(20),
      address TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS cmdb_items (
      id INT PRIMARY KEY AUTO_INCREMENT,
      cmdb_id VARCHAR(50) UNIQUE NOT NULL,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      category VARCHAR(100),
      status ENUM('active', 'inactive', 'maintenance') DEFAULT 'active',
      created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS configuration_items (
      id INT PRIMARY KEY AUTO_INCREMENT,
      ci_id VARCHAR(50) UNIQUE NOT NULL,
      cmdb_item_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      asset_category VARCHAR(100),
      asset_category_field_name VARCHAR(100),
      field_value TEXT,
      brand_name VARCHAR(100),
      comment TEXT,
      created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (cmdb_item_id) REFERENCES cmdb_items(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id INT PRIMARY KEY AUTO_INCREMENT,
      ticket_number INT UNIQUE NOT NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      priority ENUM('Low', 'Normal', 'High', 'Critical') DEFAULT 'Normal',
      status ENUM('Open', 'In Progress', 'Pending', 'Resolved', 'Closed') DEFAULT 'Open',
      assignee_id INT,
      customer_id INT NOT NULL,
      cmdb_item_id INT,
      ci_id INT,
      due_date DATE,
      sla_paused BOOLEAN DEFAULT FALSE,
      sla_paused_at DATETIME,
      sla_created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      sla_started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (assignee_id) REFERENCES users(id),
      FOREIGN KEY (customer_id) REFERENCES users(id),
      FOREIGN KEY (cmdb_item_id) REFERENCES cmdb_items(id),
      FOREIGN KEY (ci_id) REFERENCES configuration_items(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS ticket_activity (
      id INT PRIMARY KEY AUTO_INCREMENT,
      ticket_id INT NOT NULL,
      user_id INT,
      action VARCHAR(100) NOT NULL,
      details TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ticket_id) REFERENCES tickets(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS tenant_audit_log (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT,
      action VARCHAR(100) NOT NULL,
      details TEXT,
      ip_address VARCHAR(45),
      user_agent TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `;

  const statements = createTablesSQL.split(';').filter(stmt => stmt.trim());
  for (const statement of statements) {
    if (statement.trim()) {
      await connection.query(statement);
    }
  }

  // Insert default tenant users if they don't exist
  const [existingUsers] = await connection.query('SELECT COUNT(*) as count FROM users');
  if (existingUsers[0].count === 0) {
    const bcrypt = require('bcrypt');
    const hashedPassword = await bcrypt.hash('password123', 10);
    
    // Insert default admin user
    await connection.query(
      'INSERT INTO users (username, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?)',
      ['admin', `admin@${tenantCode}.com`, hashedPassword, `${tenantCode} Administrator`, 'admin']
    );
    
    // Insert default expert user
    await connection.query(
      'INSERT INTO users (username, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?)',
      ['expert', `expert@${tenantCode}.com`, hashedPassword, `${tenantCode} Expert`, 'expert']
    );
    
    // Insert default customer user
    await connection.query(
      'INSERT INTO users (username, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?)',
      ['customer', `customer@${tenantCode}.com`, hashedPassword, `${tenantCode} Customer`, 'customer']
    );
    
    console.log(`👥 Default users created for tenant ${tenantCode} (password: password123)`);
  }
}

// Close all database connections
async function closeAllConnections() {
  try {
    await masterPool.end();
    for (const [tenantCode, pool] of tenantPools) {
      await pool.end();
    }
    tenantPools.clear();
    console.log('✅ All database connections closed');
  } catch (error) {
    console.error('❌ Error closing database connections:', error);
  }
}

module.exports = {
  getMasterConnection,
  getTenantConnection,
  initializeMasterDatabase,
  initializeTenantDatabase,
  closeAllConnections,
  masterPool,
  tenantPools
};

