/**
 * SMS Notifier - Sends proactive outbound SMS notifications for ticket events.
 * Mirrors teamsNotifier.js but sends plain-text SMS via Twilio.
 */

const { sendSms } = require('./twilioClient');
const { createTicketViewUrl } = require('../utils/tokenGenerator');
const { formatNotification } = require('../bot/formatters/notificationFormatter');
const { getTenantConnection } = require('../config/database');

/**
 * Send an SMS notification to relevant users for a ticket event
 * @param {string} eventType - created, assigned, resolved, status_changed, comment
 * @param {object} ticketData - Ticket data from webhook
 * @param {string} tenantCode - Tenant code
 * @returns {Promise<object>} Result summary
 */
async function handleTicketEvent(eventType, ticketData, tenantCode) {
  console.log(`[SMS Notifier] Received ${eventType} event for ticket #${ticketData.id}`);

  const details = {};

  switch (eventType) {
    case 'created':
      break;
    case 'assigned':
      details.assignedTo = ticketData.assignee_name || ticketData.assignee_full_name;
      break;
    case 'resolved':
      details.resolutionComment = ticketData.resolution_comment;
      break;
    case 'status_changed':
      details.previousStatus = ticketData.previous_status;
      break;
    case 'comment':
      details.comment = ticketData.latest_comment;
      break;
  }

  // Generate token-based URL
  let ticketUrl;
  try {
    ticketUrl = await createTicketViewUrl(tenantCode, ticketData.id);
  } catch (e) {
    console.warn(`[SMS Notifier] Could not generate token URL for ticket #${ticketData.id}:`, e.message);
  }

  // Find users to notify via SMS
  const recipientPhones = await getNotificationRecipients(tenantCode, eventType, ticketData);

  if (recipientPhones.length === 0) {
    console.log(`[SMS Notifier] No SMS recipients for ${eventType} on ticket #${ticketData.id}`);
    return {
      success: true,
      eventType,
      ticketId: ticketData.id,
      notificationsSent: 0,
      notificationsFailed: 0
    };
  }

  const message = formatNotification(eventType, ticketData, details, ticketUrl);

  let sent = 0;
  let failed = 0;

  for (const phone of recipientPhones) {
    try {
      await sendSms(phone, message);
      sent++;
    } catch (error) {
      console.error(`[SMS Notifier] Failed to send to ${phone}:`, error.message);
      failed++;
    }
  }

  return {
    success: true,
    eventType,
    ticketId: ticketData.id,
    notificationsSent: sent,
    notificationsFailed: failed
  };
}

/**
 * Determine which phone numbers should receive a notification for this event.
 * - assigned: notify the assignee (if they have SMS prefs)
 * - resolved/status_changed: notify the requester (if they have SMS prefs)
 * - created: notify experts in expert mode (optional, off by default to avoid spam)
 */
async function getNotificationRecipients(tenantCode, eventType, ticketData) {
  const phones = [];

  try {
    const pool = await getTenantConnection(tenantCode);

    if (eventType === 'assigned' && ticketData.assignee_id) {
      // Notify the assignee
      const [rows] = await pool.query(
        'SELECT phone_number FROM sms_user_preferences WHERE user_id = ?',
        [ticketData.assignee_id]
      );
      for (const r of rows) phones.push(r.phone_number);
    }

    if (eventType === 'resolved' || eventType === 'status_changed' || eventType === 'comment') {
      // Notify the requester
      const requesterId = ticketData.requester_id;
      if (requesterId) {
        const [rows] = await pool.query(
          'SELECT phone_number FROM sms_user_preferences WHERE user_id = ?',
          [requesterId]
        );
        for (const r of rows) phones.push(r.phone_number);
      }
    }

    // Note: We intentionally don't broadcast 'created' events to all users
    // to avoid SMS cost/spam. Admins can customize this behavior.

  } catch (error) {
    console.error(`[SMS Notifier] Error getting recipients:`, error.message);
  }

  // Deduplicate
  return [...new Set(phones)];
}

module.exports = {
  handleTicketEvent,
  getNotificationRecipients
};
