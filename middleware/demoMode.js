/**
 * Demo Mode Middleware — Double-Lock Safety
 *
 * ALL demo behaviour requires BOTH conditions:
 *   1. process.env.DEMO_FEATURES_ENABLED === 'true'
 *   2. The tenant record has is_demo = 1
 *
 * If either condition is false, all demo code is skipped.
 *
 * Note: The simulated-writes middleware runs BEFORE verifyToken (global app.use),
 * so it extracts the tenant code from the JWT directly rather than relying on req.user.
 */
const jwt = require('jsonwebtoken');
const { getMasterConnection } = require('../config/database');

// In-memory cache so we don't hit master DB on every request
const demoTenantCache = new Map(); // tenantCode → { isDemo: bool, cachedAt: number }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Check if the DEMO_FEATURES_ENABLED env var is set
 */
function isDemoEnv() {
  return process.env.DEMO_FEATURES_ENABLED === 'true';
}

/**
 * Check if both locks pass for this request
 */
function isDemoRequest(req) {
  return isDemoEnv() && req.demoTenant === true;
}

/**
 * Extract tenant code from JWT in Authorization header (without full verification).
 * Used by global middleware that runs before verifyToken.
 */
function extractTenantCodeFromHeader(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded.tenantCode || null;
  } catch {
    return null;
  }
}

/**
 * Look up whether a tenant has is_demo = 1 (with caching).
 */
async function checkDemoTenant(tenantCode) {
  // Check cache first
  const cached = demoTenantCache.get(tenantCode);
  if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL_MS) {
    return cached.isDemo;
  }

  try {
    const connection = await getMasterConnection();
    try {
      const [rows] = await connection.query(
        'SELECT is_demo FROM tenants WHERE tenant_code = ? LIMIT 1',
        [tenantCode]
      );
      const isDemo = rows.length > 0 && rows[0].is_demo === 1;
      demoTenantCache.set(tenantCode, { isDemo, cachedAt: Date.now() });
      return isDemo;
    } finally {
      connection.release();
    }
  } catch (err) {
    console.warn('demoMode: failed to check is_demo flag:', err.message);
    return false;
  }
}

/**
 * Middleware: look up tenants.is_demo for the current tenant and set req.demoTenant.
 * Works both before and after verifyToken — tries req.user first, falls back to JWT header.
 */
async function attachDemoFlag(req, res, next) {
  if (!isDemoEnv()) return next();

  const tenantCode = (req.user && req.user.tenantCode) || extractTenantCodeFromHeader(req);
  if (!tenantCode) {
    req.demoTenant = false;
    return next();
  }

  req.demoTenant = await checkDemoTenant(tenantCode);
  next();
}

/**
 * Route prefixes where writes are simulated in demo mode.
 * Only POST/PUT/DELETE methods are intercepted.
 */
const SIMULATED_PREFIXES = [
  '/api/admin/settings',
  '/api/integrations',
  '/api/tenant-settings',
  '/api/sla',
  '/api/expert-permissions',
  '/api/billing',
  '/api/features',
];

/**
 * Middleware: intercept write operations to protected routes and return simulated success.
 * Runs as global middleware before route handlers, so it extracts tenant info from the JWT.
 */
async function demoSimulateWrites(req, res, next) {
  if (!isDemoEnv()) return next();

  // Only intercept write methods
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

  // Check if this route matches a simulated prefix
  const fullPath = req.originalUrl.split('?')[0]; // strip query string
  const shouldSimulate = SIMULATED_PREFIXES.some(prefix => fullPath.startsWith(prefix));
  if (!shouldSimulate) return next();

  // Double-lock: check if the tenant is a demo tenant
  // Use req.demoTenant if already set by attachDemoFlag, otherwise resolve it
  let isDemo = req.demoTenant;
  if (isDemo === undefined) {
    const tenantCode = extractTenantCodeFromHeader(req);
    if (!tenantCode) return next();
    isDemo = await checkDemoTenant(tenantCode);
    req.demoTenant = isDemo;
  }

  if (!isDemo) return next();

  return res.json({
    success: true,
    demo_simulated: true,
    message: 'Changes simulated in demo mode'
  });
}

module.exports = {
  isDemoEnv,
  isDemoRequest,
  attachDemoFlag,
  demoSimulateWrites,
};
