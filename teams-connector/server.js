require('dotenv').config();
const express = require('express');
const { CloudAdapter, ConfigurationBotFrameworkAuthentication } = require('botbuilder');
const { ServiFlowBot } = require('./src/bot/teamsBot');
const ticketWebhook = require('./src/webhooks/ticketWebhook');

const app = express();
const PORT = process.env.PORT || 3978;

// Bot Framework Authentication
const botFrameworkAuth = new ConfigurationBotFrameworkAuthentication({
  MicrosoftAppId: process.env.MICROSOFT_APP_ID,
  MicrosoftAppPassword: process.env.MICROSOFT_APP_PASSWORD,
  MicrosoftAppTenantId: process.env.MICROSOFT_APP_TENANT_ID,
  MicrosoftAppType: 'SingleTenant'
});

const adapter = new CloudAdapter(botFrameworkAuth);

// Error handler
adapter.onTurnError = async (context, error) => {
  console.error(`[Bot Error] ${error.message}`);
  console.error(error.stack);
  await context.sendActivity('An error occurred. Please try again or contact support.');
};

const bot = new ServiFlowBot();

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'ServiFlow Teams Connector',
    timestamp: new Date().toISOString()
  });
});

// Bot messaging endpoint - receives messages from Teams
app.post('/api/messages', express.json(), async (req, res) => {
  console.log('[Bot] Received message:', JSON.stringify(req.body?.type), req.body?.text?.substring(0, 50));
  try {
    await adapter.process(req, res, (context) => bot.run(context));
  } catch (error) {
    console.error('[Bot] Error processing message:', error.message);
    res.status(500).send('Error');
  }
});

// Webhook endpoint - receives notifications from ServiFlow main app
app.use('/api/webhook', express.json(), ticketWebhook);

// Start server
app.listen(PORT, () => {
  console.log(`ServiFlow Teams Connector running on port ${PORT}`);
  console.log(`Bot messaging endpoint: /api/messages`);
  console.log(`Webhook endpoint: /api/webhook`);
  console.log(`Microsoft App ID: ${process.env.MICROSOFT_APP_ID ? process.env.MICROSOFT_APP_ID.substring(0, 8) + '...' : 'NOT SET'}`);
});

module.exports = { adapter, bot };
