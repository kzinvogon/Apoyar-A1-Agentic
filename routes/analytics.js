const express = require('express');
const router = express.Router();
const { getTenantConnection } = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');
const { applyTenantMatch } = require('../middleware/tenantMatch');
const { AIAnalysisService } = require('../services/ai-analysis-service');

// Apply verifyToken middleware to all analytics routes
router.use(verifyToken);
applyTenantMatch(router);

// Get analytics dashboard data for a tenant
router.get('/:tenantId', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { period = '30' } = req.query; // days
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      // Customer role filtering - customers only see their own ticket stats
      // Multi-role: use active_company_id for company-scoped analytics, else fallback to requester_id
      const isCustomer = req.user.role === 'customer';
      let customerFilter = '';
      let customerFilterWithT = '';
      let customerParams = [];
      if (isCustomer && req.user.active_company_id) {
        customerFilter = 'AND requester_id IN (SELECT c.user_id FROM customers c WHERE c.customer_company_id = ?)';
        customerFilterWithT = 'AND t.requester_id IN (SELECT c.user_id FROM customers c WHERE c.customer_company_id = ?)';
        customerParams = [req.user.active_company_id];
      } else if (isCustomer) {
        customerFilter = 'AND requester_id = ?';
        customerFilterWithT = 'AND t.requester_id = ?';
        customerParams = [req.user.userId];
      }

      // Ticket statistics
      const [ticketStats] = await connection.query(
        `SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'Open' THEN 1 ELSE 0 END) as open_count,
          SUM(CASE WHEN status = 'In Progress' THEN 1 ELSE 0 END) as in_progress_count,
          SUM(CASE WHEN status = 'Resolved' THEN 1 ELSE 0 END) as resolved_count,
          SUM(CASE WHEN status = 'Closed' THEN 1 ELSE 0 END) as closed_count
         FROM tickets
         WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) ${customerFilter}`,
        [parseInt(period), ...customerParams]
      );

      // Ticket priority breakdown
      const [priorityStats] = await connection.query(
        `SELECT priority, COUNT(*) as count
         FROM tickets
         WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) ${customerFilter}
         GROUP BY priority`,
        [parseInt(period), ...customerParams]
      );

      // Ticket category breakdown
      const [categoryStats] = await connection.query(
        `SELECT category, COUNT(*) as count
         FROM tickets
         WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) ${customerFilter}
         GROUP BY category
         ORDER BY count DESC
         LIMIT 10`,
        [parseInt(period), ...customerParams]
      );

      // Top ticket creators - skip for customers (only shows their own data anyway)
      let topRequesters = [];
      if (!isCustomer) {
        const [requesters] = await connection.query(
          `SELECT u.full_name, u.username, COUNT(t.id) as ticket_count
           FROM tickets t
           JOIN users u ON t.requester_id = u.id
           WHERE t.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
           GROUP BY t.requester_id, u.full_name, u.username
           ORDER BY ticket_count DESC
           LIMIT 10`,
          [parseInt(period)]
        );
        topRequesters = requesters;
      }

      // SLA compliance (using status and sla_deadline since resolved_at doesn't exist)
      const [slaStats] = await connection.query(
        `SELECT
          COUNT(*) as total_with_sla,
          SUM(CASE WHEN status IN ('Resolved', 'Closed') AND updated_at <= sla_deadline THEN 1 ELSE 0 END) as met_sla,
          SUM(CASE WHEN status IN ('Resolved', 'Closed') AND updated_at > sla_deadline THEN 1 ELSE 0 END) as missed_sla,
          SUM(CASE WHEN status NOT IN ('Resolved', 'Closed') AND NOW() > sla_deadline THEN 1 ELSE 0 END) as breached_sla
         FROM tickets
         WHERE sla_deadline IS NOT NULL
         AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) ${customerFilter}`,
        [parseInt(period), ...customerParams]
      );

      // Calculate average response time (time from creation to first response)
      const [responseTimeStats] = await connection.query(
        `SELECT
          AVG(TIMESTAMPDIFF(HOUR, created_at, first_responded_at)) as avg_response_hours
         FROM tickets
         WHERE first_responded_at IS NOT NULL
         AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) ${customerFilter}`,
        [parseInt(period), ...customerParams]
      );

      // Assignee workload - skip for customers
      let assigneeWorkload = [];
      if (!isCustomer) {
        const [workload] = await connection.query(
          `SELECT u.full_name, u.username,
            COUNT(t.id) as assigned_tickets,
            SUM(CASE WHEN t.status IN ('Open', 'In Progress') THEN 1 ELSE 0 END) as active_tickets
           FROM tickets t
           LEFT JOIN users u ON t.assignee_id = u.id
           WHERE t.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
           AND t.assignee_id IS NOT NULL
           GROUP BY t.assignee_id, u.full_name, u.username
           ORDER BY assigned_tickets DESC
           LIMIT 10`,
          [parseInt(period)]
        );
        assigneeWorkload = workload;
      }

      // Trend data - tickets per day
      const [trendData] = await connection.query(
        `SELECT DATE(created_at) as date,
          COUNT(*) as created,
          SUM(CASE WHEN status = 'Resolved' OR status = 'Closed' THEN 1 ELSE 0 END) as resolved
         FROM tickets
         WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) ${customerFilter}
         GROUP BY DATE(created_at)
         ORDER BY date ASC`,
        [parseInt(period), ...customerParams]
      );

      // Recent activity - recently updated tickets
      const [recentTickets] = await connection.query(
        `SELECT id, title, status, updated_at as updatedAt
         FROM tickets
         WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) ${customerFilter}
         ORDER BY updated_at DESC
         LIMIT 10`,
        [parseInt(period), ...customerParams]
      );

      const analytics = {
        period: `${period} days`,
        tickets: {
          total: ticketStats[0].total,
          byStatus: {
            open: ticketStats[0].open_count,
            in_progress: ticketStats[0].in_progress_count,
            resolved: ticketStats[0].resolved_count,
            closed: ticketStats[0].closed_count
          },
          byPriority: priorityStats.reduce((acc, row) => {
            acc[row.priority] = row.count;
            return acc;
          }, {}),
          byCategory: categoryStats
        },
        performance: {
          avgResolutionTimeHours: responseTimeStats[0]?.avg_response_hours || null, // Calculated from first_responded_at
          sla: {
            total: slaStats[0]?.total_with_sla || 0,
            met: slaStats[0]?.met_sla || 0,
            missed: slaStats[0]?.missed_sla || 0,
            breached: slaStats[0]?.breached_sla || 0,
            complianceRate: slaStats[0]?.total_with_sla > 0 ?
              ((slaStats[0].met_sla / slaStats[0].total_with_sla) * 100).toFixed(2) : 0
          }
        },
        topRequesters,
        assigneeWorkload,
        trends: trendData,
        recentActivity: recentTickets
      };

      res.json({ success: true, analytics });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Export analytics to CSV
router.get('/:tenantId/export/csv', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { period = '30' } = req.query;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      // Get ticket statistics by date
      const [trendData] = await connection.query(
        `SELECT DATE(created_at) as date,
          COUNT(*) as total_created,
          SUM(CASE WHEN status = 'Open' THEN 1 ELSE 0 END) as open_count,
          SUM(CASE WHEN status = 'In Progress' THEN 1 ELSE 0 END) as in_progress_count,
          SUM(CASE WHEN status = 'Resolved' THEN 1 ELSE 0 END) as resolved_count,
          SUM(CASE WHEN status = 'Closed' THEN 1 ELSE 0 END) as closed_count
         FROM tickets
         WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         GROUP BY DATE(created_at)
         ORDER BY date ASC`,
        [parseInt(period)]
      );

      // Get priority breakdown
      const [priorityStats] = await connection.query(
        `SELECT priority, COUNT(*) as count
         FROM tickets
         WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         GROUP BY priority`,
        [parseInt(period)]
      );

      // Get category breakdown
      const [categoryStats] = await connection.query(
        `SELECT category, COUNT(*) as count
         FROM tickets
         WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         GROUP BY category
         ORDER BY count DESC`,
        [parseInt(period)]
      );

      // Generate CSV with multiple sections
      const csvRows = [];

      // Section 1: Daily Trend Data
      csvRows.push('DAILY TICKET TRENDS');
      csvRows.push('Date,Total Created,Open,In Progress,Resolved,Closed');
      trendData.forEach(row => {
        csvRows.push([
          row.date ? new Date(row.date).toISOString().split('T')[0] : '',
          row.total_created || 0,
          row.open_count || 0,
          row.in_progress_count || 0,
          row.resolved_count || 0,
          row.closed_count || 0
        ].join(','));
      });

      csvRows.push(''); // Empty line

      // Section 2: Priority Breakdown
      csvRows.push('PRIORITY BREAKDOWN');
      csvRows.push('Priority,Count');
      priorityStats.forEach(row => {
        csvRows.push([
          row.priority || 'Unknown',
          row.count || 0
        ].join(','));
      });

      csvRows.push(''); // Empty line

      // Section 3: Category Breakdown
      csvRows.push('CATEGORY BREAKDOWN');
      csvRows.push('Category,Count');
      categoryStats.forEach(row => {
        csvRows.push([
          `"${(row.category || 'Unknown').replace(/"/g, '""')}"`,
          row.count || 0
        ].join(','));
      });

      const csv = csvRows.join('\n');

      // Set headers for CSV download
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="analytics_${tenantId}_${period}days_${Date.now()}.csv"`);
      res.send(csv);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error exporting analytics:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get customer satisfaction metrics
router.get('/:tenantId/satisfaction', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      // Mock satisfaction data for now
      // In a real system, this would come from customer feedback/ratings
      const satisfaction = {
        averageRating: 4.2,
        totalResponses: 156,
        distribution: {
          5: 78,
          4: 52,
          3: 18,
          2: 6,
          1: 2
        },
        nps: 42 // Net Promoter Score
      };

      res.json({ success: true, satisfaction });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching satisfaction metrics:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get AI-powered insights and dashboard data
router.get('/:tenantId/ai-insights', requireRole(['admin', 'expert']), async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { period = '7' } = req.query; // days
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');

    const aiService = new AIAnalysisService(tenantCode);
    const dashboardData = await aiService.getDashboardData(parseInt(period));

    res.json({ success: true, data: dashboardData });
  } catch (error) {
    console.error('Error fetching AI insights:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Trigger trend detection manually
router.post('/:tenantId/detect-trends', requireRole(['admin', 'expert']), async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { timeRangeHours = 24 } = req.body;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');

    const aiService = new AIAnalysisService(tenantCode);
    const insights = await aiService.detectTrends(timeRangeHours);

    res.json({
      success: true,
      message: `Detected ${insights.length} insights`,
      insights
    });
  } catch (error) {
    console.error('Error detecting trends:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Acknowledge an insight
router.post('/:tenantId/insights/:insightId/acknowledge', requireRole(['admin', 'expert']), async (req, res) => {
  try {
    const { tenantId, insightId } = req.params;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      await connection.query(`
        UPDATE ai_insights
        SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = NOW()
        WHERE id = ?
      `, [req.user.userId, insightId]);

      res.json({ success: true, message: 'Insight acknowledged' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error acknowledging insight:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Dismiss an insight
router.post('/:tenantId/insights/:insightId/dismiss', requireRole(['admin', 'expert']), async (req, res) => {
  try {
    const { tenantId, insightId } = req.params;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      await connection.query(`
        UPDATE ai_insights
        SET status = 'dismissed'
        WHERE id = ?
      `, [insightId]);

      res.json({ success: true, message: 'Insight dismissed' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error dismissing insight:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get ticket with AI analysis
router.get('/:tenantId/tickets/:ticketId/ai-analysis', async (req, res) => {
  try {
    const { tenantId, ticketId } = req.params;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      const [results] = await connection.query(`
        SELECT * FROM v_tickets_with_ai WHERE id = ?
      `, [ticketId]);

      if (results.length === 0) {
        return res.status(404).json({ success: false, message: 'Ticket not found' });
      }

      const ticket = results[0];

      // Parse JSON fields
      if (ticket.key_phrases) ticket.key_phrases = JSON.parse(ticket.key_phrases);
      if (ticket.technical_terms) ticket.technical_terms = JSON.parse(ticket.technical_terms);
      if (ticket.similar_ticket_ids) ticket.similar_ticket_ids = JSON.parse(ticket.similar_ticket_ids);

      res.json({ success: true, ticket });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching ticket with AI analysis:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
