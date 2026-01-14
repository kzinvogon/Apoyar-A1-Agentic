/**
 * Feature Flags Service
 *
 * Provides tenant-level feature flag resolution with precedence:
 * override > trial > plan > system
 *
 * Usage:
 *   const { getTenantFeatures, hasFeature, requireFeature } = require('./services/feature-flags');
 *
 *   // Get all features for a tenant
 *   const features = await getTenantFeatures(tenantCode);
 *
 *   // Check a single feature
 *   const hasTeams = await hasFeature(tenantCode, 'integrations.teams');
 *
 *   // Require a feature (throws if disabled)
 *   await requireFeature(tenantCode, 'integrations.teams');
 */

const { getTenantConnection } = require('../config/database');
const { getMinimumPlanForFeature, getAllFeatureKeys } = require('../plans');

// Request-scoped cache (WeakMap keyed by request or connection)
// For simple per-request caching, we use a Map with TTL
const featureCache = new Map();
const CACHE_TTL_MS = 5000; // 5 second cache for hot paths

/**
 * Get all features for a tenant
 * @param {string} tenantCode - Tenant code
 * @param {boolean} useCache - Whether to use cache (default: true for requests, false for mutations)
 * @returns {Promise<Object>} Map of feature_key -> boolean
 */
async function getTenantFeatures(tenantCode, useCache = true) {
  const cacheKey = `features:${tenantCode}`;

  // Check cache
  if (useCache) {
    const cached = featureCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.features;
    }
  }

  const connection = await getTenantConnection(tenantCode);

  try {
    // Get all features from database
    const [rows] = await connection.query(`
      SELECT feature_key, enabled, source, expires_at
      FROM tenant_features
      ORDER BY feature_key
    `);

    // Build feature map
    const features = {};
    const now = new Date();

    for (const row of rows) {
      // Check if trial has expired
      if (row.source === 'trial' && row.expires_at && new Date(row.expires_at) < now) {
        // Trial expired - treat as disabled unless there's a plan default
        features[row.feature_key] = false;
        continue;
      }

      features[row.feature_key] = !!row.enabled;
    }

    // Ensure all known features have a value (default to false if not in DB)
    const allKeys = getAllFeatureKeys();
    for (const key of allKeys) {
      if (!(key in features)) {
        features[key] = false;
      }
    }

    // Cache the result
    featureCache.set(cacheKey, {
      features,
      expiresAt: Date.now() + CACHE_TTL_MS
    });

    return features;

  } finally {
    connection.release();
  }
}

/**
 * Check if a tenant has a specific feature enabled
 * @param {string} tenantCode - Tenant code
 * @param {string} featureKey - Feature key to check
 * @returns {Promise<boolean>}
 */
async function hasFeature(tenantCode, featureKey) {
  const features = await getTenantFeatures(tenantCode);
  return features[featureKey] === true;
}

/**
 * Require a feature - throws FeatureDisabledError if not enabled
 * @param {string} tenantCode - Tenant code
 * @param {string} featureKey - Feature key to require
 * @throws {FeatureDisabledError}
 */
async function requireFeature(tenantCode, featureKey) {
  const enabled = await hasFeature(tenantCode, featureKey);
  if (!enabled) {
    const minimumPlan = getMinimumPlanForFeature(featureKey);
    throw new FeatureDisabledError(featureKey, minimumPlan);
  }
}

/**
 * Get feature details (for admin/debugging)
 * @param {string} tenantCode - Tenant code
 * @param {string} featureKey - Feature key
 * @returns {Promise<Object|null>}
 */
async function getFeatureDetails(tenantCode, featureKey) {
  const connection = await getTenantConnection(tenantCode);

  try {
    const [rows] = await connection.query(`
      SELECT feature_key, enabled, source, expires_at, created_at, updated_at
      FROM tenant_features
      WHERE feature_key = ?
    `, [featureKey]);

    if (rows.length === 0) return null;

    const row = rows[0];
    const minimumPlan = getMinimumPlanForFeature(featureKey);

    return {
      featureKey: row.feature_key,
      enabled: !!row.enabled,
      source: row.source,
      expiresAt: row.expires_at,
      minimumPlan,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };

  } finally {
    connection.release();
  }
}

