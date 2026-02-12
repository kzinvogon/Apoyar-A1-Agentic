/**
 * Canonical ticket activity logger.
 *
 * Every service/route should use this helper to write to ticket_activity
 * so that source, actor_type, event_key and meta are always populated.
 *
 * Works with both mysql2 pool and connection objects (both expose .query()).
 */

'use strict';

/**
 * Insert a row into ticket_activity.
 *
 * @param {object} executor  mysql2 pool or connection (must have .query())
 * @param {object} payload
 * @param {number}  payload.ticketId      required
 * @param {number|null}  [payload.userId]       user_id FK (nullable)
 * @param {string}  payload.activityType  e.g. 'created', 'assigned', 'classified'
 * @param {string}  payload.description   human-readable text
 * @param {boolean} [payload.isPublic=true]
 * @param {string}  [payload.source='web']       web|email|teams|slack|chatbot|system
 * @param {string}  [payload.actorType]          user|system  (derived if omitted)
 * @param {number|null}  [payload.actorId]       actor FK (derived if omitted)
 * @param {string}  [payload.eventKey]           e.g. 'ticket.created' (derived if omitted)
 * @param {object|null}  [payload.meta]          arbitrary JSON blob
 * @param {string|null}  [payload.requestId]     correlation / trace id
 * @returns {Promise<{insertId: number}>}
 */
async function logTicketActivity(executor, payload) {
  const {
    ticketId,
    userId = null,
    activityType,
    description,
    isPublic = true,
    source = 'web',
    actorType: actorTypeIn,
    actorId: actorIdIn,
    eventKey: eventKeyIn,
    meta = null,
    requestId = null
  } = payload;

  // Derive actor fields
  const actorType = actorTypeIn || (userId ? 'user' : 'system');
  const actorId = actorIdIn !== undefined ? actorIdIn : (userId || null);
  const eventKey = eventKeyIn || `ticket.${activityType}`;
  const metaJson = meta ? JSON.stringify(meta) : null;

  const [result] = await executor.query(
    `INSERT INTO ticket_activity
       (ticket_id, user_id, activity_type, description, is_public,
        source, actor_type, actor_id, event_key, meta, request_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ticketId,
      userId,
      activityType,
      description,
      isPublic,
      source,
      actorType,
      actorId,
      eventKey,
      metaJson,
      requestId
    ]
  );

  return { insertId: result.insertId };
}

/**
 * Log a ticket view with DB-level 5-minute dedupe.
 *
 * Uses INSERT ... SELECT ... WHERE NOT EXISTS so it is multi-instance safe.
 * Callers should fire-and-forget: logTicketViewIfNotRecent(...).catch(()=>{})
 *
 * @param {object} executor  mysql2 pool or connection
 * @param {object} opts
 * @param {number} opts.ticketId
 * @param {number} opts.userId
 * @param {string} [opts.source='web']
 */
async function logTicketViewIfNotRecent(executor, { ticketId, userId, source = 'web' }) {
  await executor.query(
    `INSERT INTO ticket_activity
       (ticket_id, user_id, activity_type, description, is_public,
        source, actor_type, actor_id, event_key)
     SELECT ?, ?, 'viewed', 'Ticket viewed', FALSE,
            ?, 'user', ?, 'ticket.viewed'
     FROM DUAL
     WHERE NOT EXISTS (
       SELECT 1 FROM ticket_activity
       WHERE ticket_id = ?
         AND actor_id = ?
         AND event_key = 'ticket.viewed'
         AND created_at > DATE_SUB(NOW(), INTERVAL 5 MINUTE)
     )`,
    [ticketId, userId, source, userId, ticketId, userId]
  );
}

module.exports = { logTicketActivity, logTicketViewIfNotRecent };
