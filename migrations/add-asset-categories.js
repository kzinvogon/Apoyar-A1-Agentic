const { getTenantConnection } = require('../config/database');

async function migrate(tenantCode) {
  const connection = await getTenantConnection(tenantCode);
  try {
    // Create asset_categories table if not exists
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS asset_categories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_name (name),
        INDEX idx_is_active (is_active)
      )
    `);

    // Populate from existing DISTINCT asset_category values in cmdb_items
    const [existing] = await connection.query('SELECT COUNT(*) as cnt FROM asset_categories');
    if (existing[0].cnt === 0) {
      // Check if cmdb_items table exists and has data
      try {
        const [categories] = await connection.query(
          'SELECT DISTINCT asset_category FROM cmdb_items WHERE asset_category IS NOT NULL AND asset_category != \'\' ORDER BY asset_category'
        );
        if (categories.length > 0) {
          const values = categories.map(c => [c.asset_category]);
          await connection.query(
            'INSERT IGNORE INTO asset_categories (name) VALUES ?',
            [values]
          );
          console.log(`  → Seeded ${categories.length} asset categories from existing CMDB items`);
        }
      } catch (err) {
        // cmdb_items table might not exist yet - that's fine
        if (!err.message.includes("doesn't exist")) throw err;
      }
    }

    console.log(`✅ Asset categories migration complete for ${tenantCode}`);
  } finally {
    connection.release();
  }
}

module.exports = { migrate };
