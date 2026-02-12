#!/usr/bin/env node

const mysql = require('mysql2/promise');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function setupDatabase() {
  console.log('🚀 A1 Support Dashboard - Database Setup');
  console.log('==========================================\n');

  try {
    // Get database connection details
    const host = await question('MySQL Host (default: localhost): ') || 'localhost';
    const port = await question('MySQL Port (default: 3306): ') || '3306';
    const user = await question('MySQL Username (default: root): ') || 'root';
    const password = await question('MySQL Password: ');

    if (!password) {
      console.log('❌ Password is required');
      process.exit(1);
    }

    console.log('\n📊 Connecting to MySQL...');

    // Test connection
    const connection = await mysql.createConnection({
      host,
      port: parseInt(port),
      user,
      password
    });

    console.log('✅ Connected to MySQL successfully');

    // Create master database
    console.log('\n🗄️  Creating master database...');
    await connection.execute('CREATE DATABASE IF NOT EXISTS a1_master');
    console.log('✅ Master database created');

    // Use master database
    await connection.execute('USE a1_master');

    // Create master tables
    console.log('📋 Creating master database tables...');
    await createMasterTables(connection);
    console.log('✅ Master database tables created');

    // Create sample tenant (only Apoyar)
    console.log('\n🏢 Creating sample tenant (Apoyar)...');
    await createSampleTenant(connection);
    console.log('✅ Sample tenant created');

    // Create tenant database (only Apoyar)
    console.log('\n🏗️  Creating tenant database (Apoyar)...');
    await createTenantDatabase(connection, host, port, user, password);
    console.log('✅ Tenant database created');

    // Create .env file
    console.log('\n📝 Creating environment configuration...');
    await createEnvFile(host, port, user, password);
    console.log('✅ Environment file created');

    console.log('\n🎉 Database setup completed successfully!');
    console.log('\n📋 Summary:');
    console.log('   • Master database: a1_master');
    console.log('   • Tenant database: a1_tenant_apoyar (Apoyar company)');
    console.log('   • Customer: Bleckmann (within Apoyar tenant)');
    console.log('   • Default master admin: admin / admin123');
    console.log('   • Default tenant users: admin / password123, expert / password123, customer / password123');

    console.log('\n🚀 Next steps:');
    console.log('   1. Copy env.example to .env and update if needed');
    console.log('   2. Run: npm install');
    console.log('   3. Run: npm start');
    console.log('   4. Open: http://localhost:3000');

    await connection.end();
    rl.close();

  } catch (error) {
    console.error('\n❌ Database setup failed:', error.message);
    console.log('\n💡 Troubleshooting:');
    console.log('   • Ensure MySQL is running');
    console.log('   • Check your credentials');
    console.log('   • Ensure user has CREATE DATABASE privileges');
    process.exit(1);
  }
}

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
      await connection.execute(statement);
    }
  }
}

async function createSampleTenant(connection) {
  // Insert default master admin
  const bcrypt = require('bcrypt');
  const hashedPassword = await bcrypt.hash('admin123', 10);
  
  await connection.execute(
    'INSERT IGNORE INTO master_users (username, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?)',
    ['admin', 'admin@a1master.com', hashedPassword, 'Master Administrator', 'super_admin']
  );

  // Insert only Apoyar tenant
  await connection.execute(`
    INSERT IGNORE INTO tenants (
      tenant_code, company_name, display_name, database_name,
      database_user, database_password, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, 1)
  `, ['apoyar', 'Apoyar', 'Apoyar', 'a1_tenant_apoyar', 'apoyar_user', 'apoyar_pass_123']);

  // Create tenant admin
  const adminPassword = await bcrypt.hash('password123', 10);
  const tenantId = await getTenantId(connection, 'apoyar');
  
  await connection.execute(`
    INSERT IGNORE INTO tenant_admins (
      tenant_id, username, email, password_hash, full_name, role
    ) VALUES (?, ?, ?, ?, ?, ?)
  `, [tenantId, 'admin', 'admin@apoyar.com', adminPassword, 'Apoyar Administrator', 'tenant_admin']);
}

async function getTenantId(connection, tenantCode) {
  const [rows] = await connection.execute('SELECT id FROM tenants WHERE tenant_code = ?', [tenantCode]);
  return rows[0].id;
}

async function createTenantDatabase(connection, host, port, user, password) {
  // Create only Apoyar tenant database
  await connection.execute('CREATE DATABASE IF NOT EXISTS a1_tenant_apoyar');
  
  // Create tenant database user
  const dbUser = 'apoyar_user';
  const dbPass = 'apoyar_pass_123';
  
  try {
    await connection.execute(`CREATE USER IF NOT EXISTS '${dbUser}'@'localhost' IDENTIFIED BY '${dbPass}'`);
    await connection.execute(`GRANT ALL PRIVILEGES ON a1_tenant_apoyar.* TO '${dbUser}'@'localhost'`);
    await connection.execute('FLUSH PRIVILEGES');
  } catch (error) {
    console.warn(`⚠️  Warning: Could not create user for apoyar:`, error.message);
  }

  // Create tenant database tables
  await createTenantTables(host, port, dbUser, dbPass);
}

