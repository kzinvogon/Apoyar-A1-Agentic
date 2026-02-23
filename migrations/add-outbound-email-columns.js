/**
 * Migration: Add outbound email columns to email_ingest_settings
 *
 * Adds use_for_outbound, smtp_host, smtp_port to allow tenants
 * to send outbound emails via their configured email provider.
 *
 * Usage: node migrations/add-outbound-email-columns.js
 */
const mysql = require('mysql2/promise');

async function migrate() {
  const host = process.env.MYSQLHOST || process.env.DB_HOST || 'localhost';
  const port = parseInt(process.env.MYSQLPORT || process.env.DB_PORT || '3306', 10);
  const user = process.env.MYSQLUSER || process.env.DB_USER || 'root';
  const password = process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || '';

  console.log(`Connecting to MySQL at ${host}:${port}...`);
  const connection = await mysql.createConnection({ host, port, user, password });

  try {
    // Get all tenant databases
    const [databases] = await connection.query(
      "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME LIKE 'a1_tenant_%'"
    );

    console.log(`Found ${databases.length} tenant database(s)`);

    for (const db of databases) {
      const dbName = db.SCHEMA_NAME;
      console.log(`\nMigrating ${dbName}...`);

      // Check if table exists
      const [tables] = await connection.query(
        "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'email_ingest_settings'",
        [dbName]
      );

      if (tables.length === 0) {
        console.log(`  Skipping ${dbName} - no email_ingest_settings table`);
        continue;
      }

      // Check if columns already exist
      const [cols] = await connection.query(
        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'email_ingest_settings' AND COLUMN_NAME = 'use_for_outbound'",
        [dbName]
      );

      if (cols.length > 0) {
        console.log(`  Skipping ${dbName} - columns already exist`);
        continue;
      }

      await connection.query(`
        ALTER TABLE ${dbName}.email_ingest_settings
          ADD COLUMN use_for_outbound TINYINT(1) DEFAULT 0,
          ADD COLUMN smtp_host VARCHAR(255) DEFAULT NULL,
          ADD COLUMN smtp_port INT DEFAULT 587
      `);

      console.log(`  Done - added use_for_outbound, smtp_host, smtp_port`);
    }

    console.log('\nMigration complete!');
  } finally {
    await connection.end();
  }
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
