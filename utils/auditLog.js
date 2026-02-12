/**
 * Audit Logging Utility
 * Logs user actions to the master audit_log table
 *
 * Design principles:
 * - Best-effort: audit failures never break main operations
 * - No sensitive values: only log keys, actions, metadata - never raw values
 * - Debounced: RAW_VARS_OPEN is debounced to prevent spam
 */

const { masterQuery } = require('../config/database');

// Debounce cache for RAW_VARS_OPEN (userId -> timestamp)
const openDebounceCache = new Map();
const DEBOUNCE_MS = 60000; // 60 seconds

/**
 * Log an audit event
 * @param {Object} params
 * @param {string} params.tenantCode - Tenant identifier
 * @param {Object} params.user - User object from req.user (userId, username)
 * @param {string} params.action - Action type (e.g., RAW_VARS_OPEN, RAW_VAR_UPDATE)
 * @param {string} params.entityType - Entity type (e.g., RAW_VARIABLE)
 * @param {string} [params.entityId] - Entity identifier (e.g., variable key)
 * @param {Object} [params.details] - Additional details (will be stored as JSON)
 * @param {Object} [params.req] - Express request object for IP/user-agent
 */
async function logAudit({ tenantCode, user, action, entityType, entityId = null, details = null, req = null }) {
  try {
    // Debounce RAW_VARS_OPEN - skip if logged within last 60s for same user
    if (action === 'RAW_VARS_OPEN') {
      const cacheKey = `${tenantCode}:${user?.userId}`;
      const lastLogged = openDebounceCache.get(cacheKey);
      if (lastLogged && Date.now() - lastLogged < DEBOUNCE_MS) {
        return; // Skip - already logged recently
      }
      openDebounceCache.set(cacheKey, Date.now());
    }

    // Extract IP and user agent from request
    let ip = null;
    let userAgent = null;
    if (req) {
      ip = req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress;
      userAgent = req.headers['user-agent'];
      // Truncate user agent if too long
      if (userAgent && userAgent.length > 255) {
        userAgent = userAgent.substring(0, 252) + '...';
      }
    }

    // Sanitize details - NEVER store actual values, only metadata
    let sanitizedDetails = null;
    if (details) {
      sanitizedDetails = {};
      // Only keep safe metadata fields
      const safeFields = ['key', 'scope', 'countReturned', 'countExported', 'created', 'updated', 'errors', 'keysImported'];
      for (const field of safeFields) {
        if (details[field] !== undefined) {
          // For keysImported, just store the count not the actual keys
          if (field === 'keysImported' && Array.isArray(details[field])) {
            sanitizedDetails.keysImportedCount = details[field].length;
          } else {
            sanitizedDetails[field] = details[field];
          }
        }
      }
      // Add indication that values were changed but don't store them
      if (details.oldValue !== undefined || details.newValue !== undefined) {
        sanitizedDetails.valueChanged = true;
      }
    }

    // Use masterQuery() - delegates to hardened pool
    await masterQuery(
      `INSERT INTO audit_log (tenant_code, user_id, username, action, entity_type, entity_id, details_json, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tenantCode,
        user?.userId || null,
        user?.username || null,
        action,
        entityType,
        entityId,
        sanitizedDetails ? JSON.stringify(sanitizedDetails) : null,
        ip,
        userAgent
      ]
    );

  } catch (error) {
    // Best-effort: log error but never throw - audit must not break main operations
    console.error('[AuditLog] Failed to log audit event:', error.message);
  }
}

// Action constants
const AUDIT_ACTIONS = {
  // Auth
  LOGIN: 'LOGIN',
  LOGIN_FAILED: 'LOGIN_FAILED',
  PASSWORD_CHANGE: 'PASSWORD_CHANGE',
  PASSWORD_RESET: 'PASSWORD_RESET',
  // User management
  USER_INVITE: 'USER_INVITE',
  USER_TOGGLE: 'USER_TOGGLE',
  // Settings
  SETTINGS_UPDATE: 'SETTINGS_UPDATE',
  // Raw Variables
  RAW_VARS_OPEN: 'RAW_VARS_OPEN',
  RAW_VAR_CREATE: 'RAW_VAR_CREATE',
  RAW_VAR_UPDATE: 'RAW_VAR_UPDATE',
  RAW_VAR_DELETE: 'RAW_VAR_DELETE',
  RAW_VARS_IMPORT: 'RAW_VARS_IMPORT',
  RAW_VARS_EXPORT: 'RAW_VARS_EXPORT'
};

module.exports = {
  logAudit,
  AUDIT_ACTIONS
};
