const express = require('express');
const router = express.Router();
const { getTenantConnection } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { TicketRulesService } = require('../services/ticket-rules-service');

// Apply verifyToken middleware to all chatbot routes
router.use(verifyToken);

// AI-powered chatbot endpoint
router.post('/:tenantId/chat', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { message, conversationHistory = [] } = req.body;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      // Analyze message intent using pattern matching
      const intent = analyzeIntent(message);

      // Generate appropriate response
      const response = await generateResponse(connection, message, intent, conversationHistory, req.user);

      res.json({
        success: true,
        response: response.message,
        intent: intent.type,
        extractedData: response.extractedData,
        action: response.action
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error in chatbot:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Create ticket directly from chat
router.post('/:tenantId/chat/create-ticket', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { extractedData } = req.body;
    const tenantCode = tenantId.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const connection = await getTenantConnection(tenantCode);

    try {
      // Map priority to database enum
      const priorityMap = {
        'urgent': 'critical',
        'high': 'high',
        'normal': 'medium',
        'medium': 'medium',
        'low': 'low'
      };
      const priority = priorityMap[(extractedData.priority || 'normal').toLowerCase()] || 'medium';

      // Create ticket
      const [result] = await connection.query(
        `INSERT INTO tickets (title, description, priority, requester_id, category)
         VALUES (?, ?, ?, ?, ?)`,
        [
          extractedData.title || 'Chat Request',
          extractedData.description || extractedData.message,
          priority,
          req.user.userId,
          extractedData.category || 'General'
        ]
      );

      const ticketId = result.insertId;

      // Log activity
      await connection.query(
        `INSERT INTO ticket_activity (ticket_id, user_id, activity_type, description)
         VALUES (?, ?, ?, ?)`,
        [ticketId, req.user.userId, 'created', `Ticket created via chatbot by ${req.user.username}`]
      );

      // Execute ticket processing rules (fire-and-forget)
      const rulesService = new TicketRulesService(tenantCode);
      rulesService.executeAllRulesOnTicket(ticketId).then(results => {
        if (results.length > 0) {
          console.log(`[TicketRules] Executed ${results.length} rule(s) on chatbot ticket #${ticketId}`);
        }
      }).catch(err => console.error(`[TicketRules] Error on ticket #${ticketId}:`, err.message));

      // Get the created ticket
      const [tickets] = await connection.query(
        `SELECT t.*, u.full_name as requester_name
         FROM tickets t
         LEFT JOIN users u ON t.requester_id = u.id
         WHERE t.id = ?`,
        [ticketId]
      );

      res.json({
        success: true,
        message: `Ticket #${ticketId} created successfully!`,
        ticket: tickets[0]
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error creating ticket from chat:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Analyze user message to determine intent
function analyzeIntent(message) {
  const lowerMessage = message.toLowerCase();

  // Greeting patterns
  if (/(^hi |^hello|^hey|^good morning|^good afternoon)/i.test(lowerMessage)) {
    return { type: 'greeting', confidence: 0.9 };
  }

  // Help/support request patterns
  if (/(help|support|issue|problem|broken|not working|can't|cannot|error|bug)/i.test(lowerMessage)) {
    return { type: 'support_request', confidence: 0.85 };
  }

  // Ticket creation patterns
  if (/(create ticket|new ticket|raise ticket|report issue|submit request)/i.test(lowerMessage)) {
    return { type: 'create_ticket', confidence: 0.95 };
  }

  // Status check patterns
  if (/(status|check|track|where is|what's happening)/i.test(lowerMessage)) {
    return { type: 'status_check', confidence: 0.8 };
  }

  // Question patterns
  if (/(how do|how to|what is|what are|can you|could you)/i.test(lowerMessage)) {
    return { type: 'question', confidence: 0.75 };
  }

  return { type: 'general', confidence: 0.5 };
}

// Extract ticket information from message
function extractTicketInfo(message) {
  const info = {
    message: message,
    title: null,
    description: null,
    priority: 'normal',
    category: 'General'
  };

  // Extract priority
  if (/(urgent|critical|asap|immediately)/i.test(message)) {
    info.priority = 'urgent';
  } else if (/(high priority|important|soon)/i.test(message)) {
    info.priority = 'high';
  } else if (/(low priority|when you can|not urgent)/i.test(message)) {
    info.priority = 'low';
  }

  // Extract category based on keywords
  if (/(password|login|access|authentication|credentials)/i.test(message)) {
    info.category = 'Access & Authentication';
  } else if (/(network|internet|wifi|connection|vpn)/i.test(message)) {
    info.category = 'Network';
  } else if (/(software|application|app|program|install)/i.test(message)) {
    info.category = 'Software';
  } else if (/(hardware|computer|laptop|printer|device)/i.test(message)) {
    info.category = 'Hardware';
  }

  // Extract title (first sentence or first 50 chars)
  const sentences = message.match(/[^.!?]+[.!?]+/g);
  if (sentences && sentences.length > 0) {
    info.title = sentences[0].trim().substring(0, 100);
  } else {
    info.title = message.substring(0, 50) + (message.length > 50 ? '...' : '');
  }

  // Use full message as description
  info.description = message;

  return info;
}

// Generate chatbot response
async function generateResponse(connection, message, intent, conversationHistory, user) {
  const response = {
    message: '',
    extractedData: null,
    action: null
  };

  switch (intent.type) {
    case 'greeting':
      response.message = `Hello! I'm your IT support assistant. I can help you create tickets, check status, or answer questions. How can I help you today?`;
      break;

    case 'support_request':
    case 'create_ticket':
      // Extract ticket information from the message
      const ticketInfo = extractTicketInfo(message);
      response.extractedData = ticketInfo;
      response.action = 'confirm_ticket';
      response.message = `I understand you need help with: "${ticketInfo.title}"\n\n` +
        `Priority: ${ticketInfo.priority.charAt(0).toUpperCase() + ticketInfo.priority.slice(1)}\n` +
        `Category: ${ticketInfo.category}\n\n` +
        `Would you like me to create this ticket for you? (Reply "yes" to create, or provide more details)`;
      break;

    case 'status_check':
      // Get user's recent tickets
      const [tickets] = await connection.query(
        `SELECT id, title, status, created_at
         FROM tickets
         WHERE requester_id = ?
         ORDER BY created_at DESC
         LIMIT 5`,
        [user.userId]
      );

      if (tickets.length === 0) {
        response.message = `You don't have any tickets yet. Would you like to create one?`;
      } else {
        const ticketList = tickets.map(t =>
          `• Ticket #${t.id}: ${t.title} - Status: ${t.status}`
        ).join('\n');
        response.message = `Here are your recent tickets:\n\n${ticketList}\n\nNeed help with anything else?`;
      }
      break;

    case 'question':
      response.message = `I can help you with:\n` +
        `• Creating support tickets\n` +
        `• Checking ticket status\n` +
        `• Providing IT support information\n\n` +
        `What would you like to know more about?`;
      break;

    default:
      // Check if this is a confirmation from previous message
      if (/(yes|yeah|sure|ok|okay|please|create it|go ahead)/i.test(message.toLowerCase())) {
        // Check if there's extracted data in conversation history
        const lastMessage = conversationHistory[conversationHistory.length - 1];
        if (lastMessage && lastMessage.extractedData) {
          response.extractedData = lastMessage.extractedData;
          response.action = 'create_ticket';
          response.message = `Great! I'll create that ticket for you right away.`;
        } else {
          response.message = `I'd be happy to help! Can you tell me more about what you need assistance with?`;
        }
      } else if (/(no|nope|cancel|nevermind)/i.test(message.toLowerCase())) {
        response.message = `No problem! Is there anything else I can help you with?`;
      } else {
        response.message = `I'm here to help! You can:\n` +
          `• Describe an issue you're having\n` +
          `• Ask to create a support ticket\n` +
          `• Check the status of your tickets\n\n` +
          `What can I do for you?`;
      }
  }

  return response;
}

module.exports = router;
