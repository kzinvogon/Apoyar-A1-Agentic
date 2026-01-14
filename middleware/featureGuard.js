/**
 * Feature Guard Middleware
 *
 * Middleware for enforcing feature flags on routes.
 * Returns 403 with feature details if the feature is disabled.
 *
 * Usage:
 *   const { requireFeature } = require('../middleware/featureGuard');
 *
 *   // Single feature
 *   router.post('/teams/send', verifyToken, requireFeature('integrations.teams'), handler);
 *
 *   // Any of multiple features
 *   router.get('/webhooks', verifyToken, requireFeature(['api.webhooks.inbound', 'api.webhooks.outbound'], 'any'), handler);
 *
 *   // All of multiple features
 *   router.post('/msp/contracts', verifyToken, requireFeature(['msp.contracts', 'customer.multi_company'], 'all'), handler);
 */

const { hasFeature, getTenantFeatures, FeatureDisabledError } = require('../services/feature-flags');
const { getMinimumPlanForFeature } = require('../plans');

/**
 * Create middleware that requires a feature to be enabled
 * @param {string|string[]} featureKeys - Feature key(s) to check
 * @param {'all'|'any'} mode - For multiple features: require 'all' or 'any' to be enabled
 * @returns {Function} Express middleware
 */
function requireFeature(featureKeys, mode = 'all') {
  const keys = Array.isArray(featureKeys) ? featureKeys : [featureKeys];

  return async (req, res, next) => {
    try {
      // Get tenant code from route params or user token
      const tenantCode = req.params.tenantId || req.params.tenantCode || req.user?.tenantCode;

      if (!tenantCode) {
        return res.status(400).json({
          error: 'tenant_required',
          message: 'Tenant code is required to check feature access'
        });
      }

      // Load all features for this tenant
      const features = await getTenantFeatures(tenantCode);

      // Check features based on mode
      const results = keys.map(key => ({
        key,
        enabled: features[key] === true,
        minimumPlan: getMinimumPlanForFeature(key)
      }));

      const enabledFeatures = results.filter(r => r.enabled);
      const disabledFeatures = results.filter(r => !r.enabled);

      let allowed = false;
      if (mode === 'any') {
        allowed = enabledFeatures.length > 0;
      } else {
        // mode === 'all'
        allowed = disabledFeatures.length === 0;
      }

      if (!allowed) {
        // Find the highest tier required among disabled features
        const planOrder = { starter: 1, professional: 2, msp: 3 };
        const highestPlan = disabledFeatures.reduce((highest, f) => {
          const plan = f.minimumPlan || 'msp';
          return (planOrder[plan] || 3) > (planOrder[highest] || 0) ? plan : highest;
        }, 'starter');

        return res.status(403).json({
          error: 'feature_disabled',
          feature_keys: disabledFeatures.map(f => f.key),
          minimum_plan: highestPlan,
          message: `This feature requires the ${highestPlan.charAt(0).toUpperCase() + highestPlan.slice(1)} plan or higher`,
          upgrade_url: '/pricing'
        });
      }

      // Attach feature info to request for downstream use
      req.tenantFeatures = features;
      next();

    } catch (error) {
      console.error('Feature guard error:', error);

      if (error instanceof FeatureDisabledError) {
        return res.status(403).json(error.toJSON());
      }

      return res.status(500).json({
        error: 'feature_check_failed',
        message: 'Unable to verify feature access'
      });
    }
  };
}

/**
 * Middleware that attaches tenant features to the request
 * Use this at the start of tenant routes to pre-load features
 * @returns {Function} Express middleware
 */
function loadTenantFeatures() {
  return async (req, res, next) => {
    try {
      const tenantCode = req.params.tenantId || req.params.tenantCode || req.user?.tenantCode;

      if (tenantCode) {
        req.tenantFeatures = await getTenantFeatures(tenantCode);
      }

      next();
    } catch (error) {
      console.error('Error loading tenant features:', error);
      // Don't fail the request, just continue without features
      req.tenantFeatures = {};
      next();
    }
  };
}

/**
 * Helper to check feature in route handler (non-middleware)
 * @param {Object} req - Express request with tenantFeatures attached
 * @param {string} featureKey - Feature to check
 * @returns {boolean}
 */
function checkFeature(req, featureKey) {
  return req.tenantFeatures?.[featureKey] === true;
}

/**
 * Express error handler for FeatureDisabledError
 */
function featureErrorHandler(err, req, res, next) {
  if (err instanceof FeatureDisabledError) {
    return res.status(403).json(err.toJSON());
  }
  next(err);
}

module.exports = {
  requireFeature,
  loadTenantFeatures,
  checkFeature,
  featureErrorHandler
};
