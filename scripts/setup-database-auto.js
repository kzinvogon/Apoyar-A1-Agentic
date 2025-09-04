#!/usr/bin/env node

const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

async function setupDatabase() {
  console.log('🚀 A1 Support Dashboard - Database Setup (Auto)');
  console.log('===============================================\n');

  try {
    // Use default connection details
    const host = 'localhost';
    const port = 3306;
    const user = 'root';
    const password = ''; // No password for fresh MySQL install

    console.log(`📊 Connecting to MySQL at ${host}:${port}...`);

    // Test connection
    const connection = await mysql.createConnection({
      host,
      port,
      user,
      password
    });

    console.log('✅ Connected to MySQL successfully');

    // Create master database
    console.log('\n🗄️  Creating master database...');
    await connection.query('CREATE DATABASE IF NOT EXISTS a1_master');
    console.log('✅ Master database created');

    // Use master database
    await connection.query('USE a1_master');

    // Create master tables
    console.log('\n📋 Creating master tables...');
    await createMasterTables(connection);
    console.log('✅ Master tables created');

    // Create sample tenant and admin
    console.log('\n👤 Creating sample tenant and admin...');
    await createSampleTenant(connection);
    console.log('✅ Sample tenant and admin created');

    // Create tenant database
    console.log('\n🏢 Creating tenant database...');
    await createTenantDatabase(connection, host, port, user, password);
    console.log('✅ Tenant database created');

    // Create .env file
    console.log('\n⚙️  Creating .env file...');
    await createEnvFile(host, port, user, password);
    console.log('✅ .env file created');

    await connection.end();
    console.log('\n🎉 Database setup completed successfully!');
    console.log('\n📋 Summary:');
    console.log('   • Master database: a1_master');
    console.log('   • Tenant database: a1_tenant_apoyar');
    console.log('   • Master admin: admin / admin123');
    console.log('   • Tenant users: admin / password123, expert / password123, customer / password123');
    console.log('   • Customer users: bleckmann / customer123, othercompany / customer123');
    console.log('\n🚀 You can now run: npm start');

  } catch (error) {
    console.error('❌ Database setup failed:', error.message);
    process.exit(1);
  }
}

async function createMasterTables(connection) {
  // Master users table
  await connection.query(`
    CREATE TABLE IF NOT EXISTS master_users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('super_admin', 'master_admin') NOT NULL DEFAULT 'master_admin',
      email VARCHAR(100),
      full_name VARCHAR(100),
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  // Tenants table
  await connection.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_code VARCHAR(50) UNIQUE NOT NULL,
      company_name VARCHAR(100) NOT NULL,
      display_name VARCHAR(100) NOT NULL,
      database_name VARCHAR(100) NOT NULL,
      database_user VARCHAR(50) NOT NULL,
      database_password VARCHAR(255) NOT NULL,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      created_by INT,
      FOREIGN KEY (created_by) REFERENCES master_users(id)
    )
  `);

  // Tenant admins table
  await connection.query(`
    CREATE TABLE IF NOT EXISTS tenant_admins (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      username VARCHAR(50) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      email VARCHAR(100),
      full_name VARCHAR(100),
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      UNIQUE KEY unique_tenant_username (tenant_id, username)
    )
  `);

  // Master audit log
  await connection.query(`
    CREATE TABLE IF NOT EXISTS master_audit_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT,
      action VARCHAR(100) NOT NULL,
      resource_type VARCHAR(50),
      resource_id INT,
      details JSON,
      ip_address VARCHAR(45),
      user_agent TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES master_users(id)
    )
  `);
}

async function createSampleTenant(connection) {
  // Create master admin
  const bcrypt = require('bcrypt');
  const adminPasswordHash = await bcrypt.hash('admin123', 10);
  
  await connection.query(`
    INSERT IGNORE INTO master_users (username, password_hash, role, email, full_name)
    VALUES ('admin', '${adminPasswordHash}', 'super_admin', 'admin@a1support.com', 'Master Administrator')
  `);

  // Insert only Apoyar tenant
  await connection.query(`
    INSERT IGNORE INTO tenants (
      tenant_code, company_name, display_name, database_name,
      database_user, database_password, created_by
    ) VALUES ('apoyar', 'Apoyar', 'Apoyar', 'a1_tenant_apoyar', 'apoyar_user', 'apoyar_pass_123', 1)
  `);

  // Create tenant admin for Apoyar
  const tenantAdminPasswordHash = await bcrypt.hash('password123', 10);
  await connection.query(`
    INSERT IGNORE INTO tenant_admins (tenant_id, username, password_hash, email, full_name)
    VALUES (1, 'admin', '${tenantAdminPasswordHash}', 'admin@apoyar.com', 'Apoyar Administrator')
  `);
}

