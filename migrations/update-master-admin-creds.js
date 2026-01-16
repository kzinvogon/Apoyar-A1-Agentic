/**
 * Migration: Update Master Admin Credentials
 * Run with: node migrations/update-master-admin-creds.js
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

// Pre-hashed password for: 5tarry.5erv1fl0w
const HASHED_PASSWORD = '$2b$10$28fPLwGNF.geX4ixqFvhWeYEt87QrIyLyDTHyzVoYglAmy10oHbgW';

async function updateMasterAdmin() {
  console.log('Updating master admin credentials...');

  const conn = await mysql.createConnection(config);

  try {
    // Update username and password_hash
    const [result] = await conn.query(
      "UPDATE master_users SET username = 'master', password_hash = ? WHERE username = 'admin'",
      [HASHED_PASSWORD]
    );

    if (result.affectedRows > 0) {
      console.log('✅ Master admin credentials updated');
      console.log('   Username: master');
      console.log('   Password: 5tarry.5erv1fl0w');
    } else {
      console.log('⚠️ No user with username "admin" found. Checking if "master" already exists...');

      const [existing] = await conn.query("SELECT id FROM master_users WHERE username = 'master'");
      if (existing.length > 0) {
        // Update password_hash for existing master user
        await conn.query(
          "UPDATE master_users SET password_hash = ? WHERE username = 'master'",
          [HASHED_PASSWORD]
        );
        console.log('✅ Password updated for existing "master" user');
      } else {
        console.log('❌ No master admin user found');
      }
    }
  } finally {
    await conn.end();
  }
}

updateMasterAdmin().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
