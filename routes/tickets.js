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

// AI-powered CMDB auto-linking (fire-and-forget)
const { triggerAutoLink } = require('../scripts/auto-link-cmdb');

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
      
      // Get ticket activity/actions
      const [activities] = await connection.query(
        `SELECT ta.*, u.username as user_name, u.full_name as user_full_name
         FROM ticket_activity ta
         LEFT JOIN users u ON ta.user_id = u.id
         WHERE ta.ticket_id = ?
         ORDER BY ta.created_at DESC`,
        [ticketId]
      );
      
      res.json({ success: true, ticket: tickets[0], activities });
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
    const { title, description, priority, customer_id, cmdb_item_id, ci_id, due_date } = req.body;
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

      const [result] = await connection.query(
        `INSERT INTO tickets (title, description, priority, requester_id, cmdb_item_id, sla_deadline, category)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [title, description, mappedPriority, customer_id, cmdb_item_id || null, due_date || null, 'General']
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

      // Trigger AI-powered CMDB auto-linking (fire-and-forget)
      if (description && description.trim().length > 10) {
        triggerAutoLink(tenantCode, ticketId, req.user.userId);
      }

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
        if (status.toLowerCase() === 'resolved') {
          updates.push('resolved_by = ?');
          values.push(req.user.userId);
          updates.push('resolved_at = NOW()');

          if (comment) {
            updates.push('resolution_comment = ?');
            values.push(comment);
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
          const acceptRejectUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/ticket-resolution.html?token=${token}`;

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
      } else if (status && status !== oldStatus) {
        await sendTicketNotificationEmail({
          ticket: tickets[0],
          customer_email: tickets[0].requester_email,
          customer_name: tickets[0].requester_name,
          tenantCode: tenantCode
        }, 'status_changed', { oldStatus, newStatus: status });
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
      }

      // Re-trigger AI CMDB auto-linking if a meaningful comment was added
      // (fire-and-forget, won't block the response)
      if (comment && comment.trim().length > 20) {
        triggerAutoLink(tenantCode, parseInt(ticketId), req.user.userId);
      }

      res.json({ success: true, ticket: tickets[0] });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error updating ticket:', error);
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

      // Determine the new status and activity type based on action
      let newStatus, activityType, activityDescription;
      switch (action) {
        case 'close':
          newStatus = 'closed';
          activityType = 'closed';
          activityDescription = `Bulk closed: ${comment}`;
          break;
        case 'resolve':
          newStatus = 'Resolved';
          activityType = 'resolved';
          activityDescription = `Bulk resolved: ${comment}`;
          break;
        case 'assign':
          newStatus = 'in_progress';
          activityType = 'assigned';
          // Get assignee name
          const [assigneeResult] = await connection.query(
            'SELECT full_name, username FROM users WHERE id = ?',
            [assignee_id]
          );
          const assigneeName = assigneeResult[0]?.full_name || assigneeResult[0]?.username || 'Unknown';
          activityDescription = `Bulk assigned to ${assigneeName}: ${comment}`;
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
          console.error(`Error processing ticket ${ticketId}:`, ticketError);
          failed++;
        }
      }

      res.json({
        success: true,
        message: `Bulk ${action} completed`,
        processed,
        failed,
        total: ticket_ids.length
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error in bulk action:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;

