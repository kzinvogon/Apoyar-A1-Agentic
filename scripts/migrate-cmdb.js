/**
 * CMDB Migration Script
 * Migrates the cmdb_items table from old schema to new schema
 *
 * Old schema: id, name, type, status, owner_id, description, created_at, updated_at, customer_id
 * New schema: id, cmdb_id, asset_name, asset_category, category_field_value, brand_name, model_name,
 *             customer_name, employee_of, asset_location, comment, status, created_by, created_at, updated_at
 */

require('dotenv').config();
const { getTenantConnection } = require('../config/database');

async function migrateCMDB(tenantCode) {
  console.log(`\n🔄 Migrating CMDB for tenant: ${tenantCode}`);

  const connection = await getTenantConnection(tenantCode);

  try {
    // Check current table structure
    const [columns] = await connection.query('DESCRIBE cmdb_items');
    const columnNames = columns.map(c => c.Field);
    console.log('Current columns:', columnNames.join(', '));

    // Check if already migrated (has new columns)
    if (columnNames.includes('cmdb_id') && columnNames.includes('asset_name')) {
      console.log('✅ Table already has new schema');
      return;
    }

    // Check if has old schema
    if (columnNames.includes('name') && columnNames.includes('type')) {
      console.log('📋 Found old schema, migrating...');

      // Start transaction
      await connection.beginTransaction();

      try {
        // Rename old columns to new names
        console.log('  - Renaming name -> asset_name');
        await connection.query('ALTER TABLE cmdb_items CHANGE COLUMN name asset_name VARCHAR(255) NOT NULL');

        console.log('  - Renaming type -> asset_category');
        await connection.query('ALTER TABLE cmdb_items CHANGE COLUMN type asset_category VARCHAR(100) NOT NULL');

        console.log('  - Renaming owner_id -> created_by');
        await connection.query('ALTER TABLE cmdb_items CHANGE COLUMN owner_id created_by INT');

        console.log('  - Renaming description -> comment');
        await connection.query('ALTER TABLE cmdb_items CHANGE COLUMN description comment TEXT');

        // Add new columns
        console.log('  - Adding cmdb_id column');
        await connection.query('ALTER TABLE cmdb_items ADD COLUMN cmdb_id VARCHAR(50) UNIQUE AFTER id');

        console.log('  - Adding category_field_value column');
        await connection.query('ALTER TABLE cmdb_items ADD COLUMN category_field_value VARCHAR(255) AFTER asset_category');

        console.log('  - Adding brand_name column');
        await connection.query('ALTER TABLE cmdb_items ADD COLUMN brand_name VARCHAR(100) AFTER category_field_value');

        console.log('  - Adding model_name column');
        await connection.query('ALTER TABLE cmdb_items ADD COLUMN model_name VARCHAR(100) AFTER brand_name');

        console.log('  - Adding customer_name column');
        await connection.query('ALTER TABLE cmdb_items ADD COLUMN customer_name VARCHAR(255) AFTER model_name');

        console.log('  - Adding employee_of column');
        await connection.query('ALTER TABLE cmdb_items ADD COLUMN employee_of VARCHAR(255) AFTER customer_name');

        console.log('  - Adding asset_location column');
        await connection.query('ALTER TABLE cmdb_items ADD COLUMN asset_location VARCHAR(255) AFTER employee_of');

        // Update status enum if needed
        console.log('  - Updating status column');
        await connection.query("ALTER TABLE cmdb_items MODIFY COLUMN status ENUM('active', 'inactive', 'maintenance') DEFAULT 'active'");

        // Generate cmdb_id for existing rows
        console.log('  - Generating cmdb_id for existing rows');
        const [rows] = await connection.query('SELECT id FROM cmdb_items WHERE cmdb_id IS NULL');
        for (const row of rows) {
          const cmdbId = `CMDB-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          await connection.query('UPDATE cmdb_items SET cmdb_id = ? WHERE id = ?', [cmdbId, row.id]);
        }

        // Drop old customer_id column if exists
        if (columnNames.includes('customer_id')) {
          console.log('  - Dropping old customer_id column');
          await connection.query('ALTER TABLE cmdb_items DROP COLUMN customer_id');
        }

        // Add indexes
        console.log('  - Adding indexes');
        try {
          await connection.query('CREATE INDEX idx_customer_name ON cmdb_items(customer_name)');
        } catch (e) { /* Index may already exist */ }
        try {
          await connection.query('CREATE INDEX idx_asset_category ON cmdb_items(asset_category)');
        } catch (e) { /* Index may already exist */ }

        await connection.commit();
        console.log('✅ Migration completed successfully');

      } catch (error) {
        await connection.rollback();
        throw error;
      }
    } else {
      console.log('⚠️ Unknown schema, cannot migrate automatically');
      console.log('Current columns:', columnNames);
    }

  } finally {
    connection.release();
  }
}

// Also ensure configuration_items table exists
async function ensureConfigurationItemsTable(tenantCode) {
  console.log(`\n🔄 Ensuring configuration_items table for tenant: ${tenantCode}`);

  const connection = await getTenantConnection(tenantCode);

  try {
    // Check if table exists
    const [tables] = await connection.query(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'configuration_items'"
    );

    if (tables.length === 0) {
      console.log('  - Creating configuration_items table');
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
      console.log('✅ configuration_items table created');
    } else {
      console.log('✅ configuration_items table already exists');
    }

  } finally {
    connection.release();
  }
}

async function main() {
  const tenantCode = process.argv[2] || 'apoyar';

  console.log('🚀 CMDB Migration Script');
  console.log('========================');

  try {
    await migrateCMDB(tenantCode);
    await ensureConfigurationItemsTable(tenantCode);
    console.log('\n✨ All migrations completed');
  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    process.exit(1);
  }

  process.exit(0);
}

main();
