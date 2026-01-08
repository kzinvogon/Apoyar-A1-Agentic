/**
 * Migration: Add Teams integration tables
 * Run with: node migrations/add-teams-tables.js
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
  console.log('Starting Teams integration tables migration...');

  const connection = await mysql.createConnection(config);

  try {
    // Get all tenant databases
    const [tenants] = await connection.query(
      'SELECT tenant_code, database_name FROM tenants WHERE is_active = TRUE'
    );

    console.log(`Found ${tenants.length} active tenants`);

    for (const tenant of tenants) {
      console.log(`\nMigrating tenant: ${tenant.tenant_code} (${tenant.database_name})`);

      // Teams channel mappings table
      await connection.query(`
        CREATE TABLE IF NOT EXISTS ${tenant.database_name}.teams_channel_mappings (
          id INT AUTO_INCREMENT PRIMARY KEY,
          tenant_id VARCHAR(100) NOT NULL,
          teams_tenant_id VARCHAR(100) NOT NULL,
          teams_channel_id VARCHAR(255) NOT NULL,
          service_url VARCHAR(500) NOT NULL,
          channel_name VARCHAR(255),
          notification_types JSON DEFAULT '["created","assigned","resolved","status_changed","comment"]',
          priority_filter JSON DEFAULT '["low","medium","high","critical"]',
          is_active BOOLEAN DEFAULT TRUE,
          created_by INT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_tenant_id (tenant_id),
          INDEX idx_teams_tenant_id (teams_tenant_id),
          INDEX idx_is_active (is_active)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      console.log('  - Created teams_channel_mappings table');

      // Teams user mappings table
      await connection.query(`
        CREATE TABLE IF NOT EXISTS ${tenant.database_name}.teams_user_mappings (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          teams_user_id VARCHAR(100) NOT NULL,
          teams_tenant_id VARCHAR(100) NOT NULL,
          teams_user_email VARCHAR(255),
          is_verified BOOLEAN DEFAULT FALSE,
          linked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY unique_teams_user (teams_user_id, teams_tenant_id),
          INDEX idx_user_id (user_id),
          INDEX idx_teams_user_id (teams_user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      console.log('  - Created teams_user_mappings table');

      // Teams conversation references table
      await connection.query(`
        CREATE TABLE IF NOT EXISTS ${tenant.database_name}.teams_conversation_refs (
          id INT AUTO_INCREMENT PRIMARY KEY,
          teams_tenant_id VARCHAR(100) NOT NULL,
          teams_channel_id VARCHAR(255) NOT NULL,
          conversation_ref JSON NOT NULL,
          last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY unique_channel (teams_tenant_id, teams_channel_id),
          INDEX idx_teams_tenant_id (teams_tenant_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      console.log('  - Created teams_conversation_refs table');

      // Teams notification log table
      await connection.query(`
        CREATE TABLE IF NOT EXISTS ${tenant.database_name}.teams_notification_log (
          id INT AUTO_INCREMENT PRIMARY KEY,
          ticket_id INT NOT NULL,
          channel_mapping_id INT,
          notification_type VARCHAR(50) NOT NULL,
          message_id VARCHAR(255),
          status ENUM('pending','sent','failed') DEFAULT 'pending',
          error_message TEXT,
          sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_ticket_id (ticket_id),
          INDEX idx_status (status),
          INDEX idx_sent_at (sent_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      console.log('  - Created teams_notification_log table');

      console.log(`  Done migrating ${tenant.tenant_code}`);
    }

    // Add teams_enabled column to master tenants table if not exists
    try {
      await connection.query(`
        ALTER TABLE tenants
        ADD COLUMN teams_enabled BOOLEAN DEFAULT FALSE,
        ADD COLUMN teams_webhook_secret VARCHAR(255) NULL
      `);
      console.log('\nAdded teams_enabled and teams_webhook_secret columns to tenants table');
    } catch (error) {
      if (error.code === 'ER_DUP_FIELDNAME') {
        console.log('\nteams columns already exist in tenants table');
      } else {
        throw error;
      }
    }

    console.log('\n✅ Migration completed successfully!');

  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

runMigration();
