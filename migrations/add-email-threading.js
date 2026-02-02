/**
 * Migration: Add email threading support for reply detection
 *
 * Creates email_ticket_threads table to store outbound Message-IDs
 * and updates email_processed_messages to support 'ticket_updated' and 'skipped_system' results
 *
 * Run with: node migrations/add-email-threading.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

async function runMigration() {
  const isRailway = process.env.RAILWAY_ENVIRONMENT || process.env.MYSQLHOST;

  const dbConfig = isRailway ? {
    host: process.env.MYSQLHOST || 'localhost',
    port: parseInt(process.env.MYSQLPORT || '3306'),
    user: process.env.MYSQLUSER || 'root',
    password: process.env.MYSQLPASSWORD || '',
    multipleStatements: true
  } : {
    host: 'localhost',
    port: 3306,
    user: 'root',
    password: '',
    multipleStatements: true
  };

  console.log(`\n🔄 Email Threading Migration`);
  console.log(`Environment: ${isRailway ? 'Railway' : 'Localhost'}`);
  console.log(`Host: ${dbConfig.host}:${dbConfig.port}\n`);

  const connection = await mysql.createConnection(dbConfig);

  try {
    // Get all tenant databases
    const [databases] = await connection.query(`
      SELECT SCHEMA_NAME as db_name
      FROM information_schema.SCHEMATA
      WHERE SCHEMA_NAME LIKE 'a1_tenant_%'
    `);

    console.log(`Found ${databases.length} tenant database(s)\n`);

    for (const { db_name: dbName } of databases) {
      console.log(`📦 Processing: ${dbName}`);

      // 1. Create email_ticket_threads table
      try {
        await connection.query(`
          CREATE TABLE IF NOT EXISTS ${dbName}.email_ticket_threads (
            id INT AUTO_INCREMENT PRIMARY KEY,
            ticket_id INT NOT NULL COMMENT 'FK to tickets.id',
            message_id VARCHAR(512) NOT NULL COMMENT 'Outbound email Message-ID header',
            subject VARCHAR(500) NULL COMMENT 'Subject line for debugging',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

            UNIQUE KEY uk_message_id (message_id),
            INDEX idx_ticket_id (ticket_id),

            FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
          COMMENT='Maps outbound email Message-IDs to tickets for reply threading'
        `);
        console.log(`  ✓ Created email_ticket_threads table`);
      } catch (err) {
        if (err.code === 'ER_TABLE_EXISTS_ERROR') {
          console.log(`  - email_ticket_threads table already exists`);
        } else {
          console.log(`  ⚠ Error creating email_ticket_threads: ${err.message}`);
        }
      }

      // 2. Update email_processed_messages result enum to include new values
      try {
        await connection.query(`
          ALTER TABLE ${dbName}.email_processed_messages
          MODIFY COLUMN result ENUM(
            'ticket_created',
            'ticket_updated',
            'skipped_bounce',
            'skipped_domain',
            'skipped_duplicate',
            'skipped_system',
            'skipped_expert_request',
            'error'
          ) NOT NULL
        `);
        console.log(`  ✓ Updated result enum with ticket_updated and skipped_system`);
      } catch (err) {
        if (err.message.includes('Data truncated')) {
          console.log(`  - Result enum already has the new values`);
        } else {
          console.log(`  ⚠ Error updating result enum: ${err.message}`);
        }
      }

      // 3. Add 'email_reply' to ticket_activity activity_type enum
      try {
        await connection.query(`
          ALTER TABLE ${dbName}.ticket_activity
          MODIFY COLUMN activity_type ENUM('created','updated','assigned','resolved','closed','comment','email_reply') NOT NULL
        `);
        console.log(`  ✓ Added email_reply to ticket_activity enum`);
      } catch (err) {
        if (err.message.includes('email_reply')) {
          console.log(`  - email_reply already in ticket_activity enum`);
        } else {
          console.log(`  ⚠ Error updating ticket_activity enum: ${err.message}`);
        }
      }

      // 4. Add system_email_denylist to tenant_settings if not exists
      try {
        await connection.query(`
          INSERT IGNORE INTO ${dbName}.tenant_settings (setting_key, setting_value, description)
          VALUES (
            'system_email_subject_denylist',
            '["Password Reset Request","Verify your email","Email Verification","Account Verification","Confirm your account"]',
            'JSON array of subject patterns to skip during email ingestion (transactional emails)'
          )
        `);
        console.log(`  ✓ Added system_email_subject_denylist setting`);
      } catch (err) {
        console.log(`  ⚠ Error adding denylist setting: ${err.message}`);
      }

      console.log('');
    }

    console.log('✅ Migration complete!\n');

  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

runMigration();
