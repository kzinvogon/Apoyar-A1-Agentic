/**
 * Migration: Add must_reset_password column to users table
 *
 * This column is used to force password reset on first login
 * for accounts created via email (e.g., "Please Add Me" requests)
 */

const { getTenantConnection } = require('../config/database');

async function runMigration(tenantCode) {
  const connection = await getTenantConnection(tenantCode);

  try {
    console.log(`Running must_reset_password migration for tenant: ${tenantCode}`);

    // Check if column already exists
    const [columns] = await connection.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'must_reset_password'`
    );

    if (columns.length === 0) {
      // Add the column
      await connection.query(
        `ALTER TABLE users ADD COLUMN must_reset_password TINYINT(1) DEFAULT 0 AFTER is_active`
      );
      console.log('✅ Added must_reset_password column to users table');
    } else {
      console.log('ℹ️  must_reset_password column already exists');
    }

    return { success: true };
  } catch (error) {
    console.error('Migration error:', error);
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = { runMigration };
