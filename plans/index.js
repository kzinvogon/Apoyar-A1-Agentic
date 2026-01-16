/**
 * Plan Definitions Index
 *
 * Exports all plan feature arrays and helper functions.
 * Plans are now read from the database (subscription_plans table) with
 * fallback to static files for backward compatibility.
 *
 * Plans only define defaults - overrides are handled via tenant_features.source.
 */

const STARTER = require('./starter');
const PROFESSIONAL = require('./professional');
const MSP = require('./msp');

// Static plan name to features mapping (fallback)
const STATIC_PLANS = {
  starter: STARTER,
  professional: PROFESSIONAL,
  msp: MSP
};

// Valid plan names
const PLAN_NAMES = Object.keys(STATIC_PLANS);

// Cache for database-loaded plans
let dbPlansCache = null;
let dbPlansCacheTime = 0;
const DB_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Load plans from database
 * @returns {Promise<Object>} Map of slug -> features array
 */
async function loadPlansFromDatabase() {
  // Check cache
  if (dbPlansCache && (Date.now() - dbPlansCacheTime) < DB_CACHE_TTL) {
    return dbPlansCache;
  }

  try {
    const { getMasterConnection } = require('../config/database');
    const masterConn = await getMasterConnection();

    const [plans] = await masterConn.query(`
      SELECT slug, features
      FROM subscription_plans
      WHERE is_active = TRUE
    `);

    const plansMap = {};
    for (const plan of plans) {
      const features = typeof plan.features === 'string'
        ? JSON.parse(plan.features)
        : plan.features;
      plansMap[plan.slug] = features || [];
    }

    // Update cache
    dbPlansCache = plansMap;
    dbPlansCacheTime = Date.now();

    return plansMap;
  } catch (error) {
    console.warn('[Plans] Failed to load from database, using static fallback:', error.message);
    return null;
  }
}

/**
 * Get features for a plan (async version - reads from DB)
 * @param {string} planName - 'starter', 'professional', or 'msp'
 * @returns {Promise<string[]>} Array of feature keys enabled by default for this plan
 */
async function getPlanFeaturesAsync(planName) {
  const normalized = (planName || 'professional').toLowerCase();

  // Try database first
  const dbPlans = await loadPlansFromDatabase();
  if (dbPlans && dbPlans[normalized]) {
    return dbPlans[normalized];
  }

  // Fallback to static
  return STATIC_PLANS[normalized] || STATIC_PLANS.professional;
}

/**
 * Get features for a plan (sync version - uses static files or cached DB data)
 * @param {string} planName - 'starter', 'professional', or 'msp'
 * @returns {string[]} Array of feature keys enabled by default for this plan
 */
function getPlanFeatures(planName) {
  const normalized = (planName || 'professional').toLowerCase();

  // Use cached DB data if available
  if (dbPlansCache && dbPlansCache[normalized]) {
    return dbPlansCache[normalized];
  }

  // Fallback to static
  return STATIC_PLANS[normalized] || STATIC_PLANS.professional;
}

/**
 * Check if a feature is included in a plan
 * @param {string} planName - Plan name
 * @param {string} featureKey - Feature key to check
 * @returns {boolean}
 */
function planIncludesFeature(planName, featureKey) {
  const features = getPlanFeatures(planName);
  return features.includes(featureKey);
}

/**
 * Check if a feature is included in a plan (async version)
 * @param {string} planName - Plan name
 * @param {string} featureKey - Feature key to check
 * @returns {Promise<boolean>}
 */
async function planIncludesFeatureAsync(planName, featureKey) {
  const features = await getPlanFeaturesAsync(planName);
  return features.includes(featureKey);
}

/**
 * Get the minimum plan required for a feature
 * @param {string} featureKey - Feature key to check
 * @returns {string|null} Plan name or null if not in any plan
 */
function getMinimumPlanForFeature(featureKey) {
  // Use cached DB data if available
  if (dbPlansCache) {
    if (dbPlansCache.starter?.includes(featureKey)) return 'starter';
    if (dbPlansCache.professional?.includes(featureKey)) return 'professional';
    if (dbPlansCache.msp?.includes(featureKey)) return 'msp';
  }

  // Fallback to static
  if (STARTER.includes(featureKey)) return 'starter';
  if (PROFESSIONAL.includes(featureKey)) return 'professional';
  if (MSP.includes(featureKey)) return 'msp';
  return null;
}

/**
 * Get all unique feature keys across all plans
 * @returns {string[]}
 */
function getAllFeatureKeys() {
  // Use cached DB data if available
  if (dbPlansCache) {
    const allFeatures = new Set();
    for (const features of Object.values(dbPlansCache)) {
      features.forEach(f => allFeatures.add(f));
    }
    return Array.from(allFeatures);
  }

  // Fallback to static - MSP is the superset containing all features
  return MSP;
}

/**
 * Get all plan slugs
 * @returns {Promise<string[]>}
 */
async function getPlanSlugs() {
  const dbPlans = await loadPlansFromDatabase();
  if (dbPlans) {
    return Object.keys(dbPlans);
  }
  return PLAN_NAMES;
}

/**
 * Clear the database plans cache
 */
function clearPlansCache() {
  dbPlansCache = null;
  dbPlansCacheTime = 0;
}

/**
 * Preload plans from database (call on startup)
 */
async function preloadPlans() {
  try {
    await loadPlansFromDatabase();
    console.log('[Plans] Preloaded plans from database');
  } catch (error) {
    console.warn('[Plans] Failed to preload plans:', error.message);
  }
}

module.exports = {
  // Static exports (for backward compatibility)
  STARTER,
  PROFESSIONAL,
  MSP,
  PLANS: STATIC_PLANS,
  PLAN_NAMES,

  // Sync functions (use cache or static fallback)
  getPlanFeatures,
  planIncludesFeature,
  getMinimumPlanForFeature,
  getAllFeatureKeys,

  // Async functions (read from DB)
  getPlanFeaturesAsync,
  planIncludesFeatureAsync,
  getPlanSlugs,

  // Cache management
  clearPlansCache,
  preloadPlans,
  loadPlansFromDatabase
};
