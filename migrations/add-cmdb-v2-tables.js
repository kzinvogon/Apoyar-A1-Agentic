/**
 * Migration: Add CMDB V2 Tables
 * - Custom Field Definitions
 * - Custom Field Values
 * - Relationships
 * - Change History (Audit Trail)
 */

async function runMigration(tenantCode) {
  const { getTenantConnection } = require('../config/database');
  const connection = await getTenantConnection(tenantCode);

  try {
    // 1. Create cmdb_custom_field_definitions table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS cmdb_custom_field_definitions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        asset_category VARCHAR(100) NOT NULL,
        field_name VARCHAR(100) NOT NULL,
        field_label VARCHAR(150) NOT NULL,
        field_type ENUM('text', 'number', 'date', 'dropdown', 'boolean', 'url') NOT NULL DEFAULT 'text',
        dropdown_options JSON,
        is_required BOOLEAN DEFAULT FALSE,
        display_order INT DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_category_field (asset_category, field_name),
        INDEX idx_asset_category (asset_category),
        INDEX idx_is_active (is_active)
      )
    `);
    console.log(`✅ cmdb_custom_field_definitions table created for tenant ${tenantCode}`);

    // 2. Create cmdb_custom_field_values table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS cmdb_custom_field_values (
        id INT AUTO_INCREMENT PRIMARY KEY,
        cmdb_item_id INT NOT NULL,
        field_definition_id INT NOT NULL,
        field_value TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_item_field (cmdb_item_id, field_definition_id),
        INDEX idx_cmdb_item_id (cmdb_item_id),
        INDEX idx_field_definition_id (field_definition_id),
        FOREIGN KEY (cmdb_item_id) REFERENCES cmdb_items(id) ON DELETE CASCADE,
        FOREIGN KEY (field_definition_id) REFERENCES cmdb_custom_field_definitions(id) ON DELETE CASCADE
      )
    `);
    console.log(`✅ cmdb_custom_field_values table created for tenant ${tenantCode}`);

    // 3. Create cmdb_relationships table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS cmdb_relationships (
        id INT AUTO_INCREMENT PRIMARY KEY,
        source_cmdb_id INT NOT NULL,
        target_cmdb_id INT NOT NULL,
        relationship_type ENUM('depends_on', 'hosts', 'connects_to', 'part_of', 'uses', 'provides', 'backs_up', 'monitors') NOT NULL,
        description TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_relationship (source_cmdb_id, target_cmdb_id, relationship_type),
        INDEX idx_source_cmdb_id (source_cmdb_id),
        INDEX idx_target_cmdb_id (target_cmdb_id),
        INDEX idx_relationship_type (relationship_type),
        INDEX idx_is_active (is_active),
        FOREIGN KEY (source_cmdb_id) REFERENCES cmdb_items(id) ON DELETE CASCADE,
        FOREIGN KEY (target_cmdb_id) REFERENCES cmdb_items(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    console.log(`✅ cmdb_relationships table created for tenant ${tenantCode}`);

    // 4. Create cmdb_change_history table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS cmdb_change_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        cmdb_item_id INT NOT NULL,
        change_type ENUM('created', 'updated', 'deleted', 'relationship_added', 'relationship_removed', 'custom_field_updated') NOT NULL,
        field_name VARCHAR(100),
        old_value TEXT,
        new_value TEXT,
        changed_by INT,
        changed_by_name VARCHAR(100),
        ip_address VARCHAR(45),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_cmdb_item_id (cmdb_item_id),
        INDEX idx_change_type (change_type),
        INDEX idx_changed_by (changed_by),
        INDEX idx_created_at (created_at),
        FOREIGN KEY (cmdb_item_id) REFERENCES cmdb_items(id) ON DELETE CASCADE,
        FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    console.log(`✅ cmdb_change_history table created for tenant ${tenantCode}`);

    return true;
  } catch (error) {
    if (error.code === 'ER_TABLE_EXISTS_ERROR') {
      console.log(`ℹ️  CMDB V2 tables already exist for tenant ${tenantCode}`);
      return true;
    }
    console.error(`❌ CMDB V2 migration failed for tenant ${tenantCode}:`, error.message);
    throw error;
  } finally {
    connection.release();
  }
}

// Run migration for all active tenants
async function runMigrationAllTenants() {
  const { getMasterConnection } = require('../config/database');
  const masterConn = await getMasterConnection();

  try {
    const [tenants] = await masterConn.query("SELECT tenant_code FROM tenants WHERE status = 'active'");
    console.log(`Found ${tenants.length} active tenants to migrate`);

    for (const tenant of tenants) {
      try {
        await runMigration(tenant.tenant_code);
        console.log(`✅ CMDB V2 migration completed for tenant: ${tenant.tenant_code}`);
      } catch (error) {
        console.error(`❌ CMDB V2 migration failed for tenant ${tenant.tenant_code}:`, error.message);
      }
    }

    console.log('✅ CMDB V2 migration completed for all tenants');
  } finally {
    masterConn.release();
  }
}

module.exports = { runMigration, runMigrationAllTenants };
