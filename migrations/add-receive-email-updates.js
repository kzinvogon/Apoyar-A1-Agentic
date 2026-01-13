/**
 * Migration: Add receive_email_updates to users table
 *
 * User preference to opt-out of email notifications about ticket updates.
 * Default is ON (1) for normal users.
 * System/monitoring user (system@tenant.local) is set to OFF (0).
 */

const { getTenantConnection } = require('../config/database');

async function migrate(tenantCode) {
  const connection = await getTenantConnection(tenantCode);

  try {
    console.log(`[${tenantCode}] Adding receive_email_updates to users table...`);

    // Check if column already exists
    const [columns] = await connection.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'users'
      AND COLUMN_NAME = 'receive_email_updates'
    `);

    if (columns.length > 0) {
      console.log(`[${tenantCode}] receive_email_updates column already exists, skipping column creation...`);
    } else {
      // Add the receive_email_updates column with default ON
      await connection.query(`
        ALTER TABLE users
        ADD COLUMN receive_email_updates TINYINT(1) NOT NULL DEFAULT 1
        COMMENT 'User preference to receive email notifications about ticket updates'
      `);
      console.log(`[${tenantCode}] Added receive_email_updates column`);
    }

    // Backfill: Set receive_email_updates = 0 for system user
    const [result] = await connection.query(`
      UPDATE users
      SET receive_email_updates = 0
      WHERE email LIKE 'system@%'
         OR email LIKE 'noreply@%'
         OR username = 'system'
         OR username LIKE '%system%'
    `);

    if (result.affectedRows > 0) {
      console.log(`[${tenantCode}] Disabled email updates for ${result.affectedRows} system user(s)`);
    }

    console.log(`[${tenantCode}] receive_email_updates migration completed successfully`);
    return { success: true };

  } catch (error) {
    console.error(`[${tenantCode}] Error in receive_email_updates migration:`, error);
    throw error;
  } finally {
    connection.release();
  }
}

// Run migration if called directly
if (require.main === module) {
  const tenantCode = process.argv[2] || 'apoyar';
  migrate(tenantCode)
    .then(() => {
      console.log('Migration completed');
      process.exit(0);
    })
    .catch(err => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}

module.exports = { migrate };
