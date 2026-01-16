/**
 * Slack Connector Server
 * Main entry point for the ServiFlow Slack integration
 */

require('dotenv').config();
const express = require('express');
const { App, ExpressReceiver } = require('@slack/bolt');
const { registerSlackBot } = require('./src/bot/slackBot');
const ticketWebhook = require('./src/webhooks/ticketWebhook');

// Create Express receiver for custom routes
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: '/slack/events'
});

// Create Bolt app with custom receiver
const app = new App({
  receiver,
  // For multi-workspace support, use authorize instead of token
  authorize: async ({ teamId, enterpriseId }) => {
    // Get bot token from database for this workspace
    const { getMasterConnection } = require('./src/config/database');
    try {
      const masterPool = await getMasterConnection();
      const [rows] = await masterPool.query(
        'SELECT slack_bot_token FROM slack_workspace_mappings WHERE slack_workspace_id = ? AND is_active = TRUE',
        [teamId]
      );

      if (rows.length > 0 && rows[0].slack_bot_token) {
        return {
          botToken: rows[0].slack_bot_token,
          botId: process.env.SLACK_BOT_ID
        };
      }

      throw new Error(`No bot token found for workspace ${teamId}`);
    } catch (error) {
      console.error('[Slack Server] Authorization error:', error.message);
      throw error;
    }
  }
});

// Register bot handlers
registerSlackBot(app);

// Mount webhook routes
receiver.router.use('/api/webhook', ticketWebhook);

// Health check endpoint
receiver.router.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'slack-connector',
    timestamp: new Date().toISOString()
  });
});

// Status endpoint
receiver.router.get('/api/status', (req, res) => {
  res.json({
    connected: true,
    service: 'ServiFlow Slack Connector',
    version: '1.0.0'
  });
});

// Start the server
const PORT = process.env.PORT || 3979;

(async () => {
  try {
    await app.start(PORT);
    console.log(`⚡️ Slack Connector is running on port ${PORT}`);
    console.log(`   Health check: http://localhost:${PORT}/health`);
    console.log(`   Slack events: http://localhost:${PORT}/slack/events`);
    console.log(`   Webhooks: http://localhost:${PORT}/api/webhook/ticket`);
  } catch (error) {
    console.error('Failed to start Slack Connector:', error);
    process.exit(1);
  }
})();

module.exports = { app, receiver };
