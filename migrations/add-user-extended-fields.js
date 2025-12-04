/**
 * Migration: Add extended user fields
 * Adds phone, department, location, address fields to users table
 */

const mysql = require('mysql2/promise');

async function runMigration() {
  const connection = await mysql.createConnection({
    host: process.env.MASTER_DB_HOST || 'localhost',
    user: process.env.MASTER_DB_USER || 'root',
    password: process.env.MASTER_DB_PASSWORD || '',
    database: 'a1_tenant_apoyar'
  });

  try {
    console.log('Adding extended fields to users table...');

    // Add columns if they don't exist
    const columns = [
      { name: 'phone', type: 'VARCHAR(50)' },
      { name: 'department', type: 'VARCHAR(100)' },
      { name: 'location', type: 'VARCHAR(100)' },
      { name: 'street_address', type: 'VARCHAR(255)' },
      { name: 'city', type: 'VARCHAR(100)' },
      { name: 'state', type: 'VARCHAR(100)' },
      { name: 'postcode', type: 'VARCHAR(20)' },
      { name: 'country', type: 'VARCHAR(100)' },
      { name: 'timezone', type: 'VARCHAR(50)' },
      { name: 'language', type: 'VARCHAR(50)' }
    ];

    for (const col of columns) {
      try {
        await connection.query(`ALTER TABLE users ADD COLUMN ${col.name} ${col.type}`);
        console.log(`  ✅ Added column: ${col.name}`);
      } catch (err) {
        if (err.code === 'ER_DUP_FIELDNAME') {
          console.log(`  ⏭️  Column already exists: ${col.name}`);
        } else {
          throw err;
        }
      }
    }

    console.log('\n✅ Migration completed successfully!');
  } catch (error) {
    console.error('Migration error:', error);
  } finally {
    await connection.end();
  }
}

runMigration();
