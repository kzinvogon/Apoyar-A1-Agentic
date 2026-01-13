const express = require('express');
const router = express.Router();
const { getTenantConnection } = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');
const { sendTicketNotificationEmail } = require('../config/email');
const {
  validateTicketCreate,
  validateTicketUpdate,
  validateTicketGet
} = require('../middleware/validation');
const {
  writeOperationsLimiter,
  readOperationsLimiter
} = require('../middleware/rateLimiter');
const { triggerTeamsNotificationAsync } = require('../services/teams-notification');

// AI-powered CMDB auto-linking (fire-and-forget)
const { triggerAutoLink } = require('../scripts/auto-link-cmdb');

// AI-powered KB article auto-generation (fire-and-forget)
const { autoGenerateKBArticle } = require('../scripts/auto-generate-kb-article');

// SLA calculator service
const {
  getDefaultSLA,
  computeInitialDeadlines,
  computeResolveDeadline,
  computeSLAStatus
} = require('../services/sla-calculator');

// SLA selector service
const { resolveApplicableSLA } = require('../services/sla-selector');

// Ticket rules service
const { TicketRulesService } = require('../services/ticket-rules-service');

// Fire-and-forget ticket rules execution
async function triggerTicketRulesAsync(tenantCode, ticketId) {
  try {
    const rulesService = new TicketRulesService(tenantCode);
    const results = await rulesService.executeAllRulesOnTicket(ticketId);
    if (results.length > 0) {
      console.log(`[TicketRules] Executed ${results.length} rule(s) on ticket #${ticketId}:`,
        results.map(r => `${r.rule_name}: ${r.result}`).join(', '));
    }
  } catch (error) {
    console.error(`[TicketRules] Error executing rules on ticket #${ticketId}:`, error.message);
  }
}

// ========== PUBLIC ROUTES (NO AUTH) ==========
// These routes must come BEFORE the verifyToken middleware

