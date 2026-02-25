require('dotenv').config();
const express = require('express');
const { handleIncomingSms } = require('./src/bot/smsBot');
const { validateTwilioSignature, twimlResponse, twimlEmpty } = require('./src/services/twilioClient');
const { sendSms } = require('./src/services/twilioClient');
const ticketWebhook = require('./src/webhooks/ticketWebhook');

const app = express();
const PORT = process.env.PORT || 3980;

// Parse URL-encoded bodies (Twilio sends form-encoded data)
app.use(express.urlencoded({ extended: false }));
// Parse JSON bodies (for webhook from main app)
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'ServiFlow SMS Connector',
    timestamp: new Date().toISOString()
  });
});

/**
 * POST /api/sms/incoming
 * Twilio inbound SMS webhook.
 * Twilio POSTs form-encoded data; we respond with TwiML XML.
 */
app.post('/api/sms/incoming', async (req, res) => {
  const { From, To, Body } = req.body;

  console.log(`[SMS] Incoming from ${From} to ${To}: ${(Body || '').substring(0, 80)}`);

  // Validate Twilio signature (skip in dev if no auth token)
  if (process.env.TWILIO_AUTH_TOKEN && process.env.NODE_ENV === 'production') {
    const url = `${process.env.SMS_CONNECTOR_URL || `http://localhost:${PORT}`}/api/sms/incoming`;
    const signature = req.headers['x-twilio-signature'] || '';
    if (!validateTwilioSignature(url, req.body, signature)) {
      console.error('[SMS] Invalid Twilio signature');
      return res.status(403).send('Forbidden');
    }
  }

  try {
    const responseText = await handleIncomingSms(From, To, Body);

    // Respond with TwiML
    res.type('text/xml');
    res.send(twimlResponse(responseText));

  } catch (error) {
    console.error('[SMS] Error handling incoming SMS:', error);
    res.type('text/xml');
    res.send(twimlResponse('Something went wrong. Please try again.'));
  }
});

/**
 * POST /api/sms/test
 * Send a test SMS (called from main app admin UI)
 */
app.post('/api/sms/test', async (req, res) => {
  const { tenantCode, to_phone_number } = req.body;

  if (!to_phone_number) {
    return res.status(400).json({ error: 'to_phone_number is required' });
  }

  try {
    const result = await sendSms(
      to_phone_number,
      `ServiFlow SMS test message. Your SMS integration is working! Tenant: ${tenantCode || 'unknown'}`
    );
    res.json({ success: true, message: 'Test SMS sent', sid: result.sid });
  } catch (error) {
    console.error('[SMS] Test send error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Webhook endpoint - receives notifications from ServiFlow main app
app.use('/api/webhook', ticketWebhook);

// Start server
app.listen(PORT, () => {
  console.log(`ServiFlow SMS Connector running on port ${PORT}`);
  console.log(`Inbound SMS endpoint: /api/sms/incoming`);
  console.log(`Webhook endpoint: /api/webhook`);
  console.log(`Twilio Phone: ${process.env.TWILIO_PHONE_NUMBER || 'NOT SET'}`);
  console.log(`Twilio SID: ${process.env.TWILIO_ACCOUNT_SID ? process.env.TWILIO_ACCOUNT_SID.substring(0, 8) + '...' : 'NOT SET'}`);
});

module.exports = app;
