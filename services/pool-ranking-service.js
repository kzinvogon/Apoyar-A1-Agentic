/**
 * Pool Ranking Service
 *
 * Calculates and updates AI-powered pool scores for tickets in the expert pool.
 * Higher scores indicate higher priority for expert attention.
 */

const { getTenantConnection } = require('../config/database');
const { buildSLAFacts } = require('./sla-calculator');
const { AIAnalysisService } = require('./ai-analysis-service');

// Pool score update interval (5 minutes)
const POOL_SCORE_UPDATE_INTERVAL_MS = 5 * 60 * 1000;

// Max tickets to score per batch to avoid overwhelming the system
const MAX_BATCH_SIZE = 20;

/**
 * Calculate pool score for a single ticket using AI
 * @param {object} connection - Database connection
 * @param {object} ticket - Ticket data
 * @returns {Promise<object>} Score result with pool_score and metadata
 */
async function calculatePoolScoreAI(connection, ticket) {
  try {
    // Build context for AI analysis
    const emailData = {
      subject: ticket.title,
      body: ticket.description,
      customerName: ticket.requester_name || 'Unknown',
      companyName: ticket.company_name || 'Unknown',
      createdAt: ticket.created_at,
      currentStatus: ticket.status,
      currentPriority: ticket.priority,
      currentAssignee: 'Unassigned (in pool)'
    };

    // Get SLA definition if exists
    if (ticket.sla_definition_id) {
      const [slaDefs] = await connection.query(
        `SELECT s.*, b.timezone, b.days_of_week, b.start_time, b.end_time, b.is_24x7
         FROM sla_definitions s
         LEFT JOIN business_hours_profiles b ON s.business_hours_profile_id = b.id
         WHERE s.id = ?`,
        [ticket.sla_definition_id]
      );
      if (slaDefs.length > 0) {
        emailData.slaFacts = buildSLAFacts(ticket, slaDefs[0]);
      }
    }

    // Use AI to calculate pool score
    const aiService = new AIAnalysisService();
    aiService.setTask('pool_ranking');
    const result = await aiService.analyze(emailData);

    return {
      success: true,
      pool_score: parseFloat(result.pool_score) || 50,
      urgency_factors: result.urgency_factors || [],
      recommended_skills: result.recommended_skills || [],
      complexity_estimate: result.complexity_estimate || 'medium',
      reasoning: result.reasoning || ''
    };
  } catch (error) {
    console.error(`[POOL_RANKING] AI scoring failed for ticket ${ticket.id}:`, error.message);
    // Fall back to heuristic scoring
    return calculatePoolScoreHeuristic(ticket);
  }
}

/**
 * Calculate pool score using heuristics (fallback when AI unavailable)
 * @param {object} ticket - Ticket data
 * @returns {object} Score result
 */
function calculatePoolScoreHeuristic(ticket) {
  let score = 50; // Base score

  // Priority adjustments
  const priorityBonus = {
    'critical': 30,
    'high': 20,
    'medium': 0,
    'low': -15
  };
  score += priorityBonus[ticket.priority] || 0;

  // SLA proximity adjustments
  if (ticket.response_due_at) {
    const now = new Date();
    const responseDue = new Date(ticket.response_due_at);
    const hoursUntilDue = (responseDue - now) / (1000 * 60 * 60);

    if (hoursUntilDue < 0) {
      score += 25; // Already breached
    } else if (hoursUntilDue < 1) {
      score += 20; // Less than 1 hour
    } else if (hoursUntilDue < 4) {
      score += 10; // Less than 4 hours
    }
  }

  // Age bonus (older tickets get slight priority)
  if (ticket.created_at) {
    const ageHours = (new Date() - new Date(ticket.created_at)) / (1000 * 60 * 60);
    if (ageHours > 24) {
      score += Math.min(10, Math.floor(ageHours / 24) * 2);
    }
  }

  // Clamp to 0-100
  score = Math.max(0, Math.min(100, score));

  return {
    success: true,
    pool_score: score,
    urgency_factors: [],
    recommended_skills: [],
    complexity_estimate: 'unknown',
    reasoning: 'Heuristic scoring (AI unavailable)'
  };
}

/**
 * Update pool score for a single ticket
 * @param {string} tenantCode - Tenant code
 * @param {number} ticketId - Ticket ID
 * @param {boolean} useAI - Whether to use AI scoring (default true)
 */
