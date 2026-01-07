/**
 * Migration: Add soft delete columns to users table
 * Supports expert soft delete/restore functionality
 */

const { getTenantConnection } = require('../config/database');

async function runMigration(tenantCode) {
  const connection = await getTenantConnection(tenantCode);

  try {
    // Check if deleted_at column exists
    const [columns] = await connection.query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'deleted_at'
    `, [`a1_tenant_${tenantCode}`]);

    if (columns.length === 0) {
      console.log(`Adding soft delete columns to users table for tenant ${tenantCode}...`);

      // Add deleted_at and deleted_by columns
      await connection.query(`
        ALTER TABLE users
        ADD COLUMN deleted_at DATETIME NULL,
        ADD COLUMN deleted_by INT NULL
      `);

      // Add index for deleted_at for efficient queries
      await connection.query(`
        ALTER TABLE users
        ADD INDEX idx_deleted_at (deleted_at)
      `);

      console.log(`✅ Soft delete columns added successfully for tenant ${tenantCode}`);
    } else {
      console.log(`Soft delete columns already exist for tenant ${tenantCode}`);
    }

    return { success: true };
  } catch (error) {
    // Handle case where some columns exist but not all
    if (error.code === 'ER_DUP_FIELDNAME') {
      console.log(`Some soft delete columns already exist for tenant ${tenantCode}, skipping...`);
      return { success: true };
    }
    console.error(`Error adding soft delete columns for tenant ${tenantCode}:`, error.message);
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = { runMigration };