/**
 * Set feature override (admin only)
 * @param {string} tenantCode - Tenant code
 * @param {string} featureKey - Feature key
 * @param {boolean} enabled - Enable or disable
 * @param {string} source - 'override' or 'trial'
 * @param {Date|null} expiresAt - Expiration date for trials
 * @returns {Promise<Object>}
 */
async function setFeatureOverride(tenantCode, featureKey, enabled, source = 'override', expiresAt = null) {
  const connection = await getTenantConnection(tenantCode);

  try {
    await connection.query(`
      INSERT INTO tenant_features (feature_key, enabled, source, expires_at)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        enabled = VALUES(enabled),
        source = VALUES(source),
        expires_at = VALUES(expires_at),
        updated_at = CURRENT_TIMESTAMP
    `, [featureKey, enabled, source, expiresAt]);

    // Invalidate cache
    featureCache.delete(`features:${tenantCode}`);

    return {
      featureKey,
      enabled,
      source,
      expiresAt
    };

  } finally {
    connection.release();
  }
}

/**
 * Remove feature override (revert to plan default)
 * @param {string} tenantCode - Tenant code
 * @param {string} featureKey - Feature key
 * @returns {Promise<boolean>}
 */
async function removeFeatureOverride(tenantCode, featureKey) {
  const connection = await getTenantConnection(tenantCode);

  try {
    // Get the plan default
    const { getPlanFeatures } = require('../plans');
    const planFeatures = getPlanFeatures('professional'); // TODO: Get tenant's actual plan

    const enabled = planFeatures.includes(featureKey);

    await connection.query(`
      UPDATE tenant_features
      SET enabled = ?, source = 'plan', expires_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE feature_key = ?
    `, [enabled, featureKey]);

    // Invalidate cache
    featureCache.delete(`features:${tenantCode}`);

    return true;

  } finally {
    connection.release();
  }
}

/**
 * Get features grouped by category for UI display
 * @param {string} tenantCode - Tenant code
 * @returns {Promise<Object>}
 */
async function getFeaturesByCategory(tenantCode) {
  const features = await getTenantFeatures(tenantCode, false);

  const categories = {
    integrations: {},
    api: {},
    customer: {},
    sla: {},
    msp: {},
    core: {}
  };

  for (const [key, enabled] of Object.entries(features)) {
    const parts = key.split('.');
    const category = parts[0];
    const rest = parts.slice(1).join('.');

    if (categories[category]) {
      categories[category][rest] = {
        key,
        enabled,
        minimumPlan: getMinimumPlanForFeature(key)
      };
    }
  }

  return categories;
}

/**
 * Custom error for disabled features
 */
class FeatureDisabledError extends Error {
  constructor(featureKey, minimumPlan) {
    super(`Feature '${featureKey}' is not enabled for this tenant`);
    this.name = 'FeatureDisabledError';
    this.featureKey = featureKey;
    this.minimumPlan = minimumPlan;
    this.statusCode = 403;
  }

  toJSON() {
    return {
      error: 'feature_disabled',
      feature_key: this.featureKey,
      minimum_plan: this.minimumPlan,
      message: this.message
    };
  }
}

/**
 * Clear cache (for testing or after bulk updates)
 */
function clearCache(tenantCode = null) {
  if (tenantCode) {
    featureCache.delete(`features:${tenantCode}`);
  } else {
    featureCache.clear();
  }
}

module.exports = {
  getTenantFeatures,
  hasFeature,
  requireFeature,
  getFeatureDetails,
  setFeatureOverride,
  removeFeatureOverride,
  getFeaturesByCategory,
  FeatureDisabledError,
  clearCache
};
