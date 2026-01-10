/**
 * Migration: Add SLA Definitions and Business Hours tables
 * Task 1: Data Model for Business Hours + SLA Definition
 */

async function runMigration(tenantCode) {
  const { getTenantConnection } = require('../config/database');
  const connection = await getTenantConnection(tenantCode);

  try {
    // Create business_hours_profiles table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS business_hours_profiles (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        timezone VARCHAR(100) NOT NULL DEFAULT 'UTC',
        days_of_week JSON NOT NULL,
        start_time TIME NOT NULL DEFAULT '09:00:00',
        end_time TIME NOT NULL DEFAULT '17:00:00',
        is_24x7 BOOLEAN DEFAULT FALSE,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_name (name)
      )
    `);
    console.log(`✅ business_hours_profiles table created for tenant ${tenantCode}`);

    // Create sla_definitions table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS sla_definitions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        business_hours_profile_id INT,
        response_target_minutes INT NOT NULL DEFAULT 60,
        resolve_target_minutes INT NOT NULL DEFAULT 480,
        near_breach_percent INT NOT NULL DEFAULT 85,
        past_breach_percent INT NOT NULL DEFAULT 120,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_name (name),
        FOREIGN KEY (business_hours_profile_id) REFERENCES business_hours_profiles(id) ON DELETE RESTRICT
      )
    `);
    console.log(`✅ sla_definitions table created for tenant ${tenantCode}`);

    // Insert default business hours profile
    await connection.query(`
      INSERT IGNORE INTO business_hours_profiles (name, timezone, days_of_week, start_time, end_time, is_24x7)
      VALUES
        ('Standard Business Hours', 'Australia/Sydney', '[1,2,3,4,5]', '09:00:00', '17:00:00', FALSE),
        ('24x7 Support', 'UTC', '[1,2,3,4,5,6,7]', '00:00:00', '23:59:59', TRUE)
    `);
    console.log(`✅ Default business hours profiles seeded for tenant ${tenantCode}`);

    // Insert default SLA definitions
    await connection.query(`
      INSERT IGNORE INTO sla_definitions (name, description, business_hours_profile_id, response_target_minutes, resolve_target_minutes)
      VALUES
        ('Basic SLA', 'Standard support SLA', 1, 240, 2880),
        ('Premium SLA', 'Priority support with faster response', 1, 60, 480),
        ('Critical SLA', '24x7 critical system support', 2, 15, 120)
    `);
    console.log(`✅ Default SLA definitions seeded for tenant ${tenantCode}`);

    // FK constraint fix disabled - was causing connection issues
    // The soft delete logic in routes/sla.js handles the protection

    return true;
  } catch (error) {
    if (error.code === 'ER_TABLE_EXISTS_ERROR') {
      console.log(`ℹ️  SLA tables already exist for tenant ${tenantCode}`);
      return true;
    }
    console.error(`❌ Migration failed for tenant ${tenantCode}:`, error.message);
    throw error;
  }
}

module.exports = { runMigration };
