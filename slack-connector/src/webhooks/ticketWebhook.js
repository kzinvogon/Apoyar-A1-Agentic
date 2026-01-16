/**
 * Webhook handler for ticket events from ServiFlow main app
 * Receives ticket updates and broadcasts to appropriate Slack channels
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { sendNotification, broadcastNotification } = require('../services/slackNotifier');
const { buildNotificationBlocks } = require('../bot/blocks/notificationBlocks');

const WEBHOOK_SECRET = process.env.SLACK_WEBHOOK_SECRET;

/**
 * Verify webhook signature
 */
function verifyWebhookSignature(req, res, next) {
  if (!WEBHOOK_SECRET) {
    console.log('[Slack Webhook] No secret configured, skipping verification');
    return next();
  }

  const signature = req.headers['x-serviflow-signature'];
  if (!signature) {
    return res.status(401).json({ error: 'Missing signature' });
  }

  const payload = JSON.stringify(req.body);
  const expectedSignature = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');

  if (signature !== expectedSignature) {
    console.error('[Slack Webhook] Invalid signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  next();
}

/**
 * POST /api/webhook/ticket
 * Handle single ticket event
 */
router.post('/ticket', express.json(), verifyWebhookSignature, async (req, res) => {
  const { eventType, tenantCode, ticket, timestamp, details } = req.body;

  console.log(`[Slack Webhook] Received ${eventType} event for ticket #${ticket?.id} (tenant: ${tenantCode})`);

  if (!eventType || !ticket) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const blocks = buildNotificationBlocks(eventType, ticket, details || {});

    // Send notification to appropriate channels
    await sendNotification(tenantCode, ticket, eventType, blocks);

    res.json({ success: true, message: 'Notification sent' });
  } catch (error) {
    console.error('[Slack Webhook] Error processing event:', error);
    res.status(500).json({ error: 'Failed to process webhook' });
  }
});

/**
 * POST /api/webhook/batch
 * Handle multiple ticket events
 */
router.post('/batch', express.json(), verifyWebhookSignature, async (req, res) => {
  const { events } = req.body;

  if (!Array.isArray(events)) {
    return res.status(400).json({ error: 'events must be an array' });
  }

  console.log(`[Slack Webhook] Received batch of ${events.length} events`);

  const results = [];

  for (const event of events) {
    const { eventType, tenantCode, ticket, details } = event;

    try {
      const blocks = buildNotificationBlocks(eventType, ticket, details || {});
      await sendNotification(tenantCode, ticket, eventType, blocks);
      results.push({ ticket_id: ticket.id, success: true });
    } catch (error) {
      console.error(`[Slack Webhook] Error processing ticket #${ticket?.id}:`, error);
      results.push({ ticket_id: ticket?.id, success: false, error: error.message });
    }
  }

  res.json({ success: true, results });
});

/**
 * GET /api/webhook/health
 * Health check endpoint
 */
router.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'slack-webhook' });
});

module.exports = router;
