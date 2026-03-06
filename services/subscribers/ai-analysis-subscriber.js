/**
 * AI Analysis Subscriber
 *
 * Listens for ticket lifecycle events and triggers AI classification.
 * Uses the existing triggerClassification() fire-and-forget wrapper
 * which has its own concurrency queue and error handling.
 *
 * Phase 4: subscribes to ticket.created only.
 * Existing direct calls in routes/tickets.js and email-processor.js
 * remain in place — triggerClassification is idempotent.
 */

const { subscribe, TICKET_EVENTS } = require('../ticket-event-bus');
const { triggerClassification } = require('../../scripts/classify-ticket');

subscribe(TICKET_EVENTS.CREATED, async ({ tenantCode, ticketId }) => {
  try {
    triggerClassification(tenantCode, ticketId);
    console.log(`[ai-analysis-subscriber] Classification triggered for ticket #${ticketId} (${tenantCode})`);
  } catch (error) {
    console.error(`[ai-analysis-subscriber] Failed to trigger classification for ticket #${ticketId}:`, error.message);
  }
});

console.log('[ai-analysis-subscriber] Registered for ticket.created');
