/**
 * Migration: Add email_notifications_enabled column to users table
 * This column controls whether email notifications are sent to the user
 */

const { getTenantConnection } = require('../config/database');

async function runMigration(tenantCode) {
  console.log(`  Running email notifications migration for ${tenantCode}...`);

  const connection = await getTenantConnection(tenantCode);

  try {
    // Check if column already exists
    const [columns] = await connection.query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'users'
      AND COLUMN_NAME = 'email_notifications_enabled'
    `);

    if (columns.length === 0) {
      // Add the column
      await connection.query(`
        ALTER TABLE users
        ADD COLUMN email_notifications_enabled TINYINT(1) DEFAULT 1
      `);
      console.log(`    ✓ Added email_notifications_enabled column to users table`);
    } else {
      console.log(`    ✓ email_notifications_enabled column already exists`);
    }

    console.log(`  ✓ Email notifications migration completed for ${tenantCode}`);
  } finally {
    connection.release();
  }
}

module.exports = { runMigration };
