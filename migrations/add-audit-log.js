/**
 * Migration: Add audit_log table to master database
 * Run with: node migrations/add-audit-log.js
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
  console.log('Starting audit_log table migration...');

  const connection = await mysql.createConnection(config);

  try {
    // Create audit_log table in master database
    await connection.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_code VARCHAR(50) NOT NULL,
        user_id INT NULL,
        username VARCHAR(100) NULL,
        action VARCHAR(50) NOT NULL,
        entity_type VARCHAR(50) NOT NULL,
        entity_id VARCHAR(100) NULL,
        details_json JSON NULL,
        ip VARCHAR(64) NULL,
        user_agent VARCHAR(255) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_tenant_code (tenant_code),
        INDEX idx_user_id (user_id),
        INDEX idx_action (action),
        INDEX idx_entity_type (entity_type),
        INDEX idx_created_at (created_at)
      )
    `);

    console.log('✅ audit_log table created successfully');

  } catch (error) {
    if (error.code === 'ER_TABLE_EXISTS_ERROR') {
      console.log('ℹ️  audit_log table already exists');
    } else {
      console.error('❌ Migration failed:', error.message);
      throw error;
    }
  } finally {
    await connection.end();
  }
}

// Run if called directly
if (require.main === module) {
  runMigration()
    .then(() => {
      console.log('Migration complete');
      process.exit(0);
    })
    .catch(err => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}

module.exports = { runMigration };
