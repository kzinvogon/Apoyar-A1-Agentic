/**
 * Migration: Add Slack user preferences table to tenant databases
 * Stores user mode preferences (Expert vs Customer) for Slack users
 *
 * Run with: node migrations/add-slack-user-preferences.js [tenantCode]
 * Example: node migrations/add-slack-user-preferences.js apoyar
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

async function runMigration(tenantCode = 'apoyar') {
  console.log(`Starting Slack user preferences migration for tenant: ${tenantCode}`);

  const config = {
    host: process.env.MYSQLHOST || process.env.DB_HOST,
    port: process.env.MYSQLPORT || process.env.DB_PORT || 3306,
    user: process.env.MYSQLUSER || process.env.DB_USER,
    password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD,
    database: `a1_tenant_${tenantCode}`
  };

  const connection = await mysql.createConnection(config);

  try {
    // Create slack_user_preferences table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS slack_user_preferences (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        slack_user_id VARCHAR(100),
        mode ENUM('expert', 'customer') DEFAULT 'customer',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_user (user_id),
        INDEX idx_slack_user_id (slack_user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅ Created slack_user_preferences table');

    console.log('\n✅ Migration completed successfully!');

  } catch (error) {
    if (error.code === 'ER_TABLE_EXISTS_ERROR') {
      console.log('Table already exists');
    } else {
      console.error('Migration failed:', error);
      process.exit(1);
    }
  } finally {
    await connection.end();
  }
}

// Get tenant code from command line args
const tenantCode = process.argv[2] || 'apoyar';
runMigration(tenantCode);
