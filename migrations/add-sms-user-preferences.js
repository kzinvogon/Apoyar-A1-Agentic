/**
 * Migration: Add SMS user preferences and conversation state tables to tenant databases
 *
 * Run with: node migrations/add-sms-user-preferences.js
 *
 * By default runs against SERVIFLOW_TENANT_CODE (or 'apoyar').
 * Pass a tenant code as argument: node migrations/add-sms-user-preferences.js mytenant
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

const config = {
  host: process.env.MYSQLHOST || process.env.DB_HOST,
  port: process.env.MYSQLPORT || process.env.DB_PORT || 3306,
  user: process.env.MYSQLUSER || process.env.DB_USER,
  password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD
};

async function runMigration() {
  const tenantCode = process.argv[2] || process.env.SERVIFLOW_TENANT_CODE || 'apoyar';
  const databaseName = `a1_tenant_${tenantCode}`;

  console.log(`Starting SMS user preferences migration for ${databaseName}...`);

  const connection = await mysql.createConnection({ ...config, database: databaseName });

  try {
    // Create sms_user_preferences table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS sms_user_preferences (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        phone_number VARCHAR(20) NOT NULL,
        mode ENUM('expert', 'customer') DEFAULT 'customer',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_user (user_id),
        UNIQUE KEY unique_phone (phone_number),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('Created sms_user_preferences table');

    // Create sms_conversation_state table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS sms_conversation_state (
        id INT AUTO_INCREMENT PRIMARY KEY,
        phone_number VARCHAR(20) NOT NULL,
        state_key VARCHAR(50) NOT NULL,
        state_data JSON,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_phone_state (phone_number, state_key),
        INDEX idx_expires (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('Created sms_conversation_state table');

    console.log(`\nMigration completed successfully for ${databaseName}!`);

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
