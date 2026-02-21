/**
 * Migration: Add is_demo flag to tenants table
 * Only run on demo database — not UAT/Prod.
 */
const { getMasterConnection } = require('../config/database');

async function runMigration() {
  const connection = await getMasterConnection();
  try {
    // Check if column already exists
    const [cols] = await connection.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tenants' AND COLUMN_NAME = 'is_demo'`
    );
    if (cols.length > 0) {
      console.log('is_demo column already exists — skipping');
      return;
    }
    await connection.query(
      `ALTER TABLE tenants ADD COLUMN is_demo TINYINT(1) NOT NULL DEFAULT 0`
    );
    console.log('Added is_demo column to tenants table');
  } finally {
    connection.release();
  }
}

module.exports = { runMigration };

if (require.main === module) {
  runMigration()
    .then(() => process.exit(0))
    .catch(err => { console.error(err); process.exit(1); });
}
