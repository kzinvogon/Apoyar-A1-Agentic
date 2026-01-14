/**
 * Feature Flags API Routes
 *
 * Endpoints for managing and querying tenant feature flags.
 *
 * GET    /:tenantId/features              - List all features for tenant
 * GET    /:tenantId/features/categories   - Get features grouped by category
 * GET    /:tenantId/features/:key         - Get single feature details
 * PUT    /:tenantId/features/:key         - Set feature override (admin only)
 * DELETE /:tenantId/features/:key         - Remove override (revert to plan)
 */

const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/auth');
const {
  getTenantFeatures,
  hasFeature,
  getFeatureDetails,
  setFeatureOverride,
  removeFeatureOverride,
  getFeaturesByCategory,
  clearCache
} = require('../services/feature-flags');
const { getMinimumPlanForFeature, PLAN_NAMES } = require('../plans');

/**
 * GET /:tenantId/features
 * List all features for tenant
 */
router.get('/:tenantId/features', verifyToken, async (req, res) => {
  try {
    const { tenantId } = req.params;

    // Verify user has access to this tenant
    if (req.user.userType === 'tenant' && req.user.tenantCode !== tenantId) {
      return res.status(403).json({ error: 'Access denied to this tenant' });
    }

    const features = await getTenantFeatures(tenantId, false);

    // Enrich with minimum plan info
    const enriched = {};
    for (const [key, enabled] of Object.entries(features)) {
      enriched[key] = {
        enabled,
        minimumPlan: getMinimumPlanForFeature(key)
      };
    }

    res.json({
      tenantCode: tenantId,
      features: enriched,
      featureCount: Object.keys(features).length,
      enabledCount: Object.values(features).filter(v => v).length
    });

  } catch (error) {
    console.error('Error fetching features:', error);
    res.status(500).json({ error: 'Failed to fetch features', message: error.message });
  }
});

/**
 * GET /:tenantId/features/categories
 * Get features grouped by category (for UI)
 */
router.get('/:tenantId/features/categories', verifyToken, async (req, res) => {
  try {
    const { tenantId } = req.params;

    if (req.user.userType === 'tenant' && req.user.tenantCode !== tenantId) {
      return res.status(403).json({ error: 'Access denied to this tenant' });
    }

    const categories = await getFeaturesByCategory(tenantId);

    res.json({
      tenantCode: tenantId,
      categories
    });

  } catch (error) {
    console.error('Error fetching feature categories:', error);
    res.status(500).json({ error: 'Failed to fetch features', message: error.message });
  }
});

/**
 * GET /:tenantId/features/:key
 * Get single feature details
 */
router.get('/:tenantId/features/:key(*)', verifyToken, async (req, res) => {
  try {
    const { tenantId, key } = req.params;

    if (req.user.userType === 'tenant' && req.user.tenantCode !== tenantId) {
      return res.status(403).json({ error: 'Access denied to this tenant' });
    }

    const details = await getFeatureDetails(tenantId, key);

    if (!details) {
      // Feature doesn't exist in DB - return default info
      return res.json({
        featureKey: key,
        enabled: false,
        source: 'default',
        minimumPlan: getMinimumPlanForFeature(key),
        exists: false
      });
    }

    res.json({
      ...details,
      exists: true
    });

  } catch (error) {
    console.error('Error fetching feature:', error);
    res.status(500).json({ error: 'Failed to fetch feature', message: error.message });
  }
});

/**
 * PUT /:tenantId/features/:key
 * Set feature override (admin only)
 *
 * Body:
 * {
 *   "enabled": true,
 *   "source": "override" | "trial",
 *   "expires_at": "2025-12-31T23:59:59Z" (optional, for trials)
 * }
 */
