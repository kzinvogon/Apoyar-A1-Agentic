/**
 * SMS Notification Service
 * Triggers notifications to the SMS connector when ticket events occur
 */

const fetch = require('node-fetch');
const crypto = require('crypto');

const SMS_CONNECTOR_URL = process.env.SMS_CONNECTOR_URL || 'http://localhost:3980';
const SMS_WEBHOOK_SECRET = process.env.SMS_WEBHOOK_SECRET;

/**
 * Send a ticket event notification to SMS connector
 * @param {string} eventType - Event type: created, assigned, resolved, status_changed, comment
 * @param {object} ticket - Ticket data
 * @param {string} tenantCode - Tenant code
 * @param {object} details - Additional event details
 */
async function triggerSmsNotification(eventType, ticket, tenantCode, details = {}) {
  // Check if SMS integration is enabled
  if (!process.env.SMS_ENABLED || process.env.SMS_ENABLED !== 'true') {
    return { success: false, reason: 'SMS integration disabled' };
  }

  try {
    const payload = {
      eventType,
      tenantCode,
      ticket: {
        id: ticket.id,
        title: ticket.title,
        description: ticket.description,
        status: ticket.status,
        priority: ticket.priority,
        assignee_id: ticket.assignee_id,
        assignee_name: ticket.assignee_name || ticket.assignee_full_name,
        requester_name: ticket.requester_name || ticket.customer_name,
        created_at: ticket.created_at,
        updated_at: ticket.updated_at,
        resolution_comment: ticket.resolution_comment,
        ...details
      },
      timestamp: new Date().toISOString()
    };

    const headers = {
      'Content-Type': 'application/json'
    };

    // Add HMAC signature if secret is configured
    if (SMS_WEBHOOK_SECRET) {
      const signature = crypto
        .createHmac('sha256', SMS_WEBHOOK_SECRET)
        .update(JSON.stringify(payload))
        .digest('hex');
      headers['X-ServiFlow-Signature'] = signature;
    }

    const response = await fetch(`${SMS_CONNECTOR_URL}/api/webhook/ticket`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      timeout: 5000
    });

    const result = await response.json();

    if (response.ok) {
      console.log(`[SMS] Notification sent: ${eventType} for ticket #${ticket.id}`);
      return { success: true, ...result };
    } else {
      console.error(`[SMS] Failed to send notification:`, result);
      return { success: false, error: result.error || 'Unknown error' };
    }

  } catch (error) {
    // Don't let SMS notification failures affect ticket operations
    console.error(`[SMS] Error sending notification:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Fire-and-forget wrapper - sends notification without waiting
 */
function triggerSmsNotificationAsync(eventType, ticket, tenantCode, details = {}) {
  // Execute in background without blocking
  setImmediate(() => {
    triggerSmsNotification(eventType, ticket, tenantCode, details)
      .catch(err => console.error('[SMS] Async notification error:', err.message));
  });
}

module.exports = {
  triggerSmsNotification,
  triggerSmsNotificationAsync
};
