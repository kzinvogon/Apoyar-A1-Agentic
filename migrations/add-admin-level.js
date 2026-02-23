/**
 * Migration: Add admin_level column to tenant users table
 *
 * Adds admin_level ENUM('tenant_admin','system_admin') DEFAULT 'tenant_admin'
 * Idempotent — safe to run multiple times.
 */

const mysql = require('mysql2/promise');

async function migrate(connection, tenantDb) {
  // Check if column already exists
  const [cols] = await connection.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'admin_level'`,
    [tenantDb]
  );

  if (cols.length > 0) {
    console.log(`  [${tenantDb}] admin_level column already exists — skipping`);
    return;
  }

  await connection.query(`
    ALTER TABLE ${tenantDb}.users
    ADD COLUMN admin_level ENUM('tenant_admin','system_admin') DEFAULT 'tenant_admin'
    AFTER role
  `);

  // Set existing admin users to system_admin (the original admin created at provisioning)
  await connection.query(`
    UPDATE ${tenantDb}.users SET admin_level = 'system_admin' WHERE role = 'admin' AND username = 'admin'
  `);

  console.log(`  [${tenantDb}] Added admin_level column, set admin user to system_admin`);
}

// Run standalone
if (require.main === module) {
  (async () => {
    const connection = await mysql.createConnection({
      host: process.env.MYSQLHOST || 'localhost',
      port: process.env.MYSQLPORT || 3306,
      user: process.env.MYSQLUSER || 'root',
      password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || ''
    });

    try {
      // Get all tenant databases
      const [dbs] = await connection.query(
        "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME LIKE 'a1_tenant_%'"
      );

      for (const db of dbs) {
        await migrate(connection, db.SCHEMA_NAME);
      }

      console.log('Migration complete.');
    } finally {
      await connection.end();
    }
  })().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

module.exports = { migrate };
