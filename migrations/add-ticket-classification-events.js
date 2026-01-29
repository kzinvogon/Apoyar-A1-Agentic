/**
 * Migration: Add Ticket Classification Events Table
 *
 * Creates a history table to track all classification changes (AI, rule, human).
 * This enables:
 * - Audit trail of classification decisions
 * - Learning loop feedback for improving AI
 * - Human correction tracking
 */

const { getTenantConnection, getMasterConnection } = require('../config/database');

async function runMigration(tenantCode) {
  console.log(`  Running classification events migration for ${tenantCode}...`);

  let connection;
  try {
    connection = await getTenantConnection(tenantCode);

    // Check if table already exists
    const [tables] = await connection.query(`
      SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'ticket_classification_events'
    `);

    if (tables.length > 0) {
      console.log(`    ✓ ticket_classification_events table already exists for ${tenantCode}`);
      return;
    }

    // Create classification events table
    console.log(`    Creating ticket_classification_events table...`);
    await connection.query(`
      CREATE TABLE ticket_classification_events (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ticket_id INT NOT NULL,
        previous_work_type VARCHAR(32) NULL,
        new_work_type VARCHAR(32) NULL,
        previous_execution_mode VARCHAR(24) NULL,
        new_execution_mode VARCHAR(24) NULL,
        previous_system_tags JSON NULL,
        new_system_tags JSON NULL,
        previous_confidence DECIMAL(4,3) NULL,
        new_confidence DECIMAL(4,3) NULL,
        classified_by VARCHAR(16) NOT NULL COMMENT 'human, ai, or rule',
        user_id INT NULL COMMENT 'User ID if classified_by=human',
        reason TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_classification_events_ticket (ticket_id),
        INDEX idx_classification_events_created (created_at),
        FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    console.log(`    ✓ Ticket classification events migration completed for ${tenantCode}`);

  } catch (error) {
    console.error(`    ✗ Migration error for ${tenantCode}:`, error.message);
    throw error;
  } finally {
    if (connection) connection.release();
  }
}

async function runMigrationAllTenants() {
  console.log('Running classification events migration for all tenants...');

  let masterConn;
  try {
    masterConn = await getMasterConnection();

    // Get all active tenants
    const [tenants] = await masterConn.query(
      "SELECT tenant_code FROM tenants WHERE status = 'active'"
    );

    console.log(`Found ${tenants.length} active tenant(s)`);

    for (const tenant of tenants) {
      await runMigration(tenant.tenant_code);
    }

    console.log('✅ Classification events migration completed for all tenants');

  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    if (masterConn) masterConn.release();
  }
}

module.exports = { runMigration, runMigrationAllTenants };

// Run if executed directly
if (require.main === module) {
  runMigrationAllTenants()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
