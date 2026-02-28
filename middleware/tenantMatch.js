/**
 * Tenant Isolation Middleware
 *
 * Ensures the tenant code in the URL matches the authenticated user's JWT tenantCode.
 * Prevents cross-tenant data access.
 */

/**
 * router.param() handler — fires automatically when a matched param appears in the URL.
 * Used internally by applyTenantMatch().
 */
function createTenantParamHandler() {
  return function tenantMatchHandler(req, res, next, paramValue) {
    if (!req.user) return next();                         // Public route — no auth yet
    if (req.user.userType === 'master') return next();    // Master admins access any tenant
    if (req.allowCrossTenant === true) return next();     // Explicit override
    const normalized = paramValue.toLowerCase().replace(/[^a-z0-9]/g, '_');
    if (req.user.tenantCode !== normalized) {
      return res.status(403).json({ error: 'Access denied' });
    }
    next();
  };
}

/**
 * Registers the param handler for tenantId, tenantCode, and tenant on a router.
 * Call once per route file: applyTenantMatch(router)
 */
function applyTenantMatch(router) {
  const handler = createTenantParamHandler();
  router.param('tenantId', handler);
  router.param('tenantCode', handler);
  router.param('tenant', handler);
}

/**
 * Regular middleware for route files where verifyToken is per-route (not router-level).
 * Place inline AFTER verifyToken in the middleware chain.
 */
function requireTenantMatch(req, res, next) {
  if (!req.user) return next();
  if (req.user.userType === 'master') return next();
  if (req.allowCrossTenant === true) return next();
  const param = req.params.tenantCode || req.params.tenantId || req.params.tenant;
  if (!param) return next();
  const normalized = param.toLowerCase().replace(/[^a-z0-9]/g, '_');
  if (req.user.tenantCode !== normalized) {
    return res.status(403).json({ error: 'Access denied' });
  }
  next();
}

module.exports = { createTenantParamHandler, applyTenantMatch, requireTenantMatch };
