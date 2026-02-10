const { CloudAdapter, ConfigurationBotFrameworkAuthentication, TurnContext } = require('botbuilder');
const { buildNotificationCard } = require('../bot/adaptiveCards/notificationCard');
const { CardFactory } = require('botbuilder');
const { createTicketViewUrl } = require('../utils/tokenGenerator');

// Bot Framework Authentication
const botFrameworkAuth = new ConfigurationBotFrameworkAuthentication({
  MicrosoftAppId: process.env.MICROSOFT_APP_ID,
  MicrosoftAppPassword: process.env.MICROSOFT_APP_PASSWORD,
  MicrosoftAppTenantId: process.env.MICROSOFT_APP_TENANT_ID
});

const adapter = new CloudAdapter(botFrameworkAuth);

// In-memory store for conversation references
// In production, this should be stored in database (teams_conversation_refs table)
const conversationReferences = new Map();

/**
 * Store a conversation reference for future proactive messaging
 * Called when the bot is added to a channel or receives a message
 */
function storeConversationReference(activity) {
  const conversationRef = TurnContext.getConversationReference(activity);
  const key = `${conversationRef.conversation.tenantId}:${conversationRef.conversation.id}`;
  conversationReferences.set(key, conversationRef);
  console.log(`[Notifier] Stored conversation reference: ${key}`);
  return key;
}

/**
 * Get all stored conversation references
 */
function getConversationReferences() {
  return Array.from(conversationReferences.values());
}

/**
 * Send a proactive notification to a specific channel
 */
async function sendNotificationToChannel(conversationRef, eventType, ticket, details = {}, options = {}) {
  try {
    await adapter.continueConversationAsync(
      process.env.MICROSOFT_APP_ID,
      conversationRef,
      async (context) => {
        const card = buildNotificationCard(eventType, ticket, details, { ticketUrl: options.ticketUrl });
        await context.sendActivity({
          attachments: [CardFactory.adaptiveCard(card)]
        });
      }
    );
    console.log(`[Notifier] Sent ${eventType} notification for ticket #${ticket.id}`);
    return { success: true };
  } catch (error) {
    console.error(`[Notifier] Failed to send notification:`, error);
    return { success: false, error: error.message };
  }
}

/**
 * Send a notification to all registered channels
 */
async function broadcastNotification(eventType, ticket, details = {}, options = {}) {
  const results = [];

  for (const [key, conversationRef] of conversationReferences) {
    const result = await sendNotificationToChannel(conversationRef, eventType, ticket, details, options);
    results.push({ channel: key, ...result });
  }

  return results;
}

/**
 * Send notification to channels that match specific criteria
 * In production, this would query teams_channel_mappings table
 */
async function sendNotificationWithFilters(eventType, ticket, details = {}, filters = {}) {
  // TODO: Query teams_channel_mappings table to get channels that:
  // 1. Match the tenant
  // 2. Have this notification type enabled
  // 3. Match priority filter if applicable

  // For now, broadcast to all channels
  return broadcastNotification(eventType, ticket, details, filters);
}

/**
 * Handle incoming webhook from ServiFlow and dispatch notification
 */
async function handleTicketEvent(eventType, ticketData, tenantCode) {
  console.log(`[Notifier] Received ${eventType} event for ticket #${ticketData.id}`);

  const details = {};

  switch (eventType) {
    case 'created':
      // No extra details needed
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

  // Generate token-based URL for direct ticket access
  let ticketUrl;
  try {
    ticketUrl = await createTicketViewUrl(tenantCode, ticketData.id);
  } catch (e) {
    console.warn(`[Notifier] Could not generate token URL for ticket #${ticketData.id}:`, e.message);
  }

  const results = await sendNotificationWithFilters(eventType, ticketData, details, {
    tenantCode,
    priority: ticketData.priority,
    ticketUrl
  });

  return {
    success: true,
    eventType,
    ticketId: ticketData.id,
    notificationsSent: results.filter(r => r.success).length,
    notificationsFailed: results.filter(r => !r.success).length
  };
}

module.exports = {
  storeConversationReference,
  getConversationReferences,
  sendNotificationToChannel,
  broadcastNotification,
  sendNotificationWithFilters,
  handleTicketEvent,
  adapter
};
