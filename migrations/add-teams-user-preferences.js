/**
 * Migration: Add teams_user_preferences table
 * Stores user preferences for Teams bot (e.g., expert/customer mode)
 */

async function runMigration(tenantCode) {
  const { getTenantConnection } = require('../config/database');

  const connection = await getTenantConnection(tenantCode);

  try {
    // Create teams_user_preferences table if it doesn't exist
    await connection.query(`
      CREATE TABLE IF NOT EXISTS teams_user_preferences (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        mode ENUM('expert', 'customer') DEFAULT 'expert',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_user (user_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    console.log(`✅ teams_user_preferences table created/verified for tenant ${tenantCode}`);

    // Check if teams_user_id column exists, add if missing
    const [columns] = await connection.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'teams_user_preferences' AND COLUMN_NAME = 'teams_user_id'
    `, [`a1_tenant_${tenantCode}`]);

    if (columns.length === 0) {
      console.log(`➕ Adding teams_user_id column for tenant ${tenantCode}...`);
      await connection.query(`
        ALTER TABLE teams_user_preferences
        ADD COLUMN teams_user_id VARCHAR(255) NULL AFTER user_id
      `);
      console.log(`✅ teams_user_id column added for tenant ${tenantCode}`);
    } else {
      console.log(`ℹ️  teams_user_id column already exists for tenant ${tenantCode}`);
    }

    // Check if index exists, add if missing
    const [indexes] = await connection.query(`
      SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'teams_user_preferences' AND INDEX_NAME = 'idx_teams_user_id'
    `, [`a1_tenant_${tenantCode}`]);

    if (indexes.length === 0) {
      console.log(`➕ Adding idx_teams_user_id index for tenant ${tenantCode}...`);
      await connection.query(`
        ALTER TABLE teams_user_preferences
        ADD INDEX idx_teams_user_id (teams_user_id)
      `);
      console.log(`✅ idx_teams_user_id index added for tenant ${tenantCode}`);
    } else {
      console.log(`ℹ️  idx_teams_user_id index already exists for tenant ${tenantCode}`);
    }

    return true;
  } catch (error) {
    console.error(`❌ Migration failed for tenant ${tenantCode}:`, error.message);
    throw error;
  }
}

module.exports = { runMigration };
