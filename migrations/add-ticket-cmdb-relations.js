/**
 * Migration: Add ticket-CMDB relationship tables
 * Allows tickets to have multiple CMDB items and CIs with AI-powered matching
 */

const { getTenantConnection } = require('../config/database');

async function runMigration(tenantCode) {
  const connection = await getTenantConnection(tenantCode);

  try {
    console.log(`  Running ticket-CMDB relations migration for ${tenantCode}...`);

    // Create junction table for ticket-CMDB item relationships
    await connection.query(`
      CREATE TABLE IF NOT EXISTS ticket_cmdb_items (
        id INT PRIMARY KEY AUTO_INCREMENT,
        ticket_id INT NOT NULL,
        cmdb_item_id INT NOT NULL,
        relationship_type ENUM('affected', 'caused_by', 'related', 'resolved_by') DEFAULT 'affected',
        confidence_score DECIMAL(5,2) DEFAULT NULL,
        matched_by ENUM('manual', 'ai', 'auto') DEFAULT 'manual',
        match_reason TEXT,
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
        FOREIGN KEY (cmdb_item_id) REFERENCES cmdb_items(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id),
        UNIQUE KEY unique_ticket_cmdb (ticket_id, cmdb_item_id),
        INDEX idx_ticket (ticket_id),
        INDEX idx_cmdb_item (cmdb_item_id)
      )
    `);
    console.log('    ✓ Created ticket_cmdb_items table');

    // Create junction table for ticket-CI relationships
    await connection.query(`
      CREATE TABLE IF NOT EXISTS ticket_configuration_items (
        id INT PRIMARY KEY AUTO_INCREMENT,
        ticket_id INT NOT NULL,
        ci_id INT NOT NULL,
        relationship_type ENUM('affected', 'caused_by', 'related', 'resolved_by') DEFAULT 'affected',
        confidence_score DECIMAL(5,2) DEFAULT NULL,
        matched_by ENUM('manual', 'ai', 'auto') DEFAULT 'manual',
        match_reason TEXT,
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
        FOREIGN KEY (ci_id) REFERENCES configuration_items(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id),
        UNIQUE KEY unique_ticket_ci (ticket_id, ci_id),
        INDEX idx_ticket (ticket_id),
        INDEX idx_ci (ci_id)
      )
    `);
    console.log('    ✓ Created ticket_configuration_items table');

    // Create table to log AI CMDB matching attempts
    await connection.query(`
      CREATE TABLE IF NOT EXISTS ai_cmdb_match_log (
        id INT PRIMARY KEY AUTO_INCREMENT,
        ticket_id INT NOT NULL,
        matched_cmdb_ids JSON,
        matched_ci_ids JSON,
        ai_model VARCHAR(100),
        match_criteria TEXT,
        processing_time_ms INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
        INDEX idx_ticket (ticket_id)
      )
    `);
    console.log('    ✓ Created ai_cmdb_match_log table');

    console.log(`  ✓ Ticket-CMDB relations migration completed for ${tenantCode}`);

  } catch (error) {
    if (error.code === 'ER_TABLE_EXISTS_ERROR') {
      console.log('    Tables already exist, skipping...');
    } else {
      console.error(`  ✗ Migration error: ${error.message}`);
      throw error;
    }
  } finally {
    connection.release();
  }
}

module.exports = { runMigration };
