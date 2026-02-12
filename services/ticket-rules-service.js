const { getTenantConnection } = require('../config/database');
const { logTicketActivity } = require('./activityLogger');

// Default batch processing values (can be overridden by tenant settings)
const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_BATCH_DELAY_SECONDS = 2;
const MIN_BATCH_DELAY_SECONDS = 3;
const MAX_BATCH_SIZE = 10;

// Retry and circuit breaker settings
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const CIRCUIT_BREAKER_THRESHOLD = 5; // Abort after N consecutive transient failures
const TRANSIENT_ERROR_CODES = ['ECONNRESET', 'PROTOCOL_CONNECTION_LOST', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED'];

/**
 * Check if an error is transient (retryable)
 */
function isTransientError(error) {
  if (!error) return false;
  const code = error.code || error.errno;
  return TRANSIENT_ERROR_CODES.includes(code);
}

/**
 * Fetch batch processing settings from tenant_settings table
 */
async function getBatchSettings(connection) {
  try {
    const [settings] = await connection.query(`
      SELECT setting_key, setting_value
      FROM tenant_settings
      WHERE setting_key IN ('batch_delay_seconds', 'batch_size')
    `);

    let batchSize = DEFAULT_BATCH_SIZE;
    let batchDelayMs = DEFAULT_BATCH_DELAY_SECONDS * 1000;

    for (const setting of settings) {
      if (setting.setting_key === 'batch_size') {
        const value = parseInt(setting.setting_value, 10);
        if (!isNaN(value) && value >= 1 && value <= MAX_BATCH_SIZE) {
          batchSize = value;
        }
      } else if (setting.setting_key === 'batch_delay_seconds') {
        const value = parseInt(setting.setting_value, 10);
        if (!isNaN(value) && value >= MIN_BATCH_DELAY_SECONDS) {
          batchDelayMs = value * 1000;
        } else if (!isNaN(value) && value > 0) {
          // If below minimum, use minimum
          batchDelayMs = MIN_BATCH_DELAY_SECONDS * 1000;
        }
      }
    }

    return { batchSize, batchDelayMs };
  } catch (error) {
    // If settings table doesn't exist or error, use defaults
    console.log('[TicketRules] Using default batch settings (table error):', error.message);
    return {
      batchSize: DEFAULT_BATCH_SIZE,
      batchDelayMs: DEFAULT_BATCH_DELAY_SECONDS * 1000
    };
  }
}

class TicketRulesService {
  constructor(tenantCode) {
    this.tenantCode = tenantCode;
  }

  // Get all rules for tenant
  async getAllRules() {
    const connection = await getTenantConnection(this.tenantCode);
    try {
      const [rules] = await connection.query(
        `SELECT r.*, u.username as created_by_username
         FROM ticket_processing_rules r
         LEFT JOIN users u ON r.created_by = u.id
         WHERE r.tenant_code = ?
         ORDER BY r.enabled DESC, r.created_at DESC`,
        [this.tenantCode]
      );

      return rules.map(rule => ({
        ...rule,
        action_params: typeof rule.action_params === 'string'
          ? JSON.parse(rule.action_params)
          : rule.action_params
      }));
    } finally {
      connection.release();
    }
  }

  // Get single rule by ID
  async getRuleById(ruleId) {
    const connection = await getTenantConnection(this.tenantCode);
    try {
      const [rules] = await connection.query(
        `SELECT * FROM ticket_processing_rules
         WHERE id = ? AND tenant_code = ?`,
        [ruleId, this.tenantCode]
      );

      if (rules.length === 0) {
        throw new Error('Rule not found');
      }

      const rule = rules[0];
      return {
        ...rule,
        action_params: typeof rule.action_params === 'string'
          ? JSON.parse(rule.action_params)
          : rule.action_params
      };
    } finally {
      connection.release();
    }
  }

  // Create new rule
  async createRule(ruleData, userId) {
    const connection = await getTenantConnection(this.tenantCode);
    try {
      const {
        rule_name,
        description,
        enabled = true,
        search_in = 'both',
        search_text,
        case_sensitive = false,
        action_type,
        action_params = {}
      } = ruleData;

      const [result] = await connection.query(
        `INSERT INTO ticket_processing_rules
         (tenant_code, rule_name, description, enabled, search_in, search_text,
          case_sensitive, action_type, action_params, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          this.tenantCode,
          rule_name,
          description || null,
          enabled,
          search_in,
          search_text,
          case_sensitive,
          action_type,
          JSON.stringify(action_params),
          userId
        ]
      );

      return await this.getRuleById(result.insertId);
    } finally {
      connection.release();
    }
  }

  // Update existing rule
  async updateRule(ruleId, ruleData) {
    const connection = await getTenantConnection(this.tenantCode);
    try {
      // Verify rule exists and belongs to tenant
      await this.getRuleById(ruleId);

      const updates = [];
      const values = [];

      const updatableFields = [
        'rule_name', 'description', 'enabled', 'search_in',
        'search_text', 'case_sensitive', 'action_type', 'action_params'
      ];

      updatableFields.forEach(field => {
        if (ruleData.hasOwnProperty(field)) {
          updates.push(`${field} = ?`);
          if (field === 'action_params') {
            values.push(JSON.stringify(ruleData[field]));
          } else {
            values.push(ruleData[field]);
          }
        }
      });

      if (updates.length === 0) {
        return await this.getRuleById(ruleId);
      }

      values.push(ruleId, this.tenantCode);

      await connection.query(
        `UPDATE ticket_processing_rules
         SET ${updates.join(', ')}
         WHERE id = ? AND tenant_code = ?`,
        values
      );

      return await this.getRuleById(ruleId);
    } finally {
      connection.release();
    }
  }

  // Delete rule
  async deleteRule(ruleId) {
    const connection = await getTenantConnection(this.tenantCode);
    try {
      // Verify rule exists and belongs to tenant
      await this.getRuleById(ruleId);

      await connection.query(
        `DELETE FROM ticket_processing_rules
         WHERE id = ? AND tenant_code = ?`,
        [ruleId, this.tenantCode]
      );

      return { success: true };
    } finally {
      connection.release();
    }
  }

  // Test rule against tickets (without executing)
  async testRule(ruleId) {
    const connection = await getTenantConnection(this.tenantCode);
    try {
      const rule = await this.getRuleById(ruleId);

      // Find matching tickets
      const matchingTickets = await this.findMatchingTickets(rule);

      return {
        rule: rule,
        matching_tickets: matchingTickets,
        would_affect: matchingTickets.length
      };
    } finally {
      connection.release();
    }
  }

  // Find tickets that match a rule's search criteria
  async findMatchingTickets(rule) {
    const connection = await getTenantConnection(this.tenantCode);
    try {
      let searchCondition;
      const searchPattern = rule.case_sensitive
        ? rule.search_text
        : rule.search_text.toLowerCase();

      switch (rule.search_in) {
        case 'title':
          searchCondition = rule.case_sensitive
            ? 'title LIKE ?'
            : 'LOWER(title) LIKE ?';
          break;
        case 'body':
          searchCondition = rule.case_sensitive
            ? 'description LIKE ?'
            : 'LOWER(description) LIKE ?';
          break;
        case 'both':
        default:
          searchCondition = rule.case_sensitive
            ? '(title LIKE ? OR description LIKE ?)'
            : '(LOWER(title) LIKE ? OR LOWER(description) LIKE ?)';
          break;
      }

      const searchValue = `%${searchPattern}%`;
      const queryParams = rule.search_in === 'both'
        ? [searchValue, searchValue]
        : [searchValue];

      const [tickets] = await connection.query(
        `SELECT id, title, description, status, priority, created_at
         FROM tickets
         WHERE ${searchCondition}
         ORDER BY created_at DESC
         LIMIT 100`,
        queryParams
      );

      return tickets;
    } finally {
      connection.release();
    }
  }

  // Execute a rule on a specific ticket
  async executeRuleOnTicket(ruleId, ticketId) {
    const connection = await getTenantConnection(this.tenantCode);

    try {
      const rule = await this.getRuleById(ruleId);

      if (!rule.enabled) {
        return {
          success: false,
          message: 'Rule is disabled',
          result: 'skipped'
        };
      }

      // Execute the action based on action_type
      let actionResult;

      switch (rule.action_type) {
        case 'delete':
          actionResult = await this.deleteTicket(ticketId);
          break;

        case 'assign_to_expert':
          actionResult = await this.assignTicket(ticketId, rule.action_params);
          break;

        case 'create_for_customer':
          actionResult = await this.createTicketForCustomer(ticketId, rule.action_params);
          break;

        case 'set_priority':
          actionResult = await this.setPriority(ticketId, rule.action_params);
          break;

        case 'set_status':
          actionResult = await this.setStatus(ticketId, rule.action_params);
          break;

        case 'add_tag':
          actionResult = await this.addTag(ticketId, rule.action_params);
          break;

        case 'add_to_monitoring':
          actionResult = await this.addToMonitoringSources(ticketId, rule.action_params);
          break;

        case 'set_sla_deadlines':
          actionResult = await this.setSlaDeadlines(ticketId, rule.action_params);
          break;

        case 'set_sla_definition':
          actionResult = await this.setSlaDefinition(ticketId, rule.action_params);
          break;

        default:
          throw new Error(`Unknown action type: ${rule.action_type}`);
      }

      // Log activity (skip for delete since ticket is gone)
      if (rule.action_type !== 'delete') {
        const activityMap = {
          assign_to_expert:    { type: 'assigned',  key: 'ticket.assigned',       desc: actionResult.message },
          create_for_customer: { type: 'updated',   key: 'ticket.forwarded',      desc: actionResult.message },
          set_priority:        { type: 'updated',   key: 'ticket.priority.changed', desc: actionResult.message },
          set_status:          { type: 'updated',   key: 'ticket.status.changed', desc: actionResult.message },
          add_tag:             { type: 'updated',   key: 'ticket.tag.added',      desc: actionResult.message },
          add_to_monitoring:   { type: 'updated',   key: 'ticket.monitoring.set', desc: actionResult.message },
          set_sla_deadlines:   { type: 'updated',   key: 'ticket.sla.deadlines',  desc: actionResult.message },
          set_sla_definition:  { type: 'updated',   key: 'ticket.sla.applied',    desc: actionResult.message }
        };
        const info = activityMap[rule.action_type] || { type: 'updated', key: 'ticket.rule.action', desc: actionResult.message };
        try {
          await logTicketActivity(connection, {
            ticketId,
            userId: null,
            activityType: info.type,
            description: `${info.desc} (Rule: ${rule.name})`,
            isPublic: false,
            source: 'system',
            actorType: 'system',
            eventKey: info.key,
            meta: { ruleId: rule.id, ruleName: rule.name, actionType: rule.action_type, params: rule.action_params }
          });
        } catch (actErr) {
          console.error(`[TicketRules] Activity log failed for ticket #${ticketId}:`, actErr.message);
        }
      }

      // Log the execution
      await connection.query(
        `INSERT INTO ticket_rule_executions
         (rule_id, ticket_id, action_taken, execution_result, executed_at)
         VALUES (?, ?, ?, 'success', NOW())`,
        [ruleId, ticketId, rule.action_type]
      );

      // Update rule statistics
      await connection.query(
        `UPDATE ticket_processing_rules
         SET times_triggered = times_triggered + 1,
             last_triggered_at = NOW()
         WHERE id = ?`,
        [ruleId]
      );

      return {
        success: true,
        result: 'success',
        action: rule.action_type,
        details: actionResult
      };

    } catch (error) {
      // Log the failure (use fresh connection query to avoid issues if connection errored)
      try {
        await connection.query(
          `INSERT INTO ticket_rule_executions
           (rule_id, ticket_id, action_taken, execution_result, error_message, executed_at)
           VALUES (?, ?, ?, 'failure', ?, NOW())`,
          [ruleId, ticketId, 'unknown', error.message]
        );
      } catch (logError) {
        console.error(`[TicketRules] Failed to log execution error for ticket #${ticketId}:`, logError.message);
      }

      return {
        success: false,
        result: 'failure',
        error: error.message
      };
    } finally {
      connection.release();
    }
  }

  // Execute all enabled rules on a ticket
  async executeAllRulesOnTicket(ticketId) {
    const rules = await this.getAllRules();
    const enabledRules = rules.filter(r => r.enabled);

    const results = [];
    const ticketIdNum = parseInt(ticketId, 10); // Ensure numeric comparison

    for (const rule of enabledRules) {
      // Check if ticket matches rule
      const matchingTickets = await this.findMatchingTickets(rule);
      const matchingIds = matchingTickets.map(t => t.id);
      const matches = matchingIds.includes(ticketIdNum);

      console.log(`[TicketRules] Rule "${rule.rule_name}" (search: "${rule.search_text}" in ${rule.search_in}): found ${matchingTickets.length} matching tickets, ticketId=${ticketIdNum} matches=${matches}`);

      if (matches) {
        const result = await this.executeRuleOnTicket(rule.id, ticketId);
        results.push({
          rule_id: rule.id,
          rule_name: rule.rule_name,
          ...result
        });
      }
    }

    return results;
  }

  // Action implementations
  async deleteTicket(ticketId) {
    const connection = await getTenantConnection(this.tenantCode);
    try {
      await connection.query(
        `DELETE FROM tickets WHERE id = ?`,
        [ticketId]
      );

      return { message: `Ticket #${ticketId} deleted` };
    } finally {
      connection.release();
    }
  }

  async assignTicket(ticketId, params) {
    const connection = await getTenantConnection(this.tenantCode);
    try {
      await connection.query(
        `UPDATE tickets
         SET assignee_id = ?,
             status = CASE WHEN status = 'Open' THEN 'In Progress' ELSE status END,
             updated_at = NOW()
         WHERE id = ?`,
        [params.expert_id, ticketId]
      );

      return {
        message: `Ticket #${ticketId} assigned to ${params.expert_name || 'expert'}`,
        expert_id: params.expert_id
      };
    } finally {
      connection.release();
    }
  }

  async createTicketForCustomer(sourceTicketId, params) {
    const connection = await getTenantConnection(this.tenantCode);
    try {
      // Get source ticket details
      const [sourceTickets] = await connection.query(
        `SELECT * FROM tickets WHERE id = ?`,
        [sourceTicketId]
      );

      if (sourceTickets.length === 0) {
        throw new Error('Source ticket not found');
      }

      const sourceTicket = sourceTickets[0];

      // Create new ticket for target customer
      const [result] = await connection.query(
        `INSERT INTO tickets
         (title, description, priority, status, requester_id, created_at)
         VALUES (?, ?, ?, 'Open', ?, NOW())`,
        [
          `[Forwarded] ${sourceTicket.title}`,
          `Forwarded from ticket #${sourceTicketId}:\n\n${sourceTicket.description}`,
          sourceTicket.priority,
          params.customer_id
        ]
      );

      return {
        message: `New ticket #${result.insertId} created for customer`,
        new_ticket_id: result.insertId,
        customer_id: params.customer_id
      };
    } finally {
      connection.release();
    }
  }

  async setPriority(ticketId, params) {
    const connection = await getTenantConnection(this.tenantCode);
    try {
      await connection.query(
        `UPDATE tickets
         SET priority = ?, updated_at = NOW()
         WHERE id = ?`,
        [params.priority, ticketId]
      );

      return {
        message: `Ticket #${ticketId} priority set to ${params.priority}`,
        priority: params.priority
      };
    } finally {
      connection.release();
    }
  }

  async setStatus(ticketId, params) {
    const connection = await getTenantConnection(this.tenantCode);
    try {
      await connection.query(
        `UPDATE tickets
         SET status = ?, updated_at = NOW()
         WHERE id = ?`,
        [params.status, ticketId]
      );

      return {
        message: `Ticket #${ticketId} status set to ${params.status}`,
        status: params.status
      };
    } finally {
      connection.release();
    }
  }

  async addTag(ticketId, params) {
    const connection = await getTenantConnection(this.tenantCode);
    try {
      // Get current tags
      const [tickets] = await connection.query(
        `SELECT tags FROM tickets WHERE id = ?`,
        [ticketId]
      );

      if (tickets.length === 0) {
        throw new Error('Ticket not found');
      }

      const currentTags = tickets[0].tags ? tickets[0].tags.split(',') : [];
      const newTag = params.tag;

      if (!currentTags.includes(newTag)) {
        currentTags.push(newTag);
      }

      await connection.query(
        `UPDATE tickets
         SET tags = ?, updated_at = NOW()
         WHERE id = ?`,
        [currentTags.join(','), ticketId]
      );

      return {
        message: `Tag "${newTag}" added to ticket #${ticketId}`,
        tag: newTag
      };
    } finally {
      connection.release();
    }
  }

  // Add ticket to system monitoring sources (with optional normalised flag)
  async addToMonitoringSources(ticketId, params = {}) {
    const connection = await getTenantConnection(this.tenantCode);
    try {
      // Get current ticket to check existing metadata
      const [tickets] = await connection.query(
        `SELECT source_metadata FROM tickets WHERE id = ?`,
        [ticketId]
      );

      if (tickets.length === 0) {
        throw new Error('Ticket not found');
      }

      // Parse existing metadata if present
      let existingMetadata = {};
      if (tickets[0].source_metadata) {
        try {
          existingMetadata = typeof tickets[0].source_metadata === 'string'
            ? JSON.parse(tickets[0].source_metadata)
            : tickets[0].source_metadata;
        } catch (e) {
          existingMetadata = {};
        }
      }

      // Build the monitoring source metadata, merging with existing
      const sourceMetadata = {
        ...existingMetadata,
        monitoring: true,
        type: params.type || existingMetadata.type || 'monitoring',
        reason: 'ticket_rule_action',
        classified_as: params.classified_as || existingMetadata.classified_as || 'alert',
        added_via: 'ticket_processing_rule',
        added_at: new Date().toISOString()
      };

      // Add normalised flag if specified in params
      if (params.normalised !== undefined) {
        sourceMetadata.normalised = Boolean(params.normalised);
      }

      await connection.query(
        `UPDATE tickets
         SET source_metadata = ?, updated_at = NOW()
         WHERE id = ?`,
        [JSON.stringify(sourceMetadata), ticketId]
      );

      return {
        message: `Ticket #${ticketId} added to system monitoring sources`,
        source_metadata: sourceMetadata
      };
    } finally {
      connection.release();
    }
  }

  // Set SLA deadlines directly (Option B - no recalculation)
  async setSlaDeadlines(ticketId, params) {
    const connection = await getTenantConnection(this.tenantCode);
    try {
      // Validate params - at least one deadline must be provided
      if (!params.response_due_at && !params.resolve_due_at) {
        throw new Error('At least one of response_due_at or resolve_due_at must be provided');
      }

      // Helper to convert ISO 8601 to MySQL datetime format
      const toMySQLDateTime = (isoString) => {
        if (!isoString) return null;
        const date = new Date(isoString);
        return date.toISOString().slice(0, 19).replace('T', ' ');
      };

      const updates = [];
      const values = [];

      if (params.response_due_at) {
        updates.push('response_due_at = ?');
        values.push(toMySQLDateTime(params.response_due_at));
      }

      if (params.resolve_due_at) {
        updates.push('resolve_due_at = ?');
        values.push(toMySQLDateTime(params.resolve_due_at));
      }

      updates.push('updated_at = NOW()');
      values.push(ticketId);

      await connection.query(
        `UPDATE tickets SET ${updates.join(', ')} WHERE id = ?`,
        values
      );

      return {
        message: `Ticket #${ticketId} SLA deadlines updated`,
        response_due_at: params.response_due_at || null,
        resolve_due_at: params.resolve_due_at || null
      };
    } finally {
      connection.release();
    }
  }

  // Set SLA definition metadata (Option A - intent only, no recalculation)
  async setSlaDefinition(ticketId, params) {
    const connection = await getTenantConnection(this.tenantCode);
    try {
      // Validate params - sla_definition_id is required
      if (!params.sla_definition_id) {
        throw new Error('sla_definition_id is required');
      }

      // sla_source is optional, defaults to 'rule'
      const slaSource = params.sla_source || 'rule';

      await connection.query(
        `UPDATE tickets
         SET sla_definition_id = ?,
             sla_applied_at = NOW(),
             sla_source = ?,
             updated_at = NOW()
         WHERE id = ?`,
        [params.sla_definition_id, slaSource, ticketId]
      );

      return {
        message: `Ticket #${ticketId} SLA definition set`,
        sla_definition_id: params.sla_definition_id,
        sla_source: slaSource,
        sla_applied_at: new Date().toISOString()
      };
    } finally {
      connection.release();
    }
  }

  // Get execution history for a rule
  async getRuleExecutionHistory(ruleId, limit = 50) {
    const connection = await getTenantConnection(this.tenantCode);
    try {
      const [executions] = await connection.query(
        `SELECT e.*, t.title as ticket_title
         FROM ticket_rule_executions e
         LEFT JOIN tickets t ON e.ticket_id = t.id
         WHERE e.rule_id = ?
         ORDER BY e.executed_at DESC
         LIMIT ?`,
        [ruleId, limit]
      );

      return executions;
    } finally {
      connection.release();
    }
  }

  // Get statistics for all rules
  async getRuleStatistics() {
    const connection = await getTenantConnection(this.tenantCode);
    try {
      const [stats] = await connection.query(
        `SELECT
           COUNT(*) as total_rules,
           SUM(CASE WHEN enabled = TRUE THEN 1 ELSE 0 END) as enabled_rules,
           SUM(times_triggered) as total_executions,
           MAX(last_triggered_at) as last_execution
         FROM ticket_processing_rules
         WHERE tenant_code = ?`,
        [this.tenantCode]
      );

      const [recentExecutions] = await connection.query(
        `SELECT COUNT(*) as count
         FROM ticket_rule_executions e
         JOIN ticket_processing_rules r ON e.rule_id = r.id
         WHERE r.tenant_code = ? AND e.executed_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
        [this.tenantCode]
      );

      return {
        ...stats[0],
        executions_last_24h: recentExecutions[0].count
      };
    } finally {
      connection.release();
    }
  }

  // Run rule on all matching tickets in background
  // Returns immediately, executes asynchronously, creates notification when done
  // Processes in batches to avoid blocking the server
  async runRuleInBackground(ruleId, userId) {
    const rule = await this.getRuleById(ruleId);
    const matchingTickets = await this.findMatchingTickets(rule);
    const ticketCount = matchingTickets.length;

    if (ticketCount === 0) {
      return {
        success: true,
        message: 'No matching tickets found',
        ticket_count: 0,
        started: false
      };
    }

    // Start background execution
    const tenantCode = this.tenantCode;
    const startTime = Date.now();

    // Get batch processing settings from tenant_settings (before background job starts)
    const settingsConnection = await getTenantConnection(tenantCode);
    let batchSize, batchDelayMs;
    try {
      const settings = await getBatchSettings(settingsConnection);
      batchSize = settings.batchSize;
      batchDelayMs = settings.batchDelayMs;
    } finally {
      settingsConnection.release();
    }

    console.log(`[TicketRules] Starting background job: rule ${ruleId} on ${ticketCount} tickets for tenant ${tenantCode} (batch size: ${batchSize}, delay: ${batchDelayMs}ms)`);

    // Helper to delay execution
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // Use setImmediate to run in background after response is sent
    setImmediate(async () => {
      let successCount = 0;
      let errorCount = 0;
      let consecutiveTransientFailures = 0;
      let circuitBroken = false;
      const errors = [];

      try {
        const service = new TicketRulesService(tenantCode);

        // Process in batches
        batchLoop: for (let i = 0; i < matchingTickets.length; i += batchSize) {
          const batch = matchingTickets.slice(i, i + batchSize);
          const batchNum = Math.floor(i / batchSize) + 1;
          const totalBatches = Math.ceil(matchingTickets.length / batchSize);

          console.log(`[TicketRules] Processing batch ${batchNum}/${totalBatches} (${batch.length} tickets)`);

          // Process tickets in this batch
          for (const ticket of batch) {
            // Circuit breaker check
            if (consecutiveTransientFailures >= CIRCUIT_BREAKER_THRESHOLD) {
              console.error(`[TicketRules] Circuit breaker triggered: ${consecutiveTransientFailures} consecutive transient failures, aborting job`);
              circuitBroken = true;
              errors.push(`Circuit breaker triggered after ${consecutiveTransientFailures} consecutive connection failures`);
              break batchLoop;
            }

            let lastError = null;
            let succeeded = false;

            // Retry loop for transient errors
            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
              try {
                const result = await service.executeRuleOnTicket(ruleId, ticket.id);
                if (result.success && result.result === 'success') {
                  successCount++;
                  consecutiveTransientFailures = 0; // Reset on success
                  succeeded = true;
                  break;
                } else {
                  // Non-transient failure (rule logic error)
                  errorCount++;
                  consecutiveTransientFailures = 0; // Reset on non-transient error
                  errors.push(`#${ticket.id}: ${result.error || 'Unknown error'}`);
                  succeeded = true; // Mark as handled (not retryable)
                  break;
                }
              } catch (err) {
                lastError = err;
                if (isTransientError(err) && attempt < MAX_RETRIES) {
                  console.warn(`[TicketRules] Transient error on ticket #${ticket.id} (attempt ${attempt}/${MAX_RETRIES}): ${err.code || err.message}`);
                  await delay(RETRY_DELAY_MS * attempt); // Exponential backoff
                  continue;
                }
                // Final attempt failed or non-transient error
                break;
              }
            }

            // If we exhausted retries or hit a non-transient error
            if (!succeeded && lastError) {
              errorCount++;
              errors.push(`#${ticket.id}: ${lastError.message}`);
              if (isTransientError(lastError)) {
                consecutiveTransientFailures++;
              } else {
                consecutiveTransientFailures = 0;
              }
            }
          }

          // Delay between batches to allow other requests to be processed
          if (i + batchSize < matchingTickets.length && !circuitBroken) {
            await delay(batchDelayMs);
          }
        }

        const duration = Math.round((Date.now() - startTime) / 1000);
        const status = circuitBroken ? 'aborted (circuit breaker)' : 'completed';
        console.log(`[TicketRules] Background job ${status}: ${successCount} success, ${errorCount} errors in ${duration}s`);

        // Create notification for user
        const notifConnection = await getTenantConnection(tenantCode);
        try {
          const severity = circuitBroken ? 'critical' : (errorCount === 0 ? 'info' : 'warning');
          const message = circuitBroken
            ? `Rule "${rule.rule_name}" aborted: connection failures (${successCount} processed before abort)`
            : errorCount === 0
              ? `Rule "${rule.rule_name}" completed: ${successCount} tickets processed successfully`
              : `Rule "${rule.rule_name}" completed: ${successCount} successful, ${errorCount} failed`;

          await notifConnection.query(
            `INSERT INTO notifications (ticket_id, type, severity, message, payload_json, created_at)
             VALUES (NULL, 'RULE_EXECUTION_COMPLETE', ?, ?, ?, NOW())`,
            [
              severity,
              message,
              JSON.stringify({
                rule_id: ruleId,
                rule_name: rule.rule_name,
                success_count: successCount,
                error_count: errorCount,
                circuit_broken: circuitBroken,
                errors: errors.slice(0, 10),
                duration_seconds: duration,
                user_id: userId
              })
            ]
          );
        } finally {
          notifConnection.release();
        }

      } catch (err) {
        console.error(`[TicketRules] Background job failed:`, err);

        // Create error notification
        let errConnection;
        try {
          errConnection = await getTenantConnection(tenantCode);
          await errConnection.query(
            `INSERT INTO notifications (ticket_id, type, severity, message, payload_json, created_at)
             VALUES (NULL, 'RULE_EXECUTION_COMPLETE', 'critical', ?, ?, NOW())`,
            [
              `Rule "${rule.rule_name}" execution failed: ${err.message}`,
              JSON.stringify({ rule_id: ruleId, error: err.message, user_id: userId })
            ]
          );
        } catch (notifErr) {
          console.error(`[TicketRules] Failed to create error notification:`, notifErr);
        } finally {
          if (errConnection) errConnection.release();
        }
      }
    });

    return {
      success: true,
      message: `Started processing ${ticketCount} ticket(s) in background`,
      ticket_count: ticketCount,
      started: true,
      rule_name: rule.rule_name
    };
  }
}

module.exports = { TicketRulesService };
