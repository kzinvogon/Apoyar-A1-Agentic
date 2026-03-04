/**
 * Migration: Add missing columns to ticket_processing_rules
 *
 * Adds columns that exist in tenant-provisioning.js but were missing
 * from the original add-ticket-rules.sql migration:
 * - instruction_text TEXT DEFAULT NULL
 * - ai_interpreted TINYINT(1) DEFAULT 0
 * - ai_confidence FLOAT DEFAULT NULL
 * - search_text modified to DEFAULT NULL (was NOT NULL)
 *
 * Idempotent: checks for column existence before adding.
 */

const { getTenantConnection } = require('../config/database');

async function hasColumn(connection, table, column) {
  const [rows] = await connection.query(
    `SHOW COLUMNS FROM ${table} LIKE ?`,
    [column]
  );
  return rows.length > 0;
}

async function migrate(tenantCode) {
  let connection;
  try {
    connection = await getTenantConnection(tenantCode);

    // Check if table exists
    const [tables] = await connection.query(
      `SHOW TABLES LIKE 'ticket_processing_rules'`
    );
    if (tables.length === 0) {
      console.log(`[${tenantCode}] ticket_processing_rules does not exist, skipping`);
      return;
    }

    // Add instruction_text if missing
    if (!(await hasColumn(connection, 'ticket_processing_rules', 'instruction_text'))) {
      await connection.query(`
        ALTER TABLE ticket_processing_rules
        ADD COLUMN instruction_text TEXT DEFAULT NULL AFTER description
      `);
      console.log(`[${tenantCode}] Added instruction_text column`);
    }

    // Add ai_interpreted if missing
    if (!(await hasColumn(connection, 'ticket_processing_rules', 'ai_interpreted'))) {
      await connection.query(`
        ALTER TABLE ticket_processing_rules
        ADD COLUMN ai_interpreted TINYINT(1) DEFAULT 0 AFTER action_params
      `);
      console.log(`[${tenantCode}] Added ai_interpreted column`);
    }

    // Add ai_confidence if missing
    if (!(await hasColumn(connection, 'ticket_processing_rules', 'ai_confidence'))) {
      await connection.query(`
        ALTER TABLE ticket_processing_rules
        ADD COLUMN ai_confidence FLOAT DEFAULT NULL AFTER ai_interpreted
      `);
      console.log(`[${tenantCode}] Added ai_confidence column`);
    }

    // Make search_text nullable (it was NOT NULL in the original migration)
    await connection.query(`
      ALTER TABLE ticket_processing_rules
      MODIFY COLUMN search_text VARCHAR(500) DEFAULT NULL
    `);

    // Add source_filter if missing
    if (!(await hasColumn(connection, 'ticket_processing_rules', 'source_filter'))) {
      await connection.query(`
        ALTER TABLE ticket_processing_rules
        ADD COLUMN source_filter ENUM('all', 'monitoring', 'customer') DEFAULT 'all' AFTER case_sensitive
      `);
      console.log(`[${tenantCode}] Added source_filter column`);
    }

    // Ensure action_type ENUM includes all values (idempotent)
    await connection.query(`
      ALTER TABLE ticket_processing_rules
      MODIFY COLUMN action_type ENUM(
        'delete', 'create_for_customer', 'assign_to_expert',
        'set_priority', 'set_status', 'add_tag', 'add_to_monitoring',
        'set_sla_deadlines', 'set_sla_definition', 'close_ticket'
      ) NOT NULL
    `);

    console.log(`[${tenantCode}] ticket_processing_rules columns migration complete`);

  } catch (error) {
    console.error(`[${tenantCode}] ticket_processing_rules columns migration error:`, error.message);
    throw error;
  } finally {
    if (connection) connection.release();
  }
}

module.exports = { migrate };
