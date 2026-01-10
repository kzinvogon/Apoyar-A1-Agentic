/**
 * Migration: Add resolve_after_response_minutes column to sla_definitions
 *
 * This column tracks resolution time starting from first response (pickup),
 * replacing the original resolve_target_minutes which was from ticket creation.
 */

async function runMigration(tenantCode) {
  const { getTenantConnection } = require('../config/database');
  let connection;

  try {
    connection = await getTenantConnection(tenantCode);

    // Check if column already exists
    const [columns] = await connection.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'sla_definitions' AND COLUMN_NAME = 'resolve_after_response_minutes'
    `, [`a1_tenant_${tenantCode}`]);

    if (columns.length > 0) {
      console.log(`  ℹ️  resolve_after_response_minutes column already exists for ${tenantCode}`);
      return true;
    }

    // Add the new column with DEFAULT 480 (8 hours)
    await connection.query(`
      ALTER TABLE sla_definitions
      ADD COLUMN resolve_after_response_minutes INT NOT NULL DEFAULT 480
      AFTER resolve_target_minutes
    `);
    console.log(`  ✓ Added resolve_after_response_minutes column`);

    // Migrate existing data: copy resolve_target_minutes to resolve_after_response_minutes
    await connection.query(`
      UPDATE sla_definitions
      SET resolve_after_response_minutes = resolve_target_minutes
      WHERE resolve_target_minutes IS NOT NULL
    `);
    console.log(`  ✓ Migrated existing resolve_target_minutes values`);

    return true;
  } catch (error) {
    console.error(`❌ Migration failed for tenant ${tenantCode}:`, error.message);
    throw error;
  } finally {
    if (connection) connection.release();
  }
}

module.exports = { runMigration };
