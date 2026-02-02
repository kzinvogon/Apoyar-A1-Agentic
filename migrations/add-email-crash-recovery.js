/**
 * Migration: Add email crash recovery and dedupe tables
 *
 * Creates email_processed_messages table for deduplication and crash recovery
 * Adds last_uid_processed column to email_ingest_settings for UID-based tracking
 *
 * Run with: node migrations/add-email-crash-recovery.js
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

  console.log(`\n🔄 Email Crash Recovery Migration`);
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

      // 1. Create email_processed_messages table
      try {
        await connection.query(`
          CREATE TABLE IF NOT EXISTS ${dbName}.email_processed_messages (
            id INT AUTO_INCREMENT PRIMARY KEY,
            mailbox_id INT NOT NULL COMMENT 'FK to email_ingest_settings.id',
            message_id VARCHAR(512) NOT NULL COMMENT 'Email Message-ID header',
            uid BIGINT UNSIGNED NULL COMMENT 'IMAP UID for crash recovery',
            ticket_id INT NULL COMMENT 'FK to tickets.id if ticket was created/updated',
            processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            result ENUM(
              'ticket_created',
              'ticket_updated',
              'skipped_bounce',
              'skipped_domain',
              'skipped_duplicate',
              'skipped_system',
              'skipped_expert_request',
              'error'
            ) NOT NULL,

            UNIQUE KEY uk_mailbox_message (mailbox_id, message_id),
            INDEX idx_mailbox_uid (mailbox_id, uid),
            INDEX idx_ticket_id (ticket_id),

            FOREIGN KEY (mailbox_id) REFERENCES email_ingest_settings(id) ON DELETE CASCADE
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
          COMMENT='Tracks processed emails for deduplication and crash recovery'
        `);
        console.log(`  ✓ Created email_processed_messages table`);
      } catch (err) {
        if (err.code === 'ER_TABLE_EXISTS_ERROR') {
          console.log(`  - email_processed_messages table already exists`);
        } else if (err.message.includes('email_ingest_settings')) {
          console.log(`  ⚠ Skipped email_processed_messages: email_ingest_settings table not found`);
        } else {
          console.log(`  ⚠ Error creating email_processed_messages: ${err.message}`);
        }
      }

      // 2. Add last_uid_processed column to email_ingest_settings
      try {
        // Check if column exists
        const [cols] = await connection.query(`
          SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'email_ingest_settings' AND COLUMN_NAME = 'last_uid_processed'
        `, [dbName]);

        if (cols.length === 0) {
          await connection.query(`
            ALTER TABLE ${dbName}.email_ingest_settings
            ADD COLUMN last_uid_processed BIGINT UNSIGNED NULL
            COMMENT 'Last IMAP UID processed for crash recovery'
          `);
          console.log(`  ✓ Added last_uid_processed column to email_ingest_settings`);
        } else {
          console.log(`  - last_uid_processed column already exists`);
        }
      } catch (err) {
        if (err.code === 'ER_NO_SUCH_TABLE') {
          console.log(`  ⚠ Skipped: email_ingest_settings table not found`);
        } else {
          console.log(`  ⚠ Error adding last_uid_processed: ${err.message}`);
        }
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
