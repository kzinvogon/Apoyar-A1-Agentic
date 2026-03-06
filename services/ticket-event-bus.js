/**
 * Ticket Event Bus
 *
 * Lightweight in-process event dispatcher for ticket lifecycle events.
 * Uses a plain Map<string, Set<handler>> — no EventEmitter dependency.
 *
 * - Handlers are async-safe: exceptions are caught and logged, never propagate
 * - emit() fires all handlers concurrently via Promise.allSettled()
 * - subscribe() returns an unsubscribe function for clean teardown
 */

const TICKET_EVENTS = {
  CREATED:       'ticket.created',
  UPDATED:       'ticket.updated',
  ASSIGNED:      'ticket.assigned',
  RESOLVED:      'ticket.resolved',
  CLOSED:        'ticket.closed',
  COMMENT_ADDED: 'ticket.comment_added'
};

/** @type {Map<string, Set<function>>} */
const handlers = new Map();

/**
 * Register a handler for a ticket event.
 * @param {string} event - One of TICKET_EVENTS values
 * @param {function} handler - Async-safe handler(payload)
 * @returns {function} unsubscribe - Call to remove this handler
 */
function subscribe(event, handler) {
  if (!handlers.has(event)) {
    handlers.set(event, new Set());
  }
  handlers.get(event).add(handler);

  return function unsubscribe() {
    const set = handlers.get(event);
    if (set) {
      set.delete(handler);
      if (set.size === 0) {
        handlers.delete(event);
      }
    }
  };
}

/**
 * Emit a ticket event to all registered handlers.
 * @param {string} event - One of TICKET_EVENTS values
 * @param {object} payload - Event data passed to each handler
 * @returns {Promise<void>}
 */
async function emit(event, payload) {
  const set = handlers.get(event);
  if (!set || set.size === 0) return;

  const results = await Promise.allSettled(
    Array.from(set).map(handler => Promise.resolve(handler(payload)))
  );

  for (const result of results) {
    if (result.status === 'rejected') {
      console.error(`[ticket-event-bus] Handler failed for "${event}":`, result.reason);
    }
  }
}

module.exports = { subscribe, emit, TICKET_EVENTS };
