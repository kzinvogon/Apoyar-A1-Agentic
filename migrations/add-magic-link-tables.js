/**
 * Migration: Add magic link auth tables to master DB
 * Tables: tenant_email_domains, auth_magic_links, auth_events
 */
const { getMasterConnection } = require('../config/database');

async function runMigration() {
  const connection = await getMasterConnection();
  try {
    // tenant_email_domains — maps email domains to tenants
    await connection.query(`
      CREATE TABLE IF NOT EXISTS tenant_email_domains (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT NOT NULL,
        domain VARCHAR(255) NOT NULL,
        is_verified TINYINT(1) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_domain (domain),
        INDEX idx_tenant_id (tenant_id)
      )
    `);
    console.log('Created tenant_email_domains table');

    // auth_magic_links — stores hashed magic link tokens
    await connection.query(`
      CREATE TABLE IF NOT EXISTS auth_magic_links (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        token_hash VARCHAR(64) NOT NULL,
        tenant_id INT NOT NULL,
        purpose ENUM('login','signup') DEFAULT 'login',
        requested_host VARCHAR(255),
        expires_at DATETIME NOT NULL,
        consumed_at DATETIME NULL,
        status ENUM('pending','consumed','expired','revoked') DEFAULT 'pending',
        attempts_count INT DEFAULT 0,
        ip_hash VARCHAR(64),
        user_agent VARCHAR(512),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_token (token_hash),
        INDEX idx_email (email),
        INDEX idx_status_expires (status, expires_at)
      )
    `);
    console.log('Created auth_magic_links table');

    // auth_events — audit trail for auth actions
    await connection.query(`
      CREATE TABLE IF NOT EXISTS auth_events (
        id INT AUTO_INCREMENT PRIMARY KEY,
        event_type VARCHAR(50) NOT NULL,
        email VARCHAR(255),
        tenant_id INT,
        metadata JSON,
        ip_hash VARCHAR(64),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_event_type (event_type),
        INDEX idx_email (email),
        INDEX idx_created_at (created_at)
      )
    `);
    console.log('Created auth_events table');

  } finally {
    connection.release();
  }
}

module.exports = { runMigration };

if (require.main === module) {
  runMigration()
    .then(() => process.exit(0))
    .catch(err => { console.error(err); process.exit(1); });
}
