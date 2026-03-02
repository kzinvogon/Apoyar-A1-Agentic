/**
 * Migration: Link orphaned customers to their customer_companies records
 *
 * Customers created via the email processor were not linked to their
 * customer_companies record (customer_company_id was NULL). This migration
 * finds customers with a matching company_domain and links them.
 *
 * Idempotent: only updates customers with NULL customer_company_id.
 */

const { getTenantConnection } = require('../config/database');

async function migrate(tenantCode) {
  let connection;
  try {
    connection = await getTenantConnection(tenantCode);

    // Check if both tables exist
    const [tables] = await connection.query(
      `SHOW TABLES LIKE 'customers'`
    );
    if (tables.length === 0) {
      console.log(`[${tenantCode}] customers table does not exist, skipping`);
      return;
    }

    const [ccTables] = await connection.query(
      `SHOW TABLES LIKE 'customer_companies'`
    );
    if (ccTables.length === 0) {
      console.log(`[${tenantCode}] customer_companies table does not exist, skipping`);
      return;
    }

    // Link orphaned customers to their company by matching domain
    const [result] = await connection.query(`
      UPDATE customers c
      JOIN customer_companies cc ON c.company_domain = cc.company_domain
      SET c.customer_company_id = cc.id
      WHERE c.customer_company_id IS NULL
        AND c.company_domain IS NOT NULL
        AND c.company_domain != ''
    `);

    if (result.affectedRows > 0) {
      console.log(`[${tenantCode}] Linked ${result.affectedRows} customers to their companies`);
    } else {
      console.log(`[${tenantCode}] No orphaned customers to link`);
    }

  } catch (error) {
    console.error(`[${tenantCode}] link-customers-to-companies migration error:`, error.message);
    throw error;
  } finally {
    if (connection) connection.release();
  }
}

module.exports = { migrate };
