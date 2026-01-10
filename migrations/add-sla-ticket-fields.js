/**
 * Migration: Add SLA tracking fields to tickets table
 *
 * Fields added:
 * - sla_definition_id: FK to sla_definitions
 * - sla_applied_at: when SLA was applied to ticket
 * - response_due_at: deadline for first response
 * - resolve_due_at: deadline for resolution (computed from first_responded_at)
 * - first_responded_at: when ticket was first responded to (moved away from 'Open')
 */

async function runMigration(tenantCode) {
  const { getTenantConnection } = require('../config/database');
  let connection;

  try {
    connection = await getTenantConnection(tenantCode);
    const dbName = `a1_tenant_${tenantCode}`;

    // Check which columns already exist
    const [columns] = await connection.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tickets'
      AND COLUMN_NAME IN ('sla_definition_id', 'sla_applied_at', 'response_due_at', 'resolve_due_at', 'first_responded_at')
    `, [dbName]);

    const existingColumns = columns.map(c => c.COLUMN_NAME);
    let addedColumns = [];

    // Add sla_definition_id if missing
    if (!existingColumns.includes('sla_definition_id')) {
      await connection.query(`
        ALTER TABLE tickets
        ADD COLUMN sla_definition_id INT NULL AFTER ai_accuracy_feedback
      `);
      addedColumns.push('sla_definition_id');
    }

    // Add sla_applied_at if missing
    if (!existingColumns.includes('sla_applied_at')) {
      await connection.query(`
        ALTER TABLE tickets
        ADD COLUMN sla_applied_at TIMESTAMP NULL AFTER sla_definition_id
      `);
      addedColumns.push('sla_applied_at');
    }

    // Add response_due_at if missing
    if (!existingColumns.includes('response_due_at')) {
      await connection.query(`
        ALTER TABLE tickets
        ADD COLUMN response_due_at TIMESTAMP NULL AFTER sla_applied_at
      `);
      addedColumns.push('response_due_at');
    }

    // Add resolve_due_at if missing
    if (!existingColumns.includes('resolve_due_at')) {
      await connection.query(`
        ALTER TABLE tickets
        ADD COLUMN resolve_due_at TIMESTAMP NULL AFTER response_due_at
      `);
      addedColumns.push('resolve_due_at');
    }

    // Add first_responded_at if missing
    if (!existingColumns.includes('first_responded_at')) {
      await connection.query(`
        ALTER TABLE tickets
        ADD COLUMN first_responded_at TIMESTAMP NULL AFTER resolve_due_at
      `);
      addedColumns.push('first_responded_at');
    }

    if (addedColumns.length > 0) {
      console.log(`  ✓ Added SLA columns: ${addedColumns.join(', ')}`);
    } else {
      console.log(`  ℹ️  All SLA ticket columns already exist for ${tenantCode}`);
    }

    return true;
  } catch (error) {
    console.error(`❌ SLA ticket fields migration failed for tenant ${tenantCode}:`, error.message);
    throw error;
  } finally {
    if (connection) connection.release();
  }
}

module.exports = { runMigration };
