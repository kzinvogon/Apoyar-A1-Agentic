const express = require('express');
const crypto = require('crypto');
const { handleTicketEvent } = require('../services/smsNotifier');

const router = express.Router();

/**
 * Verify webhook signature from ServiFlow main app
 */
function verifyWebhookSignature(req, res, next) {
  const signature = req.headers['x-serviflow-signature'];
  const webhookSecret = process.env.SMS_WEBHOOK_SECRET;

  // If no secret configured, skip verification (development mode)
  if (!webhookSecret) {
    console.log('[Webhook] No webhook secret configured - skipping signature verification');
    return next();
  }

  if (!signature) {
    return res.status(401).json({ error: 'Missing signature header' });
  }

  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(JSON.stringify(req.body))
    .digest('hex');

  if (signature !== expectedSignature) {
    console.error('[Webhook] Invalid signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  next();
}

/**
 * POST /api/webhook/ticket
 * Receive ticket events from ServiFlow main app
 */
router.post('/ticket', verifyWebhookSignature, async (req, res) => {
  try {
    const { eventType, tenantCode, ticket, timestamp } = req.body;

    console.log(`[Webhook] Received ${eventType} event for ticket #${ticket?.id} from tenant ${tenantCode}`);

    if (!eventType || !ticket || !ticket.id) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: eventType, ticket'
      });
    }

    const result = await handleTicketEvent(eventType, ticket, tenantCode);
    res.json(result);

  } catch (error) {
    console.error('[Webhook] Error processing ticket event:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/webhook/batch
 * Receive batch ticket events
 */
router.post('/batch', verifyWebhookSignature, async (req, res) => {
  try {
    const { events, tenantCode } = req.body;

    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing or empty events array'
      });
    }

    console.log(`[Webhook] Received batch of ${events.length} events from tenant ${tenantCode}`);

    const results = [];
    for (const event of events) {
      const result = await handleTicketEvent(event.eventType, event.ticket, tenantCode);
      results.push(result);
    }

    res.json({
      success: true,
      processed: results.length,
      results
    });

  } catch (error) {
    console.error('[Webhook] Error processing batch events:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/webhook/health
 * Health check for webhook endpoint
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    endpoint: 'ServiFlow SMS Webhook',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
