/**
 * Migration: Add Regional Pricing Support
 * - Creates currencies table with exchange rates and rounding rules
 * - Creates plan_price_overrides table for manual price overrides
 * - Auto-conversion with rounding, override for localization
 *
 * Run with: node migrations/add-regional-pricing.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

const config = {
  host: process.env.MYSQLHOST || process.env.DB_HOST,
  port: process.env.MYSQLPORT || process.env.DB_PORT || 3306,
  user: process.env.MYSQLUSER || process.env.DB_USER,
  password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD,
  database: process.env.MYSQLDATABASE || 'railway'
};

async function runMigration() {
  console.log('Starting regional pricing migration...');
  console.log(`Connecting to database: ${config.database}`);

  const connection = await mysql.createConnection(config);

  try {
    // Create currencies table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS currencies (
        code VARCHAR(3) PRIMARY KEY,
        name VARCHAR(50) NOT NULL,
        symbol VARCHAR(5) NOT NULL,
        exchange_rate DECIMAL(10,4) NOT NULL DEFAULT 1.0000,
        round_to DECIMAL(10,2) DEFAULT 1.00,
        is_base BOOLEAN DEFAULT FALSE,
        is_active BOOLEAN DEFAULT TRUE,
        display_order INT DEFAULT 0,
        last_rate_update TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_is_active (is_active),
        INDEX idx_display_order (display_order)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅ Created currencies table');

    // Create plan_price_overrides table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS plan_price_overrides (
        id INT AUTO_INCREMENT PRIMARY KEY,
        plan_id INT NOT NULL,
        currency_code VARCHAR(3) NOT NULL,
        price_monthly DECIMAL(10,2) NULL,
        price_yearly DECIMAL(10,2) NULL,
        price_per_user DECIMAL(10,2) NULL,
        price_per_client DECIMAL(10,2) NULL,
        price_additional_client DECIMAL(10,2) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (plan_id) REFERENCES subscription_plans(id) ON DELETE CASCADE,
        FOREIGN KEY (currency_code) REFERENCES currencies(code) ON DELETE CASCADE,
        UNIQUE KEY unique_plan_currency (plan_id, currency_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅ Created plan_price_overrides table');

    // Check if currencies already seeded
    const [existing] = await connection.query('SELECT COUNT(*) as count FROM currencies');

    if (existing[0].count === 0) {
      // Seed currencies with approximate exchange rates (AUD as base)
      // Rates as of early 2025 - should be updated periodically
      await connection.query(`
        INSERT INTO currencies (code, name, symbol, exchange_rate, round_to, is_base, is_active, display_order) VALUES
        ('AUD', 'Australian Dollar', 'A$', 1.0000, 1.00, TRUE, TRUE, 1),
        ('USD', 'US Dollar', '$', 0.6500, 1.00, FALSE, TRUE, 2),
        ('GBP', 'British Pound', '£', 0.5100, 1.00, FALSE, TRUE, 3),
        ('EUR', 'Euro', '€', 0.5900, 1.00, FALSE, TRUE, 4),
        ('INR', 'Indian Rupee', '₹', 54.0000, 49.00, FALSE, TRUE, 5),
        ('NZD', 'New Zealand Dollar', 'NZ$', 1.1000, 1.00, FALSE, TRUE, 6),
        ('CAD', 'Canadian Dollar', 'CA$', 0.8800, 1.00, FALSE, TRUE, 7),
        ('SGD', 'Singapore Dollar', 'S$', 0.8700, 1.00, FALSE, TRUE, 8)
      `);
      console.log('✅ Seeded currencies with exchange rates');
    } else {
      console.log('ℹ️ Currencies already exist, skipping seed');
    }

    // Add base_currency to subscription_plans if not exists
    const [planCols] = await connection.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'subscription_plans' AND COLUMN_NAME = 'base_currency'
    `, [config.database]);

    if (planCols.length === 0) {
      await connection.query(`
        ALTER TABLE subscription_plans
        ADD COLUMN base_currency VARCHAR(3) DEFAULT 'AUD' AFTER badge_text
      `);
      console.log('✅ Added base_currency column to subscription_plans');
    }

    // Add preferred_currency to tenant_subscriptions if not exists
    const [subCols] = await connection.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tenant_subscriptions' AND COLUMN_NAME = 'currency_code'
    `, [config.database]);

    if (subCols.length === 0) {
      await connection.query(`
        ALTER TABLE tenant_subscriptions
        ADD COLUMN currency_code VARCHAR(3) DEFAULT 'AUD' AFTER client_count
      `);
      console.log('✅ Added currency_code column to tenant_subscriptions');
    }

    console.log('\n✅ Migration completed successfully!');
    console.log('\nRegional pricing now supported:');
    console.log('  - Auto-conversion from base currency (AUD)');
    console.log('  - Rounding to nearest value (e.g., ₹49 for INR)');
    console.log('  - Manual overrides per plan/currency');
    console.log('\nSeeded currencies: AUD, USD, GBP, EUR, INR, NZD, CAD, SGD');

  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

runMigration();
