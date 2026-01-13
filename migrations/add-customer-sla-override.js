/**
 * Migration: Add sla_override_id to customers table
 *
 * Allows per-user SLA override that takes precedence over company SLA.
 * Part of the SLA layering hierarchy:
 * 1. Ticket override
 * 2. User override (this field)
 * 3. Company default
 * 4. Category mapping
 * 5. CMDB item
 * 6. Tenant default
 */

const { getTenantConnection } = require('../config/database');

async function migrate(tenantCode) {
  const connection = await getTenantConnection(tenantCode);

  try {
    console.log(`[${tenantCode}] Adding sla_override_id to customers table...`);

    // Check if column already exists
    const [columns] = await connection.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'customers'
      AND COLUMN_NAME = 'sla_override_id'
    `);

    if (columns.length > 0) {
      console.log(`[${tenantCode}] sla_override_id column already exists, skipping...`);
      return { success: true, skipped: true };
    }

    // Add the sla_override_id column
    await connection.query(`
      ALTER TABLE customers
      ADD COLUMN sla_override_id INT NULL COMMENT 'Per-user SLA override, takes precedence over company SLA'
    `);

    // Add foreign key constraint (if sla_definitions table exists)
    try {
      await connection.query(`
        ALTER TABLE customers
        ADD CONSTRAINT fk_customers_sla_override
        FOREIGN KEY (sla_override_id) REFERENCES sla_definitions(id)
        ON DELETE SET NULL
      `);
      console.log(`[${tenantCode}] Added foreign key constraint`);
    } catch (fkError) {
      // FK might fail if sla_definitions doesn't exist yet - that's OK
      console.log(`[${tenantCode}] Note: Could not add FK constraint (sla_definitions may not exist)`);
    }

    // Add index for performance
    await connection.query(`
      ALTER TABLE customers
      ADD INDEX idx_customers_sla_override (sla_override_id)
    `);

    console.log(`[${tenantCode}] sla_override_id migration completed successfully`);
    return { success: true };

  } catch (error) {
    console.error(`[${tenantCode}] Error in sla_override_id migration:`, error);
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
