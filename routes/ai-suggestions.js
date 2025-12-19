const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const { AIAnalysisService } = require('../services/ai-analysis-service');

/**
 * AI Suggestions Routes
 * Provides AI-powered ticket triage, suggestions, and one-click actions
 */

// Apply verifyToken middleware to all AI routes
router.use(verifyToken);

// Get AI suggestions for a specific ticket
router.get('/:tenantCode/tickets/:ticketId/suggestions', async (req, res) => {
  try {
    const { tenantCode, ticketId } = req.params;

    // Verify user has access to this tenant
    if (req.user.tenantCode !== tenantCode && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied to this tenant' });
    }

    // Only experts and admins can get AI suggestions
    if (!['admin', 'expert'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only experts and admins can access AI suggestions' });
    }

    const aiService = new AIAnalysisService(tenantCode, {
      aiProvider: process.env.AI_PROVIDER || 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY || process.env.AI_API_KEY
    });

    const suggestions = await aiService.getTicketSuggestions(parseInt(ticketId));

    res.json({
      success: true,
      ticketId: parseInt(ticketId),
      suggestions,
      aiProvider: aiService.aiProvider,
      model: aiService.model
    });

  } catch (error) {
    console.error('Error getting AI suggestions:', error);
    res.status(500).json({
      error: 'Failed to get AI suggestions',
      message: error.message
    });
  }
});

// Execute an AI-suggested action (one-click)
router.post('/:tenantCode/tickets/:ticketId/execute-action', async (req, res) => {
  try {
    const { tenantCode, ticketId } = req.params;
    const { action } = req.body;

    // Verify user has access
    if (req.user.tenantCode !== tenantCode && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied to this tenant' });
    }

    if (!['admin', 'expert'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only experts and admins can execute AI actions' });
    }

    if (!action || !action.type) {
      return res.status(400).json({ error: 'Action is required with a type property' });
    }

    const aiService = new AIAnalysisService(tenantCode, {
      aiProvider: process.env.AI_PROVIDER || 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY || process.env.AI_API_KEY
    });

    const results = await aiService.executeSuggestion(
      parseInt(ticketId),
      action,
      req.user.userId
    );

    res.json({
      success: true,
      ticketId: parseInt(ticketId),
      executedAction: action.type,
      results
    });

  } catch (error) {
    console.error('Error executing AI action:', error);
    res.status(500).json({
      error: 'Failed to execute AI action',
      message: error.message
    });
  }
});

// Execute multiple AI-suggested actions at once
router.post('/:tenantCode/tickets/:ticketId/execute-actions', async (req, res) => {
  try {
    const { tenantCode, ticketId } = req.params;
    const { actions } = req.body;

    // Verify user has access
    if (req.user.tenantCode !== tenantCode && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied to this tenant' });
    }

    if (!['admin', 'expert'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only experts and admins can execute AI actions' });
    }

    if (!actions || !Array.isArray(actions) || actions.length === 0) {
      return res.status(400).json({ error: 'Actions array is required' });
    }

    const aiService = new AIAnalysisService(tenantCode, {
      aiProvider: process.env.AI_PROVIDER || 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY || process.env.AI_API_KEY
    });

    const allResults = [];
    for (const action of actions) {
      const results = await aiService.executeSuggestion(
        parseInt(ticketId),
        action,
        req.user.userId
      );
      allResults.push(...results);
    }

    res.json({
      success: true,
      ticketId: parseInt(ticketId),
      executedActions: actions.map(a => a.type),
      results: allResults
    });

  } catch (error) {
    console.error('Error executing AI actions:', error);
    res.status(500).json({
      error: 'Failed to execute AI actions',
      message: error.message
    });
  }
});

// Analyze a ticket with AI (full analysis)
router.post('/:tenantCode/tickets/:ticketId/analyze', async (req, res) => {
  try {
    const { tenantCode, ticketId } = req.params;

    // Verify user has access
    if (req.user.tenantCode !== tenantCode && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied to this tenant' });
    }

    if (!['admin', 'expert'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only experts and admins can trigger AI analysis' });
    }

    const aiService = new AIAnalysisService(tenantCode, {
      aiProvider: process.env.AI_PROVIDER || 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY || process.env.AI_API_KEY
    });

    // Get ticket data first
    const { getTenantConnection } = require('../config/database');
    const connection = await getTenantConnection(tenantCode);

    try {
      const [tickets] = await connection.query(`
        SELECT t.*, u.full_name as requester_name, c.company_name
        FROM tickets t
        LEFT JOIN users u ON t.requester_id = u.id
        LEFT JOIN customers c ON u.id = c.user_id
        WHERE t.id = ?
      `, [ticketId]);

      if (tickets.length === 0) {
        return res.status(404).json({ error: 'Ticket not found' });
      }

      const ticket = tickets[0];
      const emailData = {
        subject: ticket.title,
        body: ticket.description,
        customerName: ticket.requester_name,
        companyName: ticket.company_name,
        ticketId: ticketId
      };

      const analysis = await aiService.analyzeTicket(parseInt(ticketId), emailData);

      res.json({
        success: true,
        ticketId: parseInt(ticketId),
        analysis,
        aiProvider: aiService.aiProvider,
        model: aiService.model
      });

    } finally {
      connection.release();
    }

  } catch (error) {
    console.error('Error analyzing ticket:', error);
    res.status(500).json({
      error: 'Failed to analyze ticket',
      message: error.message
    });
  }
});

// Get AI insights dashboard data
router.get('/:tenantCode/insights', async (req, res) => {
  try {
    const { tenantCode } = req.params;
    const { period = 7 } = req.query;

    // Verify user has access
    if (req.user.tenantCode !== tenantCode && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied to this tenant' });
    }

    if (!['admin', 'expert'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only experts and admins can view AI insights' });
    }

    const aiService = new AIAnalysisService(tenantCode, {
      aiProvider: process.env.AI_PROVIDER || 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY || process.env.AI_API_KEY
    });

    const dashboardData = await aiService.getDashboardData(parseInt(period));

    res.json({
      success: true,
      period: parseInt(period),
      data: dashboardData
    });

  } catch (error) {
    console.error('Error getting AI insights:', error);
    res.status(500).json({
      error: 'Failed to get AI insights',
      message: error.message
    });
  }
});

// Detect trends (can be called manually or via cron)
router.post('/:tenantCode/detect-trends', async (req, res) => {
  try {
    const { tenantCode } = req.params;
    const { hours = 24 } = req.body;

    // Verify user has access
    if (req.user.tenantCode !== tenantCode && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied to this tenant' });
    }

    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can trigger trend detection' });
    }

    const aiService = new AIAnalysisService(tenantCode, {
      aiProvider: process.env.AI_PROVIDER || 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY || process.env.AI_API_KEY
    });

    const insights = await aiService.detectTrends(parseInt(hours));

    res.json({
      success: true,
      timeRangeHours: parseInt(hours),
      insightsDetected: insights.length,
      insights
    });

  } catch (error) {
    console.error('Error detecting trends:', error);
    res.status(500).json({
      error: 'Failed to detect trends',
      message: error.message
    });
  }
});

// ============================================================================
// CMDB MATCHING ROUTES - AI-powered ticket to CMDB item matching
// ============================================================================

// Get AI-suggested CMDB matches for a ticket
router.get('/:tenantCode/tickets/:ticketId/cmdb-matches', async (req, res) => {
  try {
    const { tenantCode, ticketId } = req.params;

    // Verify user has access
    if (req.user.tenantCode !== tenantCode && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied to this tenant' });
    }

    if (!['admin', 'expert'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only experts and admins can access CMDB matching' });
    }

    const aiService = new AIAnalysisService(tenantCode, {
      aiProvider: process.env.AI_PROVIDER || 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY || process.env.AI_API_KEY
    });

    const matches = await aiService.matchTicketToCMDB(parseInt(ticketId));

    res.json(matches);

  } catch (error) {
    console.error('Error matching ticket to CMDB:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to match ticket to CMDB',
      message: error.message
    });
  }
});

// Get linked CMDB items for a ticket
router.get('/:tenantCode/tickets/:ticketId/cmdb-items', async (req, res) => {
  try {
    const { tenantCode, ticketId } = req.params;

    // Verify user has access
    if (req.user.tenantCode !== tenantCode && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied to this tenant' });
    }

    const aiService = new AIAnalysisService(tenantCode);
    const items = await aiService.getTicketCMDBItems(parseInt(ticketId));

    res.json({
      success: true,
      ticketId: parseInt(ticketId),
      ...items
    });

  } catch (error) {
    console.error('Error getting ticket CMDB items:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get ticket CMDB items',
      message: error.message
    });
  }
});

// Link CMDB items and CIs to a ticket
router.post('/:tenantCode/tickets/:ticketId/cmdb-items', async (req, res) => {
  try {
    const { tenantCode, ticketId } = req.params;
    const { cmdbItemIds = [], ciIds = [], matchedBy = 'manual' } = req.body;

    // Verify user has access
    if (req.user.tenantCode !== tenantCode && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied to this tenant' });
    }

    if (!['admin', 'expert'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only experts and admins can link CMDB items' });
    }

    if (cmdbItemIds.length === 0 && ciIds.length === 0) {
      return res.status(400).json({ error: 'At least one CMDB item or CI must be provided' });
    }

    const aiService = new AIAnalysisService(tenantCode);
    const results = await aiService.linkTicketToCMDB(
      parseInt(ticketId),
      cmdbItemIds,
      ciIds,
      req.user.userId,
      matchedBy
    );

    res.json({
      success: true,
      ticketId: parseInt(ticketId),
      ...results
    });

  } catch (error) {
    console.error('Error linking CMDB items:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to link CMDB items',
      message: error.message
    });
  }
});

// Apply AI-suggested CMDB matches to a ticket
router.post('/:tenantCode/tickets/:ticketId/apply-cmdb-matches', async (req, res) => {
  try {
    const { tenantCode, ticketId } = req.params;
    const { cmdbItemIds = [], ciIds = [] } = req.body;

    // Verify user has access
    if (req.user.tenantCode !== tenantCode && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied to this tenant' });
    }

    if (!['admin', 'expert'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only experts and admins can apply CMDB matches' });
    }

    const aiService = new AIAnalysisService(tenantCode);
    const results = await aiService.linkTicketToCMDB(
      parseInt(ticketId),
      cmdbItemIds,
      ciIds,
      req.user.userId,
      'ai'
    );

    res.json({
      success: true,
      ticketId: parseInt(ticketId),
      message: `Applied ${results.cmdbLinked} CMDB items and ${results.ciLinked} CIs`,
      ...results
    });

  } catch (error) {
    console.error('Error applying CMDB matches:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to apply CMDB matches',
      message: error.message
    });
  }
});

// Remove a CMDB item link from a ticket
router.delete('/:tenantCode/tickets/:ticketId/cmdb-items/:cmdbItemId', async (req, res) => {
  try {
    const { tenantCode, ticketId, cmdbItemId } = req.params;

    // Verify user has access
    if (req.user.tenantCode !== tenantCode && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied to this tenant' });
    }

    if (!['admin', 'expert'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only experts and admins can unlink CMDB items' });
    }

    const aiService = new AIAnalysisService(tenantCode);
    await aiService.unlinkCMDBItem(parseInt(ticketId), parseInt(cmdbItemId), req.user.userId);

    res.json({
      success: true,
      message: 'CMDB item unlinked successfully'
    });

  } catch (error) {
    console.error('Error unlinking CMDB item:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to unlink CMDB item',
      message: error.message
    });
  }
});

// Remove a CI link from a ticket
router.delete('/:tenantCode/tickets/:ticketId/cis/:ciId', async (req, res) => {
  try {
    const { tenantCode, ticketId, ciId } = req.params;

    // Verify user has access
    if (req.user.tenantCode !== tenantCode && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied to this tenant' });
    }

    if (!['admin', 'expert'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only experts and admins can unlink CIs' });
    }

    const aiService = new AIAnalysisService(tenantCode);
    await aiService.unlinkCI(parseInt(ticketId), parseInt(ciId), req.user.userId);

    res.json({
      success: true,
      message: 'CI unlinked successfully'
    });

  } catch (error) {
    console.error('Error unlinking CI:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to unlink CI',
      message: error.message
    });
  }
});

// ============================================================================
// AI CMDB AUTO-LINK MANAGEMENT ROUTES
// ============================================================================

// Get pending AI-suggested CMDB links count and list
router.get('/:tenantCode/cmdb-suggestions', async (req, res) => {
  try {
    const { tenantCode } = req.params;
    const { limit = 50, ticket_id } = req.query;

    // Verify user has access
    if (req.user.tenantCode !== tenantCode && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied to this tenant' });
    }

    if (!['admin', 'expert'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only experts and admins can view AI suggestions' });
    }

    const { getTenantConnection } = require('../config/database');
    const connection = await getTenantConnection(tenantCode);

    try {
      // Build query with optional ticket_id filter
      let whereClause = 'tcm.matched_by = \'ai\'';
      const params = [];

      if (ticket_id) {
        whereClause += ' AND tcm.ticket_id = ?';
        params.push(parseInt(ticket_id));
      }
      params.push(parseInt(limit));

      // Get pending AI suggestions (not yet approved/rejected)
      const [suggestions] = await connection.query(`
        SELECT
          tcm.id,
          tcm.ticket_id,
          tcm.cmdb_item_id,
          tcm.relationship_type,
          tcm.confidence_score,
          tcm.match_reason,
          tcm.created_at,
          t.title as ticket_title,
          t.status as ticket_status,
          t.priority as ticket_priority,
          ci.asset_name,
          ci.asset_category,
          ci.customer_name as cmdb_customer
        FROM ticket_cmdb_items tcm
        JOIN tickets t ON tcm.ticket_id = t.id
        JOIN cmdb_items ci ON tcm.cmdb_item_id = ci.id
        WHERE ${whereClause}
        ORDER BY tcm.created_at DESC
        LIMIT ?
      `, params);

      // Get count (with optional ticket_id filter)
      const countParams = ticket_id ? [parseInt(ticket_id)] : [];
      const [countResult] = await connection.query(`
        SELECT COUNT(*) as total
        FROM ticket_cmdb_items
        WHERE matched_by = 'ai'${ticket_id ? ' AND ticket_id = ?' : ''}
      `, countParams);

      res.json({
        success: true,
        count: countResult[0].total,
        suggestions
      });

    } finally {
      connection.release();
    }

  } catch (error) {
    console.error('Error getting AI suggestions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get AI suggestions',
      message: error.message
    });
  }
});

// Known monitoring system patterns (emails, usernames, or full names)
const MONITORING_SYSTEMS = [
  'nagios', 'zabbix', 'datadog', 'prometheus', 'pagerduty', 'newrelic',
  'icinga', 'grafana', 'splunk', 'dynatrace', 'appdynamics', 'solarwinds',
  'opsgenie', 'victorops', 'pingdom', 'uptime', 'monitor', 'alert',
  'cloudwatch', 'stackdriver', 'sensu', 'checkmk'
];

function isMonitoringSystem(requesterName, requesterEmail) {
  const nameLC = (requesterName || '').toLowerCase();
  const emailLC = (requesterEmail || '').toLowerCase();
  return MONITORING_SYSTEMS.some(m => nameLC.includes(m) || emailLC.includes(m));
}

// Approve an AI-suggested CMDB link (convert to manual)
router.post('/:tenantCode/cmdb-suggestions/:suggestionId/approve', async (req, res) => {
  try {
    const { tenantCode, suggestionId } = req.params;

    // Verify user has access
    if (req.user.tenantCode !== tenantCode && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied to this tenant' });
    }

    if (!['admin', 'expert'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only experts and admins can approve suggestions' });
    }

    const { getTenantConnection } = require('../config/database');
    const connection = await getTenantConnection(tenantCode);

    try {
      // First, get the suggestion details before updating
      const [suggestions] = await connection.query(`
        SELECT tci.id, tci.ticket_id, tci.cmdb_item_id, tci.relationship_type, tci.confidence_score,
               ci.asset_name, ci.customer_name as cmdb_customer_name,
               t.requester_id, t.cmdb_item_id as current_cmdb_item_id,
               u.full_name as requester_name, u.email as requester_email
        FROM ticket_cmdb_items tci
        JOIN cmdb_items ci ON tci.cmdb_item_id = ci.id
        JOIN tickets t ON tci.ticket_id = t.id
        LEFT JOIN users u ON t.requester_id = u.id
        WHERE tci.id = ? AND tci.matched_by = 'ai'
      `, [suggestionId]);

      if (suggestions.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Suggestion not found or already processed'
        });
      }

      const suggestion = suggestions[0];
      let customerAssociated = null;

      // Check if requester is a monitoring system
      const isMonitoring = isMonitoringSystem(suggestion.requester_name, suggestion.requester_email);

      if (isMonitoring && suggestion.cmdb_customer_name) {
        console.log(`   Monitoring system detected (${suggestion.requester_name}), attempting to associate with customer: ${suggestion.cmdb_customer_name}`);

        // Try to find a matching customer company
        const [companies] = await connection.query(`
          SELECT id, company_name FROM customer_companies
          WHERE company_name LIKE ? OR company_name LIKE ?
          LIMIT 1
        `, [`%${suggestion.cmdb_customer_name}%`, suggestion.cmdb_customer_name]);

        if (companies.length > 0) {
          customerAssociated = companies[0];
          console.log(`   Found matching customer company: ${customerAssociated.company_name} (ID: ${customerAssociated.id})`);
        }
      }

      // Update the suggestion to manual
      await connection.query(`
        UPDATE ticket_cmdb_items
        SET matched_by = 'manual', created_by = ?
        WHERE id = ?
      `, [req.user.userId, suggestionId]);

      // Also update the ticket's cmdb_item_id if not already set
      if (!suggestion.current_cmdb_item_id) {
        await connection.query(`
          UPDATE tickets SET cmdb_item_id = ? WHERE id = ?
        `, [suggestion.cmdb_item_id, suggestion.ticket_id]);
      }

      // Add activity log entry
      let activityDescription = `CMDB item "${suggestion.asset_name}" linked to ticket (approved AI suggestion with ${Math.round(suggestion.confidence_score)}% confidence)`;

      if (customerAssociated) {
        activityDescription += `. Customer identified as "${customerAssociated.company_name}" based on CMDB ownership.`;
      }

      await connection.query(`
        INSERT INTO ticket_activity (ticket_id, user_id, activity_type, description)
        VALUES (?, ?, 'updated', ?)
      `, [suggestion.ticket_id, req.user.userId, activityDescription]);

      res.json({
        success: true,
        message: 'Suggestion approved and converted to manual link',
        cmdbItem: suggestion.asset_name,
        customerAssociated: customerAssociated ? customerAssociated.company_name : null,
        isMonitoringSystem: isMonitoring
      });

    } finally {
      connection.release();
    }

  } catch (error) {
    console.error('Error approving suggestion:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to approve suggestion',
      message: error.message
    });
  }
});

// Reject an AI-suggested CMDB link (delete it)
router.delete('/:tenantCode/cmdb-suggestions/:suggestionId', async (req, res) => {
  try {
    const { tenantCode, suggestionId } = req.params;

    // Verify user has access
    if (req.user.tenantCode !== tenantCode && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied to this tenant' });
    }

    if (!['admin', 'expert'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only experts and admins can reject suggestions' });
    }

    const { getTenantConnection } = require('../config/database');
    const connection = await getTenantConnection(tenantCode);

    try {
      const [result] = await connection.query(`
        DELETE FROM ticket_cmdb_items
        WHERE id = ? AND matched_by = 'ai'
      `, [suggestionId]);

      if (result.affectedRows === 0) {
        return res.status(404).json({
          success: false,
          error: 'Suggestion not found or already processed'
        });
      }

      res.json({
        success: true,
        message: 'Suggestion rejected and removed'
      });

    } finally {
      connection.release();
    }

  } catch (error) {
    console.error('Error rejecting suggestion:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to reject suggestion',
      message: error.message
    });
  }
});

// Trigger manual re-analysis of a ticket for CMDB links
router.post('/:tenantCode/tickets/:ticketId/auto-link-cmdb', async (req, res) => {
  try {
    const { tenantCode, ticketId } = req.params;

    // Verify user has access
    if (req.user.tenantCode !== tenantCode && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied to this tenant' });
    }

    if (!['admin', 'expert'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only experts and admins can trigger CMDB auto-linking' });
    }

    const { autoLinkCMDB } = require('../scripts/auto-link-cmdb');

    // Run the auto-linking (synchronous in this case for immediate feedback)
    const result = await autoLinkCMDB(tenantCode, parseInt(ticketId), {
      forceReanalyze: true,
      userId: req.user.userId
    });

    res.json(result);

  } catch (error) {
    console.error('Error triggering CMDB auto-link:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to trigger CMDB auto-linking',
      message: error.message
    });
  }
});

module.exports = router;
