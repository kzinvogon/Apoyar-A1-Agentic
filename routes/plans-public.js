/**
 * Public Plans API Routes
 * No authentication required - used by marketing site and public pricing pages
 *
 * Endpoints:
 * - GET /api/plans - All active plans for pricing page
 * - GET /api/plans/:slug - Single plan details
 * - GET /api/plans/features - Feature catalog with categories
 * - GET /api/plans/compare - Feature comparison matrix
 */

const express = require('express');
const router = express.Router();
const { getMasterConnection } = require('../config/database');

// Cache for plan data (5 minute TTL)
let plansCache = null;
let plansCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * GET /api/plans
 * Returns all active subscription plans for marketing/pricing pages
 */
router.get('/', async (req, res) => {
  try {
    // Check cache
    if (plansCache && (Date.now() - plansCacheTime) < CACHE_TTL) {
      return res.json(plansCache);
    }

    const masterConn = await getMasterConnection();

    // Check if new columns exist (for backward compatibility before migration)
    let hasNewColumns = false;
    try {
      const [cols] = await masterConn.query(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = 'subscription_plans' AND COLUMN_NAME = 'pricing_model'
      `);
      hasNewColumns = cols.length > 0;
    } catch (e) {
      // Ignore - columns don't exist yet
    }

    const selectFields = hasNewColumns
      ? `slug, name, display_name, tagline, description,
         price_monthly, price_yearly, price_per_user,
         pricing_model, price_per_client, base_clients_included,
         price_additional_client, unlimited_technicians,
         features, feature_limits, display_order, is_featured, badge_text`
      : `slug, name, display_name, tagline, description,
         price_monthly, price_yearly, price_per_user,
         'per_technician' as pricing_model, 0 as price_per_client, 0 as base_clients_included,
         0 as price_additional_client, 0 as unlimited_technicians,
         features, feature_limits, display_order, is_featured, badge_text`;

    const [plans] = await masterConn.query(`
      SELECT ${selectFields}
      FROM subscription_plans
      WHERE is_active = TRUE
      ORDER BY display_order ASC
    `);

    // Parse JSON fields and separate by pricing model
    const formattedPlans = plans.map(plan => ({
      ...plan,
      features: typeof plan.features === 'string' ? JSON.parse(plan.features) : plan.features,
      feature_limits: typeof plan.feature_limits === 'string' ? JSON.parse(plan.feature_limits) : plan.feature_limits,
      price_monthly: parseFloat(plan.price_monthly || 0),
      price_yearly: parseFloat(plan.price_yearly || 0),
      price_per_user: parseFloat(plan.price_per_user || 0),
      price_per_client: parseFloat(plan.price_per_client || 0),
      base_clients_included: parseInt(plan.base_clients_included || 0),
      price_additional_client: parseFloat(plan.price_additional_client || 0),
      unlimited_technicians: !!plan.unlimited_technicians,
      pricing_model: plan.pricing_model || 'per_technician'
    }));

    // Separate plans by pricing model
    const perTechPlans = formattedPlans.filter(p => p.pricing_model === 'per_technician');
    const perClientPlans = formattedPlans.filter(p => p.pricing_model === 'per_client');

    const response = {
      plans: perTechPlans,
      per_client_plans: perClientPlans,
      all_plans: formattedPlans,
      currency: 'AUD',
      billing_note: 'Per technician/month, billed annually'
    };

    // Update cache
    plansCache = response;
    plansCacheTime = Date.now();

    res.json(response);
  } catch (error) {
    console.error('[Plans API] Error fetching plans:', error);
    res.status(500).json({ error: 'Failed to fetch plans' });
  }
});

/**
 * GET /api/plans/features
 * Returns feature catalog grouped by category
 */
router.get('/features', async (req, res) => {
  try {
    const masterConn = await getMasterConnection();

    const [features] = await masterConn.query(`
      SELECT
        feature_key,
        name,
        marketing_name,
        description,
        category,
        display_order,
        is_visible_marketing
      FROM plan_features
      WHERE is_visible_marketing = TRUE
      ORDER BY category, display_order ASC
    `);

    // Group by category
    const grouped = features.reduce((acc, feature) => {
      const cat = feature.category || 'other';
      if (!acc[cat]) {
        acc[cat] = [];
      }
      acc[cat].push(feature);
      return acc;
    }, {});

    // Category display names
    const categoryNames = {
      core: 'Core Features',
      customer: 'Customer Experience',
      ai: 'AI & Automation',
      integrations: 'Integrations',
      sla: 'SLA Management',
      msp: 'MSP Features',
      api: 'API & Extensibility'
    };

    res.json({
      features: grouped,
      categories: categoryNames
    });
  } catch (error) {
    console.error('[Plans API] Error fetching features:', error);
    res.status(500).json({ error: 'Failed to fetch features' });
  }
});

/**
 * GET /api/plans/compare
 * Returns feature comparison matrix for pricing page
 */
router.get('/compare', async (req, res) => {
  try {
    const masterConn = await getMasterConnection();

    // Get per-technician plans only (per-client has same features as MSP)
    const [plans] = await masterConn.query(`
      SELECT slug, display_name, features
      FROM subscription_plans
      WHERE is_active = TRUE AND (pricing_model = 'per_technician' OR pricing_model IS NULL)
      ORDER BY display_order ASC
    `);

    // Get all marketing-visible features
    const [features] = await masterConn.query(`
      SELECT feature_key, marketing_name, category, display_order
      FROM plan_features
      WHERE is_visible_marketing = TRUE
      ORDER BY category, display_order ASC
    `);

    // Build comparison matrix
    const matrix = features.map(feature => {
      const row = {
        feature_key: feature.feature_key,
        name: feature.marketing_name,
        category: feature.category
      };

      plans.forEach(plan => {
        const planFeatures = typeof plan.features === 'string'
          ? JSON.parse(plan.features)
          : plan.features;
        row[plan.slug] = planFeatures.includes(feature.feature_key);
      });

      return row;
    });

    // Group by category
    const grouped = matrix.reduce((acc, row) => {
      const cat = row.category || 'other';
      if (!acc[cat]) {
        acc[cat] = [];
      }
      acc[cat].push(row);
      return acc;
    }, {});

    res.json({
      plans: plans.map(p => ({ slug: p.slug, name: p.display_name })),
      comparison: grouped,
      categories: {
        core: 'Core Features',
        customer: 'Customer Experience',
        ai: 'AI & Automation',
        integrations: 'Integrations',
        sla: 'SLA Management',
        msp: 'MSP Features',
        api: 'API & Extensibility'
      }
    });
  } catch (error) {
    console.error('[Plans API] Error building comparison:', error);
    res.status(500).json({ error: 'Failed to build comparison' });
  }
});

/**
 * GET /api/plans/:slug
 * Returns details for a specific plan
 */
router.get('/:slug', async (req, res) => {
  const { slug } = req.params;

  try {
    const masterConn = await getMasterConnection();

    const [plans] = await masterConn.query(`
      SELECT
        slug,
        name,
        display_name,
        tagline,
        description,
        price_monthly,
        price_yearly,
        price_per_user,
        pricing_model,
        price_per_client,
        base_clients_included,
        price_additional_client,
        unlimited_technicians,
        features,
        feature_limits,
        is_featured,
        badge_text
      FROM subscription_plans
      WHERE slug = ? AND is_active = TRUE
    `, [slug]);

    if (plans.length === 0) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    const plan = plans[0];

    // Get feature details for this plan
    const planFeatures = typeof plan.features === 'string'
      ? JSON.parse(plan.features)
      : plan.features;

    const [featureDetails] = await masterConn.query(`
      SELECT feature_key, marketing_name, description, category
      FROM plan_features
      WHERE feature_key IN (?) AND is_visible_marketing = TRUE
      ORDER BY category, display_order
    `, [planFeatures.length > 0 ? planFeatures : ['none']]);

    res.json({
      ...plan,
      features: planFeatures,
      feature_limits: typeof plan.feature_limits === 'string'
        ? JSON.parse(plan.feature_limits)
        : plan.feature_limits,
      price_monthly: parseFloat(plan.price_monthly || 0),
      price_yearly: parseFloat(plan.price_yearly || 0),
      price_per_user: parseFloat(plan.price_per_user || 0),
      price_per_client: parseFloat(plan.price_per_client || 0),
      base_clients_included: parseInt(plan.base_clients_included || 0),
      price_additional_client: parseFloat(plan.price_additional_client || 0),
      unlimited_technicians: !!plan.unlimited_technicians,
      pricing_model: plan.pricing_model || 'per_technician',
      feature_details: featureDetails
    });
  } catch (error) {
    console.error('[Plans API] Error fetching plan:', error);
    res.status(500).json({ error: 'Failed to fetch plan' });
  }
});

/**
 * Clear cache (for admin use after plan updates)
 */
function clearPlansCache() {
  plansCache = null;
  plansCacheTime = 0;
}

module.exports = router;
module.exports.clearPlansCache = clearPlansCache;
