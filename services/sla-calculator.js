/**
 * SLA Calculator Service
 *
 * Handles SLA deadline calculations and state determination.
 * For MVP: Uses calendar time (ignores business hours for now).
 */

/**
 * Add minutes to a date (calendar time for now)
 * @param {Date} startDate
 * @param {number} minutes
 * @returns {Date}
 */
function addMinutes(startDate, minutes) {
  return new Date(startDate.getTime() + minutes * 60 * 1000);
}

/**
 * Get default SLA definition for a tenant
 * Returns the first active SLA definition (can be enhanced to use priority-based rules)
 */
async function getDefaultSLA(connection) {
  const [definitions] = await connection.query(`
    SELECT id, name, response_target_minutes, resolve_after_response_minutes, resolve_target_minutes,
           near_breach_percent, past_breach_percent
    FROM sla_definitions
    WHERE is_active = 1
    ORDER BY id ASC
    LIMIT 1
  `);
  return definitions.length > 0 ? definitions[0] : null;
}

/**
 * Compute SLA deadlines for a new ticket
 * @param {Object} sla - SLA definition
 * @param {Date} createdAt - Ticket creation time
 * @returns {Object} { response_due_at, resolve_due_at }
 */
function computeInitialDeadlines(sla, createdAt) {
  const created = new Date(createdAt);

  // Response deadline: created_at + response_target_minutes
  const response_due_at = addMinutes(created, sla.response_target_minutes);

  // Initial resolve deadline: response_due_at + resolve_after_response_minutes
  // (will be recalculated when first_responded_at is set)
  const resolve_due_at = addMinutes(response_due_at, sla.resolve_after_response_minutes || sla.resolve_target_minutes);

  return {
    response_due_at,
    resolve_due_at
  };
}

/**
 * Recompute resolve deadline after first response
 * @param {Object} sla - SLA definition
 * @param {Date} firstRespondedAt - When ticket was first responded to
 * @returns {Date} resolve_due_at
 */
function computeResolveDeadline(sla, firstRespondedAt) {
  const responded = new Date(firstRespondedAt);
  return addMinutes(responded, sla.resolve_after_response_minutes || sla.resolve_target_minutes);
}

/**
 * Calculate SLA state for response
 * @param {Date|null} dueAt - Response deadline
 * @param {Date|null} respondedAt - When first responded (null if not yet)
 * @param {number} nearBreachPercent - Threshold for near breach (default 85)
 * @param {Date} createdAt - Ticket creation time
 * @returns {Object} { state: 'on_track'|'near_breach'|'breached'|'met', percent_elapsed }
 */
function calculateResponseState(dueAt, respondedAt, nearBreachPercent, createdAt) {
  if (!dueAt) return { state: 'no_sla', percent_elapsed: 0 };

  const now = new Date();
  const due = new Date(dueAt);
  const created = new Date(createdAt);
  const totalTime = due.getTime() - created.getTime();

  // If already responded
  if (respondedAt) {
    const responded = new Date(respondedAt);
    if (responded <= due) {
      return { state: 'met', percent_elapsed: 100 };
    } else {
      return { state: 'breached', percent_elapsed: 100 };
    }
  }

  // Not yet responded - calculate current state
  const elapsed = now.getTime() - created.getTime();
  const percent_elapsed = totalTime > 0 ? Math.round((elapsed / totalTime) * 100) : 0;

  if (now > due) {
    return { state: 'breached', percent_elapsed: Math.min(percent_elapsed, 999) };
  } else if (percent_elapsed >= (nearBreachPercent || 85)) {
    return { state: 'near_breach', percent_elapsed };
  } else {
    return { state: 'on_track', percent_elapsed };
  }
}

/**
 * Calculate SLA state for resolution
 * @param {Date|null} dueAt - Resolution deadline
 * @param {Date|null} firstRespondedAt - When first responded
 * @param {Date|null} resolvedAt - When resolved (null if not yet)
 * @param {number} nearBreachPercent - Threshold for near breach (default 85)
 * @returns {Object} { state: 'pending'|'on_track'|'near_breach'|'breached'|'met', percent_elapsed }
 */
function calculateResolveState(dueAt, firstRespondedAt, resolvedAt, nearBreachPercent) {
  // Resolve clock only starts after first response
  if (!firstRespondedAt) {
    return { state: 'pending', percent_elapsed: 0 };
  }

  if (!dueAt) return { state: 'no_sla', percent_elapsed: 0 };

  const now = new Date();
  const due = new Date(dueAt);
  const responded = new Date(firstRespondedAt);
  const totalTime = due.getTime() - responded.getTime();

  // If already resolved
  if (resolvedAt) {
    const resolved = new Date(resolvedAt);
    if (resolved <= due) {
      return { state: 'met', percent_elapsed: 100 };
    } else {
      return { state: 'breached', percent_elapsed: 100 };
    }
  }

  // Not yet resolved - calculate current state
  const elapsed = now.getTime() - responded.getTime();
  const percent_elapsed = totalTime > 0 ? Math.round((elapsed / totalTime) * 100) : 0;

  if (now > due) {
    return { state: 'breached', percent_elapsed: Math.min(percent_elapsed, 999) };
  } else if (percent_elapsed >= (nearBreachPercent || 85)) {
    return { state: 'near_breach', percent_elapsed };
  } else {
    return { state: 'on_track', percent_elapsed };
  }
}

/**
 * Compute full SLA status for a ticket
 * @param {Object} ticket - Ticket with SLA fields
 * @param {Object} slaDef - SLA definition (optional, will be included in ticket if applied)
 * @returns {Object} SLA status object
 */
function computeSLAStatus(ticket, slaDef = null) {
  const nearBreachPercent = slaDef?.near_breach_percent || 85;

  const responseState = calculateResponseState(
    ticket.response_due_at,
    ticket.first_responded_at,
    nearBreachPercent,
    ticket.created_at
  );

  const resolveState = calculateResolveState(
    ticket.resolve_due_at,
    ticket.first_responded_at,
    ticket.resolved_at,
    nearBreachPercent
  );

  return {
    sla_definition_id: ticket.sla_definition_id,
    sla_name: slaDef?.name || null,
    response: {
      due_at: ticket.response_due_at,
      first_responded_at: ticket.first_responded_at,
      state: responseState.state,
      percent_elapsed: responseState.percent_elapsed
    },
    resolve: {
      due_at: ticket.resolve_due_at,
      resolved_at: ticket.resolved_at,
      state: resolveState.state,
      percent_elapsed: resolveState.percent_elapsed
    }
  };
}

module.exports = {
  getDefaultSLA,
  computeInitialDeadlines,
  computeResolveDeadline,
  calculateResponseState,
  calculateResolveState,
  computeSLAStatus
};
