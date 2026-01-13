/**
 * Migration: Add tenant_settings table
 *
 * Creates a key-value settings table for tenant-level configuration.
 * Used for feature flags like customer_billing_enabled and enhanced_sla_billing_mode.
 */

const { getTenantConnection } = require('../config/database');

async function migrate(tenantCode) {
  const connection = await getTenantConnection(tenantCode);

  try {
    console.log(`[${tenantCode}] Creating tenant_settings table...`);

    // Create the tenant_settings table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS tenant_settings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        setting_key VARCHAR(100) NOT NULL UNIQUE,
        setting_value TEXT,
        setting_type ENUM('boolean', 'string', 'number', 'json') DEFAULT 'string',
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_setting_key (setting_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    console.log(`[${tenantCode}] Inserting default settings...`);

    // Insert default settings (ignore if already exists)
    const defaultSettings = [
      {
        key: 'customer_billing_enabled',
        value: 'false',
        type: 'boolean',
        description: 'Show Billing and Plans & Upgrades in customer portal'
      },
      {
        key: 'enhanced_sla_billing_mode',
        value: 'none',
        type: 'string',
        description: 'SLA uplift tracking mode: none, report_only, or chargeback'
      }
    ];

    for (const setting of defaultSettings) {
      await connection.query(`
        INSERT IGNORE INTO tenant_settings (setting_key, setting_value, setting_type, description)
        VALUES (?, ?, ?, ?)
      `, [setting.key, setting.value, setting.type, setting.description]);
    }

    console.log(`[${tenantCode}] tenant_settings migration completed successfully`);
    return { success: true };

  } catch (error) {
    console.error(`[${tenantCode}] Error in tenant_settings migration:`, error);
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
