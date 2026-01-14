/**
 * Plan Definitions Index
 *
 * Exports all plan feature arrays and helper functions.
 * Plans only define defaults - overrides are handled via tenant_features.source.
 */

const STARTER = require('./starter');
const PROFESSIONAL = require('./professional');
const MSP = require('./msp');

// Plan name to features mapping
const PLANS = {
  starter: STARTER,
  professional: PROFESSIONAL,
  msp: MSP
};

// Valid plan names
const PLAN_NAMES = Object.keys(PLANS);

/**
 * Get features for a plan
 * @param {string} planName - 'starter', 'professional', or 'msp'
 * @returns {string[]} Array of feature keys enabled by default for this plan
 */
function getPlanFeatures(planName) {
  const normalized = (planName || 'professional').toLowerCase();
  return PLANS[normalized] || PLANS.professional;
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
 * Get the minimum plan required for a feature
 * @param {string} featureKey - Feature key to check
 * @returns {string|null} Plan name or null if not in any plan
 */
function getMinimumPlanForFeature(featureKey) {
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
  return MSP; // MSP is the superset containing all features
}

module.exports = {
  STARTER,
  PROFESSIONAL,
  MSP,
  PLANS,
  PLAN_NAMES,
  getPlanFeatures,
  planIncludesFeature,
  getMinimumPlanForFeature,
  getAllFeatureKeys
};
