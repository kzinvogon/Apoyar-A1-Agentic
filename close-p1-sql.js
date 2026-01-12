const mysql = require('mysql2/promise');

async function main() {
  // Connect to Railway MySQL
  const connection = await mysql.createConnection({
    host: process.env.MYSQLHOST || 'autorack.proxy.rlwy.net',
    port: process.env.MYSQLPORT || 24502,
    user: process.env.MYSQLUSER || 'root',
    password: process.env.MYSQLPASSWORD || 'gXCdWCHOlzkqMTsuoSYNQFZssjoBNXMa',
    database: 'apoyar_tenant'
  });

  try {
    // Count matching tickets
    const [countResult] = await connection.execute(
      "SELECT COUNT(*) as cnt FROM tickets WHERE title = 'P1 - Security Issue LIVE' AND status NOT IN ('Resolved', 'Closed')"
    );
    console.log(`Found ${countResult[0].cnt} tickets to close`);

    // Bulk update all matching tickets
    const [updateResult] = await connection.execute(`
      UPDATE tickets
      SET status = 'Resolved',
          resolution_status = 'resolved',
          resolution_comment = 'Bulk closed - test tickets',
          resolved_at = NOW(),
          updated_at = NOW()
      WHERE title = 'P1 - Security Issue LIVE'
      AND status NOT IN ('Resolved', 'Closed')
    `);

    console.log(`Updated ${updateResult.affectedRows} tickets`);

    // Verify
    const [verifyResult] = await connection.execute(
      "SELECT COUNT(*) as cnt FROM tickets WHERE title = 'P1 - Security Issue LIVE' AND status NOT IN ('Resolved', 'Closed')"
    );
    console.log(`Remaining open: ${verifyResult[0].cnt}`);

  } finally {
    await connection.end();
  }
}

main().catch(console.error);
