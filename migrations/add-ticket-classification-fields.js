/**
 * Migration: Add Ticket Classification Fields
 *
 * Adds AI-powered work type classification columns to the tickets table.
 * Classification runs automatically on ticket creation and can be overridden by humans.
 *
 * Work Types:
 * - request: Service request (new access, setup, etc.)
 * - incident: Something is broken or not working
 * - problem: Root cause investigation for recurring incidents
 * - change_request: Request to modify existing system/config
 * - operational_action: Scheduled maintenance, routine task
 * - question: General inquiry, how-to
 * - feedback: Complaint, compliment, suggestion
 * - unknown: Could not classify with confidence
 *
 * Execution Modes:
 * - automated: Can be handled by automation
 * - human_review: Needs human review before action
 * - expert_required: Needs specialist/expert handling
 * - escalation_required: Needs escalation to higher tier
 * - mixed: Multiple execution paths needed
 */

const { getTenantConnection, getMasterConnection } = require('../config/database');

const WORK_TYPES = [
  'request',
  'incident',
  'problem',
  'change_request',
  'operational_action',
  'question',
  'feedback',
  'unknown'
];

const EXECUTION_MODES = [
  'automated',
  'human_review',
  'expert_required',
  'escalation_required',
  'mixed'
];

async function runMigration(tenantCode) {
  console.log(`  Running ticket classification migration for ${tenantCode}...`);

  let connection;
  try {
    connection = await getTenantConnection(tenantCode);

    // Check if work_type column already exists
    const [columns] = await connection.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'tickets'
      AND COLUMN_NAME = 'work_type'
    `);

    if (columns.length > 0) {
      console.log(`    ✓ work_type column already exists for ${tenantCode}`);
      return;
    }

    // Add work_type column
    console.log(`    Adding work_type column...`);
    await connection.query(`
      ALTER TABLE tickets
      ADD COLUMN work_type VARCHAR(32) NULL
      COMMENT 'AI-classified work type: request, incident, problem, change_request, operational_action, question, feedback, unknown'
    `);

    // Add execution_mode column
    console.log(`    Adding execution_mode column...`);
    await connection.query(`
      ALTER TABLE tickets
      ADD COLUMN execution_mode VARCHAR(24) NULL
      COMMENT 'Execution mode: automated, human_review, expert_required, escalation_required, mixed'
    `);

    // Add system_tags column (JSON array)
    console.log(`    Adding system_tags column...`);
    await connection.query(`
      ALTER TABLE tickets
      ADD COLUMN system_tags JSON NULL
      COMMENT 'AI-generated tags for categorization, e.g. ["database", "urgent", "compliance"]'
    `);

    // Add classification_confidence column
    console.log(`    Adding classification_confidence column...`);
    await connection.query(`
      ALTER TABLE tickets
      ADD COLUMN classification_confidence DECIMAL(4,3) NULL
      COMMENT 'Confidence score 0.000 to 1.000'
    `);

    // Add classification_reason column
    console.log(`    Adding classification_reason column...`);
    await connection.query(`
      ALTER TABLE tickets
      ADD COLUMN classification_reason TEXT NULL
      COMMENT 'Brief explanation of why this classification was chosen'
    `);

    // Add classified_by column
    console.log(`    Adding classified_by column...`);
    await connection.query(`
      ALTER TABLE tickets
      ADD COLUMN classified_by VARCHAR(24) NULL
      COMMENT 'Who classified: ai or human'
    `);

    // Add classified_at column
    console.log(`    Adding classified_at column...`);
    await connection.query(`
      ALTER TABLE tickets
      ADD COLUMN classified_at TIMESTAMP NULL
      COMMENT 'When classification was applied'
    `);

    // Add index on work_type for efficient filtering
    console.log(`    Adding index on work_type...`);
    try {
      await connection.query(`
        CREATE INDEX idx_tickets_work_type ON tickets(work_type)
      `);
    } catch (e) {
      if (!e.message.includes('Duplicate')) throw e;
    }

    console.log(`    ✓ Ticket classification migration completed for ${tenantCode}`);

  } catch (error) {
    console.error(`    ✗ Migration error for ${tenantCode}:`, error.message);
    throw error;
  } finally {
    if (connection) connection.release();
  }
}

async function runMigrationAllTenants() {
  console.log('Running ticket classification migration for all tenants...');

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

    console.log('✅ Ticket classification migration completed for all tenants');

  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    if (masterConn) masterConn.release();
  }
}

module.exports = { runMigration, runMigrationAllTenants, WORK_TYPES, EXECUTION_MODES };

// Run if executed directly
if (require.main === module) {
  runMigrationAllTenants()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
