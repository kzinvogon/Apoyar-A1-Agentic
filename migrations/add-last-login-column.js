/**
 * Migration: Add last_login column to users table
 * This ensures the last_login column exists for tracking user login times
 */

const { getTenantConnection } = require('../config/database');

async function migrate(tenantCode) {
  const connection = await getTenantConnection(tenantCode);

  try {
    // Check if last_login column exists
    const [columns] = await connection.query(
      `SHOW COLUMNS FROM users LIKE 'last_login'`
    );

    if (columns.length === 0) {
      // Add the last_login column
      await connection.query(`
        ALTER TABLE users
        ADD COLUMN last_login DATETIME NULL AFTER updated_at
      `);
      console.log(`  ✓ Added last_login column to users table for tenant ${tenantCode}`);
    } else {
      console.log(`  ℹ️  last_login column already exists for tenant ${tenantCode}`);
    }

  } finally {
    connection.release();
  }
}

module.exports = { migrate };
