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
      const testPw = process.env.TEST_PASSWORD || 'changeme';
      const matches = await bcrypt.compare(testPw, user.password_hash);
      console.log(`  Password matches: ${matches ? '✅ YES' : '❌ NO'}`);
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

      const testPw = process.env.TEST_PASSWORD || 'changeme';
      const matchesPw = await bcrypt.compare(testPw, user.password_hash);
      console.log(`  Password matches: ${matchesPw ? '✅ YES' : '❌ NO'}`);
    }

    await tenantConn.end();

  } catch (error) {
    console.error('Error:', error);
  }
}

testPasswords();
