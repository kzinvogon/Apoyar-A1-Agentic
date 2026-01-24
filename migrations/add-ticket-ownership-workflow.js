/**
 * Migration: Add Ticket Ownership Workflow
 *
 * Adds pool_status and ownership tracking columns to support the
 * Expert ticket pool workflow with soft claim locks and explicit ownership.
 *
 * Key concepts:
 * - pool_status: OPEN_POOL | CLAIMED_LOCKED | IN_PROGRESS_OWNED | WAITING_CUSTOMER | ESCALATED | RESOLVED
 * - Claim is a SOFT LOCK only (30s) - does NOT start SLA
 * - Accept & Own creates ownership and starts SLA from ownership_started_at
 * - Viewing ≠ Owning
 */

const { getTenantConnection, getMasterConnection } = require('../config/database');

const POOL_STATUS_VALUES = [
  'OPEN_POOL',
  'CLAIMED_LOCKED',
  'IN_PROGRESS_OWNED',
  'WAITING_CUSTOMER',
  'ESCALATED',
  'RESOLVED'
];

async function runMigration(tenantCode) {
  console.log(`  Running ticket ownership workflow migration for ${tenantCode}...`);

  let connection;
  try {
    connection = await getTenantConnection(tenantCode);

    // Check if pool_status column already exists
    const [columns] = await connection.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'tickets'
      AND COLUMN_NAME = 'pool_status'
    `);

    if (columns.length > 0) {
      console.log(`    ✓ pool_status column already exists for ${tenantCode}`);
      return;
    }

    // Add pool_status column
    console.log(`    Adding pool_status column...`);
    await connection.query(`
      ALTER TABLE tickets
      ADD COLUMN pool_status VARCHAR(30) NOT NULL DEFAULT 'OPEN_POOL'
    `);

    // Add claimed_by_expert_id column
    console.log(`    Adding claimed_by_expert_id column...`);
    await connection.query(`
      ALTER TABLE tickets
      ADD COLUMN claimed_by_expert_id INT NULL
    `);

    // Add claimed_until_at column (soft lock expiry)
    console.log(`    Adding claimed_until_at column...`);
    await connection.query(`
      ALTER TABLE tickets
      ADD COLUMN claimed_until_at TIMESTAMP NULL
    `);

    // Add owned_by_expert_id column
    console.log(`    Adding owned_by_expert_id column...`);
    await connection.query(`
      ALTER TABLE tickets
      ADD COLUMN owned_by_expert_id INT NULL
    `);

    // Add ownership_started_at column (SLA starts here)
    console.log(`    Adding ownership_started_at column...`);
    await connection.query(`
      ALTER TABLE tickets
      ADD COLUMN ownership_started_at TIMESTAMP NULL
    `);

    // Add ownership_released_at column
    console.log(`    Adding ownership_released_at column...`);
    await connection.query(`
      ALTER TABLE tickets
      ADD COLUMN ownership_released_at TIMESTAMP NULL
    `);

    // Add waiting_since_at column
    console.log(`    Adding waiting_since_at column...`);
    await connection.query(`
      ALTER TABLE tickets
      ADD COLUMN waiting_since_at TIMESTAMP NULL
    `);

    // Add sla_paused_at column
    console.log(`    Adding sla_paused_at column...`);
    await connection.query(`
      ALTER TABLE tickets
      ADD COLUMN sla_paused_at TIMESTAMP NULL
    `);

    // Add sla_pause_total_seconds column
    console.log(`    Adding sla_pause_total_seconds column...`);
    await connection.query(`
      ALTER TABLE tickets
      ADD COLUMN sla_pause_total_seconds INT NOT NULL DEFAULT 0
    `);

    // Add pool_score column for AI ranking
    console.log(`    Adding pool_score column...`);
    await connection.query(`
      ALTER TABLE tickets
      ADD COLUMN pool_score DECIMAL(5,2) NULL
    `);

    // Add pool_score_updated_at column
    console.log(`    Adding pool_score_updated_at column...`);
    await connection.query(`
      ALTER TABLE tickets
      ADD COLUMN pool_score_updated_at TIMESTAMP NULL
    `);

    // Add indexes for efficient queries
    console.log(`    Adding indexes...`);

    // Index on pool_status for pool queries
    try {
      await connection.query(`
        CREATE INDEX idx_tickets_pool_status ON tickets(pool_status)
      `);
    } catch (e) {
      if (!e.message.includes('Duplicate')) throw e;
    }

    // Index on owned_by_expert_id for "My Tickets" queries
    try {
      await connection.query(`
        CREATE INDEX idx_tickets_owned_by ON tickets(owned_by_expert_id)
      `);
    } catch (e) {
      if (!e.message.includes('Duplicate')) throw e;
    }

    // Index on claimed_by_expert_id for claim checks
    try {
      await connection.query(`
        CREATE INDEX idx_tickets_claimed_by ON tickets(claimed_by_expert_id)
      `);
    } catch (e) {
      if (!e.message.includes('Duplicate')) throw e;
    }

    // Set existing tickets to appropriate pool_status based on current status
    console.log(`    Migrating existing tickets to pool_status...`);

    // Open tickets without assignee -> OPEN_POOL
    await connection.query(`
      UPDATE tickets
      SET pool_status = 'OPEN_POOL'
      WHERE status = 'Open' AND assignee_id IS NULL
    `);

    // Open tickets with assignee -> IN_PROGRESS_OWNED (migrate assignee to owner)
    await connection.query(`
      UPDATE tickets
      SET pool_status = 'IN_PROGRESS_OWNED',
          owned_by_expert_id = assignee_id,
          ownership_started_at = COALESCE(first_responded_at, updated_at, created_at)
      WHERE status IN ('Open', 'In Progress') AND assignee_id IS NOT NULL
    `);

    // Pending tickets -> WAITING_CUSTOMER
    await connection.query(`
      UPDATE tickets
      SET pool_status = 'WAITING_CUSTOMER',
          owned_by_expert_id = assignee_id,
          ownership_started_at = COALESCE(first_responded_at, updated_at, created_at),
          waiting_since_at = updated_at
      WHERE status = 'Pending' AND assignee_id IS NOT NULL
    `);

    // Resolved/Closed tickets -> RESOLVED
    await connection.query(`
      UPDATE tickets
      SET pool_status = 'RESOLVED',
          owned_by_expert_id = COALESCE(resolved_by, assignee_id),
          ownership_started_at = COALESCE(first_responded_at, created_at)
      WHERE status IN ('Resolved', 'Closed')
    `);

    console.log(`    ✓ Ticket ownership workflow migration completed for ${tenantCode}`);

  } catch (error) {
    console.error(`    ✗ Migration error for ${tenantCode}:`, error.message);
    throw error;
  } finally {
    if (connection) connection.release();
  }
}

async function runMigrationAllTenants() {
  console.log('Running ticket ownership workflow migration for all tenants...');

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

    console.log('✅ Ticket ownership workflow migration completed for all tenants');

  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    if (masterConn) masterConn.release();
  }
}

module.exports = { runMigration, runMigrationAllTenants, POOL_STATUS_VALUES };

// Run if executed directly
if (require.main === module) {
  runMigrationAllTenants()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
