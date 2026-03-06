/**
 * Migration: Add Incident Correlation Tables
 *
 * Adds monitoring alert grouping support:
 * - tickets.incident_key — normalised host:service key for fast lookup
 * - tickets.alert_count — number of alerts grouped into this ticket
 * - tickets.last_alert_at — timestamp of most recent alert
 * - alert_fingerprints — deduplicates identical alerts within a ticket
 * - incident_events — full timeline of every alert received
 *
 * Also backfills incident_key from existing source_metadata JSON.
 */

const { getTenantConnection, getMasterConnection } = require('../config/database');

async function runMigration(tenantCode) {
  console.log(`  Running incident correlation migration for ${tenantCode}...`);

  let connection;
  try {
    connection = await getTenantConnection(tenantCode);

    // Check if incident_key column already exists
    const [columns] = await connection.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'tickets'
      AND COLUMN_NAME = 'incident_key'
    `);

    if (columns.length > 0) {
      console.log(`    ✓ incident_key column already exists for ${tenantCode}`);
    } else {
      // Add incident_key column
      console.log(`    Adding incident_key column...`);
      await connection.query(`
        ALTER TABLE tickets
        ADD COLUMN incident_key VARCHAR(255) NULL
      `);

      // Add alert_count column
      console.log(`    Adding alert_count column...`);
      await connection.query(`
        ALTER TABLE tickets
        ADD COLUMN alert_count INT NOT NULL DEFAULT 0
      `);

      // Add last_alert_at column
      console.log(`    Adding last_alert_at column...`);
      await connection.query(`
        ALTER TABLE tickets
        ADD COLUMN last_alert_at TIMESTAMP NULL
      `);

      // Add index on incident_key
      console.log(`    Adding index on incident_key...`);
      try {
        await connection.query(`
          CREATE INDEX idx_tickets_incident_key ON tickets(incident_key)
        `);
      } catch (e) {
        if (!e.message.includes('Duplicate')) throw e;
      }

      console.log(`    ✓ Ticket columns added for ${tenantCode}`);
    }

    // Create alert_fingerprints table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS alert_fingerprints (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ticket_id INT NOT NULL,
        fingerprint VARCHAR(64) NOT NULL,
        subject VARCHAR(200) NULL,
        from_email VARCHAR(255) NULL,
        state VARCHAR(20) NULL,
        first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        occurrence_count INT NOT NULL DEFAULT 1,
        UNIQUE KEY uk_ticket_fingerprint (ticket_id, fingerprint),
        FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log(`    ✓ alert_fingerprints table ready for ${tenantCode}`);

    // Create incident_events table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS incident_events (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ticket_id INT NOT NULL,
        event_type VARCHAR(30) NOT NULL,
        state VARCHAR(20) NULL,
        subject VARCHAR(200) NULL,
        from_email VARCHAR(255) NULL,
        message_id VARCHAR(512) NULL,
        raw_metadata JSON NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_incident_events_ticket (ticket_id, created_at),
        FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log(`    ✓ incident_events table ready for ${tenantCode}`);

    // Backfill incident_key from existing source_metadata JSON
    const [updated] = await connection.query(`
      UPDATE tickets
      SET incident_key = LOWER(CONCAT(
        JSON_UNQUOTE(JSON_EXTRACT(source_metadata, '$.host')),
        ':',
        JSON_UNQUOTE(JSON_EXTRACT(source_metadata, '$.service'))
      )),
      alert_count = 1,
      last_alert_at = created_at
      WHERE source_metadata IS NOT NULL
        AND JSON_EXTRACT(source_metadata, '$.host') IS NOT NULL
        AND JSON_EXTRACT(source_metadata, '$.service') IS NOT NULL
        AND incident_key IS NULL
    `);
    if (updated.affectedRows > 0) {
      console.log(`    ✓ Backfilled incident_key for ${updated.affectedRows} existing monitoring ticket(s)`);
    }

    console.log(`    ✓ Incident correlation migration completed for ${tenantCode}`);

  } catch (error) {
    console.error(`    ✗ Migration error for ${tenantCode}:`, error.message);
    throw error;
  } finally {
    if (connection) connection.release();
  }
}

async function runMigrationAllTenants() {
  console.log('Running incident correlation migration for all tenants...');

  let masterConn;
  try {
    masterConn = await getMasterConnection();

    // Get all active tenants
    const [tenants] = await masterConn.query(
      "SELECT tenant_code FROM tenants WHERE status = 'active'"
    );

    console.log(`Found ${tenants.length} active tenant(s)`);

    for (const tenant of tenants) {
      await runMigration(tenant.tenant_code);
    }

    console.log('✅ Incident correlation migration completed for all tenants');

  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    if (masterConn) masterConn.release();
  }
}

module.exports = { runMigration, runMigrationAllTenants };

// Run if executed directly
if (require.main === module) {
  runMigrationAllTenants()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
