/**
 * CMDB Migration Module (inline version for server startup)
 * Migrates the cmdb_items table from old schema to new schema
 */

const { getTenantConnection } = require('../config/database');

async function runCMDBMigration(tenantCode) {
  const connection = await getTenantConnection(tenantCode);

  try {
    // Check current table structure
    const [columns] = await connection.query('DESCRIBE cmdb_items');
    const columnNames = columns.map(c => c.Field);

    // Check if already migrated (has new columns)
    if (columnNames.includes('cmdb_id') && columnNames.includes('asset_name')) {
      console.log('  CMDB table already has new schema');
      return;
    }

    // Check if has old schema
    if (columnNames.includes('name') && columnNames.includes('type')) {
      console.log('  Migrating CMDB table from old schema...');

      await connection.beginTransaction();

      try {
        // Rename old columns to new names
        await connection.query('ALTER TABLE cmdb_items CHANGE COLUMN name asset_name VARCHAR(255) NOT NULL');
        await connection.query('ALTER TABLE cmdb_items CHANGE COLUMN type asset_category VARCHAR(100) NOT NULL');
        await connection.query('ALTER TABLE cmdb_items CHANGE COLUMN owner_id created_by INT');
        await connection.query('ALTER TABLE cmdb_items CHANGE COLUMN description comment TEXT');

        // Add new columns
        await connection.query('ALTER TABLE cmdb_items ADD COLUMN cmdb_id VARCHAR(50) UNIQUE AFTER id');
        await connection.query('ALTER TABLE cmdb_items ADD COLUMN category_field_value VARCHAR(255) AFTER asset_category');
        await connection.query('ALTER TABLE cmdb_items ADD COLUMN brand_name VARCHAR(100) AFTER category_field_value');
        await connection.query('ALTER TABLE cmdb_items ADD COLUMN model_name VARCHAR(100) AFTER brand_name');
        await connection.query('ALTER TABLE cmdb_items ADD COLUMN customer_name VARCHAR(255) AFTER model_name');
        await connection.query('ALTER TABLE cmdb_items ADD COLUMN employee_of VARCHAR(255) AFTER customer_name');
        await connection.query('ALTER TABLE cmdb_items ADD COLUMN asset_location VARCHAR(255) AFTER employee_of');

        // Update status enum
        await connection.query("ALTER TABLE cmdb_items MODIFY COLUMN status ENUM('active', 'inactive', 'maintenance') DEFAULT 'active'");

        // Generate cmdb_id for existing rows
        const [rows] = await connection.query('SELECT id FROM cmdb_items WHERE cmdb_id IS NULL');
        for (const row of rows) {
          const cmdbId = `CMDB-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          await connection.query('UPDATE cmdb_items SET cmdb_id = ? WHERE id = ?', [cmdbId, row.id]);
        }

        // Drop old customer_id column if exists
        if (columnNames.includes('customer_id')) {
          await connection.query('ALTER TABLE cmdb_items DROP COLUMN customer_id');
        }

        // Add indexes (ignore errors if they exist)
        try { await connection.query('CREATE INDEX idx_customer_name ON cmdb_items(customer_name)'); } catch (e) {}
        try { await connection.query('CREATE INDEX idx_asset_category ON cmdb_items(asset_category)'); } catch (e) {}

        await connection.commit();
        console.log('  CMDB migration completed');

      } catch (error) {
        await connection.rollback();
        throw error;
      }
    }

    // Ensure configuration_items table exists
    const [tables] = await connection.query(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'configuration_items'"
    );

    if (tables.length === 0) {
      await connection.query(`
        CREATE TABLE configuration_items (
          id INT PRIMARY KEY AUTO_INCREMENT,
          ci_id VARCHAR(50) UNIQUE NOT NULL,
          cmdb_item_id INT NOT NULL,
          ci_name VARCHAR(255) NOT NULL,
          asset_category VARCHAR(100),
          category_field_value VARCHAR(255),
          brand_name VARCHAR(100),
          model_name VARCHAR(100),
          serial_number VARCHAR(100),
          asset_location VARCHAR(255),
          employee_of VARCHAR(255),
          comment TEXT,
          status ENUM('active', 'inactive', 'maintenance') DEFAULT 'active',
          created_by INT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (cmdb_item_id) REFERENCES cmdb_items(id) ON DELETE CASCADE,
          INDEX idx_cmdb_item (cmdb_item_id),
          INDEX idx_asset_category (asset_category)
        )
      `);
      console.log('  Created configuration_items table');
    }

  } finally {
    connection.release();
  }
}

module.exports = { runCMDBMigration };
