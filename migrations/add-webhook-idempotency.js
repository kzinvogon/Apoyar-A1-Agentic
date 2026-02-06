/**
 * Migration: Add webhook idempotency and billing_email
 *
 * Creates:
 * - stripe_webhook_events table for idempotency
 * - billing_email column on tenants
 *
 * Run with: node migrations/add-webhook-idempotency.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

const config = {
  host: process.env.MYSQLHOST || process.env.MASTER_DB_HOST || process.env.DB_HOST,
  port: process.env.MYSQLPORT || process.env.MASTER_DB_PORT || process.env.DB_PORT || 3306,
  user: process.env.MYSQLUSER || process.env.MASTER_DB_USER || process.env.DB_USER,
  password: process.env.MYSQLPASSWORD || process.env.MASTER_DB_PASSWORD || process.env.DB_PASSWORD,
  database: process.env.MYSQLDATABASE || process.env.MASTER_DB_NAME || 'railway'
};

async function runMigration() {
  console.log('Adding webhook idempotency table and billing_email...');
  console.log(`Connecting to database: ${config.database}`);

  const connection = await mysql.createConnection(config);

  try {
    // 1. Create stripe_webhook_events table for idempotency
    console.log('\n1. Creating stripe_webhook_events table...');
    await connection.query(`
      CREATE TABLE IF NOT EXISTS stripe_webhook_events (
        id INT AUTO_INCREMENT PRIMARY KEY,
        event_id VARCHAR(255) UNIQUE NOT NULL,
        event_type VARCHAR(100) NOT NULL,
        processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        payload JSON,
        INDEX idx_event_id (event_id),
        INDEX idx_event_type (event_type),
        INDEX idx_processed_at (processed_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('  ✅ stripe_webhook_events table created');

    // 2. Add billing_email to tenants
    console.log('\n2. Adding billing_email column to tenants...');
    const [cols] = await connection.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tenants'
      AND COLUMN_NAME = 'billing_email'
    `, [config.database]);

    if (cols.length === 0) {
      await connection.query(`
        ALTER TABLE tenants
        ADD COLUMN billing_email VARCHAR(255) NULL
      `);
      console.log('  ✅ Added billing_email column');
    } else {
      console.log('  ℹ️  billing_email column already exists');
    }

    console.log('\n✅ Migration completed successfully!');

  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

runMigration();
