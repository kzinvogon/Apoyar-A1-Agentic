/**
 * Migration: Align tenant_subscriptions status with Stripe-native values
 *
 * Changes:
 * 1. Update status ENUM to Stripe-native: incomplete, trialing, active, past_due, unpaid, canceled
 * 2. Map existing values: trial → trialing, cancelled → canceled, expired → canceled
 * 3. Fix unique key: UNIQUE(tenant_id, status) → UNIQUE(tenant_id)
 *
 * Run with: node migrations/align-subscription-status-stripe.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

const config = {
  host: process.env.MYSQLHOST || process.env.MASTER_DB_HOST || process.env.DB_HOST,
  port: process.env.MYSQLPORT || process.env.MASTER_DB_PORT || process.env.DB_PORT || 3306,
  user: process.env.MYSQLUSER || process.env.MASTER_DB_USER || process.env.DB_USER,
  password: process.env.MYSQLPASSWORD || process.env.MASTER_DB_PASSWORD || process.env.DB_PASSWORD,
  database: process.env.MYSQLDATABASE || process.env.MASTER_DB_NAME || 'railway'
};

async function runMigration() {
  console.log('Aligning tenant_subscriptions status with Stripe-native values...');
  console.log(`Connecting to database: ${config.database}`);

  const connection = await mysql.createConnection(config);

  try {
    // Step 1: Check current state
    console.log('\n1. Checking current subscription statuses...');
    const [currentStatuses] = await connection.query(`
      SELECT status, COUNT(*) as count
      FROM tenant_subscriptions
      GROUP BY status
    `);
    console.log('   Current status distribution:');
    currentStatuses.forEach(row => {
      console.log(`     ${row.status}: ${row.count}`);
    });

    // Step 2: Map old values to Stripe-native equivalents
    console.log('\n2. Mapping old status values to Stripe-native...');

    // trial → trialing
    const [trialResult] = await connection.query(`
      UPDATE tenant_subscriptions SET status = 'trial' WHERE status = 'trial'
    `);
    // Note: We'll do the actual mapping during ENUM change

    // Step 3: Drop the problematic unique key
    console.log('\n3. Fixing unique key constraint...');

    // Check if the key exists
    const [keys] = await connection.query(`
      SELECT CONSTRAINT_NAME
      FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = 'tenant_subscriptions'
        AND CONSTRAINT_TYPE = 'UNIQUE'
        AND CONSTRAINT_NAME = 'unique_active_subscription'
    `, [config.database]);

    if (keys.length > 0) {
      // Before dropping, ensure we don't have duplicates per tenant
      const [duplicates] = await connection.query(`
        SELECT tenant_id, COUNT(*) as cnt
        FROM tenant_subscriptions
        GROUP BY tenant_id
        HAVING cnt > 1
      `);

      if (duplicates.length > 0) {
        console.log('   ⚠️  Found tenants with multiple subscriptions:');
        duplicates.forEach(d => console.log(`     tenant_id ${d.tenant_id}: ${d.cnt} rows`));
        console.log('   Keeping only the most recent subscription per tenant...');

        // Keep only the most recent subscription per tenant
        await connection.query(`
          DELETE t1 FROM tenant_subscriptions t1
          INNER JOIN tenant_subscriptions t2
          WHERE t1.tenant_id = t2.tenant_id
            AND t1.id < t2.id
        `);
        console.log('   ✅ Removed duplicate subscriptions');
      }

      await connection.query(`
        ALTER TABLE tenant_subscriptions
        DROP INDEX unique_active_subscription
      `);
      console.log('   ✅ Dropped old unique_active_subscription key');
    } else {
      console.log('   ℹ️  unique_active_subscription key not found (already removed?)');
    }

    // Step 4: Alter ENUM and map values in one transaction
    console.log('\n4. Altering status ENUM to Stripe-native values...');

    // MySQL requires us to modify ENUM carefully
    // First, temporarily allow all values by changing to VARCHAR
    await connection.query(`
      ALTER TABLE tenant_subscriptions
      MODIFY COLUMN status VARCHAR(50) DEFAULT 'trialing'
    `);
    console.log('   ✅ Temporarily converted to VARCHAR');

    // Map old values to new
    await connection.query(`UPDATE tenant_subscriptions SET status = 'trialing' WHERE status = 'trial'`);
    await connection.query(`UPDATE tenant_subscriptions SET status = 'canceled' WHERE status IN ('cancelled', 'expired')`);
    console.log('   ✅ Mapped: trial→trialing, cancelled→canceled, expired→canceled');

    // Now set the new ENUM
    await connection.query(`
      ALTER TABLE tenant_subscriptions
      MODIFY COLUMN status ENUM('incomplete', 'trialing', 'active', 'past_due', 'unpaid', 'canceled') DEFAULT 'trialing'
    `);
    console.log('   ✅ Set new Stripe-native ENUM');

    // Step 5: Add new unique constraint on tenant_id only
    console.log('\n5. Adding UNIQUE(tenant_id) constraint...');

    // Check if it already exists
    const [existingUnique] = await connection.query(`
      SELECT CONSTRAINT_NAME
      FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = 'tenant_subscriptions'
        AND CONSTRAINT_TYPE = 'UNIQUE'
        AND CONSTRAINT_NAME = 'unique_tenant_subscription'
    `, [config.database]);

    if (existingUnique.length === 0) {
      await connection.query(`
        ALTER TABLE tenant_subscriptions
        ADD CONSTRAINT unique_tenant_subscription UNIQUE (tenant_id)
      `);
      console.log('   ✅ Added UNIQUE(tenant_id) constraint');
    } else {
      console.log('   ℹ️  unique_tenant_subscription already exists');
    }

    // Step 6: Verify final state
    console.log('\n6. Verifying final state...');
    const [finalStatuses] = await connection.query(`
      SELECT status, COUNT(*) as count
      FROM tenant_subscriptions
      GROUP BY status
    `);
    console.log('   Final status distribution:');
    finalStatuses.forEach(row => {
      console.log(`     ${row.status}: ${row.count}`);
    });

    const [columnDef] = await connection.query(`
      SELECT COLUMN_TYPE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = 'tenant_subscriptions'
        AND COLUMN_NAME = 'status'
    `, [config.database]);
    console.log(`   Column definition: ${columnDef[0]?.COLUMN_TYPE}`);

    console.log('\n✅ Migration completed successfully!');
    console.log('\nNew status values align with Stripe subscription.status:');
    console.log('  incomplete - Checkout started but not completed');
    console.log('  trialing   - In trial period');
    console.log('  active     - Paid and current');
    console.log('  past_due   - Payment failed, in grace period');
    console.log('  unpaid     - Payment failed, grace period ended');
    console.log('  canceled   - Subscription ended');

  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    console.error(error);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

runMigration();