// Get ticket details using public token
router.get('/public/:token/details', async (req, res) => {
  try {
    const { token } = req.params;

    // Decode token
    const decoded = Buffer.from(token, 'base64').toString('utf-8');
    const [tenantCode, ticketId] = decoded.split(':');

    if (!tenantCode || !ticketId) {
      return res.status(400).json({ success: false, message: 'Invalid token' });
    }

    const connection = await getTenantConnection(tenantCode);

    try {
      // Get ticket details including resolver information
      const [tickets] = await connection.query(
        `SELECT t.*,
                u1.full_name as requester_name,
                u2.full_name as resolved_by_name,
                u2.email as resolved_by_email
         FROM tickets t
         LEFT JOIN users u1 ON t.requester_id = u1.id
         LEFT JOIN users u2 ON t.resolved_by = u2.id
         WHERE t.id = ?`,
        [ticketId]
      );

      if (tickets.length === 0) {
        return res.status(404).json({ success: false, message: 'Ticket not found' });
      }

      res.json({ success: true, ticket: tickets[0] });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching ticket details:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Accept ticket resolution
router.post('/public/:token/accept', async (req, res) => {
  try {
    const { token } = req.params;

    // Decode token to get tenant and ticket ID
    const decoded = Buffer.from(token, 'base64').toString('utf-8');
    const [tenantCode, ticketId, timestamp] = decoded.split(':');

    if (!tenantCode || !ticketId) {
      return res.status(400).json({ success: false, message: 'Invalid token' });
    }

    const connection = await getTenantConnection(tenantCode);

    try {
      // Get ticket details for requester_id
      const [tickets] = await connection.query(
        `SELECT requester_id, title FROM tickets WHERE id = ?`,
        [ticketId]
      );

      if (tickets.length === 0) {
        return res.status(404).json({ success: false, message: 'Ticket not found' });
      }

      const ticket = tickets[0];

      // Update ticket status
      await connection.query(
        `UPDATE tickets SET resolution_status = 'accepted', status = 'closed', updated_at = NOW() WHERE id = ?`,
        [ticketId]
      );

      // Log activity
      const currentTime = new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      });
      await connection.query(
        `INSERT INTO ticket_activity (ticket_id, user_id, activity_type, description)
         VALUES (?, ?, ?, ?)`,
        [ticketId, ticket.requester_id, 'resolved', `Resolution Accepted - ${currentTime}`]
      );

      res.json({ success: true, message: 'Resolution accepted. Please provide your feedback.' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error accepting resolution:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Reject ticket resolution
router.post('/public/:token/reject', async (req, res) => {
  try {
    const { token } = req.params;
    const { reason, comment } = req.body;

    if (!reason) {
      return res.status(400).json({ success: false, message: 'Rejection reason is required' });
    }

    if (!comment || comment.trim().length < 10) {
      return res.status(400).json({ success: false, message: 'Please provide a detailed reason (minimum 10 characters)' });
    }

    // Decode token
    const decoded = Buffer.from(token, 'base64').toString('utf-8');
    const [tenantCode, ticketId] = decoded.split(':');

    if (!tenantCode || !ticketId) {
      return res.status(400).json({ success: false, message: 'Invalid token' });
    }

    const connection = await getTenantConnection(tenantCode);

    try {
      // Update ticket status back to 'in_progress' and save rejection details
      await connection.query(
        `UPDATE tickets SET
          resolution_status = 'rejected',
          status = 'in_progress',
          rejection_reason = ?,
          rejection_comment = ?,
          updated_at = NOW()
        WHERE id = ?`,
        [reason, comment, ticketId]
      );

      // Get ticket and assignee details for notification
      const [tickets] = await connection.query(
        `SELECT t.*, u.email as assignee_email, u.full_name as assignee_name
         FROM tickets t
         LEFT JOIN users u ON t.assignee_id = u.id
         WHERE t.id = ?`,
        [ticketId]
      );

      // Log activity with rejection details
      if (tickets[0]) {
        const currentTime = new Date().toLocaleString('en-US', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false
        });
        await connection.query(
          `INSERT INTO ticket_activity (ticket_id, user_id, activity_type, description)
           VALUES (?, ?, ?, ?)`,
          [
            ticketId,
            tickets[0].requester_id,
            'comment',
            `Resolution Rejected - ${currentTime}\nReason: ${reason}\nComment: ${comment}`
          ]
        );
      }

      // Send notification to assignee about rejection
      if (tickets[0] && tickets[0].assignee_email) {
        const { sendEmail } = require('../config/email');
        await sendEmail(tenantCode, {
          to: tickets[0].assignee_email,
          subject: `Ticket #${ticketId} - Resolution Rejected`,
          html: `
            <h2>Resolution Rejected</h2>
            <p>The customer has rejected the resolution for Ticket #${ticketId}</p>
            <p><strong>Ticket:</strong> ${tickets[0].title}</p>
            <p><strong>Rejection Reason:</strong> ${reason}</p>
            <p><strong>Customer Comments:</strong></p>
            <p>${comment}</p>
            <p>Please review and reopen the ticket.</p>
          `
        });
      }

      res.json({ success: true, message: 'Resolution rejected. The support team has been notified.' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error rejecting resolution:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Submit CSAT rating
router.post('/public/:token/csat', async (req, res) => {
  try {
    const { token } = req.params;
    const { rating, comment } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: 'Rating must be between 1 and 5' });
    }

    // Decode token
    const decoded = Buffer.from(token, 'base64').toString('utf-8');
    const [tenantCode, ticketId] = decoded.split(':');

    if (!tenantCode || !ticketId) {
      return res.status(400).json({ success: false, message: 'Invalid token' });
    }

    const connection = await getTenantConnection(tenantCode);

    try {
      // Get ticket details for requester_id
      const [tickets] = await connection.query(
        'SELECT requester_id FROM tickets WHERE id = ?',
        [ticketId]
      );

      if (tickets.length === 0) {
        return res.status(404).json({ success: false, message: 'Ticket not found' });
      }

      const requesterId = tickets[0].requester_id;

      // Save CSAT rating
      await connection.query(
        `UPDATE tickets SET csat_rating = ?, csat_comment = ?, updated_at = NOW() WHERE id = ?`,
        [rating, comment || null, ticketId]
      );

      // Log activity
      const stars = '⭐'.repeat(rating);
      const csatDescription = comment
        ? `Customer Satisfaction: ${stars} (${rating}/5) - ${comment}`
        : `Customer Satisfaction: ${stars} (${rating}/5)`;

      await connection.query(
        `INSERT INTO ticket_activity (ticket_id, user_id, activity_type, description)
         VALUES (?, ?, ?, ?)`,
        [ticketId, requesterId, 'comment', csatDescription]
      );

      res.json({ success: true, message: 'Thank you for your feedback!' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error saving CSAT rating:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get feedback scoreboard (public endpoint)
router.get('/public/:tenantCode/feedback-scoreboard', async (req, res) => {
  try {
    const { tenantCode } = req.params;
    const connection = await getTenantConnection(tenantCode);

    try {
      // Get all tickets with CSAT ratings
      const [feedbackTickets] = await connection.query(
        `SELECT t.id, t.title, t.csat_rating, t.csat_comment, t.updated_at,
                u1.full_name as requester_name,
                u2.full_name as resolved_by_name
         FROM tickets t
         LEFT JOIN users u1 ON t.requester_id = u1.id
         LEFT JOIN users u2 ON t.resolved_by = u2.id
         WHERE t.csat_rating IS NOT NULL
         ORDER BY t.updated_at DESC`
      );

      // Calculate statistics
      const totalFeedback = feedbackTickets.length;
      const ratingDistribution = {
        5: 0,
        4: 0,
        3: 0,
        2: 0,
        1: 0
      };

      let totalRating = 0;
      feedbackTickets.forEach(ticket => {
        totalRating += ticket.csat_rating;
        ratingDistribution[ticket.csat_rating]++;
      });

      const averageRating = totalFeedback > 0 ? (totalRating / totalFeedback).toFixed(2) : 0;

      // Get recent feedback (last 10)
      const recentFeedback = feedbackTickets.slice(0, 10).map(ticket => ({
        ticketId: ticket.id,
        title: ticket.title,
        rating: ticket.csat_rating,
        comment: ticket.csat_comment,
        requesterName: ticket.requester_name,
        resolvedByName: ticket.resolved_by_name,
        submittedAt: ticket.updated_at
      }));

      res.json({
        success: true,
        scoreboard: {
          totalFeedback,
          averageRating: parseFloat(averageRating),
          ratingDistribution,
          recentFeedback
        }
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching feedback scoreboard:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ========== PROTECTED ROUTES (AUTH REQUIRED) ==========
// Apply verifyToken middleware to all routes below
router.use(verifyToken);

// Get tenant settings (must come BEFORE /:tenantId to avoid route conflict)
router.get('/settings/:tenantId', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      const [settings] = await connection.query('SELECT * FROM tenant_settings');
      const settingsObj = {};
      settings.forEach(s => {
        settingsObj[s.setting_key] = s.setting_value;
      });
      res.json({ success: true, settings: settingsObj });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Update tenant settings (must come BEFORE /:tenantId to avoid route conflict)
router.post('/settings/:tenantId', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { key, value } = req.body;

    if (!key) {
      return res.status(400).json({ success: false, message: 'Setting key is required' });
    }

    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      await connection.query(
        `INSERT INTO tenant_settings (setting_key, setting_value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE setting_value = ?`,
        [key, value, value]
      );
      res.json({ success: true, message: 'Setting updated successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error updating setting:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get all tickets for a tenant
router.get('/:tenantId', readOperationsLimiter, validateTicketGet, async (req, res) => {
  try {
    const { tenantId } = req.params;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      // Build query with filtering based on role
      let query = `
        SELECT t.*,
               u1.full_name as assignee_name,
               u2.full_name as requester_name,
               (u2.username = 'system' OR u2.email = 'system@tenant.local') as is_system_source,
               ci.asset_name as cmdb_item_name,
               c.customer_company_id,
               cc.company_name as company_name,
               cc.company_domain as company_domain
        FROM tickets t
        LEFT JOIN users u1 ON t.assignee_id = u1.id
        LEFT JOIN users u2 ON t.requester_id = u2.id
        LEFT JOIN cmdb_items ci ON t.cmdb_item_id = ci.id
        LEFT JOIN customers c ON t.requester_id = c.user_id
        LEFT JOIN customer_companies cc ON c.customer_company_id = cc.id
      `;

      const params = [];
      const whereConditions = [];

      // Filter by role
      if (req.user.role === 'customer') {
        // Customers see only their own tickets
        whereConditions.push('t.requester_id = ?');
        params.push(req.user.userId);
      } else if (req.user.role === 'expert') {
        // Experts see tickets based on their permissions
        const [permissions] = await connection.query(
          `SELECT permission_type, customer_id, title_pattern
           FROM expert_ticket_permissions
           WHERE expert_id = ? AND is_active = TRUE`,
          [req.user.userId]
        );

        if (permissions.length === 0) {
          // No permissions = no tickets visible
          whereConditions.push('1 = 0');
        } else {
          // Check if has 'all_tickets' permission
          const hasAllTickets = permissions.some(p => p.permission_type === 'all_tickets');

          if (!hasAllTickets) {
            // Build permission-based filter
            const permissionConditions = [];

            // Specific customers
            const customerIds = permissions
              .filter(p => p.permission_type === 'specific_customers')
              .map(p => p.customer_id);
            if (customerIds.length > 0) {
              permissionConditions.push(`t.requester_id IN (${customerIds.join(',')})`);
            }

            // Title patterns
            const titlePatterns = permissions
              .filter(p => p.permission_type === 'title_patterns' && p.title_pattern)
              .map(p => p.title_pattern);
            if (titlePatterns.length > 0) {
              const titleConditions = titlePatterns.map(() => 't.title LIKE ?');
              permissionConditions.push(`(${titleConditions.join(' OR ')})`);
              titlePatterns.forEach(pattern => params.push(`%${pattern}%`));
            }

            if (permissionConditions.length > 0) {
              whereConditions.push(`(${permissionConditions.join(' OR ')})`);
            } else {
              // Has permissions but none are valid
              whereConditions.push('1 = 0');
            }
          }
          // If hasAllTickets, no WHERE condition needed (see all tickets)
        }
      }
      // Admin role sees all tickets (no WHERE condition)

      if (whereConditions.length > 0) {
        query += ` WHERE ${whereConditions.join(' AND ')}`;
      }

      query += ` ORDER BY t.created_at DESC`;

      const [tickets] = await connection.query(query, params);

      // Enrich tickets with computed SLA status
      await enrichTicketsWithSLAStatus(tickets, connection);

      res.json({ success: true, tickets });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching tickets:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get a specific ticket
router.get('/:tenantId/:ticketId', readOperationsLimiter, validateTicketGet, async (req, res) => {
  try {
    const { tenantId, ticketId } = req.params;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      const [tickets] = await connection.query(
        `SELECT t.*,
                u1.full_name as assignee_name,
                u2.full_name as requester_name,
                u2.customer_company_id as requester_company_id,
                ci.asset_name as cmdb_item_name
         FROM tickets t
         LEFT JOIN users u1 ON t.assignee_id = u1.id
         LEFT JOIN users u2 ON t.requester_id = u2.id
         LEFT JOIN cmdb_items ci ON t.cmdb_item_id = ci.id
         WHERE t.id = ?`,
        [ticketId]
      );

      if (tickets.length === 0) {
        return res.status(404).json({ success: false, message: 'Ticket not found' });
      }

      const ticket = tickets[0];

      // Customer permission check - customers can only see their own tickets or company tickets
      if (req.user.role === 'customer') {
        // Use == for type coercion (userId might be string from JWT, requester_id is number from DB)
        const isOwnTicket = ticket.requester_id == req.user.userId;

        // If not own ticket, check company membership
        let isSameCompany = false;
        if (!isOwnTicket && ticket.requester_company_id) {
          // Look up customer's company from database
          const [customerInfo] = await connection.query(
            `SELECT c.customer_company_id FROM customers c WHERE c.user_id = ?`,
            [req.user.userId]
          );
          if (customerInfo.length > 0 && customerInfo[0].customer_company_id) {
            isSameCompany = ticket.requester_company_id == customerInfo[0].customer_company_id;
          }
        }

        if (!isOwnTicket && !isSameCompany) {
          return res.status(403).json({ success: false, message: 'Access denied' });
        }
      }

      // Get ticket activity/actions - filter for customers
      let activityQuery = `
        SELECT ta.*, u.username as user_name, u.full_name as user_full_name, u.role as user_role
        FROM ticket_activity ta
        LEFT JOIN users u ON ta.user_id = u.id
        WHERE ta.ticket_id = ?`;

      // For customers, filter out internal notes
      // Customers see: created, resolved, closed, their own comments, and public replies from staff
      if (req.user.role === 'customer') {
        activityQuery += ` AND (
          ta.activity_type IN ('created', 'resolved', 'closed')
          OR (ta.activity_type = 'comment' AND ta.user_id = ?)
          OR (ta.activity_type = 'comment' AND ta.description LIKE 'Public reply%')
          OR (ta.activity_type = 'comment' AND ta.description LIKE 'Customer reply%')
          OR (ta.activity_type = 'updated' AND ta.description LIKE '%status%')
        )`;
      }

      activityQuery += ` ORDER BY ta.created_at DESC`;

      const activityParams = req.user.role === 'customer'
        ? [ticketId, req.user.userId]
        : [ticketId];

      const [activities] = await connection.query(activityQuery, activityParams);

      // Enrich with SLA status
      await enrichTicketWithSLAStatus(ticket, connection);

      res.json({ success: true, ticket, activities });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error fetching ticket:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Export tickets to CSV
router.get('/:tenantId/export/csv', readOperationsLimiter, validateTicketGet, async (req, res) => {
  try {
    const { tenantId } = req.params;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      // Build query with customer filtering based on role
      let query = `
        SELECT t.id, t.title, t.description, t.status, t.priority, t.category,
               t.created_at, t.updated_at, t.sla_deadline,
               u1.full_name as assignee_name,
               u2.full_name as requester_name,
               ci.asset_name as cmdb_item_name
        FROM tickets t
        LEFT JOIN users u1 ON t.assignee_id = u1.id
        LEFT JOIN users u2 ON t.requester_id = u2.id
        LEFT JOIN cmdb_items ci ON t.cmdb_item_id = ci.id
      `;

      const params = [];

      // Filter by customer if role is 'customer'
      if (req.user.role === 'customer') {
        query += ` WHERE t.requester_id = ?`;
        params.push(req.user.userId);
      }

      query += ` ORDER BY t.created_at DESC`;

      const [tickets] = await connection.query(query, params);

      // Generate CSV
      const csvRows = [];

      // Header row
      csvRows.push([
        'ID',
        'Title',
        'Description',
        'Status',
        'Priority',
        'Category',
        'Requester',
        'Assignee',
        'CMDB Item',
        'Created At',
        'Updated At',
        'SLA Deadline'
      ].join(','));

      // Data rows
      tickets.forEach(ticket => {
        const row = [
          ticket.id,
          `"${(ticket.title || '').replace(/"/g, '""')}"`,
          `"${(ticket.description || '').replace(/"/g, '""')}"`,
          ticket.status || '',
          ticket.priority || '',
          ticket.category || '',
          `"${(ticket.requester_name || '').replace(/"/g, '""')}"`,
          `"${(ticket.assignee_name || '').replace(/"/g, '""')}"`,
          `"${(ticket.cmdb_item_name || '').replace(/"/g, '""')}"`,
          ticket.created_at ? new Date(ticket.created_at).toISOString() : '',
          ticket.updated_at ? new Date(ticket.updated_at).toISOString() : '',
          ticket.sla_deadline ? new Date(ticket.sla_deadline).toISOString() : ''
        ];
        csvRows.push(row.join(','));
      });

      const csv = csvRows.join('\n');

      // Set headers for CSV download
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="tickets_${tenantId}_${Date.now()}.csv"`);
      res.send(csv);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error exporting tickets:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Create a new ticket
router.post('/:tenantId', writeOperationsLimiter, validateTicketCreate, async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { title, description, priority, customer_id, cmdb_item_id, ci_id, due_date, sla_definition_id, category } = req.body;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      // Map priority values to database enum (low, medium, high, critical)
      const priorityMap = {
        'normal': 'medium',
        'low': 'low',
        'medium': 'medium',
        'high': 'high',
        'critical': 'critical'
      };
      const mappedPriority = priorityMap[(priority || 'medium').toLowerCase()] || 'medium';

      // Resolve applicable SLA using priority-based selector
      // Priority: ticket override → customer → category → cmdb → default
      const { slaId, source: slaSource } = await resolveApplicableSLA({
        tenantCode,
        ticketPayload: {
          sla_definition_id,
          requester_id: customer_id,  // customer_id from request = requester_id in DB
          category,
          cmdb_item_id: cmdb_item_id || ci_id
        }
      });

      // Fetch full SLA definition with business hours for deadline calculation
      let sla = null;
      if (slaId) {
        const [slaRows] = await connection.query(
          `SELECT s.*, b.timezone, b.days_of_week, b.start_time, b.end_time, b.is_24x7
           FROM sla_definitions s
           LEFT JOIN business_hours_profiles b ON s.business_hours_profile_id = b.id
           WHERE s.id = ? AND s.is_active = 1`,
          [slaId]
        );
        if (slaRows.length > 0) sla = slaRows[0];
      }

      let slaFields = {
        sla_definition_id: null,
        sla_source: null,
        sla_applied_at: null,
        response_due_at: null,
        resolve_due_at: null
      };

      if (sla) {
        const now = new Date();
        const deadlines = computeInitialDeadlines(sla, now);
        slaFields = {
          sla_definition_id: sla.id,
          sla_source: slaSource,
          sla_applied_at: now,
          response_due_at: deadlines.response_due_at,
          resolve_due_at: deadlines.resolve_due_at
        };
      }

      const [result] = await connection.query(
        `INSERT INTO tickets (title, description, priority, requester_id, cmdb_item_id, sla_deadline, category,
                              sla_definition_id, sla_source, sla_applied_at, response_due_at, resolve_due_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [title, description, mappedPriority, customer_id, cmdb_item_id || null, due_date || null, category || 'General',
         slaFields.sla_definition_id, slaFields.sla_source, slaFields.sla_applied_at, slaFields.response_due_at, slaFields.resolve_due_at]
      );

      const ticketId = result.insertId;

      // Log activity
      await connection.query(
        `INSERT INTO ticket_activity (ticket_id, user_id, activity_type, description)
         VALUES (?, ?, ?, ?)`,
        [ticketId, req.user.userId, 'created', `Ticket created by ${req.user.username}`]
      );

      // Get the created ticket
      const [tickets] = await connection.query(
        `SELECT t.*,
                u1.full_name as assignee_name,
                u1.email as assignee_email,
                u2.full_name as requester_name,
                u2.email as requester_email,
                u2.username as requester_username,
                u2.role as requester_role,
                ci.asset_name as cmdb_item_name
         FROM tickets t
         LEFT JOIN users u1 ON t.assignee_id = u1.id
         LEFT JOIN users u2 ON t.requester_id = u2.id
         LEFT JOIN cmdb_items ci ON t.cmdb_item_id = ci.id
         WHERE t.id = ?`,
        [ticketId]
      );

      // Send email notification
      await sendTicketNotificationEmail({
        ticket: tickets[0],
        customer_email: tickets[0].requester_email,
        customer_name: tickets[0].requester_name,
        tenantCode: tenantCode
      }, 'created', {});

      // Send Teams notification (fire-and-forget)
      triggerTeamsNotificationAsync('created', tickets[0], tenantCode);

      // Trigger AI-powered CMDB auto-linking (fire-and-forget)
      if (description && description.trim().length > 10) {
        triggerAutoLink(tenantCode, ticketId, req.user.userId);
      }

      // Execute ticket processing rules (fire-and-forget)
      triggerTicketRulesAsync(tenantCode, ticketId);

      // Enrich with SLA status
      await enrichTicketWithSLAStatus(tickets[0], connection);

      res.json({ success: true, ticket: tickets[0] });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error creating ticket:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Self-assign ticket to current expert
router.post('/:tenantId/:ticketId/self-assign', writeOperationsLimiter, requireRole(['expert', 'admin']), async (req, res) => {
  try {
    const { tenantId, ticketId } = req.params;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      // Get current ticket
      const [currentTickets] = await connection.query(
        'SELECT * FROM tickets WHERE id = ?',
        [ticketId]
      );

      if (currentTickets.length === 0) {
        return res.status(404).json({ success: false, message: 'Ticket not found' });
      }

      const currentTicket = currentTickets[0];

      // Check if ticket is available for assignment (open, paused, or unassigned)
      if (currentTicket.assignee_id && currentTicket.status !== 'paused' && currentTicket.status !== 'open') {
        return res.status(400).json({
          success: false,
          message: 'Ticket is already assigned and in progress'
        });
      }

      // For experts, verify they have permission to see this ticket
      if (req.user.role === 'expert') {
        const [permissions] = await connection.query(
          `SELECT permission_type, customer_id, title_pattern
           FROM expert_ticket_permissions
           WHERE expert_id = ? AND is_active = TRUE`,
          [req.user.userId]
        );

        if (permissions.length === 0) {
          return res.status(403).json({
            success: false,
            message: 'You do not have permission to assign tickets'
          });
        }

        const hasAllTickets = permissions.some(p => p.permission_type === 'all_tickets');

        if (!hasAllTickets) {
          // Check if expert has permission for this specific ticket
          const customerIds = permissions
            .filter(p => p.permission_type === 'specific_customers')
            .map(p => p.customer_id);

          const titlePatterns = permissions
            .filter(p => p.permission_type === 'title_patterns' && p.title_pattern)
            .map(p => p.title_pattern);

          let hasPermission = false;

          // Check customer permission
          if (customerIds.includes(currentTicket.requester_id)) {
            hasPermission = true;
          }

          // Check title pattern permission
          if (!hasPermission && titlePatterns.length > 0) {
            for (const pattern of titlePatterns) {
              if (currentTicket.title.toLowerCase().includes(pattern.toLowerCase())) {
                hasPermission = true;
                break;
              }
            }
          }

          if (!hasPermission) {
            return res.status(403).json({
              success: false,
              message: 'You do not have permission to assign this ticket'
            });
          }
        }
      }

      // Store previous assignee if ticket was assigned
      const previousAssigneeId = currentTicket.assignee_id;

      // Assign ticket to current user and set status to in_progress
      await connection.query(
        `UPDATE tickets
         SET assignee_id = ?,
             previous_assignee_id = ?,
             status = 'in_progress',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [req.user.userId, previousAssigneeId, ticketId]
      );

      // Log activity
      await connection.query(
        `INSERT INTO ticket_activity (ticket_id, user_id, activity_type, description)
         VALUES (?, ?, ?, ?)`,
        [ticketId, req.user.userId, 'assigned', `Ticket self-assigned by ${req.user.username}`]
      );

      // Get updated ticket
      const [tickets] = await connection.query(
        `SELECT t.*,
                u1.full_name as assignee_name,
                u1.email as assignee_email,
                u2.full_name as requester_name,
                u2.email as requester_email,
                ci.asset_name as cmdb_item_name
         FROM tickets t
         LEFT JOIN users u1 ON t.assignee_id = u1.id
         LEFT JOIN users u2 ON t.requester_id = u2.id
         LEFT JOIN cmdb_items ci ON t.cmdb_item_id = ci.id
         WHERE t.id = ?`,
        [ticketId]
      );

      // Send notification email to customer
      await sendTicketNotificationEmail({
        ticket: tickets[0],
        customer_email: tickets[0].requester_email,
        customer_name: tickets[0].requester_name,
        tenantCode: tenantCode
      }, 'assigned', {
        assignee_email: tickets[0].assignee_email,
        assignee_username: req.user.username
      });

      res.json({
        success: true,
        message: 'Ticket successfully self-assigned',
        ticket: tickets[0]
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error self-assigning ticket:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Update ticket (status change, assignment, etc.)
router.put('/:tenantId/:ticketId', writeOperationsLimiter, validateTicketUpdate, async (req, res) => {
  try {
    const { tenantId, ticketId } = req.params;
    const { status, assignee_id, priority, comment } = req.body;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);
    
    try {
      // Get current ticket
      const [currentTickets] = await connection.query(
        'SELECT * FROM tickets WHERE id = ?',
        [ticketId]
      );
      
      if (currentTickets.length === 0) {
        return res.status(404).json({ success: false, message: 'Ticket not found' });
      }
      
      const currentTicket = currentTickets[0];
      const oldStatus = currentTicket.status;
      const oldAssigneeId = currentTicket.assignee_id;

      // Update ticket
      const updates = [];
      const values = [];
      
      if (status !== undefined) {
        updates.push('status = ?');
        values.push(status);

        // If resolving the ticket, save who resolved it and the resolution comment (case-insensitive)
        if (status.toLowerCase() === 'resolved' || status.toLowerCase() === 'closed') {
          updates.push('resolved_by = ?');
          values.push(req.user.userId);
          updates.push('resolved_at = NOW()');

          if (comment) {
            updates.push('resolution_comment = ?');
            values.push(comment);
          }
        }

        // SLA: Set first_responded_at when moving away from 'Open' for the first time
        if (oldStatus === 'Open' && status !== 'Open' && !currentTicket.first_responded_at) {
          updates.push('first_responded_at = NOW()');

          // Recompute resolve_due_at if SLA is applied
          if (currentTicket.sla_definition_id) {
            const [slaDefs] = await connection.query(
              'SELECT resolve_after_response_minutes, resolve_target_minutes FROM sla_definitions WHERE id = ?',
              [currentTicket.sla_definition_id]
            );
            if (slaDefs.length > 0) {
              const resolveMinutes = slaDefs[0].resolve_after_response_minutes || slaDefs[0].resolve_target_minutes;
              updates.push('resolve_due_at = DATE_ADD(NOW(), INTERVAL ? MINUTE)');
              values.push(resolveMinutes);
            }
          }
        }
      }

      if (assignee_id !== undefined) {
        updates.push('assignee_id = ?');
        values.push(assignee_id);
      }

      if (priority !== undefined) {
        updates.push('priority = ?');
        values.push(priority);
      }
      
      if (updates.length === 0) {
        return res.status(400).json({ success: false, message: 'No fields to update' });
      }
      
      values.push(ticketId);
      
      await connection.query(
        `UPDATE tickets SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        values
      );
      
      // Log activity
      const actionDescription = [];
      let activityType = 'updated';

      if (status && status !== oldStatus) {
        if (status.toLowerCase() === 'resolved') {
          activityType = 'resolved';
          // For resolved status, create a detailed description
          const [resolverUser] = await connection.query(
            'SELECT full_name FROM users WHERE id = ?',
            [req.user.userId]
          );
          const resolverName = resolverUser[0]?.full_name || req.user.username;
          actionDescription.push(`Resolved by ${resolverName}`);
          if (comment) {
            actionDescription.push(`Resolution: ${comment}`);
          }
        } else {
          actionDescription.push(`Status changed from ${oldStatus} to ${status}`);
        }
      }
      if (assignee_id && status && status.toLowerCase() !== 'resolved') {
        // Look up the assignee's name
        const [assigneeUser] = await connection.query(
          'SELECT full_name FROM users WHERE id = ?',
          [assignee_id]
        );
        const assigneeName = assigneeUser[0]?.full_name || `User ID ${assignee_id}`;
        actionDescription.push(`Assigned to ${assigneeName}`);
      }
      if (priority) {
        actionDescription.push(`Priority changed to ${priority}`);
      }
      if (comment && (!status || status.toLowerCase() !== 'resolved')) {
        actionDescription.push(`Comment: ${comment}`);
      }

      await connection.query(
        `INSERT INTO ticket_activity (ticket_id, user_id, activity_type, description)
         VALUES (?, ?, ?, ?)`,
        [ticketId, req.user.userId, activityType, actionDescription.join('. ')]
      );
      
      // Get updated ticket
      const [tickets] = await connection.query(
        `SELECT t.*,
                u1.full_name as assignee_name,
                u1.email as assignee_email,
                u1.username as assignee_username,
                u1.role as assignee_role,
                u2.full_name as requester_name,
                u2.email as requester_email,
                u2.username as requester_username,
                u2.role as requester_role,
                ci.asset_name as cmdb_item_name
         FROM tickets t
         LEFT JOIN users u1 ON t.assignee_id = u1.id
         LEFT JOIN users u2 ON t.requester_id = u2.id
         LEFT JOIN cmdb_items ci ON t.cmdb_item_id = ci.id
         WHERE t.id = ?`,
        [ticketId]
      );

      // Send email notification if status changed to Resolved
      if (status === 'Resolved' && oldStatus !== 'Resolved') {
        // Check if resolution requires customer acceptance
        const [settings] = await connection.query(
          'SELECT setting_value FROM tenant_settings WHERE setting_key = ?',
          ['resolution_requires_acceptance']
        );

        const requiresAcceptance = settings.length > 0 && settings[0].setting_value === 'true';

        if (requiresAcceptance) {
          // Set resolution status to pending_acceptance
          await connection.query(
            'UPDATE tickets SET resolution_status = ?, resolved_at = NOW() WHERE id = ?',
            ['pending_acceptance', ticketId]
          );

          // Generate token for public access
          const token = Buffer.from(`${tenantCode}:${ticketId}:${Date.now()}`).toString('base64');
          const acceptRejectUrl = `${process.env.BASE_URL || 'https://serviflow.app'}/ticket-resolution.html?token=${token}`;

          // Send email with Accept/Reject links
          const { sendEmail } = require('../config/email');
          await sendEmail(tenantCode, {
            to: tickets[0].requester_email,
            subject: `Ticket #${ticketId} - Resolution Pending Your Approval`,
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #48bb78;">Ticket Resolved - Awaiting Your Approval</h2>
                <p><strong>Ticket #${ticketId}</strong></p>
                <p><strong>Title:</strong> ${tickets[0].title}</p>
                ${comment ? `<p><strong>Resolution Notes:</strong> ${comment}</p>` : ''}

                <hr style="border: 1px solid #ddd; margin: 20px 0;">

                <h3>Review & Respond</h3>
                <p>Our team has marked your ticket as resolved. Please review the resolution and let us know if it meets your expectations:</p>

                <p style="text-align: center; margin: 30px 0;">
                  <a href="${acceptRejectUrl}"
                     style="background-color: #48bb78; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: 600;">
                    Review Resolution
                  </a>
                </p>

                <p style="color: #666; font-size: 14px;">
                  <strong>What happens next?</strong><br>
                  • If you accept, we'll ask for your feedback to help us improve<br>
                  • If you reject, please tell us why so we can address your concerns
                </p>

                <hr style="border: 1px solid #ddd; margin: 20px 0;">

                <p style="color: #666; font-size: 12px;">
                  This link will remain active until you respond. If you have any questions, please reply to this email.
                </p>
              </div>
            `
          });
        } else {
          // Normal resolution email (no acceptance required)
          await sendTicketNotificationEmail({
            ticket: tickets[0],
            customer_email: tickets[0].requester_email,
            customer_name: tickets[0].requester_name,
            tenantCode: tenantCode
          }, 'resolved', { comment });
        }

        // Send Teams notification for resolved ticket
        triggerTeamsNotificationAsync('resolved', tickets[0], tenantCode, { resolutionComment: comment });

        // Fire-and-forget: Auto-generate KB article from resolved ticket
        autoGenerateKBArticle(tenantCode, parseInt(ticketId), { userId: req.user.userId })
          .then(result => {
            if (result.success && result.articleId) {
              console.log(`📚 KB article generated from ticket #${ticketId}: ${result.articleId}`);
            } else if (result.skipped) {
              console.log(`📚 KB article skipped for ticket #${ticketId}: ${result.reason}`);
            }
          })
          .catch(err => {
            console.error(`KB article generation failed for ticket #${ticketId}:`, err.message);
          });
      } else if (status && status !== oldStatus) {
        await sendTicketNotificationEmail({
          ticket: tickets[0],
          customer_email: tickets[0].requester_email,
          customer_name: tickets[0].requester_name,
          tenantCode: tenantCode
        }, 'status_changed', { oldStatus, newStatus: status });

        // Send Teams notification for status change
        triggerTeamsNotificationAsync('status_changed', tickets[0], tenantCode, { previous_status: oldStatus });
      }

      // Send email notification if ticket was assigned
      if (assignee_id && assignee_id !== oldAssigneeId && tickets[0].assignee_email) {
        await sendTicketNotificationEmail({
          ticket: tickets[0],
          customer_email: tickets[0].assignee_email,
          customer_name: tickets[0].assignee_name,
          tenantCode: tenantCode
        }, 'assigned', {
          assignee_email: tickets[0].assignee_email,
          assignee_username: tickets[0].assignee_username,
          assignee_role: tickets[0].assignee_role,
          comment
        });

        // Send Teams notification for assignment
        triggerTeamsNotificationAsync('assigned', tickets[0], tenantCode, { assignedTo: tickets[0].assignee_name });
      }

      // Re-trigger AI CMDB auto-linking if a meaningful comment was added
      // (fire-and-forget, won't block the response)
      if (comment && comment.trim().length > 20) {
        triggerAutoLink(tenantCode, parseInt(ticketId), req.user.userId);
      }

      // Enrich with SLA status
      await enrichTicketWithSLAStatus(tickets[0], connection);

      res.json({ success: true, ticket: tickets[0] });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error updating ticket:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Add comment/note to ticket
router.post('/:tenantId/:ticketId/comment', writeOperationsLimiter, async (req, res) => {
  try {
    const { tenantId, ticketId } = req.params;
    const { comment, is_public } = req.body;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      // Validate comment
      if (!comment || comment.trim().length === 0) {
        return res.status(400).json({ success: false, message: 'Comment cannot be empty' });
      }

      // Get ticket to verify it exists and check permissions
      const [tickets] = await connection.query(
        `SELECT t.*, u.customer_company_id as requester_company_id
         FROM tickets t
         LEFT JOIN users u ON t.requester_id = u.id
         WHERE t.id = ?`,
        [ticketId]
      );

      if (tickets.length === 0) {
        return res.status(404).json({ success: false, message: 'Ticket not found' });
      }

      const ticket = tickets[0];

      // Customer permission check
      if (req.user.role === 'customer') {
        const isOwnTicket = ticket.requester_id === req.user.userId;
        const isSameCompany = req.user.customerCompanyId &&
                             ticket.requester_company_id === req.user.customerCompanyId;

        if (!isOwnTicket && !isSameCompany) {
          return res.status(403).json({ success: false, message: 'Access denied' });
        }
      }

      // Get user info for activity description
      const [userInfo] = await connection.query(
        'SELECT full_name FROM users WHERE id = ?',
        [req.user.userId]
      );
      const userName = userInfo[0]?.full_name || req.user.username;

      // Determine if this is an internal note or public comment
      // Customers always add public comments; staff can specify
      const isCustomer = req.user.role === 'customer';
      const isInternal = isCustomer ? false : (is_public === false);

      // Create activity description
      const activityDescription = isInternal
        ? `Internal note by ${userName}: ${comment}`
        : `${isCustomer ? 'Customer reply' : 'Public reply'} by ${userName}: ${comment}`;

      // Insert activity
      await connection.query(
        `INSERT INTO ticket_activity (ticket_id, user_id, activity_type, description)
         VALUES (?, ?, ?, ?)`,
        [ticketId, req.user.userId, 'comment', activityDescription]
      );

      // Update ticket's updated_at
      await connection.query(
        'UPDATE tickets SET updated_at = NOW() WHERE id = ?',
        [ticketId]
      );

      res.json({ success: true, message: 'Comment added successfully' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error adding comment:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Bulk action on multiple tickets (close, assign, resolve)
router.post('/:tenantId/bulk-action', writeOperationsLimiter, requireRole(['expert', 'admin']), async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { action, ticket_ids, comment, assignee_id } = req.body;

    // Validate inputs
    if (!action || !['close', 'assign', 'resolve'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Invalid action. Must be close, assign, or resolve' });
    }

    if (!ticket_ids || !Array.isArray(ticket_ids) || ticket_ids.length === 0) {
      return res.status(400).json({ success: false, message: 'No tickets selected' });
    }

    if (!comment || comment.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'Action note is required' });
    }

    if (action === 'assign' && !assignee_id) {
      return res.status(400).json({ success: false, message: 'Assignee is required for assign action' });
    }

    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      let processed = 0;
      let failed = 0;
      const errors = [];  // Track error details

      // Determine the new status and activity type based on action
      // Note: activity_type must be a valid ENUM value (created, updated, resolved, commented, etc.)
      let newStatus, activityType, activityDescription;
      switch (action) {
        case 'close':
          newStatus = 'closed';
          activityType = 'updated';  // Use 'updated' as 'closed' may not be valid ENUM
          activityDescription = `Status changed to Closed (bulk action): ${comment}`;
          break;
        case 'resolve':
          newStatus = 'Resolved';
          activityType = 'resolved';
          activityDescription = `Bulk resolved: ${comment}`;
          break;
        case 'assign':
          newStatus = 'in_progress';
          activityType = 'updated';  // Use 'updated' as 'assigned' may not be valid ENUM
          // Get assignee name
          const [assigneeResult] = await connection.query(
            'SELECT full_name, username FROM users WHERE id = ?',
            [assignee_id]
          );
          const assigneeName = assigneeResult[0]?.full_name || assigneeResult[0]?.username || 'Unknown';
          activityDescription = `Assigned to ${assigneeName} (bulk action): ${comment}`;
          break;
      }

      // Process each ticket
      for (const ticketId of ticket_ids) {
        try {
          // Update ticket
          if (action === 'assign') {
            await connection.query(
              `UPDATE tickets SET status = ?, assignee_id = ?, updated_at = NOW() WHERE id = ?`,
              [newStatus, assignee_id, ticketId]
            );
          } else if (action === 'resolve') {
            await connection.query(
              `UPDATE tickets SET status = ?, resolved_by = ?, resolved_at = NOW(), resolution_comment = ?, updated_at = NOW() WHERE id = ?`,
              [newStatus, req.user.userId, comment, ticketId]
            );
            // Fire-and-forget: Auto-generate KB article from resolved ticket
            // Skip KB generation for large bulk operations (>10 tickets) to prevent system overload
            if (ticket_ids.length <= 10) {
              autoGenerateKBArticle(tenantCode, parseInt(ticketId), { userId: req.user.userId })
                .catch(err => console.error(`KB article generation failed for ticket #${ticketId}:`, err.message));
            }
          } else {
            await connection.query(
              `UPDATE tickets SET status = ?, updated_at = NOW() WHERE id = ?`,
              [newStatus, ticketId]
            );
          }

          // Log activity
          await connection.query(
            `INSERT INTO ticket_activity (ticket_id, user_id, activity_type, description)
             VALUES (?, ?, ?, ?)`,
            [ticketId, req.user.userId, activityType, activityDescription]
          );

          processed++;
        } catch (ticketError) {
          console.error(`Error processing ticket ${ticketId} for ${action}:`, ticketError.message);
          console.error(`  SQL Error Code: ${ticketError.code}, SQL State: ${ticketError.sqlState}`);
          errors.push({ ticketId, error: ticketError.message, code: ticketError.code });
          failed++;
        }
      }

      res.json({
        success: true,
        message: `Bulk ${action} completed`,
        processed,
        failed,
        total: ticket_ids.length,
        errors: errors.length > 0 ? errors : undefined
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error in bulk action:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Bulk delete tickets (permanently remove from database)
router.post('/:tenantId/bulk-delete', writeOperationsLimiter, requireRole(['admin']), async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { ticket_ids } = req.body;

    if (!ticket_ids || !Array.isArray(ticket_ids) || ticket_ids.length === 0) {
      return res.status(400).json({ success: false, message: 'No tickets selected' });
    }

    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      // Delete ticket activity first (foreign key constraint)
      const placeholders = ticket_ids.map(() => '?').join(',');
      await connection.query(
        `DELETE FROM ticket_activity WHERE ticket_id IN (${placeholders})`,
        ticket_ids
      );

      // Delete tickets
      const [result] = await connection.query(
        `DELETE FROM tickets WHERE id IN (${placeholders})`,
        ticket_ids
      );

      res.json({
        success: true,
        message: `Deleted ${result.affectedRows} tickets`,
        deleted: result.affectedRows,
        total: ticket_ids.length
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error in bulk delete:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

/**
 * Helper: Enrich ticket object with computed SLA status
 * @param {Object} ticket - Ticket row from database
 * @param {Object} connection - Database connection (optional, for SLA name lookup)
 * @returns {Object} Ticket with sla_status field
 */
async function enrichTicketWithSLAStatus(ticket, connection = null) {
  if (!ticket) return ticket;

  // Get SLA definition with business hours profile
  let slaDef = null;
  if (ticket.sla_definition_id && connection) {
    try {
      const [defs] = await connection.query(`
        SELECT s.name, s.near_breach_percent, s.business_hours_profile_id,
               b.timezone, b.days_of_week, b.start_time, b.end_time, b.is_24x7
        FROM sla_definitions s
        LEFT JOIN business_hours_profiles b ON s.business_hours_profile_id = b.id
        WHERE s.id = ?
      `, [ticket.sla_definition_id]);
      if (defs.length > 0) slaDef = defs[0];
    } catch (e) {
      // Ignore SLA lookup errors
    }
  }

  // Compute SLA status
  ticket.sla_status = computeSLAStatus(ticket, slaDef);
  return ticket;
}

/**
 * Helper: Enrich multiple tickets with SLA status
 */
async function enrichTicketsWithSLAStatus(tickets, connection = null) {
  return Promise.all(tickets.map(t => enrichTicketWithSLAStatus(t, connection)));
}

// Re-apply SLA to a single ticket or all tickets without SLA
router.post('/:tenantId/reapply-sla', writeOperationsLimiter, requireRole(['admin']), async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { ticketId, applyToAll } = req.body;
    const tenantCode = tenantId;
    const connection = await getTenantConnection(tenantCode);

    try {
      let ticketsToUpdate = [];

      if (ticketId) {
        // Single ticket
        const [tickets] = await connection.query(
          'SELECT id, requester_id, category, cmdb_item_id, sla_definition_id FROM tickets WHERE id = ?',
          [ticketId]
        );
        if (tickets.length === 0) {
          return res.status(404).json({ success: false, message: 'Ticket not found' });
        }
        ticketsToUpdate = tickets;
      } else if (applyToAll) {
        // All tickets without SLA
        const [tickets] = await connection.query(
          'SELECT id, requester_id, category, cmdb_item_id, sla_definition_id FROM tickets WHERE sla_definition_id IS NULL'
        );
        ticketsToUpdate = tickets;
      } else {
        return res.status(400).json({ success: false, message: 'Provide ticketId or set applyToAll: true' });
      }

      const results = [];
      for (const ticket of ticketsToUpdate) {
        const { slaId, source } = await resolveApplicableSLA({
          tenantCode,
          ticketPayload: {
            requester_id: ticket.requester_id,
            category: ticket.category,
            cmdb_item_id: ticket.cmdb_item_id
          }
        });

        if (slaId && slaId !== ticket.sla_definition_id) {
          await connection.query(
            'UPDATE tickets SET sla_definition_id = ? WHERE id = ?',
            [slaId, ticket.id]
          );
          results.push({ ticketId: ticket.id, slaId, source, updated: true });
        } else {
          results.push({ ticketId: ticket.id, slaId: ticket.sla_definition_id, source: source || 'unchanged', updated: false });
        }
      }

      const updatedCount = results.filter(r => r.updated).length;
      res.json({
        success: true,
        message: `Updated ${updatedCount} of ${ticketsToUpdate.length} tickets`,
        results
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error re-applying SLA:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;

