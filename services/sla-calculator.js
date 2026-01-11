/**
 * SLA Calculator Service
 *
 * Handles SLA deadline calculations and state determination.
 * Supports business hours with timezone awareness.
 */

/**
 * Parse days_of_week from DB (could be JSON string or array)
 * @param {string|Array} daysOfWeek - JSON string like "[1,2,3,4,5]" or array
 * @returns {Array<number>} - Array of day numbers (1=Mon, 7=Sun)
 */
function parseDaysOfWeek(daysOfWeek) {
  if (!daysOfWeek) return [1, 2, 3, 4, 5, 6, 7]; // Default to all days
  if (Array.isArray(daysOfWeek)) return daysOfWeek;
  try {
    const parsed = JSON.parse(daysOfWeek);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    return [1, 2, 3, 4, 5, 6, 7];
  } catch (e) {
    return [1, 2, 3, 4, 5, 6, 7];
  }
}

/**
 * Parse time string (HH:MM:SS or HH:MM) to hours and minutes
 * @param {string} timeStr - Time string like "09:00:00" or "09:00"
 * @returns {{ hours: number, minutes: number }}
 */
function parseTime(timeStr) {
  if (!timeStr) return { hours: 0, minutes: 0 };
  const parts = timeStr.split(':');
  return {
    hours: parseInt(parts[0], 10) || 0,
    minutes: parseInt(parts[1], 10) || 0
  };
}

/**
 * Convert JS Date.getDay() (0=Sun, 6=Sat) to ISO day (1=Mon, 7=Sun)
 * @param {number} jsDay - JS day of week
 * @returns {number} - ISO day of week
 */
function jsToIsoDay(jsDay) {
  return jsDay === 0 ? 7 : jsDay;
}

/**
 * Check if a given date/time falls within business hours
 * @param {Date} date - Date to check (in local timezone)
 * @param {Object} profile - Business hours profile
 * @returns {boolean}
 */
