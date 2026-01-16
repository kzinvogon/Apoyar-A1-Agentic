/**
 * Migration: Add Slack workspace mapping tables to master database
 * Maps Slack workspace IDs to ServiFlow tenant codes
 *
 * Run with: node migrations/add-slack-tenant-mapping.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

const config = {
  host: process.env.MYSQLHOST || process.env.DB_HOST,
  port: process.env.MYSQLPORT || process.env.DB_PORT || 3306,
  user: process.env.MYSQLUSER || process.env.DB_USER,
  password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD,
  database: process.env.MYSQLDATABASE || process.env.DB_NAME || 'master_tenant'
};

async function runMigration() {
  console.log('Starting Slack workspace mapping migration...');

  const connection = await mysql.createConnection(config);

  try {
    // Create slack_workspace_mappings table in master database
    await connection.query(`
      CREATE TABLE IF NOT EXISTS slack_workspace_mappings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        slack_workspace_id VARCHAR(100) NOT NULL UNIQUE,
        slack_workspace_name VARCHAR(255),
        tenant_code VARCHAR(50) NOT NULL,
        slack_bot_token TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_slack_workspace_id (slack_workspace_id),
        INDEX idx_tenant_code (tenant_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅ Created slack_workspace_mappings table');

    // Create slack_email_domain_mappings for fallback email domain lookup
    await connection.query(`
      CREATE TABLE IF NOT EXISTS slack_email_domain_mappings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email_domain VARCHAR(255) NOT NULL UNIQUE,
        tenant_code VARCHAR(50) NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_email_domain (email_domain),
        INDEX idx_tenant_code (tenant_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅ Created slack_email_domain_mappings table');

    console.log('\n✅ Migration completed successfully!');
    console.log('\nNext steps:');
    console.log('1. Create a Slack app at https://api.slack.com/apps');
    console.log('2. Configure OAuth redirect URL to: {APP_BASE_URL}/api/integrations/slack/callback');
    console.log('3. Add required bot scopes: chat:write, commands, users:read, users:read.email');
    console.log('4. Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET in environment');

  } catch (error) {
    if (error.code === 'ER_TABLE_EXISTS_ERROR') {
      console.log('Tables already exist');
    } else {
      console.error('Migration failed:', error);
      process.exit(1);
    }
  } finally {
    await connection.end();
  }
}

runMigration();
