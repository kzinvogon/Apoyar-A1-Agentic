/**
 * Migration: Add invitation columns to users table
 * Supports expert invitation workflow
 */

const { getTenantConnection } = require('../config/database');

async function runMigration(tenantCode) {
  const connection = await getTenantConnection(tenantCode);

  try {
    // Check if invitation_token column exists
    const [columns] = await connection.query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'invitation_token'
    `, [`a1_tenant_${tenantCode}`]);

    if (columns.length === 0) {
      console.log(`Adding invitation columns to users table for tenant ${tenantCode}...`);

      // Add invitation columns
      await connection.query(`
        ALTER TABLE users
        ADD COLUMN invitation_token VARCHAR(255) NULL,
        ADD COLUMN invitation_expires DATETIME NULL,
        ADD COLUMN invitation_sent_at DATETIME NULL,
        ADD COLUMN invitation_accepted_at DATETIME NULL
      `);

      // Add index for token lookup
      await connection.query(`
        ALTER TABLE users
        ADD INDEX idx_invitation_token (invitation_token)
      `);

      console.log(`✅ Invitation columns added successfully for tenant ${tenantCode}`);
    } else {
      console.log(`Invitation columns already exist for tenant ${tenantCode}`);
    }

    return { success: true };
  } catch (error) {
    // Handle case where some columns exist but not all
    if (error.code === 'ER_DUP_FIELDNAME') {
      console.log(`Some invitation columns already exist for tenant ${tenantCode}, skipping...`);
      return { success: true };
    }
    console.error(`Error adding invitation columns for tenant ${tenantCode}:`, error.message);
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = { runMigration };
