const bcrypt = require('bcrypt');
const mysql = require('mysql2/promise');

async function testPasswords() {
  console.log('Testing database passwords...\n');

  try {
    // Test master user
    console.log('=== MASTER DATABASE ===');
    const masterConn = await mysql.createConnection({
      host: 'localhost',
      port: 3306,
      user: 'root',
      password: '',
      database: 'a1_master'
    });

    const [masterUsers] = await masterConn.query('SELECT username, password_hash FROM master_users');

    for (const user of masterUsers) {
      console.log(`\nUser: ${user.username}`);
      const matches = await bcrypt.compare('admin123', user.password_hash);
      console.log(`  Password 'admin123' matches: ${matches ? '✅ YES' : '❌ NO'}`);
    }

    await masterConn.end();

    // Test tenant users
    console.log('\n\n=== TENANT DATABASE (apoyar) ===');
    const tenantConn = await mysql.createConnection({
      host: 'localhost',
      port: 3306,
      user: 'root',
      password: '',
      database: 'a1_tenant_apoyar'
    });

    const [tenantUsers] = await tenantConn.query('SELECT username, password_hash FROM users');

    for (const user of tenantUsers) {
      console.log(`\nUser: ${user.username}`);

      // Test with password123
      const matchesPassword123 = await bcrypt.compare('password123', user.password_hash);
      console.log(`  Password 'password123' matches: ${matchesPassword123 ? '✅ YES' : '❌ NO'}`);

      // Test with customer123
      const matchesCustomer123 = await bcrypt.compare('customer123', user.password_hash);
      console.log(`  Password 'customer123' matches: ${matchesCustomer123 ? '✅ YES' : '❌ NO'}`);
    }

    await tenantConn.end();

  } catch (error) {
    console.error('Error:', error);
  }
}

testPasswords();
