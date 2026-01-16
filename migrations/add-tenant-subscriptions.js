/**
 * Migration: Add Tenant Subscriptions Table
 * Links tenants to subscription plans with billing cycle tracking
 *
 * Run with: node migrations/add-tenant-subscriptions.js
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
  console.log('Starting tenant subscriptions migration...');
  console.log(`Connecting to database: ${config.database}`);

  const connection = await mysql.createConnection(config);

  try {
    // Create tenant_subscriptions table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS tenant_subscriptions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT NOT NULL,
        plan_id INT NOT NULL,
        status ENUM('trial', 'active', 'past_due', 'cancelled', 'expired') DEFAULT 'trial',

        -- Billing cycle
        billing_cycle ENUM('monthly', 'yearly') DEFAULT 'monthly',
        current_period_start DATE,
        current_period_end DATE,

        -- Trial info
        trial_start DATE,
        trial_end DATE,

        -- Usage tracking
        user_count INT DEFAULT 0,
        ticket_count_this_period INT DEFAULT 0,
        storage_used_gb DECIMAL(10,2) DEFAULT 0,

        -- Payment info (for future billing integration)
        stripe_subscription_id VARCHAR(255),
        stripe_customer_id VARCHAR(255),

        -- Plan change tracking
        previous_plan_id INT,
        plan_changed_at TIMESTAMP,

        -- Timestamps
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        cancelled_at TIMESTAMP NULL,

        -- Foreign keys
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        FOREIGN KEY (plan_id) REFERENCES subscription_plans(id),
        FOREIGN KEY (previous_plan_id) REFERENCES subscription_plans(id),

        -- Indexes
        INDEX idx_tenant_id (tenant_id),
        INDEX idx_plan_id (plan_id),
        INDEX idx_status (status),
        INDEX idx_current_period_end (current_period_end),

        -- One active subscription per tenant
        UNIQUE KEY unique_active_subscription (tenant_id, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅ Created tenant_subscriptions table');

    // Get existing tenants that don't have subscriptions
    const [tenants] = await connection.query(`
      SELECT t.id, t.tenant_code, t.company_name
      FROM tenants t
      LEFT JOIN tenant_subscriptions ts ON t.id = ts.tenant_id
      WHERE ts.id IS NULL AND t.status = 'active'
    `);

    if (tenants.length > 0) {
      // Get the professional plan as default (or starter if not found)
      const [plans] = await connection.query(`
        SELECT id, slug FROM subscription_plans WHERE slug IN ('professional', 'starter') ORDER BY display_order DESC LIMIT 1
      `);

      if (plans.length > 0) {
        const defaultPlanId = plans[0].id;
        const defaultPlanSlug = plans[0].slug;

        // Calculate trial period (14 days)
        const trialStart = new Date();
        const trialEnd = new Date();
        trialEnd.setDate(trialEnd.getDate() + 14);

        for (const tenant of tenants) {
          try {
            await connection.query(`
              INSERT INTO tenant_subscriptions (
                tenant_id, plan_id, status, billing_cycle,
                trial_start, trial_end, current_period_start, current_period_end
              ) VALUES (?, ?, 'trial', 'monthly', ?, ?, ?, ?)
            `, [
              tenant.id,
              defaultPlanId,
              trialStart,
              trialEnd,
              trialStart,
              trialEnd
            ]);
            console.log(`   ✅ Created trial subscription for ${tenant.company_name || tenant.tenant_code} (${defaultPlanSlug} plan)`);
          } catch (e) {
            // Might fail on unique constraint if partial data exists
            console.log(`   ⚠️ Skipped ${tenant.tenant_code}: ${e.message}`);
          }
        }
        console.log(`✅ Created subscriptions for ${tenants.length} existing tenants`);
      } else {
        console.log('⚠️ No plans found - run enhance-subscription-plans.js first');
      }
    } else {
      console.log('ℹ️ All tenants already have subscriptions or no active tenants found');
    }

    // Create subscription_history table for audit trail
    await connection.query(`
      CREATE TABLE IF NOT EXISTS subscription_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        subscription_id INT NOT NULL,
        tenant_id INT NOT NULL,
        action ENUM('created', 'upgraded', 'downgraded', 'cancelled', 'reactivated', 'renewed', 'trial_started', 'trial_ended') NOT NULL,
        from_plan_id INT,
        to_plan_id INT,
        from_status VARCHAR(50),
        to_status VARCHAR(50),
        notes TEXT,
        performed_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        INDEX idx_subscription_id (subscription_id),
        INDEX idx_tenant_id (tenant_id),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅ Created subscription_history table');

    console.log('\n✅ Migration completed successfully!');
    console.log('\nTenant subscriptions are now linked to plans.');
    console.log('Default: All existing tenants get a 14-day trial on Professional plan.');

  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

runMigration();
