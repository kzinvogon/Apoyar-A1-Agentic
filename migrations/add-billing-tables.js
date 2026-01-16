/**
 * Migration: Add billing tables for subscription onboarding
 *
 * Creates:
 * - billing_transactions: Payment history
 * - payment_methods: Saved credit cards
 * - signup_sessions: Track incomplete signups
 * - Adds Stripe price columns to subscription_plans
 *
 * Run with: node migrations/add-billing-tables.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

const config = {
  host: process.env.MASTER_DB_HOST || process.env.MYSQLHOST || process.env.DB_HOST,
  port: process.env.MASTER_DB_PORT || process.env.MYSQLPORT || process.env.DB_PORT || 3306,
  user: process.env.MASTER_DB_USER || process.env.MYSQLUSER || process.env.DB_USER,
  password: process.env.MASTER_DB_PASSWORD || process.env.MYSQLPASSWORD || process.env.DB_PASSWORD,
  database: process.env.MASTER_DB_NAME || process.env.MYSQLDATABASE || 'railway'
};

async function runMigration() {
  console.log('Adding billing tables to master database...');
  console.log(`Connecting to database: ${config.database}`);

  const connection = await mysql.createConnection(config);

  try {
    // 1. Create billing_transactions table
    console.log('\n1. Creating billing_transactions table...');
    await connection.query(`
      CREATE TABLE IF NOT EXISTS billing_transactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT NOT NULL,
        subscription_id INT,
        type ENUM('charge', 'refund', 'credit', 'adjustment') NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        currency_code VARCHAR(3) DEFAULT 'USD',
        description TEXT,
        status ENUM('pending', 'succeeded', 'failed', 'refunded', 'disputed') DEFAULT 'pending',
        stripe_payment_intent_id VARCHAR(255),
        stripe_invoice_id VARCHAR(255),
        stripe_charge_id VARCHAR(255),
        failure_code VARCHAR(100),
        failure_message TEXT,
        transaction_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        INDEX idx_tenant_id (tenant_id),
        INDEX idx_subscription_id (subscription_id),
        INDEX idx_status (status),
        INDEX idx_stripe_payment_intent (stripe_payment_intent_id),
        INDEX idx_transaction_date (transaction_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('  ✅ billing_transactions table created');

    // 2. Create payment_methods table
    console.log('\n2. Creating payment_methods table...');
    await connection.query(`
      CREATE TABLE IF NOT EXISTS payment_methods (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT NOT NULL,
        stripe_payment_method_id VARCHAR(255) NOT NULL,
        stripe_customer_id VARCHAR(255) NOT NULL,
        card_brand VARCHAR(50),
        card_last_four VARCHAR(4),
        card_exp_month INT,
        card_exp_year INT,
        is_default BOOLEAN DEFAULT FALSE,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        INDEX idx_tenant_id (tenant_id),
        INDEX idx_stripe_customer (stripe_customer_id),
        INDEX idx_is_default (is_default, tenant_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('  ✅ payment_methods table created');

    // 3. Create signup_sessions table
    console.log('\n3. Creating signup_sessions table...');
    await connection.query(`
      CREATE TABLE IF NOT EXISTS signup_sessions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_token VARCHAR(255) UNIQUE NOT NULL,
        email VARCHAR(255) NOT NULL,
        tenant_name VARCHAR(100),
        tenant_code VARCHAR(50),
        num_technicians INT,
        num_clients INT,
        selected_plan_slug VARCHAR(50),
        step ENUM('quiz', 'plan', 'password', 'completed', 'abandoned') DEFAULT 'quiz',
        ip_address VARCHAR(45),
        user_agent TEXT,
        referrer TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        expires_at TIMESTAMP,
        completed_at TIMESTAMP,
        INDEX idx_session_token (session_token),
        INDEX idx_email (email),
        INDEX idx_expires_at (expires_at),
        INDEX idx_step (step)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('  ✅ signup_sessions table created');

    // 4. Add Stripe columns to subscription_plans (if table exists)
    console.log('\n4. Adding Stripe price columns to subscription_plans...');

    // Check if subscription_plans table exists
    const [tables] = await connection.query(`
      SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'subscription_plans'
    `, [config.database]);

    if (tables.length === 0) {
      console.log('  ⚠️ subscription_plans table does not exist - skipping (will be added when Plans system is set up)');
    } else {
      // Check if columns exist
      const [cols] = await connection.query(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'subscription_plans'
        AND COLUMN_NAME IN ('stripe_price_monthly', 'stripe_price_yearly', 'stripe_product_id')
      `, [config.database]);

      const existingCols = cols.map(c => c.COLUMN_NAME);

      if (!existingCols.includes('stripe_product_id')) {
        await connection.query(`
          ALTER TABLE subscription_plans
          ADD COLUMN stripe_product_id VARCHAR(255)
        `);
        console.log('  ✅ Added stripe_product_id column');
      } else {
        console.log('  ℹ️ stripe_product_id column already exists');
      }

      if (!existingCols.includes('stripe_price_monthly')) {
        await connection.query(`
          ALTER TABLE subscription_plans
          ADD COLUMN stripe_price_monthly VARCHAR(255)
        `);
        console.log('  ✅ Added stripe_price_monthly column');
      } else {
        console.log('  ℹ️ stripe_price_monthly column already exists');
      }

      if (!existingCols.includes('stripe_price_yearly')) {
        await connection.query(`
          ALTER TABLE subscription_plans
          ADD COLUMN stripe_price_yearly VARCHAR(255)
        `);
        console.log('  ✅ Added stripe_price_yearly column');
      } else {
        console.log('  ℹ️ stripe_price_yearly column already exists');
      }
    }

    // 5. Add signup_source column to tenants table (if table exists)
    console.log('\n5. Adding signup tracking columns to tenants...');

    const [tenantTables] = await connection.query(`
      SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tenants'
    `, [config.database]);

    if (tenantTables.length === 0) {
      console.log('  ⚠️ tenants table does not exist - skipping');
    } else {
      const [tenantCols] = await connection.query(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tenants'
        AND COLUMN_NAME IN ('signup_source', 'signup_session_id', 'stripe_customer_id')
      `, [config.database]);

      const existingTenantCols = tenantCols.map(c => c.COLUMN_NAME);

      if (!existingTenantCols.includes('signup_source')) {
        await connection.query(`
          ALTER TABLE tenants
          ADD COLUMN signup_source ENUM('manual', 'marketing_trial', 'api', 'import') DEFAULT 'manual'
        `);
        console.log('  ✅ Added signup_source column');
      } else {
        console.log('  ℹ️ signup_source column already exists');
      }

      if (!existingTenantCols.includes('signup_session_id')) {
        await connection.query(`
          ALTER TABLE tenants
          ADD COLUMN signup_session_id INT
        `);
        console.log('  ✅ Added signup_session_id column');
      } else {
        console.log('  ℹ️ signup_session_id column already exists');
      }

      if (!existingTenantCols.includes('stripe_customer_id')) {
        await connection.query(`
          ALTER TABLE tenants
          ADD COLUMN stripe_customer_id VARCHAR(255)
        `);
        console.log('  ✅ Added stripe_customer_id column');
      } else {
        console.log('  ℹ️ stripe_customer_id column already exists');
      }
    }

    // 6. Add payment_method_id to tenant_subscriptions (if table exists)
    console.log('\n6. Adding payment columns to tenant_subscriptions...');

    const [subTables] = await connection.query(`
      SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tenant_subscriptions'
    `, [config.database]);

    if (subTables.length === 0) {
      console.log('  ⚠️ tenant_subscriptions table does not exist - skipping');
    } else {
      const [subCols] = await connection.query(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tenant_subscriptions'
        AND COLUMN_NAME IN ('payment_method_id', 'next_billing_date', 'auto_renew')
      `, [config.database]);

      const existingSubCols = subCols.map(c => c.COLUMN_NAME);

      if (!existingSubCols.includes('payment_method_id')) {
        await connection.query(`
          ALTER TABLE tenant_subscriptions
          ADD COLUMN payment_method_id INT
        `);
        console.log('  ✅ Added payment_method_id column');
      } else {
        console.log('  ℹ️ payment_method_id column already exists');
      }

      if (!existingSubCols.includes('next_billing_date')) {
        await connection.query(`
          ALTER TABLE tenant_subscriptions
          ADD COLUMN next_billing_date DATE
        `);
        console.log('  ✅ Added next_billing_date column');
      } else {
        console.log('  ℹ️ next_billing_date column already exists');
      }

      if (!existingSubCols.includes('auto_renew')) {
        await connection.query(`
          ALTER TABLE tenant_subscriptions
          ADD COLUMN auto_renew BOOLEAN DEFAULT TRUE
        `);
        console.log('  ✅ Added auto_renew column');
      } else {
        console.log('  ℹ️ auto_renew column already exists');
      }
    }

    console.log('\n✅ Migration completed successfully!');

  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

runMigration();
