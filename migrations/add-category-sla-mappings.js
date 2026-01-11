/**
 * Migration: Add category_sla_mappings table
 *
 * Maps ticket category strings to SLA definitions.
 * Category matching is case-insensitive in application code.
 */

const { getTenantConnection } = require('../config/database');

async function runMigration(tenantCode) {
  let connection;

  try {
    connection = await getTenantConnection(tenantCode);

    // Create category_sla_mappings table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS category_sla_mappings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        category VARCHAR(50) NOT NULL,
        sla_definition_id INT NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_category (category),
        FOREIGN KEY (sla_definition_id) REFERENCES sla_definitions(id) ON DELETE RESTRICT
      )
    `);
    console.log(`✅ category_sla_mappings table created for tenant ${tenantCode}`);

  } catch (error) {
    if (error.code === 'ER_TABLE_EXISTS_ERROR') {
      console.log(`ℹ️  category_sla_mappings table already exists for tenant ${tenantCode}`);
    } else {
      console.error(`❌ Migration error for tenant ${tenantCode}:`, error.message);
      throw error;
    }
  } finally {
    if (connection) connection.release();
  }
}

module.exports = { runMigration };
