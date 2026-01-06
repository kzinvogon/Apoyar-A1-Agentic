/**
 * Set tenant_domain for expert registration via email
 * Usage: node scripts/set-tenant-domain.js [tenant_code] [domain]
 * Example: node scripts/set-tenant-domain.js apoyar apoyar.com.au
 */

const mysql = require('mysql2/promise');

async function setTenantDomain() {
  const tenantCode = process.argv[2] || 'apoyar';
  const domain = process.argv[3] || 'apoyar.com.au';

  console.log(`Setting tenant_domain for ${tenantCode} to ${domain}`);

  // Use Railway production database
  const config = {
    host: process.env.MYSQLHOST || 'autorack.proxy.rlwy.net',
    port: parseInt(process.env.MYSQLPORT || '47741'),
    user: process.env.MYSQLUSER || 'root',
    password: process.env.MYSQLPASSWORD || 'zCmWzGkPHmITMzKPGBhSLsVTchBXltwn',
    database: `${tenantCode}_tenant`,
    connectTimeout: 30000,
    ssl: {
      rejectUnauthorized: false
    }
  };

  let connection;
  try {
    console.log('Connecting to database...');
    connection = await mysql.createConnection(config);
    console.log('Connected!');

    // Ensure tenant_settings table exists
    await connection.query(`
      CREATE TABLE IF NOT EXISTS tenant_settings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        setting_key VARCHAR(100) NOT NULL UNIQUE,
        setting_value TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Insert or update tenant_domain
    await connection.query(`
      INSERT INTO tenant_settings (setting_key, setting_value)
      VALUES ('tenant_domain', ?)
      ON DUPLICATE KEY UPDATE setting_value = ?
    `, [domain, domain]);

    console.log(`✅ Set tenant_domain = ${domain}`);

    // Verify
    const [result] = await connection.query(
      "SELECT * FROM tenant_settings WHERE setting_key = 'tenant_domain'"
    );
    console.log('Current setting:', result[0]);

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

setTenantDomain();
