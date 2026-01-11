/**
 * Migration: Add SLA source tracking and SLA pointer columns
 *
 * Adds:
 * - tickets.sla_source VARCHAR(16) NULL - tracks where SLA came from
 * - customer_companies.sla_definition_id INT NULL - company-level SLA
 * - cmdb_items.sla_definition_id INT NULL - CMDB item-level SLA
 */

async function runMigration(tenantCode) {
  const { getTenantConnection } = require('../config/database');
  const connection = await getTenantConnection(tenantCode);

  try {
    // 1. Add sla_source to tickets table
    try {
      await connection.query(`
        ALTER TABLE tickets
        ADD COLUMN sla_source VARCHAR(16) NULL
        COMMENT 'Source of SLA: ticket, customer, service, cmdb, default'
      `);
      console.log(`✅ Added sla_source column to tickets for tenant ${tenantCode}`);
    } catch (error) {
      if (error.code === 'ER_DUP_FIELDNAME') {
        console.log(`ℹ️  sla_source column already exists in tickets for tenant ${tenantCode}`);
      } else {
        throw error;
      }
    }

    // 2. Add sla_definition_id to customer_companies table
    try {
      await connection.query(`
        ALTER TABLE customer_companies
        ADD COLUMN sla_definition_id INT NULL,
        ADD INDEX idx_sla_definition_id (sla_definition_id)
      `);
      console.log(`✅ Added sla_definition_id column to customer_companies for tenant ${tenantCode}`);
    } catch (error) {
      if (error.code === 'ER_DUP_FIELDNAME' || error.code === 'ER_DUP_KEYNAME') {
        console.log(`ℹ️  sla_definition_id column already exists in customer_companies for tenant ${tenantCode}`);
      } else {
        throw error;
      }
    }

    // 3. Add sla_definition_id to cmdb_items table
    try {
      await connection.query(`
        ALTER TABLE cmdb_items
        ADD COLUMN sla_definition_id INT NULL,
        ADD INDEX idx_cmdb_sla_definition_id (sla_definition_id)
      `);
      console.log(`✅ Added sla_definition_id column to cmdb_items for tenant ${tenantCode}`);
    } catch (error) {
      if (error.code === 'ER_DUP_FIELDNAME' || error.code === 'ER_DUP_KEYNAME') {
        console.log(`ℹ️  sla_definition_id column already exists in cmdb_items for tenant ${tenantCode}`);
      } else {
        throw error;
      }
    }

    return true;
  } catch (error) {
    console.error(`❌ Migration failed for tenant ${tenantCode}:`, error.message);
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = { runMigration };
