/**
 * Migration: Add Teams tenant mapping table to master database
 * Maps Microsoft 365 tenant IDs to ServiFlow tenant codes
 *
 * Run with: node migrations/add-teams-tenant-mapping.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

const config = {
  host: process.env.MYSQLHOST || process.env.DB_HOST,
  port: process.env.MYSQLPORT || process.env.DB_PORT || 3306,
  user: process.env.MYSQLUSER || process.env.DB_USER,
  password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD,
  database: process.env.MYSQLDATABASE || process.env.DB_NAME || 'master_tenant'
};

async function runMigration() {
  console.log('Starting Teams tenant mapping migration...');

  const connection = await mysql.createConnection(config);

  try {
    // Create teams_tenant_mappings table in master database
    // Note: No foreign key to avoid collation issues - tenant_code validated at app level
    await connection.query(`
      CREATE TABLE IF NOT EXISTS teams_tenant_mappings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        teams_tenant_id VARCHAR(100) NOT NULL UNIQUE,
        teams_tenant_name VARCHAR(255),
        tenant_code VARCHAR(50) NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_teams_tenant_id (teams_tenant_id),
        INDEX idx_tenant_code (tenant_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅ Created teams_tenant_mappings table');

    // Create teams_email_domain_mappings for fallback email domain lookup
    await connection.query(`
      CREATE TABLE IF NOT EXISTS teams_email_domain_mappings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email_domain VARCHAR(255) NOT NULL UNIQUE,
        tenant_code VARCHAR(50) NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_email_domain (email_domain),
        INDEX idx_tenant_code (tenant_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅ Created teams_email_domain_mappings table');

    console.log('\n✅ Migration completed successfully!');
    console.log('\nNext steps:');
    console.log('1. Add your Teams tenant mapping:');
    console.log('   INSERT INTO teams_tenant_mappings (teams_tenant_id, teams_tenant_name, tenant_code)');
    console.log('   VALUES ("your-m365-tenant-id", "Your Company", "your_tenant_code");');
    console.log('\n2. Or add email domain mapping:');
    console.log('   INSERT INTO teams_email_domain_mappings (email_domain, tenant_code)');
    console.log('   VALUES ("yourcompany.com", "your_tenant_code");');

  } catch (error) {
    if (error.code === 'ER_TABLE_EXISTS_ERROR') {
      console.log('Tables already exist');
    } else {
      console.error('Migration failed:', error);
      process.exit(1);
    }
  } finally {
    await connection.end();
  }
}

runMigration();
