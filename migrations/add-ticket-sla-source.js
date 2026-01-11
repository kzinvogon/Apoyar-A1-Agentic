/**
 * Migration: Add sla_source column to tickets table
 *
 * Tracks the origin of the SLA applied to a ticket.
 * Allowed values: 'ticket', 'customer', 'cmdb', 'default', 'category' (reserved)
 */

const { getTenantConnection } = require('../config/database');

async function runMigration(tenantCode) {
  let connection;

  try {
    connection = await getTenantConnection(tenantCode);

    // Check if column exists
    const [columns] = await connection.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tickets' AND COLUMN_NAME = 'sla_source'`,
      [`a1_tenant_${tenantCode}`]
    );

    if (columns.length === 0) {
      await connection.query(`
        ALTER TABLE tickets
        ADD COLUMN sla_source VARCHAR(16) NULL
        COMMENT 'SLA origin: ticket, customer, cmdb, default, category'
      `);
      console.log(`✅ Added sla_source column to tickets for tenant ${tenantCode}`);
    } else {
      console.log(`ℹ️  sla_source column already exists in tickets for tenant ${tenantCode}`);
    }

  } catch (error) {
    console.error(`❌ Migration error for tenant ${tenantCode}:`, error.message);
    throw error;
  } finally {
    if (connection) connection.release();
  }
}

module.exports = { runMigration };
