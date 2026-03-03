/**
 * Migration: Update configuration_items table to V2 schema
 * Adds V2 columns if missing and copies data from old V1 columns (key_name → ci_name, value → category_field_value).
 * Idempotent — safe to run multiple times.
 */

async function runMigration(tenantCode) {
  const { getTenantConnection } = require('../config/database');
  const connection = await getTenantConnection(tenantCode);

  try {
    // Check which columns exist
    const [columns] = await connection.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'configuration_items'`,
      [`a1_tenant_${tenantCode}`]
    );
    const colNames = columns.map(c => c.COLUMN_NAME);

    // Add V2 columns if missing
    const v2Columns = [
      { name: 'ci_id', def: 'VARCHAR(50) AFTER id' },
      { name: 'ci_name', def: 'VARCHAR(255) AFTER cmdb_item_id' },
      { name: 'asset_category', def: 'VARCHAR(100) AFTER ci_name' },
      { name: 'category_field_value', def: 'TEXT AFTER asset_category' },
      { name: 'brand_name', def: 'VARCHAR(150) AFTER category_field_value' },
      { name: 'model_name', def: 'VARCHAR(150) AFTER brand_name' },
      { name: 'serial_number', def: 'VARCHAR(150) AFTER model_name' },
      { name: 'asset_location', def: 'VARCHAR(255) AFTER serial_number' },
      { name: 'employee_of', def: 'VARCHAR(255) AFTER asset_location' },
      { name: 'comment', def: 'TEXT AFTER employee_of' },
      { name: 'status', def: "VARCHAR(50) DEFAULT 'active' AFTER comment" },
      { name: 'created_by', def: 'INT AFTER status' },
    ];

    for (const col of v2Columns) {
      if (!colNames.includes(col.name)) {
        await connection.query(`ALTER TABLE configuration_items ADD COLUMN ${col.name} ${col.def}`);
        console.log(`  + Added column ${col.name} to configuration_items for ${tenantCode}`);
      }
    }

    // Copy data from V1 columns to V2 if V1 columns exist
    if (colNames.includes('key_name') && colNames.includes('ci_name')) {
      await connection.query(
        `UPDATE configuration_items SET ci_name = key_name WHERE ci_name IS NULL AND key_name IS NOT NULL`
      );
    }
    if (colNames.includes('value') && colNames.includes('category_field_value')) {
      await connection.query(
        `UPDATE configuration_items SET category_field_value = value WHERE category_field_value IS NULL AND value IS NOT NULL`
      );
    }

    // Add indexes if missing
    try {
      await connection.query(`ALTER TABLE configuration_items ADD INDEX idx_ci_id (ci_id)`);
    } catch (e) { /* index may already exist */ }
    try {
      await connection.query(`ALTER TABLE configuration_items ADD INDEX idx_ci_status (status)`);
    } catch (e) { /* index may already exist */ }

    console.log(`✅ configuration_items V2 migration completed for tenant ${tenantCode}`);
    return true;
  } catch (error) {
    console.error(`❌ configuration_items V2 migration failed for ${tenantCode}:`, error.message);
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = { runMigration };