async function updateTicketPoolScore(tenantCode, ticketId, useAI = true) {
  let connection;
  try {
    connection = await getTenantConnection(tenantCode);

    // Get ticket with all needed data
    const [tickets] = await connection.query(`
      SELECT t.*,
             u.full_name as requester_name,
             cc.company_name
      FROM tickets t
      LEFT JOIN users u ON t.requester_id = u.id
      LEFT JOIN customers c ON t.requester_id = c.user_id
      LEFT JOIN customer_companies cc ON c.customer_company_id = cc.id
      WHERE t.id = ?
    `, [ticketId]);

    if (tickets.length === 0) {
      return { success: false, message: 'Ticket not found' };
    }

    const ticket = tickets[0];

    // Only score tickets in the pool
    if (!['OPEN_POOL', 'CLAIMED_LOCKED', 'ESCALATED'].includes(ticket.pool_status)) {
      return { success: false, message: 'Ticket not in pool' };
    }

    // Calculate score
    const scoreResult = useAI
      ? await calculatePoolScoreAI(connection, ticket)
      : calculatePoolScoreHeuristic(ticket);

    // Update ticket
    await connection.query(`
      UPDATE tickets
      SET pool_score = ?,
          pool_score_updated_at = NOW()
      WHERE id = ?
    `, [scoreResult.pool_score, ticketId]);

    console.log(`[POOL_RANKING] ${tenantCode} ticket=${ticketId} score=${scoreResult.pool_score}`);

    return {
      success: true,
      ticketId,
      ...scoreResult
    };
  } catch (error) {
    console.error(`[POOL_RANKING] Error updating ticket ${ticketId}:`, error.message);
    return { success: false, message: error.message };
  } finally {
    if (connection) connection.release();
  }
}

/**
 * Recalculate pool scores for all pool tickets in a tenant
 * @param {string} tenantCode - Tenant code
 * @param {boolean} useAI - Whether to use AI scoring
 */
async function recalculatePoolScores(tenantCode, useAI = true) {
  let connection;
  try {
    connection = await getTenantConnection(tenantCode);

    // Get all tickets in pool that need scoring
    // Prioritize tickets with no score or stale scores
    const [poolTickets] = await connection.query(`
      SELECT t.id
      FROM tickets t
      WHERE t.pool_status IN ('OPEN_POOL', 'CLAIMED_LOCKED', 'ESCALATED')
        AND t.status NOT IN ('Resolved', 'Closed')
        AND (
          t.pool_score IS NULL
          OR t.pool_score_updated_at IS NULL
          OR t.pool_score_updated_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)
        )
      ORDER BY
        CASE WHEN t.pool_score IS NULL THEN 0 ELSE 1 END,
        t.created_at ASC
      LIMIT ?
    `, [MAX_BATCH_SIZE]);

    if (poolTickets.length === 0) {
      return { success: true, updated: 0 };
    }

    let updated = 0;
    for (const ticket of poolTickets) {
      const result = await updateTicketPoolScore(tenantCode, ticket.id, useAI);
      if (result.success) {
        updated++;
      }
      // Small delay between tickets to prevent overwhelming AI API
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    console.log(`[POOL_RANKING] ${tenantCode}: updated ${updated}/${poolTickets.length} pool scores`);

    return {
      success: true,
      updated,
      total: poolTickets.length
    };
  } catch (error) {
    console.error(`[POOL_RANKING] Error recalculating scores for ${tenantCode}:`, error.message);
    return { success: false, message: error.message };
  } finally {
    if (connection) connection.release();
  }
}

/**
 * Calculate and update score when a new ticket enters the pool
 * Called from ticket creation or status change
 */
async function onTicketEnterPool(tenantCode, ticketId) {
  // Small delay to ensure ticket data is committed
  await new Promise(resolve => setTimeout(resolve, 100));
  return updateTicketPoolScore(tenantCode, ticketId, true);
}

/**
 * Helper to enrich a single ticket with SLA status
 * Used by the pool endpoint
 */
async function enrichTicketWithSLAStatus(ticket, connection) {
  if (!ticket.sla_definition_id) {
    ticket.sla_status = { phase: 'no_sla' };
    return;
  }

  try {
    const [slaDefs] = await connection.query(
      `SELECT s.*, b.timezone, b.days_of_week, b.start_time, b.end_time, b.is_24x7
       FROM sla_definitions s
       LEFT JOIN business_hours_profiles b ON s.business_hours_profile_id = b.id
       WHERE s.id = ?`,
      [ticket.sla_definition_id]
    );
    if (slaDefs.length > 0) {
      ticket.sla_status = buildSLAFacts(ticket, slaDefs[0]);
    } else {
      ticket.sla_status = { phase: 'no_sla' };
    }
  } catch (error) {
    ticket.sla_status = { phase: 'error' };
  }
}

/**
 * Enrich multiple tickets with SLA status
 */
async function enrichTicketsWithSLAStatus(tickets, connection) {
  for (const ticket of tickets) {
    await enrichTicketWithSLAStatus(ticket, connection);
  }
}

module.exports = {
  calculatePoolScoreAI,
  calculatePoolScoreHeuristic,
  updateTicketPoolScore,
  recalculatePoolScores,
  onTicketEnterPool,
  enrichTicketWithSLAStatus,
  enrichTicketsWithSLAStatus,
  POOL_SCORE_UPDATE_INTERVAL_MS
};
