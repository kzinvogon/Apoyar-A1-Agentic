/**
 * Migration: Add SMS phone-tenant mapping table to master database
 * Maps Twilio phone numbers to ServiFlow tenant codes
 *
 * Run with: node migrations/add-sms-tenant-mapping.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

const config = {
  host: process.env.MYSQLHOST || process.env.DB_HOST,
  port: process.env.MYSQLPORT || process.env.DB_PORT || 3306,
  user: process.env.MYSQLUSER || process.env.DB_USER,
  password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD,
  database: process.env.MYSQLDATABASE || process.env.DB_NAME || 'a1_master'
};

async function runMigration() {
  console.log('Starting SMS phone-tenant mapping migration...');

  const connection = await mysql.createConnection(config);

  try {
    // Create sms_phone_tenant_mappings table in master database
    await connection.query(`
      CREATE TABLE IF NOT EXISTS sms_phone_tenant_mappings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        twilio_phone_number VARCHAR(20) NOT NULL,
        tenant_code VARCHAR(50) NOT NULL,
        twilio_account_sid VARCHAR(100),
        twilio_auth_token_encrypted TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_phone (twilio_phone_number),
        INDEX idx_tenant_code (tenant_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('Created sms_phone_tenant_mappings table');

    console.log('\nMigration completed successfully!');
    console.log('\nNext steps:');
    console.log('1. Add your Twilio phone mapping:');
    console.log('   INSERT INTO sms_phone_tenant_mappings (twilio_phone_number, tenant_code, twilio_account_sid)');
    console.log('   VALUES ("+14155551234", "your_tenant_code", "ACxxxxxxxx");');

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
