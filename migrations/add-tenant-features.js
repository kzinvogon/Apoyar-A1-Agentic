/**
 * Migration: Add tenant_features table
 *
 * Creates a feature flag table for tenant-level capability control.
 * Supports plan-based features, overrides, trials, and system flags.
 */

const { getTenantConnection } = require('../config/database');

// Import plan definitions for seeding
const STARTER_FEATURES = require('../plans/starter');
const PROFESSIONAL_FEATURES = require('../plans/professional');
const MSP_FEATURES = require('../plans/msp');

async function migrate(tenantCode, planType = 'professional') {
  const connection = await getTenantConnection(tenantCode);

  try {
    console.log(`[${tenantCode}] Creating tenant_features table...`);

    // Create the tenant_features table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS tenant_features (
        id INT AUTO_INCREMENT PRIMARY KEY,
        feature_key VARCHAR(100) NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT false,
        source ENUM('plan', 'override', 'trial', 'system') DEFAULT 'plan',
        expires_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE INDEX idx_feature_key (feature_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Check if expires_at column exists, add if not
    const [columns] = await connection.query(`SHOW COLUMNS FROM tenant_features LIKE 'expires_at'`);
    if (columns.length === 0) {
      console.log(`[${tenantCode}] Adding expires_at column...`);
      await connection.query(`
        ALTER TABLE tenant_features
        ADD COLUMN expires_at TIMESTAMP NULL AFTER source
      `);
    }

    // Get existing features to avoid overwriting overrides
    const [existingFeatures] = await connection.query(`
      SELECT feature_key, source FROM tenant_features WHERE source IN ('override', 'trial')
    `);
    const preservedKeys = new Set(existingFeatures.map(f => f.feature_key));

    // Determine which features to seed based on plan
    let planFeatures;
    switch (planType.toLowerCase()) {
      case 'starter':
        planFeatures = STARTER_FEATURES;
        break;
      case 'msp':
        planFeatures = MSP_FEATURES;
        break;
      case 'professional':
      default:
        planFeatures = PROFESSIONAL_FEATURES;
        break;
    }

    console.log(`[${tenantCode}] Seeding features for plan: ${planType} (${planFeatures.length} features)...`);

    // Get all possible feature keys from MSP (the superset)
    const allFeatureKeys = MSP_FEATURES;

    // Seed features - enabled if in plan, disabled otherwise
    for (const featureKey of allFeatureKeys) {
      // Skip if this feature has an override or trial
      if (preservedKeys.has(featureKey)) {
        console.log(`  ℹ️  Preserving override/trial for: ${featureKey}`);
        continue;
      }

      const enabled = planFeatures.includes(featureKey);
      await connection.query(`
        INSERT INTO tenant_features (feature_key, enabled, source)
        VALUES (?, ?, 'plan')
        ON DUPLICATE KEY UPDATE
          enabled = IF(source = 'plan', VALUES(enabled), enabled),
          updated_at = CURRENT_TIMESTAMP
      `, [featureKey, enabled]);
    }

    console.log(`[${tenantCode}] tenant_features migration completed successfully`);
    return { success: true };

  } catch (error) {
    console.error(`[${tenantCode}] Error in tenant_features migration:`, error);
    throw error;
  } finally {
    connection.release();
  }
}

// Run migration if called directly
if (require.main === module) {
  const tenantCode = process.argv[2] || 'apoyar';
  const planType = process.argv[3] || 'professional';
  migrate(tenantCode, planType)
    .then(() => {
      console.log('Migration completed');
      process.exit(0);
    })
    .catch(err => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}

module.exports = { migrate };
