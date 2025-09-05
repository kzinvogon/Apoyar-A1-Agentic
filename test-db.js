const { Pool } = require('pg');

const pool = new Pool({
  user: 'davidhamilton',
  host: 'localhost',
  database: 'a1_support_dashboard',
  password: '',
  port: 5432,
});

async function testConnection() {
  try {
    const client = await pool.connect();
    console.log('✅ PostgreSQL connected successfully');
    const result = await client.query('SELECT COUNT(*) FROM tenants');
    console.log('Tenant count:', result.rows[0].count);
    client.release();
    return true;
  } catch (error) {
    console.error('❌ PostgreSQL connection failed:', error.message);
    return false;
  } finally {
    await pool.end();
  }
}

testConnection();
