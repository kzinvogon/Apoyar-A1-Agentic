const crypto = require('crypto');
const { getTenantConnection } = require('../config/database');

/**
 * Generate a cryptographically secure random token
 * @returns {string} A 64-character hex string (256 bits of entropy)
 */
function generateSecureToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Create and store an access token for a ticket
 * @param {string} tenantCode - The tenant code (e.g., 'apoyar')
 * @param {number} ticketId - The ticket ID
 * @param {number} expirationDays - Days until token expires (default: 30)
 * @returns {Promise<string>} The generated token
 */
async function createTicketAccessToken(tenantCode, ticketId, expirationDays = 30) {
  const connection = await getTenantConnection(tenantCode);

  try {
    const token = generateSecureToken();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expirationDays);

    await connection.query(
      `INSERT INTO ticket_access_tokens (ticket_id, token, expires_at)
       VALUES (?, ?, ?)`,
      [ticketId, token, expiresAt]
    );

    return token;
  } finally {
    connection.release();
  }
}

/**
 * Validate and retrieve ticket information using a token
 * @param {string} tenantCode - The tenant code
 * @param {string} token - The access token
 * @returns {Promise<Object|null>} Ticket data if valid, null if invalid/expired
 */
async function validateTicketAccessToken(tenantCode, token) {
  const connection = await getTenantConnection(tenantCode);

  try {
    // Check if token exists and hasn't expired
    const [tokenRows] = await connection.query(
      `SELECT tat.*, tat.ticket_id
       FROM ticket_access_tokens tat
       WHERE tat.token = ? AND tat.expires_at > NOW()`,
      [token]
    );

    if (tokenRows.length === 0) {
      return null; // Token not found or expired
    }

    const tokenData = tokenRows[0];

    // Update access tracking
    await connection.query(
      `UPDATE ticket_access_tokens
       SET last_accessed_at = NOW(), access_count = access_count + 1
       WHERE id = ?`,
      [tokenData.id]
    );

    // Fetch ticket details
    const [ticketRows] = await connection.query(
      `SELECT t.id, t.title, t.description, t.status,
              t.priority, t.created_at, t.updated_at,
              u.full_name as requester_name, u.email as requester_email,
              u.username as requester_username, u.role as requester_role
       FROM tickets t
       LEFT JOIN users u ON t.requester_id = u.id
       WHERE t.id = ?`,
      [tokenData.ticket_id]
    );

    if (ticketRows.length === 0) {
      return null; // Ticket not found
    }

    return {
      token: tokenData,
      ticket: ticketRows[0]
    };
  } finally {
    connection.release();
  }
}

/**
 * Clean up expired tokens (can be run periodically)
 * @param {string} tenantCode - The tenant code
 * @returns {Promise<number>} Number of tokens deleted
 */
async function cleanupExpiredTokens(tenantCode) {
  const connection = await getTenantConnection(tenantCode);

  try {
    const [result] = await connection.query(
      `DELETE FROM ticket_access_tokens WHERE expires_at < NOW()`
    );

    return result.affectedRows;
  } finally {
    connection.release();
  }
}

module.exports = {
  generateSecureToken,
  createTicketAccessToken,
  validateTicketAccessToken,
  cleanupExpiredTokens
};
