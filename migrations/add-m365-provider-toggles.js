/**
 * Migration: Add per-provider M365 toggle columns to email_ingest_settings
 *
 * Adds m365_enabled and m365_use_for_outbound so each provider
 * (IMAP and M365) has independent enabled/outbound toggles.
 *
 * Usage: node migrations/add-m365-provider-toggles.js
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
        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'email_ingest_settings' AND COLUMN_NAME = 'm365_enabled'",
        [dbName]
      );

      if (cols.length > 0) {
        console.log(`  Skipping ${dbName} - columns already exist`);
        continue;
      }

      // Migrate existing data: if auth_method=oauth2 and enabled=1, set m365_enabled=1
      // so existing M365 tenants don't lose their enabled state
      await connection.query(`
        ALTER TABLE ${dbName}.email_ingest_settings
          ADD COLUMN m365_enabled TINYINT(1) DEFAULT 0,
          ADD COLUMN m365_use_for_outbound TINYINT(1) DEFAULT 0
      `);

      // Copy existing enabled/outbound state to m365 columns for oauth2 rows
      await connection.query(`
        UPDATE ${dbName}.email_ingest_settings
        SET m365_enabled = enabled,
            m365_use_for_outbound = use_for_outbound,
            enabled = 0,
            use_for_outbound = 0
        WHERE auth_method = 'oauth2'
      `);

      console.log(`  Done - added m365_enabled, m365_use_for_outbound`);
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
