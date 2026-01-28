/**
 * Migration: Add SLA rule action types
 *
 * Adds new action_type ENUM values to ticket_processing_rules table:
 * - set_sla_deadlines: Set response_due_at and resolve_due_at directly
 * - set_sla_definition: Set sla_definition_id, sla_applied_at, sla_source
 *
 * Also ensures add_to_monitoring is present (was added in tenant-provisioning
 * but may be missing from early tenants).
 */

const { getMasterConnection, getTenantConnection } = require('../config/database');

async function migrate() {
  const masterConnection = await getMasterConnection();

  try {
    // Get all active tenants
    const [tenants] = await masterConnection.query(`
      SELECT tenant_code FROM tenants WHERE status = 'active'
    `);

    console.log(`Found ${tenants.length} active tenants to migrate`);

    for (const tenant of tenants) {
      const tenantCode = tenant.tenant_code;
      console.log(`[${tenantCode}] Updating ticket_processing_rules ENUM...`);

      let connection;
      try {
        connection = await getTenantConnection(tenantCode);

        // Check if table exists
        const [tables] = await connection.query(`
          SHOW TABLES LIKE 'ticket_processing_rules'
        `);

        if (tables.length === 0) {
          console.log(`[${tenantCode}] ticket_processing_rules table does not exist, skipping`);
          continue;
        }

        // Alter the ENUM to include new values
        // MySQL requires specifying all existing values plus new ones
        await connection.query(`
          ALTER TABLE ticket_processing_rules
          MODIFY COLUMN action_type ENUM(
            'delete',
            'create_for_customer',
            'assign_to_expert',
            'set_priority',
            'set_status',
            'add_tag',
            'add_to_monitoring',
            'set_sla_deadlines',
            'set_sla_definition'
          ) NOT NULL
        `);

        console.log(`[${tenantCode}] ENUM updated successfully`);

      } catch (error) {
        console.error(`[${tenantCode}] Error updating ENUM:`, error.message);
      } finally {
        if (connection) connection.release();
      }
    }

    console.log('Migration completed for all tenants');
    return { success: true };

  } catch (error) {
    console.error('Migration error:', error);
    throw error;
  } finally {
    masterConnection.release();
  }
}

// Run migration if called directly
if (require.main === module) {
  migrate()
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
