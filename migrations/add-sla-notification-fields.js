/**
 * Migration: Add SLA notification tracking fields to tickets + notifications table
 *
 * A) Adds notified_* columns to tickets for tracking threshold crossings
 * B) Creates notifications table as internal notification queue/log
 */

async function runMigration(tenantCode) {
  const { getTenantConnection } = require('../config/database');
  const connection = await getTenantConnection(tenantCode);

  try {
    // A) Add notification tracking columns to tickets table
    const columnsToAdd = [
      { name: 'notified_response_near_at', type: 'TIMESTAMP NULL' },
      { name: 'notified_response_breached_at', type: 'TIMESTAMP NULL' },
      { name: 'notified_response_past_at', type: 'TIMESTAMP NULL' },
      { name: 'notified_resolve_near_at', type: 'TIMESTAMP NULL' },
      { name: 'notified_resolve_breached_at', type: 'TIMESTAMP NULL' },
      { name: 'notified_resolve_past_at', type: 'TIMESTAMP NULL' }
    ];

    for (const col of columnsToAdd) {
      try {
        await connection.query(`ALTER TABLE tickets ADD COLUMN ${col.name} ${col.type}`);
        console.log(`✅ Added column ${col.name} to tickets for tenant ${tenantCode}`);
      } catch (error) {
        if (error.code === 'ER_DUP_FIELDNAME') {
          console.log(`ℹ️  Column ${col.name} already exists for tenant ${tenantCode}`);
        } else {
          throw error;
        }
      }
    }

    // B) Create notifications table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ticket_id INT NOT NULL,
        type VARCHAR(64) NOT NULL,
        severity VARCHAR(16) NOT NULL,
        message VARCHAR(255) NOT NULL,
        payload_json JSON NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        delivered_at TIMESTAMP NULL,
        INDEX idx_ticket_id (ticket_id),
        INDEX idx_type (type),
        INDEX idx_created_at (created_at),
        INDEX idx_delivered_at (delivered_at)
      )
    `);
    console.log(`✅ notifications table created for tenant ${tenantCode}`);

    return true;
  } catch (error) {
    if (error.code === 'ER_TABLE_EXISTS_ERROR') {
      console.log(`ℹ️  notifications table already exists for tenant ${tenantCode}`);
      return true;
    }
    console.error(`❌ Migration failed for tenant ${tenantCode}:`, error.message);
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = { runMigration };