function isWithinBusinessHours(date, profile) {
  if (!profile || profile.is_24x7) return true;

  const daysOfWeek = parseDaysOfWeek(profile.days_of_week);
  const isoDay = jsToIsoDay(date.getDay());

  // Check if day is a working day
  if (!daysOfWeek.includes(isoDay)) return false;

  // Check time range
  const start = parseTime(profile.start_time);
  const end = parseTime(profile.end_time);

  const currentMinutes = date.getHours() * 60 + date.getMinutes();
  const startMinutes = start.hours * 60 + start.minutes;
  const endMinutes = end.hours * 60 + end.minutes;

  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

/**
 * Get the next business hour start time from a given date
 * @param {Date} date - Starting date (in local timezone)
 * @param {Object} profile - Business hours profile
 * @param {number} maxIterations - Max days to search (prevent infinite loop)
 * @returns {Date} - Next business hour start
 */
function getNextBusinessStart(date, profile, maxIterations = 14) {
  if (!profile || profile.is_24x7) return new Date(date);

  const daysOfWeek = parseDaysOfWeek(profile.days_of_week);
  if (daysOfWeek.length === 0) return new Date(date); // Defensive: no valid days

  const start = parseTime(profile.start_time);
  const end = parseTime(profile.end_time);
  const current = new Date(date);

  for (let i = 0; i < maxIterations; i++) {
    const isoDay = jsToIsoDay(current.getDay());

    if (daysOfWeek.includes(isoDay)) {
      const startMinutes = start.hours * 60 + start.minutes;
      const endMinutes = end.hours * 60 + end.minutes;
      const currentMinutes = current.getHours() * 60 + current.getMinutes();

      // If we're before business hours today, return today's start
      if (currentMinutes < startMinutes) {
        current.setHours(start.hours, start.minutes, 0, 0);
        return current;
      }

      // If we're within business hours, return current time
      if (currentMinutes >= startMinutes && currentMinutes < endMinutes) {
        return current;
      }
    }

    // Move to start of next day
    current.setDate(current.getDate() + 1);
    current.setHours(start.hours, start.minutes, 0, 0);
  }

  // Fallback: return original date if no business day found
  return new Date(date);
}

/**
 * Add business minutes to a date
 * @param {Date} startDate - Starting date
 * @param {number} minutes - Business minutes to add
 * @param {Object} profile - Business hours profile
 * @param {number} maxIterations - Max iterations (prevent infinite loop)
 * @returns {Date} - Result date
 */
function addBusinessMinutes(startDate, minutes, profile, maxIterations = 10000) {
  if (!profile || profile.is_24x7) {
    // 24x7: simple calendar time
    return new Date(startDate.getTime() + minutes * 60 * 1000);
  }

  const daysOfWeek = parseDaysOfWeek(profile.days_of_week);
  if (daysOfWeek.length === 0) {
    // Defensive: fallback to calendar time
    return new Date(startDate.getTime() + minutes * 60 * 1000);
  }

  const start = parseTime(profile.start_time);
  const end = parseTime(profile.end_time);
  const dailyMinutes = (end.hours * 60 + end.minutes) - (start.hours * 60 + start.minutes);

  if (dailyMinutes <= 0) {
    // Defensive: invalid time range, fallback to calendar time
    return new Date(startDate.getTime() + minutes * 60 * 1000);
  }

  let current = getNextBusinessStart(new Date(startDate), profile);
  let remainingMinutes = minutes;
  let iterations = 0;

  while (remainingMinutes > 0 && iterations < maxIterations) {
    iterations++;

    const isoDay = jsToIsoDay(current.getDay());
    if (!daysOfWeek.includes(isoDay)) {
      // Skip non-business day
      current.setDate(current.getDate() + 1);
      current.setHours(start.hours, start.minutes, 0, 0);
      continue;
    }

    const currentMinutes = current.getHours() * 60 + current.getMinutes();
    const endMinutes = end.hours * 60 + end.minutes;
    const minutesLeftToday = endMinutes - currentMinutes;

    if (minutesLeftToday <= 0) {
      // Move to next day
      current.setDate(current.getDate() + 1);
      current.setHours(start.hours, start.minutes, 0, 0);
      continue;
    }

    if (remainingMinutes <= minutesLeftToday) {
      // Enough time left today
      current = new Date(current.getTime() + remainingMinutes * 60 * 1000);
      remainingMinutes = 0;
    } else {
      // Consume rest of today and continue tomorrow
      remainingMinutes -= minutesLeftToday;
      current.setDate(current.getDate() + 1);
      current.setHours(start.hours, start.minutes, 0, 0);
    }
  }

  return current;
}

/**
 * Calculate elapsed business minutes between two dates
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @param {Object} profile - Business hours profile
 * @returns {number} - Elapsed business minutes
 */
function elapsedBusinessMinutes(startDate, endDate, profile) {
  if (!profile || profile.is_24x7) {
    return Math.max(0, Math.round((endDate - startDate) / 60000));
  }

  const daysOfWeek = parseDaysOfWeek(profile.days_of_week);
  if (daysOfWeek.length === 0) {
    return Math.max(0, Math.round((endDate - startDate) / 60000));
  }

  const start = parseTime(profile.start_time);
  const end = parseTime(profile.end_time);
  const startMinOfDay = start.hours * 60 + start.minutes;
  const endMinOfDay = end.hours * 60 + end.minutes;
  const dailyMinutes = endMinOfDay - startMinOfDay;

  if (dailyMinutes <= 0) {
    return Math.max(0, Math.round((endDate - startDate) / 60000));
  }

  let current = new Date(startDate);
  let totalMinutes = 0;
  const maxIterations = 365; // Max 1 year

  for (let i = 0; i < maxIterations && current < endDate; i++) {
    const isoDay = jsToIsoDay(current.getDay());

    if (daysOfWeek.includes(isoDay)) {
      const currentMinOfDay = current.getHours() * 60 + current.getMinutes();

      // Find effective start for this day
      let effectiveStart = Math.max(currentMinOfDay, startMinOfDay);
      let effectiveEnd = endMinOfDay;

      // Check if endDate is on this same day
      const isSameDay = current.toDateString() === endDate.toDateString();
      if (isSameDay) {
        const endMinutes = endDate.getHours() * 60 + endDate.getMinutes();
        effectiveEnd = Math.min(effectiveEnd, endMinutes);
      }

      // Add business minutes for this day
      if (effectiveEnd > effectiveStart) {
        totalMinutes += effectiveEnd - effectiveStart;
      }
    }

    // Move to next day at business start
    current.setDate(current.getDate() + 1);
    current.setHours(start.hours, start.minutes, 0, 0);
  }

  return totalMinutes;
}

/**
 * Get default SLA definition for a tenant (with business hours profile)
 * Returns the first active SLA definition
 */
async function getDefaultSLA(connection) {
  const [definitions] = await connection.query(`
    SELECT s.id, s.name, s.response_target_minutes, s.resolve_after_response_minutes,
           s.resolve_target_minutes, s.near_breach_percent, s.past_breach_percent,
           s.business_hours_profile_id,
           b.timezone, b.days_of_week, b.start_time, b.end_time, b.is_24x7
    FROM sla_definitions s
    LEFT JOIN business_hours_profiles b ON s.business_hours_profile_id = b.id
    WHERE s.is_active = 1
    ORDER BY s.id ASC
    LIMIT 1
  `);
  return definitions.length > 0 ? definitions[0] : null;
}

/**
 * Build business hours profile object from SLA definition row
 * @param {Object} sla - SLA definition with business hours fields
 * @returns {Object|null} - Business hours profile or null for 24x7
 */
function buildProfile(sla) {
  if (!sla || !sla.business_hours_profile_id) {
    // No profile: fallback to 24x7
    return null;
  }
  return {
    timezone: sla.timezone || 'UTC',
    days_of_week: sla.days_of_week,
    start_time: sla.start_time,
    end_time: sla.end_time,
    is_24x7: Boolean(sla.is_24x7)
  };
}

/**
 * Compute SLA deadlines for a new ticket
 * @param {Object} sla - SLA definition (with business hours fields)
 * @param {Date} createdAt - Ticket creation time
 * @returns {Object} { response_due_at, resolve_due_at }
 */
function computeInitialDeadlines(sla, createdAt) {
  const created = new Date(createdAt);
  const profile = buildProfile(sla);

  // Response deadline: start from next business hours + response_target_minutes
  const response_due_at = addBusinessMinutes(created, sla.response_target_minutes, profile);

  // Initial resolve deadline: response_due_at + resolve_after_response_minutes
  // (will be recalculated when first_responded_at is set)
  const resolveMinutes = sla.resolve_after_response_minutes || sla.resolve_target_minutes;
  const resolve_due_at = addBusinessMinutes(response_due_at, resolveMinutes, profile);

  return {
    response_due_at,
    resolve_due_at
  };
}

/**
 * Recompute resolve deadline after first response
 * @param {Object} sla - SLA definition (with business hours fields)
 * @param {Date} firstRespondedAt - When ticket was first responded to
 * @returns {Date} resolve_due_at
 */
function computeResolveDeadline(sla, firstRespondedAt) {
  const responded = new Date(firstRespondedAt);
  const profile = buildProfile(sla);
  const resolveMinutes = sla.resolve_after_response_minutes || sla.resolve_target_minutes;
  return addBusinessMinutes(responded, resolveMinutes, profile);
}

/**
 * Calculate SLA state for response
 * @param {Date|null} dueAt - Response deadline
 * @param {Date|null} respondedAt - When first responded (null if not yet)
 * @param {number} nearBreachPercent - Threshold for near breach (default 85)
 * @param {Date} createdAt - Ticket creation time
 * @param {Object} profile - Business hours profile (optional)
 * @returns {Object} { state, percent_elapsed }
 */
function calculateResponseState(dueAt, respondedAt, nearBreachPercent, createdAt, profile = null) {
  if (!dueAt) return { state: 'no_sla', percent_elapsed: 0 };

  const now = new Date();
  const due = new Date(dueAt);
  const created = new Date(createdAt);

  // If already responded
  if (respondedAt) {
    const responded = new Date(respondedAt);
    if (responded <= due) {
      return { state: 'met', percent_elapsed: 100 };
    } else {
      return { state: 'breached', percent_elapsed: 100 };
    }
  }

  // Calculate elapsed vs total (in business minutes if profile provided)
  let elapsed, total;
  if (profile && !profile.is_24x7) {
    elapsed = elapsedBusinessMinutes(created, now, profile);
    total = elapsedBusinessMinutes(created, due, profile);
  } else {
    elapsed = (now.getTime() - created.getTime()) / 60000;
    total = (due.getTime() - created.getTime()) / 60000;
  }

  const percent_elapsed = total > 0 ? Math.round((elapsed / total) * 100) : 0;

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
 * @param {Object} profile - Business hours profile (optional)
 * @returns {Object} { state, percent_elapsed }
 */
function calculateResolveState(dueAt, firstRespondedAt, resolvedAt, nearBreachPercent, profile = null) {
  // Resolve clock only starts after first response
  if (!firstRespondedAt) {
    return { state: 'pending', percent_elapsed: 0 };
  }

  if (!dueAt) return { state: 'no_sla', percent_elapsed: 0 };

  const now = new Date();
  const due = new Date(dueAt);
  const responded = new Date(firstRespondedAt);

  // If already resolved
  if (resolvedAt) {
    const resolved = new Date(resolvedAt);
    if (resolved <= due) {
      return { state: 'met', percent_elapsed: 100 };
    } else {
      return { state: 'breached', percent_elapsed: 100 };
    }
  }

  // Calculate elapsed vs total (in business minutes if profile provided)
  let elapsed, total;
  if (profile && !profile.is_24x7) {
    elapsed = elapsedBusinessMinutes(responded, now, profile);
    total = elapsedBusinessMinutes(responded, due, profile);
  } else {
    elapsed = (now.getTime() - responded.getTime()) / 60000;
    total = (due.getTime() - responded.getTime()) / 60000;
  }

  const percent_elapsed = total > 0 ? Math.round((elapsed / total) * 100) : 0;

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
 * @param {Object} slaDef - SLA definition (optional, with business hours)
 * @returns {Object} SLA status object
 */
function computeSLAStatus(ticket, slaDef = null) {
  const nearBreachPercent = slaDef?.near_breach_percent || 85;
  const profile = slaDef ? buildProfile(slaDef) : null;

  const responseState = calculateResponseState(
    ticket.response_due_at,
    ticket.first_responded_at,
    nearBreachPercent,
    ticket.created_at,
    profile
  );

  const resolveState = calculateResolveState(
    ticket.resolve_due_at,
    ticket.first_responded_at,
    ticket.resolved_at,
    nearBreachPercent,
    profile
  );

  // Determine SLA phase
  let sla_phase = 'awaiting_response';
  if (ticket.resolved_at) {
    sla_phase = 'resolved';
  } else if (ticket.first_responded_at) {
    sla_phase = 'in_progress';
  }

  // Check if currently outside business hours
  let outside_business_hours = false;
  if (profile && !profile.is_24x7) {
    outside_business_hours = !isWithinBusinessHours(new Date(), profile);
  }

  return {
    sla_definition_id: ticket.sla_definition_id,
    sla_name: slaDef?.name || null,
    sla_phase,
    outside_business_hours,
    response_due_at: ticket.response_due_at,
    resolve_due_at: ticket.resolve_due_at,
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

/**
 * Calculate remaining business minutes until a deadline
 * @param {Date} dueAt - Deadline
 * @param {Object} profile - Business hours profile
 * @returns {number} - Remaining minutes (negative if overdue)
 */
function remainingBusinessMinutes(dueAt, profile) {
  if (!dueAt) return null;
  const now = new Date();
  const due = new Date(dueAt);

  if (now > due) {
    // Overdue - return negative elapsed time
    if (profile && !profile.is_24x7) {
      return -elapsedBusinessMinutes(due, now, profile);
    }
    return -Math.round((now - due) / 60000);
  }

  if (profile && !profile.is_24x7) {
    return elapsedBusinessMinutes(now, due, profile);
  }
  return Math.round((due - now) / 60000);
}

/**
 * Build SLA facts object for AI context
 * Uses computeSLAStatus output and adds remaining_minutes and timezone
 * @param {Object} ticket - Ticket with SLA fields (including sla_source)
 * @param {Object} slaDef - SLA definition (optional, with business hours)
 * @returns {Object} sla_facts for AI prompts
 */
function buildSLAFacts(ticket, slaDef = null) {
  const status = computeSLAStatus(ticket, slaDef);
  const profile = slaDef ? buildProfile(slaDef) : null;

  // Determine timezone
  const timezone = profile?.timezone || 'UTC';

  // Calculate remaining minutes for response and resolve
  const responseRemaining = status.response.state !== 'met' && status.response.state !== 'no_sla'
    ? remainingBusinessMinutes(status.response.due_at, profile)
    : null;

  const resolveRemaining = status.resolve.state !== 'met' && status.resolve.state !== 'pending' && status.resolve.state !== 'no_sla'
    ? remainingBusinessMinutes(status.resolve.due_at, profile)
    : null;

  return {
    sla_name: status.sla_name,
    sla_source: ticket.sla_source || 'unknown',
    timezone,
    outside_business_hours: status.outside_business_hours,
    phase: status.sla_phase,
    response: {
      state: status.response.state,
      percent_used: status.response.percent_elapsed,
      due_at: status.response.due_at,
      remaining_minutes: responseRemaining
    },
    resolve: {
      state: status.resolve.state,
      percent_used: status.resolve.percent_elapsed,
      due_at: status.resolve.due_at,
      remaining_minutes: resolveRemaining
    }
  };
}

module.exports = {
  // Core functions
  getDefaultSLA,
  computeInitialDeadlines,
  computeResolveDeadline,
  calculateResponseState,
  calculateResolveState,
  computeSLAStatus,
  buildSLAFacts,
  // Business hours utilities (for testing)
  addBusinessMinutes,
  elapsedBusinessMinutes,
  remainingBusinessMinutes,
  isWithinBusinessHours,
  getNextBusinessStart,
  parseDaysOfWeek,
  buildProfile
};
