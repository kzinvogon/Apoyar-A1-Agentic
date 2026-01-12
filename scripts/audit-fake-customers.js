/**
 * Audit and cleanup fake customer companies
 * Created by monitoring/system email ingestion
 *
 * Usage:
 *   node scripts/audit-fake-customers.js [tenant_code] [--cleanup]
 *
 * Examples:
 *   node scripts/audit-fake-customers.js apoyar          # Audit only (dry run)
 *   node scripts/audit-fake-customers.js apoyar --cleanup # Reassign to System user
 */

const mysql = require('mysql2/promise');

// Patterns that indicate system/monitoring sources
const MONITORING_PATTERNS = [
  'nagios', 'zabbix', 'prtg', 'datadog', 'prometheus', 'alertmanager',
  'pagerduty', 'opsgenie', 'servicenow', 'icinga', 'checkmk', 'sensu',
  'newrelic', 'splunk', 'dynatrace', 'grafana', 'pingdom', 'uptime',
  'mailer-daemon', 'postmaster', 'noreply', 'no-reply', 'donotreply',
  'do-not-reply', 'alerts', 'monitoring', 'monitor', 'notification',
  'notify', 'system', 'automated', 'auto-reply', 'bounce'
];

async function auditFakeCustomers() {
  const tenantCode = process.argv[2] || 'apoyar';
  const doCleanup = process.argv.includes('--cleanup');

  console.log(`\n=== Audit Fake Customers for ${tenantCode} ===\n`);
  console.log(`Mode: ${doCleanup ? 'CLEANUP (will reassign tickets)' : 'AUDIT ONLY (dry run)'}\n`);

  // Database config
  const config = {
    host: process.env.MYSQLHOST || 'autorack.proxy.rlwy.net',
    port: parseInt(process.env.MYSQLPORT || '47741'),
    user: process.env.MYSQLUSER || 'root',
    password: process.env.MYSQLPASSWORD || 'zCmWzGkPHmITMzKPGBhSLsVTchBXltwn',
    database: `${tenantCode}_tenant`,
    connectTimeout: 30000,
    ssl: { rejectUnauthorized: false }
  };

  let connection;
  try {
    console.log('Connecting to database...');
    connection = await mysql.createConnection(config);
    console.log('Connected!\n');

    // Step 1: Find suspicious customer companies
    // These are companies with only 1 user and suspicious email patterns
    const [suspiciousCompanies] = await connection.query(`
      SELECT
        cc.id as company_id,
        cc.name as company_name,
        cc.domain as company_domain,
        COUNT(DISTINCT c.id) as customer_count,
        GROUP_CONCAT(DISTINCT u.email) as user_emails,
        GROUP_CONCAT(DISTINCT u.id) as user_ids
      FROM customer_companies cc
      LEFT JOIN customers c ON c.company_id = cc.id
      LEFT JOIN users u ON c.user_id = u.id
      WHERE cc.deleted_at IS NULL
      GROUP BY cc.id, cc.name, cc.domain
      HAVING customer_count <= 2
      ORDER BY cc.created_at DESC
    `);

    // Filter to suspicious ones based on email patterns
    const suspiciousList = [];
    for (const company of suspiciousCompanies) {
      const emails = (company.user_emails || '').toLowerCase();
      const domain = (company.company_domain || '').toLowerCase();
      const name = (company.company_name || '').toLowerCase();

      // Check if any pattern matches
      const isLikelySuspicious = MONITORING_PATTERNS.some(pattern =>
        emails.includes(pattern) || domain.includes(pattern) || name.includes(pattern)
      );

      if (isLikelySuspicious) {
        suspiciousList.push({
          ...company,
          matchedPattern: MONITORING_PATTERNS.find(p =>
            emails.includes(p) || domain.includes(p) || name.includes(p)
          )
        });
      }
    }

    console.log(`Found ${suspiciousList.length} suspicious customer companies:\n`);

    if (suspiciousList.length === 0) {
      console.log('No suspicious companies found. Database looks clean!\n');
      return;
    }

    // Display findings
    for (const company of suspiciousList) {
      console.log(`  ID: ${company.company_id}`);
      console.log(`  Name: ${company.company_name}`);
      console.log(`  Domain: ${company.company_domain || '(none)'}`);
      console.log(`  Users: ${company.customer_count} (${company.user_emails || 'none'})`);
      console.log(`  Matched pattern: "${company.matchedPattern}"`);
      console.log('');
    }

    // Step 2: Check for associated tickets
    console.log('\n=== Checking Associated Tickets ===\n');

    let totalTickets = 0;
    const companyTickets = [];

    for (const company of suspiciousList) {
      const userIds = (company.user_ids || '').split(',').filter(id => id);
      if (userIds.length === 0) continue;

      const [tickets] = await connection.query(`
        SELECT COUNT(*) as count FROM tickets
        WHERE requester_id IN (${userIds.join(',')})
      `);

      const ticketCount = tickets[0].count;
      totalTickets += ticketCount;

      if (ticketCount > 0) {
        companyTickets.push({
          company_id: company.company_id,
          company_name: company.company_name,
          user_ids: userIds,
          ticket_count: ticketCount
        });
        console.log(`  ${company.company_name}: ${ticketCount} ticket(s)`);
      }
    }

    console.log(`\nTotal tickets from suspicious companies: ${totalTickets}`);

    // Step 3: Cleanup if requested
    if (doCleanup && totalTickets > 0) {
      console.log('\n=== Performing Cleanup ===\n');

      // Ensure System user exists
      let [systemUser] = await connection.query(
        "SELECT id FROM users WHERE username = 'system' OR email = 'system@tenant.local'"
      );

      let systemUserId;
      if (systemUser.length === 0) {
        // Create System user
        const bcrypt = require('bcrypt');
        const crypto = require('crypto');
        const randomPassword = crypto.randomBytes(32).toString('hex');
        const passwordHash = await bcrypt.hash(randomPassword, 10);

        const [result] = await connection.query(
          `INSERT INTO users (username, email, password_hash, full_name, role, is_active)
           VALUES ('system', 'system@tenant.local', ?, 'System', 'customer', 1)`,
          [passwordHash]
        );
        systemUserId = result.insertId;
        console.log(`Created System user (ID: ${systemUserId})\n`);
      } else {
        systemUserId = systemUser[0].id;
        console.log(`Found existing System user (ID: ${systemUserId})\n`);
      }

      // Reassign tickets
      for (const { company_id, company_name, user_ids, ticket_count } of companyTickets) {
        console.log(`Reassigning ${ticket_count} tickets from "${company_name}" to System user...`);

        const [updateResult] = await connection.query(
          `UPDATE tickets SET requester_id = ? WHERE requester_id IN (${user_ids.join(',')})`,
          [systemUserId]
        );

        console.log(`  Updated ${updateResult.affectedRows} tickets`);

        // Log activity
        for (const userId of user_ids) {
          const [activityResult] = await connection.query(`
            INSERT INTO ticket_activity (ticket_id, user_id, activity_type, description)
            SELECT t.id, ?, 'system_note', ?
            FROM tickets t WHERE t.requester_id = ?
          `, [systemUserId, `Requester reassigned from suspected monitoring source (audit cleanup)`, systemUserId]);
        }
      }

      // Soft-delete the suspicious companies
      console.log('\nSoft-deleting suspicious companies...');
      const companyIds = suspiciousList.map(c => c.company_id);
      await connection.query(
        `UPDATE customer_companies SET deleted_at = NOW() WHERE id IN (${companyIds.join(',')})`
      );
      console.log(`Soft-deleted ${companyIds.length} companies`);

      console.log('\nCleanup complete!');
    } else if (doCleanup) {
      console.log('\nNo tickets to reassign. Cleanup not needed.');
    } else {
      console.log('\n=== To perform cleanup, run with --cleanup flag ===');
      console.log(`node scripts/audit-fake-customers.js ${tenantCode} --cleanup\n`);
    }

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

auditFakeCustomers();
