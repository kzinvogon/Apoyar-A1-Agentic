const express = require('express');
const router = express.Router();
const { getTenantConnection } = require('../config/database');
const { verifyToken } = require('../middleware/auth');

// Apply verifyToken middleware to all usage routes
router.use(verifyToken);

// Get usage statistics for a tenant
router.get('/:tenantId', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      // Get total users count
      const [userCount] = await connection.query(
        'SELECT COUNT(*) as total FROM users WHERE is_active = TRUE'
      );

      // Get total tickets count
      const [ticketCount] = await connection.query(
        'SELECT COUNT(*) as total FROM tickets'
      );

      // Get tickets by status
      const [ticketsByStatus] = await connection.query(
        `SELECT status, COUNT(*) as count
         FROM tickets
         GROUP BY status`
      );

      // Get tickets created this month
      const [monthlyTickets] = await connection.query(
        `SELECT COUNT(*) as total
         FROM tickets
         WHERE created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')`
      );

      // Get CMDB items count
      const [cmdbCount] = await connection.query(
        'SELECT COUNT(*) as total FROM cmdb_items'
      );

      // Get average response time (mock for now - would need actual SLA tracking)
      const avgResponseTime = '2.5 hours';

      // Get storage usage (mock for now - would need actual file tracking)
      const storageUsed = 2.3; // GB

      const usage = {
        users: {
          total: userCount[0].total,
          limit: 25 // would come from subscription
        },
        tickets: {
          total: ticketCount[0].total,
          thisMonth: monthlyTickets[0].total,
          byStatus: ticketsByStatus.reduce((acc, row) => {
            acc[row.status] = row.count;
            return acc;
          }, {}),
          limit: 1000 // would come from subscription
        },
        cmdb: {
          total: cmdbCount[0].total
        },
        storage: {
          used: storageUsed,
          limit: 10 // GB, would come from subscription
        },
        performance: {
          avgResponseTime
        }
      };

      res.json({ success: true, usage });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching usage statistics:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get detailed usage history (for charts)
router.get('/:tenantId/history', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { days = 30 } = req.query;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      // Get tickets created per day for the last N days
      const [ticketHistory] = await connection.query(
        `SELECT DATE(created_at) as date, COUNT(*) as count
         FROM tickets
         WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         GROUP BY DATE(created_at)
         ORDER BY date ASC`,
        [parseInt(days)]
      );

      // Get user activity per day (mock data for now)
      const userActivity = ticketHistory.map(row => ({
        date: row.date,
        activeUsers: Math.floor(Math.random() * 10) + 5
      }));

      res.json({
        success: true,
        history: {
          tickets: ticketHistory,
          activeUsers: userActivity
        }
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching usage history:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
