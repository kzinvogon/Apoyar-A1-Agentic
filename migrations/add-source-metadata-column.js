/**
 * Migration: Add source_metadata column to tickets table
 * This column stores metadata about ticket source (monitoring, email, etc.)
 *
 * Run with: node migrations/add-source-metadata-column.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

const config = {
  host: process.env.MYSQLHOST || process.env.DB_HOST,
  port: process.env.MYSQLPORT || process.env.DB_PORT || 3306,
  user: process.env.MYSQLUSER || process.env.DB_USER,
  password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD,
  database: process.env.MYSQLDATABASE || 'railway'
};

async function runMigration() {
  console.log('Adding source_metadata column to tickets tables...');
  console.log(`Connecting to database: ${config.database}`);

  const connection = await mysql.createConnection(config);

  try {
    // Get all tenant databases
    const [tenants] = await connection.query('SELECT tenant_code FROM tenants WHERE is_active = TRUE');

    for (const tenant of tenants) {
      const tenantDb = `a1_tenant_${tenant.tenant_code}`;
      console.log(`\nProcessing tenant: ${tenant.tenant_code} (${tenantDb})`);

      try {
        // Check if column exists
        const [cols] = await connection.query(`
          SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tickets' AND COLUMN_NAME = 'source_metadata'
        `, [tenantDb]);

        if (cols.length === 0) {
          // Add the column
          await connection.query(`
            ALTER TABLE \`${tenantDb}\`.tickets
            ADD COLUMN source_metadata JSON NULL
          `);
          console.log(`  ✅ Added source_metadata column to ${tenantDb}.tickets`);
        } else {
          console.log(`  ℹ️ source_metadata column already exists in ${tenantDb}.tickets`);
        }
      } catch (err) {
        console.error(`  ❌ Error processing ${tenantDb}:`, err.message);
      }
    }

    console.log('\n✅ Migration completed!');

  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

runMigration();