router.put('/:tenantId/features/:key(*)', verifyToken, requireRole(['admin']), async (req, res) => {
  try {
    const { tenantId, key } = req.params;
    const { enabled, source = 'override', expires_at } = req.body;

    // Validate source
    if (!['override', 'trial'].includes(source)) {
      return res.status(400).json({
        error: 'invalid_source',
        message: "Source must be 'override' or 'trial'"
      });
    }

    // Validate enabled is boolean
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({
        error: 'invalid_enabled',
        message: "'enabled' must be a boolean"
      });
    }

    // Parse expires_at if provided
    let expiresAt = null;
    if (expires_at) {
      expiresAt = new Date(expires_at);
      if (isNaN(expiresAt.getTime())) {
        return res.status(400).json({
          error: 'invalid_date',
          message: "'expires_at' must be a valid ISO date string"
        });
      }
    }

    const result = await setFeatureOverride(tenantId, key, enabled, source, expiresAt);

    res.json({
      success: true,
      feature: result,
      message: `Feature '${key}' ${enabled ? 'enabled' : 'disabled'} via ${source}`
    });

  } catch (error) {
    console.error('Error setting feature override:', error);
    res.status(500).json({ error: 'Failed to set feature', message: error.message });
  }
});

/**
 * DELETE /:tenantId/features/:key
 * Remove override (revert to plan default)
 */
router.delete('/:tenantId/features/:key(*)', verifyToken, requireRole(['admin']), async (req, res) => {
  try {
    const { tenantId, key } = req.params;

    await removeFeatureOverride(tenantId, key);

    res.json({
      success: true,
      message: `Feature '${key}' reverted to plan default`
    });

  } catch (error) {
    console.error('Error removing feature override:', error);
    res.status(500).json({ error: 'Failed to remove override', message: error.message });
  }
});

/**
 * POST /:tenantId/features/check
 * Check multiple features at once (for frontend)
 *
 * Body:
 * {
 *   "features": ["integrations.teams", "integrations.slack"]
 * }
 */
router.post('/:tenantId/features/check', verifyToken, async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { features: featureKeys } = req.body;

    if (req.user.userType === 'tenant' && req.user.tenantCode !== tenantId) {
      return res.status(403).json({ error: 'Access denied to this tenant' });
    }

    if (!Array.isArray(featureKeys)) {
      return res.status(400).json({
        error: 'invalid_request',
        message: "'features' must be an array of feature keys"
      });
    }

    const allFeatures = await getTenantFeatures(tenantId);

    const results = {};
    for (const key of featureKeys) {
      results[key] = {
        enabled: allFeatures[key] === true,
        minimumPlan: getMinimumPlanForFeature(key)
      };
    }

    res.json({
      tenantCode: tenantId,
      features: results
    });

  } catch (error) {
    console.error('Error checking features:', error);
    res.status(500).json({ error: 'Failed to check features', message: error.message });
  }
});

/**
 * GET /:tenantId/features/plans/compare
 * Compare current features against all plans (for upgrade UI)
 */
router.get('/:tenantId/features/plans/compare', verifyToken, async (req, res) => {
  try {
    const { tenantId } = req.params;

    const features = await getTenantFeatures(tenantId);
    const { STARTER, PROFESSIONAL, MSP } = require('../plans');

    const comparison = {
      current: features,
      plans: {
        starter: {
          name: 'Starter',
          features: STARTER,
          currentlyHas: STARTER.filter(f => features[f]).length,
          total: STARTER.length
        },
        professional: {
          name: 'Professional',
          features: PROFESSIONAL,
          currentlyHas: PROFESSIONAL.filter(f => features[f]).length,
          total: PROFESSIONAL.length
        },
        msp: {
          name: 'MSP',
          features: MSP,
          currentlyHas: MSP.filter(f => features[f]).length,
          total: MSP.length
        }
      }
    };

    res.json(comparison);

  } catch (error) {
    console.error('Error comparing plans:', error);
    res.status(500).json({ error: 'Failed to compare plans', message: error.message });
  }
});

/**
 * POST /:tenantId/features/cache/clear
 * Clear feature cache (admin only)
 */
router.post('/:tenantId/features/cache/clear', verifyToken, requireRole(['admin']), async (req, res) => {
  try {
    const { tenantId } = req.params;

    clearCache(tenantId);

    res.json({
      success: true,
      message: `Feature cache cleared for tenant ${tenantId}`
    });

  } catch (error) {
    console.error('Error clearing cache:', error);
    res.status(500).json({ error: 'Failed to clear cache', message: error.message });
  }
});

module.exports = router;
