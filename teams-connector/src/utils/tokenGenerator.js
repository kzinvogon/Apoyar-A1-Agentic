const crypto = require('crypto');
const { getTenantConnection } = require('../config/database');

const SERVIFLOW_URL = process.env.SERVIFLOW_URL || 'https://app.serviflow.app';

/**
 * Create and store an access token for a ticket.
 * Returns the full URL for the public ticket view.
 * @param {string} tenantCode
 * @param {number} ticketId
 * @param {number} expirationDays
 * @returns {Promise<string>} The public ticket view URL
 */
async function createTicketViewUrl(tenantCode, ticketId, expirationDays = 30) {
  const pool = await getTenantConnection(tenantCode);

  try {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expirationDays);

    await pool.query(
      'INSERT INTO ticket_access_tokens (ticket_id, token, expires_at) VALUES (?, ?, ?)',
      [ticketId, token, expiresAt]
    );

    return `${SERVIFLOW_URL}/ticket/view/${token}`;
  } finally {
    pool.release();
  }
}

module.exports = { createTicketViewUrl };
