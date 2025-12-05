/**
 * Seed script for Railway deployment
 * Creates the apoyar tenant and default users
 *
 * Run with: node migrations/seed-railway-data.js
 *
 * Environment variables required:
 * - MYSQLHOST, MYSQLPORT, MYSQLUSER, MYSQLPASSWORD (Railway MySQL)
 */

const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');

async function seedData() {
  // Get connection config from environment
  const config = {
    host: process.env.MASTER_DB_HOST || process.env.MYSQLHOST || 'localhost',
    port: process.env.MASTER_DB_PORT || process.env.MYSQLPORT || 3306,
    user: process.env.MASTER_DB_USER || process.env.MYSQLUSER || 'root',
    password: process.env.MASTER_DB_PASSWORD || process.env.MYSQLPASSWORD || '',
    multipleStatements: true
  };

  console.log(`Connecting to MySQL at ${config.host}:${config.port}...`);

  const connection = await mysql.createConnection(config);

  try {
    // Create master database if not exists
    console.log('Creating a1_master database...');
    await connection.query('CREATE DATABASE IF NOT EXISTS a1_master');
    await connection.query('USE a1_master');

    // Create master tables
    console.log('Creating master tables...');
    await connection.query(`
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
      )
    `);

    await connection.query(`
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
        created_by INT
      )
    `);

    // Create default master admin if not exists
    const [existingAdmin] = await connection.query(
      "SELECT id FROM master_users WHERE username = 'admin'"
    );

    if (existingAdmin.length === 0) {
      const adminPassword = process.env.DEFAULT_MASTER_PASSWORD || 'CHANGE_ME_IMMEDIATELY';
      const hashedAdminPassword = await bcrypt.hash(adminPassword, 10);
      await connection.query(`
        INSERT INTO master_users (username, email, password_hash, full_name, role)
        VALUES ('admin', 'admin@a1master.com', ?, 'Master Administrator', 'super_admin')
      `, [hashedAdminPassword]);
      console.log('✅ Master admin created');
      console.log(`   Username: admin, Password: ${adminPassword}`);
    }

    // Check if tenant exists
    const [existingTenant] = await connection.query(
      "SELECT id FROM tenants WHERE tenant_code = 'apoyar'"
    );

    if (existingTenant.length > 0) {
      console.log('✅ Tenant "apoyar" already exists');
    } else {
      // Insert apoyar tenant
      const tenantPassword = process.env.DEFAULT_TENANT_PASSWORD || 'CHANGE_ME_IMMEDIATELY';

      console.log('Inserting apoyar tenant...');
      await connection.query(`
        INSERT INTO tenants (
          tenant_code, company_name, display_name,
          database_name, database_user, database_password,
          status, max_users, max_tickets, subscription_plan
        ) VALUES (
          'apoyar', 'Apoyar', 'Apoyar Support',
          'a1_tenant_apoyar', 'root', ?,
          'active', 100, 10000, 'enterprise'
        )
      `, [process.env.MYSQLPASSWORD || '']);

      console.log('✅ Tenant "apoyar" created');
    }

    // Create tenant database
    console.log('Creating a1_tenant_apoyar database...');
    await connection.query('CREATE DATABASE IF NOT EXISTS a1_tenant_apoyar');
    await connection.query('USE a1_tenant_apoyar');

    // Create users table if not exists
    console.log('Creating users table...');
    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT PRIMARY KEY AUTO_INCREMENT,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        full_name VARCHAR(100) NOT NULL,
        role ENUM('admin', 'expert', 'customer') NOT NULL,
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Check if users exist
    const [existingUsers] = await connection.query('SELECT COUNT(*) as count FROM users');

    if (existingUsers[0].count > 0) {
      console.log('✅ Users already exist');
    } else {
      // Create default users
      const defaultPassword = process.env.DEFAULT_TENANT_PASSWORD || 'CHANGE_ME_IMMEDIATELY';
      const hashedPassword = await bcrypt.hash(defaultPassword, 10);

      console.log('Creating default users...');
      await connection.query(`
        INSERT INTO users (username, email, password_hash, full_name, role) VALUES
        ('admin', 'admin@apoyar.com', ?, 'Apoyar Administrator', 'admin'),
        ('expert', 'expert@apoyar.com', ?, 'Apoyar Expert', 'expert'),
        ('customer', 'customer@apoyar.com', ?, 'Apoyar Customer', 'customer')
      `, [hashedPassword, hashedPassword, hashedPassword]);

      console.log('✅ Default users created');
      console.log(`   Username: admin, expert, customer`);
      console.log(`   Password: ${defaultPassword}`);
    }

    // Create other required tables
    console.log('Creating additional tables...');

    await connection.query(`
      CREATE TABLE IF NOT EXISTS tickets (
        id INT PRIMARY KEY AUTO_INCREMENT,
        ticket_number INT UNIQUE NOT NULL,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        priority ENUM('low', 'medium', 'high', 'critical') DEFAULT 'medium',
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
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS tenant_settings (
        id INT PRIMARY KEY AUTO_INCREMENT,
        setting_key VARCHAR(100) UNIQUE NOT NULL,
        setting_value TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_setting_key (setting_key)
      )
    `);

    console.log('✅ All tables created');
    console.log('\n🎉 Railway database seeded successfully!');
    console.log('\nYou can now log in with:');
    console.log('  Tenant: apoyar');
    console.log('  Username: admin');
    console.log(`  Password: ${process.env.DEFAULT_TENANT_PASSWORD || 'CHANGE_ME_IMMEDIATELY'}`);

  } catch (error) {
    console.error('❌ Error seeding data:', error.message);
    throw error;
  } finally {
    await connection.end();
  }
}

seedData().catch(err => {
  console.error(err);
  process.exit(1);
});