async function createTenantDatabase(connection, host, port, user, password) {
  // Create only Apoyar tenant database
  await connection.query('CREATE DATABASE IF NOT EXISTS a1_tenant_apoyar');
  
  // Create tenant database user
  const dbUser = 'apoyar_user';
  const dbPass = 'apoyar_pass_123';
  
  try {
    await connection.query(`CREATE USER IF NOT EXISTS '${dbUser}'@'localhost' IDENTIFIED BY '${dbPass}'`);
    await connection.query(`GRANT ALL PRIVILEGES ON a1_tenant_apoyar.* TO '${dbUser}'@'localhost'`);
    await connection.query('FLUSH PRIVILEGES');
  } catch (error) {
    console.log('⚠️  Note: User creation might have failed, but database was created');
  }

  // Create tenant database tables
  await createTenantTables(host, port, dbUser, dbPass);
}

async function createTenantTables(host, port, dbUser, dbPass) {
  const tenantConnection = await mysql.createConnection({
    host,
    port,
    user: dbUser,
    password: dbPass,
    database: 'a1_tenant_apoyar'
  });

  // Users table
  await tenantConnection.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('admin', 'expert', 'customer') NOT NULL,
      email VARCHAR(100),
      full_name VARCHAR(100),
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  // Experts table
  await tenantConnection.execute(`
    CREATE TABLE IF NOT EXISTS experts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      skills TEXT,
      availability_status ENUM('available', 'busy', 'offline') DEFAULT 'available',
      max_concurrent_tickets INT DEFAULT 5,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Customers table
  await tenantConnection.execute(`
    CREATE TABLE IF NOT EXISTS customers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      company_name VARCHAR(100),
      contact_phone VARCHAR(20),
      address TEXT,
      sla_level ENUM('basic', 'premium', 'enterprise') DEFAULT 'basic',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // CMDB Items table
  await tenantConnection.execute(`
    CREATE TABLE IF NOT EXISTS cmdb_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      type ENUM('server', 'network', 'application', 'database', 'other') NOT NULL,
      status ENUM('active', 'inactive', 'maintenance', 'retired') DEFAULT 'active',
      owner_id INT,
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (owner_id) REFERENCES users(id)
    )
  `);

  // Configuration Items table
  await tenantConnection.execute(`
    CREATE TABLE IF NOT EXISTS configuration_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      cmdb_item_id INT NOT NULL,
      key_name VARCHAR(100) NOT NULL,
      value TEXT,
      data_type ENUM('string', 'number', 'boolean', 'json') DEFAULT 'string',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (cmdb_item_id) REFERENCES cmdb_items(id) ON DELETE CASCADE
    )
  `);

  // Tickets table
  await tenantConnection.execute(`
    CREATE TABLE IF NOT EXISTS tickets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      description TEXT,
      status ENUM('open', 'in_progress', 'resolved', 'closed') DEFAULT 'open',
      priority ENUM('low', 'medium', 'high', 'critical') DEFAULT 'medium',
      category VARCHAR(50),
      requester_id INT NOT NULL,
      assignee_id INT,
      cmdb_item_id INT,
      sla_deadline TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (requester_id) REFERENCES users(id),
      FOREIGN KEY (assignee_id) REFERENCES users(id),
      FOREIGN KEY (cmdb_item_id) REFERENCES cmdb_items(id)
    )
  `);

  // Ticket Activity table
  await tenantConnection.execute(`
    CREATE TABLE IF NOT EXISTS ticket_activity (
      id INT AUTO_INCREMENT PRIMARY KEY,
      ticket_id INT NOT NULL,
      user_id INT NOT NULL,
      activity_type ENUM('created', 'updated', 'assigned', 'resolved', 'closed', 'comment') NOT NULL,
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Tenant audit log
  await tenantConnection.execute(`
    CREATE TABLE IF NOT EXISTS tenant_audit_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT,
      action VARCHAR(100) NOT NULL,
      resource_type VARCHAR(50),
      resource_id INT,
      details JSON,
      ip_address VARCHAR(45),
      user_agent TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Insert default tenant users
  const bcrypt = require('bcrypt');
  const defaultPasswordHash = await bcrypt.hash('password123', 10);
  const customerPasswordHash = await bcrypt.hash('customer123', 10);

  const users = [
    ['admin', defaultPasswordHash, 'admin', 'admin@apoyar.com', 'Apoyar Admin'],
    ['expert', defaultPasswordHash, 'expert', 'expert@apoyar.com', 'Apoyar Expert'],
    ['customer', defaultPasswordHash, 'customer', 'customer@apoyar.com', 'Apoyar Customer']
  ];

  for (const [username, passwordHash, role, email, fullName] of users) {
    await tenantConnection.execute(`
      INSERT IGNORE INTO users (username, password_hash, role, email, full_name)
      VALUES (?, ?, ?, ?, ?)
    `, [username, passwordHash, role, email, fullName]);
  }

  // Insert sample customers (including Bleckmann)
  const customers = [
    ['bleckmann', 'Bleckmann Bleckmann', 'bleckmann@bleckmann.com', '+1234567890', 'Bleckmann Address'],
    ['othercompany', 'Other Company Ltd', 'contact@othercompany.com', '+0987654321', 'Other Company Address']
  ];

  for (const [username, fullName, email, phone, address] of customers) {
    // Create customer user
    await tenantConnection.execute(`
      INSERT IGNORE INTO users (username, password_hash, role, email, full_name)
      VALUES (?, ?, ?, ?, ?)
    `, [username, customerPasswordHash, 'customer', email, fullName]);

    // Get the user ID
    const [userResult] = await tenantConnection.execute(
      'SELECT id FROM users WHERE username = ?', [username]
    );

    if (userResult.length > 0) {
      const userId = userResult[0].id;
      
      // Create customer profile
      await tenantConnection.execute(`
        INSERT IGNORE INTO customers (user_id, company_name, contact_phone, address, sla_level)
        VALUES (?, ?, ?, ?, ?)
      `, [userId, fullName, phone, address, 'premium']);
    }
  }

  // Insert sample CMDB items for Bleckmann
  const [bleckmannUser] = await tenantConnection.execute(
    'SELECT id FROM users WHERE username = ?', ['bleckmann']
  );

  if (bleckmannUser.length > 0) {
    const bleckmannUserId = bleckmannUser[0].id;
    
    // Create CMDB item for Bleckmann
    await tenantConnection.execute(`
      INSERT IGNORE INTO cmdb_items (name, type, status, owner_id, description)
      VALUES (?, ?, ?, ?, ?)
    `, ['Bleckmann Production Server', 'server', 'active', bleckmannUserId, 'Main production server for Bleckmann operations']);

    // Get the CMDB item ID
    const [cmdbResult] = await tenantConnection.execute(
      'SELECT id FROM cmdb_items WHERE name = ?', ['Bleckmann Production Server']
    );

    if (cmdbResult.length > 0) {
      const cmdbItemId = cmdbResult[0].id;
      
      // Create configuration items
      const configItems = [
        ['server_name', 'bleckmann-prod-01', 'string'],
        ['ip_address', '192.168.1.100', 'string'],
        ['os_version', 'Ubuntu 20.04 LTS', 'string'],
        ['cpu_cores', '8', 'number'],
        ['memory_gb', '32', 'number'],
        ['disk_space_gb', '500', 'number']
      ];

      for (const [keyName, value, dataType] of configItems) {
        await tenantConnection.execute(`
          INSERT IGNORE INTO configuration_items (cmdb_item_id, key_name, value, data_type)
          VALUES (?, ?, ?, ?)
        `, [cmdbItemId, keyName, value, dataType]);
      }
    }
  }

  await tenantConnection.end();
}

async function createEnvFile(host, port, user, password) {
  const envContent = `# A1 Support Dashboard Configuration
PORT=3000
NODE_ENV=development

# JWT Configuration
JWT_SECRET=a1_support_dashboard_secret_key_2024
JWT_EXPIRES_IN=24h

# Master Database Configuration
MASTER_DB_HOST=${host}
MASTER_DB_PORT=${port}
MASTER_DB_USER=${user}
MASTER_DB_PASSWORD=${password}
MASTER_DB_NAME=a1_master

# Default tenant for development
DEFAULT_TENANT=apoyar
`;

  fs.writeFileSync('.env', envContent);
}

// Run the setup
setupDatabase().catch(console.error);
