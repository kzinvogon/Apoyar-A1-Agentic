/**
 * Migration: Update Master Admin Credentials
 * Run with: node migrations/update-master-admin-creds.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const config = {
  host: process.env.MYSQLHOST || process.env.DB_HOST,
  port: process.env.MYSQLPORT || process.env.DB_PORT || 3306,
  user: process.env.MYSQLUSER || process.env.DB_USER,
  password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD,
  database: process.env.MYSQLDATABASE || 'railway'
};

async function updateMasterAdmin() {
  console.log('Updating master admin credentials...');

  const conn = await mysql.createConnection(config);

  try {
    // Hash new password
    const newPassword = '5tarry.5erv1fl0w';
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update username and password
    const [result] = await conn.query(
      "UPDATE master_users SET username = 'master', password = ? WHERE username = 'admin'",
      [hashedPassword]
    );

    if (result.affectedRows > 0) {
      console.log('✅ Master admin credentials updated');
      console.log('   Username: master');
      console.log('   Password: 5tarry.5erv1fl0w');
    } else {
      console.log('⚠️ No user with username "admin" found. Checking if "master" already exists...');

      const [existing] = await conn.query("SELECT id FROM master_users WHERE username = 'master'");
      if (existing.length > 0) {
        // Update password for existing master user
        await conn.query(
          "UPDATE master_users SET password = ? WHERE username = 'master'",
          [hashedPassword]
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
