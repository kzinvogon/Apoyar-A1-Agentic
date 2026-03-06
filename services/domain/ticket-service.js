/**
 * Ticket Domain Service
 *
 * This service defines the ticket lifecycle domain boundary.
 * SQL currently lives in routes but will move here in Phase 3.
 *
 * Each function is a domain entry point that:
 *   1. Validates required fields (throws DomainValidationError on caller bugs)
 *   2. Emits the corresponding lifecycle event via ticket-event-bus
 *   3. Returns a consistent result object { success, event, ticketId }
 *
 * No database imports — infrastructure-neutral until Phase 3.
 */

const { emit, TICKET_EVENTS } = require('../ticket-event-bus');

// ── Error type ──────────────────────────────────────────────────────────

class DomainValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DomainValidationError';
  }
}

// ── Constants ───────────────────────────────────────────────────────────

const EVENT_SOURCES = {
  // Ticket creation origin
  WEB:                'web',
  EMAIL:              'email',
  API:                'api',
  // Close origin
  MANUAL:             'manual',
  CUSTOMER_ACCEPTED:  'customer_accepted',
  AUTO:               'auto',
  // Assignment method
  DIRECT:             'direct',
  SELF_ASSIGN:        'self_assign',
  CLAIM:              'claim',
  ACCEPT_OWNERSHIP:   'accept_ownership',
  TAKE_OVER:          'take_over'
};

// ── Validation helper ───────────────────────────────────────────────────

function requireFields(fnName, fields, payload) {
  for (const field of fields) {
    if (payload[field] === undefined || payload[field] === null) {
      throw new DomainValidationError(`${fnName}: ${field} is required`);
    }
  }
}

// ── Domain functions ────────────────────────────────────────────────────

/**
 * @param {object} params
 * @param {string} params.tenantCode
 * @param {number} params.ticketId
 * @param {number} params.userId        - user who created the ticket
 * @param {string} [params.source]      - EVENT_SOURCES.WEB | EMAIL | API
 * @param {number|null} [params.assigneeId]
 */
async function createTicket(params) {
  requireFields('createTicket', ['tenantCode', 'ticketId', 'userId'], params);

  await emit(TICKET_EVENTS.CREATED, {
    tenantCode: params.tenantCode,
    ticketId: params.ticketId,
    userId: params.userId,
    source: params.source || EVENT_SOURCES.WEB,
    assigneeId: params.assigneeId || null
  });

  return { success: true, event: TICKET_EVENTS.CREATED, ticketId: params.ticketId };
}

/**
 * @param {object} params
 * @param {string} params.tenantCode
 * @param {number} params.ticketId
 * @param {number} params.userId        - user who performed the update
 * @param {object} params.changes       - { status, priority, ... } fields that changed
 * @param {string|null} [params.oldStatus]
 * @param {string|null} [params.newStatus]
 */
async function updateTicket(params) {
  requireFields('updateTicket', ['tenantCode', 'ticketId', 'userId', 'changes'], params);

  await emit(TICKET_EVENTS.UPDATED, {
    tenantCode: params.tenantCode,
    ticketId: params.ticketId,
    userId: params.userId,
    changes: params.changes,
    oldStatus: params.oldStatus || null,
    newStatus: params.newStatus || null
  });

  return { success: true, event: TICKET_EVENTS.UPDATED, ticketId: params.ticketId };
}

/**
 * @param {object} params
 * @param {string} params.tenantCode
 * @param {number} params.ticketId
 * @param {number} params.userId           - user who triggered the assignment
 * @param {number} params.assigneeId       - new assignee
 * @param {number|null} [params.oldAssigneeId]
 * @param {string} [params.method]         - EVENT_SOURCES.DIRECT | SELF_ASSIGN | CLAIM | ACCEPT_OWNERSHIP | TAKE_OVER
 */
async function assignTicket(params) {
  requireFields('assignTicket', ['tenantCode', 'ticketId', 'userId', 'assigneeId'], params);

  await emit(TICKET_EVENTS.ASSIGNED, {
    tenantCode: params.tenantCode,
    ticketId: params.ticketId,
    userId: params.userId,
    assigneeId: params.assigneeId,
    oldAssigneeId: params.oldAssigneeId || null,
    method: params.method || EVENT_SOURCES.DIRECT
  });

  return { success: true, event: TICKET_EVENTS.ASSIGNED, ticketId: params.ticketId };
}

/**
 * @param {object} params
 * @param {string} params.tenantCode
 * @param {number} params.ticketId
 * @param {number} params.userId         - user who resolved the ticket
 * @param {string|null} [params.comment] - resolution comment
 */
async function resolveTicket(params) {
  requireFields('resolveTicket', ['tenantCode', 'ticketId', 'userId'], params);

  await emit(TICKET_EVENTS.RESOLVED, {
    tenantCode: params.tenantCode,
    ticketId: params.ticketId,
    userId: params.userId,
    comment: params.comment || null
  });

  return { success: true, event: TICKET_EVENTS.RESOLVED, ticketId: params.ticketId };
}

/**
 * @param {object} params
 * @param {string} params.tenantCode
 * @param {number} params.ticketId
 * @param {number|null} [params.userId]  - null for public accept (no authenticated user)
 * @param {string} [params.source]       - EVENT_SOURCES.MANUAL | CUSTOMER_ACCEPTED | AUTO
 */
async function closeTicket(params) {
  requireFields('closeTicket', ['tenantCode', 'ticketId'], params);

  await emit(TICKET_EVENTS.CLOSED, {
    tenantCode: params.tenantCode,
    ticketId: params.ticketId,
    userId: params.userId || null,
    source: params.source || EVENT_SOURCES.MANUAL
  });

  return { success: true, event: TICKET_EVENTS.CLOSED, ticketId: params.ticketId };
}

/**
 * @param {object} params
 * @param {string} params.tenantCode
 * @param {number} params.ticketId
 * @param {number} params.userId         - user who added the comment
 * @param {boolean} [params.isInternal]  - true for internal notes
 */
async function addComment(params) {
  requireFields('addComment', ['tenantCode', 'ticketId', 'userId'], params);

  await emit(TICKET_EVENTS.COMMENT_ADDED, {
    tenantCode: params.tenantCode,
    ticketId: params.ticketId,
    userId: params.userId,
    isInternal: params.isInternal || false
  });

  return { success: true, event: TICKET_EVENTS.COMMENT_ADDED, ticketId: params.ticketId };
}

module.exports = {
  DomainValidationError,
  EVENT_SOURCES,
  createTicket,
  updateTicket,
  assignTicket,
  resolveTicket,
  closeTicket,
  addComment
};
