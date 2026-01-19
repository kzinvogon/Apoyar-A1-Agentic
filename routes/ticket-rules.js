const express = require('express');
const router = express.Router();
const { TicketRulesService } = require('../services/ticket-rules-service');
const { verifyToken, requireRole } = require('../middleware/auth');

// Apply authentication to all routes
router.use(verifyToken);

// Get all rules for tenant
router.get('/:tenantId', requireRole(['admin', 'expert']), async (req, res) => {
  try {
    const { tenantId } = req.params;
    const service = new TicketRulesService(tenantId);

    const rules = await service.getAllRules();

    res.json({
      success: true,
      rules: rules,
      count: rules.length
    });
  } catch (error) {
    console.error('Error fetching rules:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch rules',
      message: error.message
    });
  }
});

// Get rule statistics for tenant (must come before /:tenantId/:ruleId to avoid matching "statistics" as ruleId)
router.get('/:tenantId/statistics', requireRole(['admin', 'expert']), async (req, res) => {
  try {
    const { tenantId } = req.params;
    const service = new TicketRulesService(tenantId);

    const stats = await service.getRuleStatistics();

    res.json({
      success: true,
      statistics: stats
    });
  } catch (error) {
    console.error('Error fetching statistics:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch statistics',
      message: error.message
    });
  }
});

// Get single rule by ID
router.get('/:tenantId/:ruleId', requireRole(['admin', 'expert']), async (req, res) => {
  try {
    const { tenantId, ruleId } = req.params;
    const service = new TicketRulesService(tenantId);

    const rule = await service.getRuleById(parseInt(ruleId));

    res.json({
      success: true,
      rule: rule
    });
  } catch (error) {
    console.error('Error fetching rule:', error);
    res.status(error.message === 'Rule not found' ? 404 : 500).json({
      success: false,
      error: 'Failed to fetch rule',
      message: error.message
    });
  }
});

// Create new rule
router.post('/:tenantId', requireRole(['admin', 'expert']), async (req, res) => {
  try {
    const { tenantId } = req.params;
    const service = new TicketRulesService(tenantId);
    const userId = req.user.userId;

    const ruleData = req.body;

    // Validate required fields
    if (!ruleData.rule_name || !ruleData.search_text || !ruleData.action_type) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        message: 'rule_name, search_text, and action_type are required'
      });
    }

    const rule = await service.createRule(ruleData, userId);

    res.status(201).json({
      success: true,
      message: 'Rule created successfully',
      rule: rule
    });
  } catch (error) {
    console.error('Error creating rule:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create rule',
      message: error.message
    });
  }
});

// Update existing rule
router.put('/:tenantId/:ruleId', requireRole(['admin', 'expert']), async (req, res) => {
  try {
    const { tenantId, ruleId } = req.params;
    const service = new TicketRulesService(tenantId);

    const ruleData = req.body;

    const rule = await service.updateRule(parseInt(ruleId), ruleData);

    res.json({
      success: true,
      message: 'Rule updated successfully',
      rule: rule
    });
  } catch (error) {
    console.error('Error updating rule:', error);
    res.status(error.message === 'Rule not found' ? 404 : 500).json({
      success: false,
      error: 'Failed to update rule',
      message: error.message
    });
  }
});

// Delete rule
router.delete('/:tenantId/:ruleId', requireRole(['admin', 'expert']), async (req, res) => {
  try {
    const { tenantId, ruleId } = req.params;
    const service = new TicketRulesService(tenantId);

    await service.deleteRule(parseInt(ruleId));

    res.json({
      success: true,
      message: 'Rule deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting rule:', error);
    res.status(error.message === 'Rule not found' ? 404 : 500).json({
      success: false,
      error: 'Failed to delete rule',
      message: error.message
    });
  }
});

// Test rule (preview matching tickets without executing)
router.post('/:tenantId/:ruleId/test', requireRole(['admin', 'expert']), async (req, res) => {
  try {
    const { tenantId, ruleId } = req.params;
    const service = new TicketRulesService(tenantId);

    const testResult = await service.testRule(parseInt(ruleId));

    res.json({
      success: true,
      message: `Rule would affect ${testResult.would_affect} ticket(s)`,
      ...testResult
    });
  } catch (error) {
    console.error('Error testing rule:', error);
    res.status(error.message === 'Rule not found' ? 404 : 500).json({
      success: false,
      error: 'Failed to test rule',
      message: error.message
    });
  }
});

// Run rule on all matching tickets in background
router.post('/:tenantId/:ruleId/run', requireRole(['admin', 'expert']), async (req, res) => {
  try {
    const { tenantId, ruleId } = req.params;
    const userId = req.user.userId;
    const service = new TicketRulesService(tenantId);

    const result = await service.runRuleInBackground(parseInt(ruleId), userId);

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Error starting rule execution:', error);
    res.status(error.message === 'Rule not found' ? 404 : 500).json({
      success: false,
      error: 'Failed to start rule execution',
      message: error.message
    });
  }
});

// Execute rule on specific ticket
router.post('/:tenantId/:ruleId/execute/:ticketId', requireRole(['admin', 'expert']), async (req, res) => {
  try {
    const { tenantId, ruleId, ticketId } = req.params;
    const service = new TicketRulesService(tenantId);

    const result = await service.executeRuleOnTicket(parseInt(ruleId), parseInt(ticketId));

    res.json({
      success: result.success,
      message: result.success ? 'Rule executed successfully' : 'Rule execution failed',
      result: result
    });
  } catch (error) {
    console.error('Error executing rule:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to execute rule',
      message: error.message
    });
  }
});

// Execute all enabled rules on a ticket
router.post('/:tenantId/execute-all/:ticketId', requireRole(['admin', 'expert']), async (req, res) => {
  try {
    const { tenantId, ticketId } = req.params;
    const service = new TicketRulesService(tenantId);

    const results = await service.executeAllRulesOnTicket(parseInt(ticketId));

    res.json({
      success: true,
      message: `Executed ${results.length} rule(s)`,
      results: results
    });
  } catch (error) {
    console.error('Error executing rules:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to execute rules',
      message: error.message
    });
  }
});

// Get execution history for a rule
router.get('/:tenantId/:ruleId/history', requireRole(['admin', 'expert']), async (req, res) => {
  try {
    const { tenantId, ruleId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const service = new TicketRulesService(tenantId);

    const history = await service.getRuleExecutionHistory(parseInt(ruleId), limit);

    res.json({
      success: true,
      history: history,
      count: history.length
    });
  } catch (error) {
    console.error('Error fetching execution history:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch execution history',
      message: error.message
    });
  }
});

module.exports = router;
