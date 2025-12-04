const { getTenantConnection } = require('../config/database');

class TicketRulesService {
  constructor(tenantCode) {
    this.tenantCode = tenantCode;
  }

  // Get all rules for tenant
  async getAllRules() {
    const connection = await getTenantConnection(this.tenantCode);

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
  }

  // Get single rule by ID
  async getRuleById(ruleId) {
    const connection = await getTenantConnection(this.tenantCode);

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
  }

  // Create new rule
  async createRule(ruleData, userId) {
    const connection = await getTenantConnection(this.tenantCode);

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
  }

  // Update existing rule
  async updateRule(ruleId, ruleData) {
    const connection = await getTenantConnection(this.tenantCode);

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
  }

  // Delete rule
  async deleteRule(ruleId) {
    const connection = await getTenantConnection(this.tenantCode);

    // Verify rule exists and belongs to tenant
    await this.getRuleById(ruleId);

    await connection.query(
      `DELETE FROM ticket_processing_rules
       WHERE id = ? AND tenant_code = ?`,
      [ruleId, this.tenantCode]
    );

    return { success: true };
  }

  // Test rule against tickets (without executing)
  async testRule(ruleId) {
    const connection = await getTenantConnection(this.tenantCode);

    const rule = await this.getRuleById(ruleId);

    // Find matching tickets
    const matchingTickets = await this.findMatchingTickets(rule);

    return {
      rule: rule,
      matching_tickets: matchingTickets,
      would_affect: matchingTickets.length
    };
  }

  // Find tickets that match a rule's search criteria
  async findMatchingTickets(rule) {
    const connection = await getTenantConnection(this.tenantCode);

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
      ? [searchValue, searchValue, this.tenantCode]
      : [searchValue, this.tenantCode];

    const [tickets] = await connection.query(
      `SELECT id, title, description, status, priority, created_at
       FROM tickets
       WHERE ${searchCondition} AND tenant_code = ?
       ORDER BY created_at DESC
       LIMIT 100`,
      queryParams
    );

    return tickets;
  }

  // Execute a rule on a specific ticket
  async executeRuleOnTicket(ruleId, ticketId) {
    const connection = await getTenantConnection(this.tenantCode);

    const rule = await this.getRuleById(ruleId);

    if (!rule.enabled) {
      return {
        success: false,
        message: 'Rule is disabled',
        result: 'skipped'
      };
    }

    try {
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

        default:
          throw new Error(`Unknown action type: ${rule.action_type}`);
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
      // Log the failure
      await connection.query(
        `INSERT INTO ticket_rule_executions
         (rule_id, ticket_id, action_taken, execution_result, error_message, executed_at)
         VALUES (?, ?, ?, 'failure', ?, NOW())`,
        [ruleId, ticketId, rule.action_type, error.message]
      );

      return {
        success: false,
        result: 'failure',
        error: error.message
      };
    }
  }

  // Execute all enabled rules on a ticket
  async executeAllRulesOnTicket(ticketId) {
    const rules = await this.getAllRules();
    const enabledRules = rules.filter(r => r.enabled);

    const results = [];

    for (const rule of enabledRules) {
      // Check if ticket matches rule
      const matchingTickets = await this.findMatchingTickets(rule);
      const matches = matchingTickets.some(t => t.id === ticketId);

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

    await connection.query(
      `DELETE FROM tickets WHERE id = ? AND tenant_code = ?`,
      [ticketId, this.tenantCode]
    );

    return { message: `Ticket #${ticketId} deleted` };
  }

  async assignTicket(ticketId, params) {
    const connection = await getTenantConnection(this.tenantCode);

    await connection.query(
      `UPDATE tickets
       SET assignee_id = ?,
           status = CASE WHEN status = 'Open' THEN 'In Progress' ELSE status END,
           updated_at = NOW()
       WHERE id = ? AND tenant_code = ?`,
      [params.expert_id, ticketId, this.tenantCode]
    );

    return {
      message: `Ticket #${ticketId} assigned to ${params.expert_name || 'expert'}`,
      expert_id: params.expert_id
    };
  }

  async createTicketForCustomer(sourceTicketId, params) {
    const connection = await getTenantConnection(this.tenantCode);

    // Get source ticket details
    const [sourceTickets] = await connection.query(
      `SELECT * FROM tickets WHERE id = ? AND tenant_code = ?`,
      [sourceTicketId, this.tenantCode]
    );

    if (sourceTickets.length === 0) {
      throw new Error('Source ticket not found');
    }

    const sourceTicket = sourceTickets[0];

    // Create new ticket for target customer
    const [result] = await connection.query(
      `INSERT INTO tickets
       (tenant_code, title, description, priority, status, requester_id, created_at)
       VALUES (?, ?, ?, ?, 'Open', ?, NOW())`,
      [
        this.tenantCode,
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
  }

  async setPriority(ticketId, params) {
    const connection = await getTenantConnection(this.tenantCode);

    await connection.query(
      `UPDATE tickets
       SET priority = ?, updated_at = NOW()
       WHERE id = ? AND tenant_code = ?`,
      [params.priority, ticketId, this.tenantCode]
    );

    return {
      message: `Ticket #${ticketId} priority set to ${params.priority}`,
      priority: params.priority
    };
  }

  async setStatus(ticketId, params) {
    const connection = await getTenantConnection(this.tenantCode);

    await connection.query(
      `UPDATE tickets
       SET status = ?, updated_at = NOW()
       WHERE id = ? AND tenant_code = ?`,
      [params.status, ticketId, this.tenantCode]
    );

    return {
      message: `Ticket #${ticketId} status set to ${params.status}`,
      status: params.status
    };
  }

  async addTag(ticketId, params) {
    const connection = await getTenantConnection(this.tenantCode);

    // Get current tags
    const [tickets] = await connection.query(
      `SELECT tags FROM tickets WHERE id = ? AND tenant_code = ?`,
      [ticketId, this.tenantCode]
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
       WHERE id = ? AND tenant_code = ?`,
      [currentTags.join(','), ticketId, this.tenantCode]
    );

    return {
      message: `Tag "${newTag}" added to ticket #${ticketId}`,
      tag: newTag
    };
  }

  // Get execution history for a rule
  async getRuleExecutionHistory(ruleId, limit = 50) {
    const connection = await getTenantConnection(this.tenantCode);

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
  }

  // Get statistics for all rules
  async getRuleStatistics() {
    const connection = await getTenantConnection(this.tenantCode);

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
  }
}

module.exports = { TicketRulesService };
