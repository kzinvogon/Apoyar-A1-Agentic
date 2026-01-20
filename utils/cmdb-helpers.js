/**
 * CMDB Helper Utilities
 * Shared functions for CMDB routes
 */

/**
 * Log a change to the CMDB change history
 * @param {object} connection - Database connection
 * @param {object} params - Change parameters
 * @param {number} params.cmdbItemId - The CMDB item ID (internal id, not cmdb_id)
 * @param {string} params.changeType - Type of change: created, updated, deleted, etc.
 * @param {string} [params.fieldName] - Name of the field that changed (for updates)
 * @param {string} [params.oldValue] - Previous value
 * @param {string} [params.newValue] - New value
 * @param {number} params.userId - User who made the change
 * @param {string} params.userName - Name of user who made the change
 * @param {string} [params.ipAddress] - IP address of the request
 */
async function logCMDBChange(connection, params) {
  const {
    cmdbItemId,
    changeType,
    fieldName = null,
    oldValue = null,
    newValue = null,
    userId,
    userName,
    ipAddress = null
  } = params;

  try {
    await connection.query(
      `INSERT INTO cmdb_change_history
        (cmdb_item_id, change_type, field_name, old_value, new_value, changed_by, changed_by_name, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [cmdbItemId, changeType, fieldName, oldValue, newValue, userId, userName, ipAddress]
    );
  } catch (error) {
    // Log error but don't fail the operation - history is non-critical
    console.error('Error logging CMDB change:', error.message);
  }
}

/**
 * Get the client IP address from the request
 */
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.connection?.remoteAddress ||
         req.socket?.remoteAddress ||
         null;
}

/**
 * Validate that user has admin role
 */
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Admin access required' });
  }
  next();
}

module.exports = {
  logCMDBChange,
  getClientIP,
  requireAdmin
};
