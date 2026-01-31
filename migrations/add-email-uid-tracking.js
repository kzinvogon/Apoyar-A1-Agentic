#!/usr/bin/env node
/**
 * Migration: Add UID tracking for email processing
 *
 * Prevents data loss when email worker crashes after marking emails as seen
 * but before creating tickets.
 *
 * Changes:
 * 1. Add last_uid_processed column to email_ingest_settings
 * 2. Create email_processed_messages table for message-id deduplication
 *
 * Usage:
 *   node migrations/add-email-uid-tracking.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

async function migrate() {
  const config = {
    host: process.env.MYSQLHOST || 'localhost',
    port: parseInt(process.env.MYSQLPORT || '3306', 10),
    user: process.env.MYSQLUSER || 'root',
    password: process.env.MYSQLPASSWORD || '',
  };

  console.log('Connecting to database...');
  const connection = await mysql.createConnection(config);

  try {
    // Get all tenant databases
    const [databases] = await connection.query(
      "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'a1_tenant_%'"
    );

    console.log(`Found ${databases.length} tenant database(s)`);

    for (const db of databases) {
      const dbName = db.SCHEMA_NAME;
      console.log(`\nMigrating ${dbName}...`);

      // Check if email_ingest_settings table exists in this tenant
      const [tableCheck] = await connection.query(`
        SELECT TABLE_NAME FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'email_ingest_settings'
      `, [dbName]);

      if (tableCheck.length === 0) {
        console.log(`  - Skipping: email_ingest_settings table doesn't exist`);
        continue;
      }

      // 1. Add last_uid_processed column to email_ingest_settings
      try {
        const [cols] = await connection.query(`
          SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'email_ingest_settings'
          AND COLUMN_NAME = 'last_uid_processed'
        `, [dbName]);

        if (cols.length === 0) {
          await connection.query(`
            ALTER TABLE ${dbName}.email_ingest_settings
            ADD COLUMN last_uid_processed BIGINT UNSIGNED NULL DEFAULT NULL
            COMMENT 'Last IMAP UID successfully processed'
          `);
          console.log(`  ✓ Added last_uid_processed column`);
        } else {
          console.log(`  - last_uid_processed column already exists`);
        }
      } catch (err) {
        console.log(`  ⚠ Error adding column: ${err.message}`);
      }

      // 2. Create email_processed_messages table for deduplication
      try {
        await connection.query(`
          CREATE TABLE IF NOT EXISTS ${dbName}.email_processed_messages (
            id INT AUTO_INCREMENT PRIMARY KEY,
            mailbox_id INT NOT NULL COMMENT 'FK to email_ingest_settings.id',
            message_id VARCHAR(512) NOT NULL COMMENT 'Email Message-ID header',
            uid BIGINT UNSIGNED NULL COMMENT 'IMAP UID at time of processing',
            ticket_id INT NULL COMMENT 'Created ticket ID (if any)',
            processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            result ENUM('ticket_created', 'skipped_bounce', 'skipped_domain', 'skipped_duplicate', 'error') NOT NULL,

            UNIQUE KEY uk_mailbox_message (mailbox_id, message_id),
            INDEX idx_processed_at (processed_at),
            INDEX idx_uid (mailbox_id, uid),

            FOREIGN KEY (mailbox_id) REFERENCES email_ingest_settings(id) ON DELETE CASCADE
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
          COMMENT='Tracks processed emails to prevent duplicates and enable UID-based recovery'
        `);
        console.log(`  ✓ Created email_processed_messages table`);
      } catch (err) {
        console.log(`  ⚠ Error creating table: ${err.message}`);
      }

      // 3. Add index for faster UID lookups
      try {
        await connection.query(`
          ALTER TABLE ${dbName}.email_ingest_settings
          ADD INDEX idx_last_uid (last_uid_processed)
        `);
        console.log(`  ✓ Added index on last_uid_processed`);
      } catch (err) {
        if (err.code === 'ER_DUP_KEYNAME') {
          console.log(`  - Index already exists`);
        } else {
          console.log(`  ⚠ Error adding index: ${err.message}`);
        }
      }
    }

    console.log('\n✅ Migration completed successfully');

  } finally {
    await connection.end();
  }
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
