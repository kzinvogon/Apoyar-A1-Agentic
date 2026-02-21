/**
 * Migration: Add report_history table and monthly report settings to all existing tenants.
 *
 * Usage:
 *   node migrations/add-report-history.js [localhost|uat|prod]
 *
 * Defaults to localhost if no argument given.
 */

const mysql = require('mysql2/promise');

const ENVS = {
  localhost: { host: 'localhost', port: 3306, user: 'root', password: '' },
  uat:      { host: process.env.MYSQLHOST || 'tramway.proxy.rlwy.net', port: parseInt(process.env.MYSQLPORT || '20773', 10), user: process.env.MYSQLUSER || 'serviflow_app', password: process.env.RAILWAY_MYSQL_PASSWORD || '' },
  prod:     { host: process.env.MYSQLHOST || 'tramway.proxy.rlwy.net', port: parseInt(process.env.MYSQLPORT || '20773', 10), user: process.env.MYSQLUSER || 'serviflow_app', password: process.env.RAILWAY_MYSQL_PASSWORD || '' },
};

async function run() {
  const envArg = process.argv[2] || 'localhost';
  const cfg = ENVS[envArg];
  if (!cfg) { console.error('Unknown env:', envArg); process.exit(1); }

  if ((envArg === 'uat' || envArg === 'prod') && !cfg.password) {
    console.error('Set RAILWAY_MYSQL_PASSWORD env variable first.');
    process.exit(1);
  }

  console.log(`Connecting to ${envArg} (${cfg.host}:${cfg.port})...`);
  const conn = await mysql.createConnection(cfg);

  // Find all tenant databases
  const [dbs] = await conn.query(`SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'a1_tenant_%'`);
  console.log(`Found ${dbs.length} tenant database(s).`);

  for (const row of dbs) {
    const db = row.SCHEMA_NAME;
    console.log(`\n--- ${db} ---`);

    // Create report_history table
    try {
      await conn.query(`
        CREATE TABLE IF NOT EXISTS ${db}.report_history (
          id INT AUTO_INCREMENT PRIMARY KEY,
          report_type VARCHAR(50) NOT NULL DEFAULT 'monthly',
          period_month INT NOT NULL,
          period_year INT NOT NULL,
          company_filter VARCHAR(255),
          generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          generated_by INT,
          recipients_json TEXT,
          ticket_count INT,
          cmdb_change_count INT,
          sla_compliance_pct DECIMAL(5,2),
          status VARCHAR(20) DEFAULT 'sent',
          error_message TEXT,
          INDEX idx_period (period_year, period_month)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      console.log(`  report_history: created/exists`);
    } catch (err) {
      console.error(`  report_history: ${err.message}`);
    }

    // Insert default settings (IGNORE if exist)
    const settings = [
      ['monthly_report_enabled', 'false', 'boolean', 'Enable automatic monthly report email'],
      ['monthly_report_recipients', '[]', 'json', 'JSON array of email addresses to receive monthly report'],
      ['monthly_report_send_day', '1', 'number', 'Day of month to send report (1-28)'],
      ['monthly_report_include_system_tickets', 'false', 'boolean', 'Include system-generated tickets in monthly report'],
    ];

    // Check if description column exists
    let hasDescription = true;
    try {
      const [cols] = await conn.query(`SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tenant_settings' AND COLUMN_NAME = 'description'`, [db]);
      hasDescription = cols.length > 0;
    } catch { hasDescription = false; }

    for (const [key, val, type, desc] of settings) {
      try {
        if (hasDescription) {
          await conn.query(`
            INSERT IGNORE INTO ${db}.tenant_settings (setting_key, setting_value, setting_type, description)
            VALUES (?, ?, ?, ?)
          `, [key, val, type, desc]);
        } else {
          await conn.query(`
            INSERT IGNORE INTO ${db}.tenant_settings (setting_key, setting_value, setting_type)
            VALUES (?, ?, ?)
          `, [key, val, type]);
        }
      } catch (err) {
        // tenant_settings may not exist on very old tenants
        if (err.code === 'ER_NO_SUCH_TABLE') {
          console.log(`  tenant_settings table does not exist — skipping settings`);
          break;
        }
        console.error(`  setting ${key}: ${err.message}`);
      }
    }
    console.log(`  settings: inserted/exist`);
  }

  await conn.end();
  console.log('\nDone.');
}

run().catch(err => { console.error('Migration failed:', err); process.exit(1); });
