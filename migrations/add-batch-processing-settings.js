/**
 * Migration: Add batch processing settings
 *
 * Adds batch_delay_seconds and batch_size settings to existing tenants.
 * These control how SLA notifier and ticket rules process tickets.
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
      console.log(`[${tenantCode}] Adding batch processing settings...`);

      let connection;
      try {
        connection = await getTenantConnection(tenantCode);

        // Ensure description column exists
        const [descCols] = await connection.query(`SHOW COLUMNS FROM tenant_settings LIKE 'description'`);
        if (descCols.length === 0) {
          console.log(`[${tenantCode}] Adding description column to tenant_settings...`);
          await connection.query(`
            ALTER TABLE tenant_settings
            ADD COLUMN description TEXT AFTER setting_type
          `);
        }

        // Insert batch processing settings (ignore if already exists)
        const batchSettings = [
          {
            key: 'batch_delay_seconds',
            value: '2',
            type: 'number',
            description: 'Delay in seconds between batch processing operations (minimum 3)'
          },
          {
            key: 'batch_size',
            value: '5',
            type: 'number',
            description: 'Maximum number of items to process per batch (maximum 10)'
          },
          {
            key: 'sla_check_interval_seconds',
            value: '300',
            type: 'number',
            description: 'How often to check for SLA breaches in seconds (minimum 60)'
          }
        ];

        for (const setting of batchSettings) {
          await connection.query(`
            INSERT IGNORE INTO tenant_settings (setting_key, setting_value, setting_type, description)
            VALUES (?, ?, ?, ?)
          `, [setting.key, setting.value, setting.type, setting.description]);
        }

        console.log(`[${tenantCode}] Batch processing settings added`);

      } catch (error) {
        console.error(`[${tenantCode}] Error adding settings:`, error.message);
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
