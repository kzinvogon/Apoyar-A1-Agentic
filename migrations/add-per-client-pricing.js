/**
 * Migration: Add Per-Client Pricing Support
 * Adds pricing model fields to support both per-technician and per-client billing
 *
 * Run with: node migrations/add-per-client-pricing.js
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
  console.log('Starting per-client pricing migration...');
  console.log(`Connecting to database: ${config.database}`);

  const connection = await mysql.createConnection(config);

  try {
    // Add pricing model columns to subscription_plans
    console.log('Adding pricing model columns...');

    // Check if columns already exist
    const [columns] = await connection.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'subscription_plans' AND COLUMN_NAME = 'pricing_model'
    `, [config.database]);

    if (columns.length === 0) {
      // Add pricing_model column
      await connection.query(`
        ALTER TABLE subscription_plans
        ADD COLUMN pricing_model ENUM('per_technician', 'per_client', 'flat') DEFAULT 'per_technician' AFTER price_per_user
      `);
      console.log('✅ Added pricing_model column');

      // Add per-client pricing columns
      await connection.query(`
        ALTER TABLE subscription_plans
        ADD COLUMN price_per_client DECIMAL(10,2) DEFAULT 0 AFTER pricing_model
      `);
      console.log('✅ Added price_per_client column');

      await connection.query(`
        ALTER TABLE subscription_plans
        ADD COLUMN base_clients_included INT DEFAULT 0 AFTER price_per_client
      `);
      console.log('✅ Added base_clients_included column');

      await connection.query(`
        ALTER TABLE subscription_plans
        ADD COLUMN price_additional_client DECIMAL(10,2) DEFAULT 0 AFTER base_clients_included
      `);
      console.log('✅ Added price_additional_client column');

      // Add unlimited_technicians flag for per-client plans
      await connection.query(`
        ALTER TABLE subscription_plans
        ADD COLUMN unlimited_technicians BOOLEAN DEFAULT FALSE AFTER price_additional_client
      `);
      console.log('✅ Added unlimited_technicians column');
    } else {
      console.log('ℹ️ Pricing model columns already exist');
    }

    // Update existing plans to be per_technician
    await connection.query(`
      UPDATE subscription_plans
      SET pricing_model = 'per_technician'
      WHERE pricing_model IS NULL OR pricing_model = ''
    `);
    console.log('✅ Updated existing plans to per_technician model');

    // Check if per-client plan exists
    const [existingPerClient] = await connection.query(`
      SELECT id FROM subscription_plans WHERE slug = 'msp-per-client'
    `);

    if (existingPerClient.length === 0) {
      // Get MSP features to copy to per-client plan
      const [mspPlan] = await connection.query(`
        SELECT features FROM subscription_plans WHERE slug = 'msp'
      `);

      // Ensure features is a JSON string
      let mspFeatures = '[]';
      if (mspPlan.length > 0 && mspPlan[0].features) {
        mspFeatures = typeof mspPlan[0].features === 'string'
          ? mspPlan[0].features
          : JSON.stringify(mspPlan[0].features);
      }

      // Create per-client plan
      await connection.query(`
        INSERT INTO subscription_plans (
          slug, name, display_name, tagline, description,
          price_monthly, price_yearly, price_per_user,
          pricing_model, price_per_client, base_clients_included, price_additional_client,
          unlimited_technicians, features, feature_limits,
          display_order, is_active, is_featured, badge_text
        ) VALUES (
          'msp-per-client',
          'MSP Per-Client',
          'Per-Client',
          'Perfect for MSPs who want unlimited technicians',
          'All Pro features with per-client billing model. Ideal for MSPs managing multiple client environments.',
          89.00,
          890.00,
          0,
          'per_client',
          89.00,
          10,
          5.00,
          TRUE,
          ?,
          '{"max_clients": -1, "max_technicians": -1}',
          4,
          TRUE,
          FALSE,
          'UNLIMITED TECHS'
        )
      `, [mspFeatures]);
      console.log('✅ Created MSP Per-Client plan');
    } else {
      console.log('ℹ️ MSP Per-Client plan already exists');
    }

    // Add pricing_model to tenant_subscriptions if not exists
    const [subColumns] = await connection.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tenant_subscriptions' AND COLUMN_NAME = 'pricing_model'
    `, [config.database]);

    if (subColumns.length === 0) {
      await connection.query(`
        ALTER TABLE tenant_subscriptions
        ADD COLUMN pricing_model ENUM('per_technician', 'per_client', 'flat') DEFAULT 'per_technician' AFTER billing_cycle
      `);
      console.log('✅ Added pricing_model to tenant_subscriptions');

      await connection.query(`
        ALTER TABLE tenant_subscriptions
        ADD COLUMN client_count INT DEFAULT 0 AFTER user_count
      `);
      console.log('✅ Added client_count to tenant_subscriptions');
    } else {
      console.log('ℹ️ tenant_subscriptions pricing columns already exist');
    }

    console.log('\n✅ Migration completed successfully!');
    console.log('\nPricing models now supported:');
    console.log('  - per_technician: $X per technician per month');
    console.log('  - per_client: Base price includes N clients, +$X per additional client');
    console.log('  - flat: Fixed price regardless of usage');

  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

runMigration();
