/**
 * Subscription Gating Middleware
 *
 * Middleware for enforcing subscription status on routes.
 * Returns 402 Payment Required if subscription is not active.
 *
 * Access Rules (from Stripe Billing Epic):
 * - Full access: active, trialing
 * - Grace period: past_due (configurable)
 * - Restricted: none, incomplete, unpaid, canceled
 *
 * Usage:
 *   const { requireActiveSubscription, loadSubscriptionStatus } = require('../middleware/subscription-gating');
 *
 *   // Require active subscription
 *   router.get('/tickets', verifyToken, requireActiveSubscription(), handler);
 *
 *   // Allow grace period for past_due
 *   router.get('/tickets', verifyToken, requireActiveSubscription({ allowPastDue: true }), handler);
 *
 *   // Just load status without blocking
 *   router.get('/dashboard', verifyToken, loadSubscriptionStatus(), handler);
 */

const { getMasterConnection } = require('../config/database');

// Cache subscription status for 60 seconds to reduce DB load
const statusCache = new Map();
const CACHE_TTL = 60 * 1000;

/**
 * Get subscription status for a tenant
 * @param {string} tenantCode - Tenant code
 * @returns {Promise<{status: string|null, plan_slug: string|null, trial_end: Date|null, current_period_end: Date|null}>}
 */
async function getSubscriptionStatus(tenantCode) {
  // Check cache first
  const cached = statusCache.get(tenantCode);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    return cached.data;
  }

  const connection = await getMasterConnection();

  try {
    const [results] = await connection.query(`
      SELECT ts.status, ts.trial_end, ts.current_period_end, sp.slug as plan_slug
      FROM tenants t
      LEFT JOIN tenant_subscriptions ts ON t.id = ts.tenant_id
      LEFT JOIN subscription_plans sp ON ts.plan_id = sp.id
      WHERE t.tenant_code = ?
    `, [tenantCode]);

    const data = results.length > 0 ? {
      status: results[0].status || null,
      plan_slug: results[0].plan_slug || null,
      trial_end: results[0].trial_end || null,
      current_period_end: results[0].current_period_end || null
    } : {
      status: null,
      plan_slug: null,
      trial_end: null,
      current_period_end: null
    };

    // Cache the result
    statusCache.set(tenantCode, { data, timestamp: Date.now() });

    return data;
  } finally {
    connection.release();
  }
}

/**
 * Clear cached subscription status for a tenant
 * Call this after subscription changes
 * @param {string} tenantCode
 */
function clearSubscriptionCache(tenantCode) {
  statusCache.delete(tenantCode);
}

/**
 * Create middleware that requires an active subscription
 * @param {Object} options
 * @param {boolean} options.allowPastDue - Allow access during past_due grace period (default: true)
 * @param {boolean} options.allowTrialing - Allow access during trial (default: true)
 * @returns {Function} Express middleware
 */
function requireActiveSubscription(options = {}) {
  const { allowPastDue = true, allowTrialing = true } = options;

  return async (req, res, next) => {
    try {
      // Get tenant code from route params or user token
      const tenantCode = req.params.tenantId || req.params.tenantCode || req.user?.tenantCode;

      if (!tenantCode) {
        return res.status(400).json({
          error: 'tenant_required',
          message: 'Tenant code is required to check subscription access'
        });
      }

      const subscription = await getSubscriptionStatus(tenantCode);
      req.subscriptionStatus = subscription;

      // Define allowed statuses
      const allowedStatuses = ['active'];
      if (allowTrialing) allowedStatuses.push('trialing');
      if (allowPastDue) allowedStatuses.push('past_due');

      if (!subscription.status || !allowedStatuses.includes(subscription.status)) {
        return res.status(402).json({
          error: 'subscription_required',
          status: subscription.status,
          message: getSubscriptionMessage(subscription.status),
          action: getSubscriptionAction(subscription.status),
          billing_url: '/billing'
        });
      }

      next();

    } catch (error) {
      console.error('Subscription gating error:', error);
      return res.status(500).json({
        error: 'subscription_check_failed',
        message: 'Unable to verify subscription status'
      });
    }
  };
}

/**
 * Middleware that loads subscription status without blocking
 * Use this to make subscription info available in routes
 * @returns {Function} Express middleware
 */
function loadSubscriptionStatus() {
  return async (req, res, next) => {
    try {
      const tenantCode = req.params.tenantId || req.params.tenantCode || req.user?.tenantCode;

      if (tenantCode) {
        req.subscriptionStatus = await getSubscriptionStatus(tenantCode);
      }

      next();
    } catch (error) {
      console.error('Error loading subscription status:', error);
      // Don't fail the request, just continue without status
      req.subscriptionStatus = { status: null };
      next();
    }
  };
}

/**
 * Get user-friendly message for subscription status
 * @param {string|null} status
 * @returns {string}
 */
function getSubscriptionMessage(status) {
  switch (status) {
    case null:
    case 'none':
      return 'No active subscription. Please subscribe to access this feature.';
    case 'incomplete':
      return 'Your subscription setup is incomplete. Please complete checkout.';
    case 'past_due':
      return 'Your payment is past due. Please update your payment method.';
    case 'unpaid':
      return 'Your subscription is unpaid. Please update your payment method to restore access.';
    case 'canceled':
      return 'Your subscription has been canceled. Please resubscribe to regain access.';
    default:
      return 'Active subscription required.';
  }
}

/**
 * Get recommended action for subscription status
 * @param {string|null} status
 * @returns {string}
 */
function getSubscriptionAction(status) {
  switch (status) {
    case null:
    case 'none':
      return 'subscribe';
    case 'incomplete':
      return 'complete_checkout';
    case 'past_due':
    case 'unpaid':
      return 'update_payment';
    case 'canceled':
      return 'resubscribe';
    default:
      return 'subscribe';
  }
}

/**
 * Check if a status allows access
 * @param {string|null} status
 * @param {Object} options
 * @returns {boolean}
 */
function isSubscriptionActive(status, options = {}) {
  const { allowPastDue = true, allowTrialing = true } = options;

  if (status === 'active') return true;
  if (allowTrialing && status === 'trialing') return true;
  if (allowPastDue && status === 'past_due') return true;

  return false;
}

module.exports = {
  requireActiveSubscription,
  loadSubscriptionStatus,
  getSubscriptionStatus,
  clearSubscriptionCache,
  isSubscriptionActive
};
