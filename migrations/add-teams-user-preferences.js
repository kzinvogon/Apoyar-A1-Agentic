/**
 * Migration: Add teams_user_preferences table
 * Stores user preferences for Teams bot (e.g., expert/customer mode)
 */

async function runMigration(tenantCode) {
  const { getTenantConnection } = require('../config/database');

  const connection = await getTenantConnection(tenantCode);

  try {
    // Create teams_user_preferences table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS teams_user_preferences (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        teams_user_id VARCHAR(255),
        mode ENUM('expert', 'customer') DEFAULT 'expert',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_user (user_id),
        INDEX idx_teams_user_id (teams_user_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    console.log(`✅ teams_user_preferences table created for tenant ${tenantCode}`);
    return true;
  } catch (error) {
    if (error.code === 'ER_TABLE_EXISTS_ERROR') {
      console.log(`ℹ️  teams_user_preferences table already exists for tenant ${tenantCode}`);
      return true;
    }
    console.error(`❌ Migration failed for tenant ${tenantCode}:`, error.message);
    throw error;
  }
}

module.exports = { runMigration };