async function createTenantTables(host, port, dbUser, dbPass) {
  const tenantConnection = await mysql.createConnection({
    host,
    port: parseInt(port),
    user: dbUser,
    password: dbPass,
    database: 'a1_tenant_apoyar'
  });

  try {
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
        await tenantConnection.execute(statement);
      }
    }

    // Insert default tenant users
    const bcrypt = require('bcrypt');
    const hashedPassword = await bcrypt.hash('password123', 10);
    
    const defaultUsers = [
      ['admin', 'admin@apoyar.com', 'Apoyar Administrator', 'admin'],
      ['expert', 'expert@apoyar.com', 'Apoyar Expert', 'expert'],
      ['customer', 'customer@apoyar.com', 'Apoyar Customer', 'customer']
    ];

    for (const [username, email, fullName, role] of defaultUsers) {
      await tenantConnection.execute(`
        INSERT IGNORE INTO users (username, email, password_hash, full_name, role) 
        VALUES (?, ?, ?, ?, ?)
      `, [username, email, hashedPassword, fullName, role]);
    }

    // Insert sample customers (including Bleckmann)
    const customers = [
      ['bleckmann', 'Bleckmann Bleckmann', 'bleckmann@bleckmann.com', '+1234567890', 'Bleckmann Address'],
      ['othercompany', 'Other Company Ltd', 'contact@othercompany.com', '+0987654321', 'Other Company Address']
    ];

    for (const [company, companyName, email, phone, address] of customers) {
      // Create customer user
      const customerPassword = await bcrypt.hash('customer123', 10);
      const [userResult] = await tenantConnection.execute(`
        INSERT INTO users (username, email, password_hash, full_name, role) 
        VALUES (?, ?, ?, ?, ?)
      `, [company, email, customerPassword, companyName, 'customer']);

      // Create customer profile
      await tenantConnection.execute(`
        INSERT INTO customers (user_id, company, phone, address) 
        VALUES (?, ?, ?, ?)
      `, [userResult.insertId, companyName, phone, address]);
    }

    // Insert sample CMDB items for Bleckmann
    const [bleckmannUser] = await tenantConnection.execute(
      'SELECT id FROM users WHERE username = ?', ['bleckmann']
    );

    if (bleckmannUser.length > 0) {
      const bleckmannUserId = bleckmannUser[0].id;
      
      // Create CMDB item for Bleckmann
      const [cmdbResult] = await tenantConnection.execute(`
        INSERT INTO cmdb_items (cmdb_id, name, description, category, created_by) 
        VALUES (?, ?, ?, ?, ?)
      `, ['CMDB-351e1d81ca', 'Bleckmann API uat server', 'Bleckmann API server for UAT environment', 'Windows server', bleckmannUserId]);

      // Create configuration items
      await tenantConnection.execute(`
        INSERT INTO configuration_items (ci_id, cmdb_item_id, name, asset_category, asset_category_field_name, field_value, brand_name, comment) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, ['CI-8b4d8f2f44', cmdbResult.insertId, 'General', 'Windows server', 'External IP Address', '94.185.142.91', 'Bleckmann', 'Bleckmann API server configuration']);
    }

    console.log('👥 Default users and sample data created for Apoyar tenant');
    console.log('🏢 Sample customers created: Bleckmann, Other Company Ltd');
    console.log('🗃️  Sample CMDB items created for Bleckmann');

  } finally {
    await tenantConnection.end();
  }
}

async function createEnvFile(host, port, user, password) {
  const envContent = `# A1 Support Dashboard - Environment Configuration

# Server Configuration
PORT=3000
NODE_ENV=development

# JWT Configuration
JWT_SECRET=a1-support-secret-key-2024

# Master Database Configuration
MASTER_DB_HOST=${host}
MASTER_DB_PORT=${port}
MASTER_DB_USER=${user}
MASTER_DB_PASSWORD=${password}
MASTER_DB_NAME=a1_master

# Security (for production)
# CORS_ORIGIN=https://yourdomain.com
# RATE_LIMIT_WINDOW_MS=900000
# RATE_LIMIT_MAX_REQUESTS=100
`;

  fs.writeFileSync('.env', envContent);
}

// Run setup if this script is executed directly
if (require.main === module) {
  setupDatabase();
}

module.exports = { setupDatabase };
