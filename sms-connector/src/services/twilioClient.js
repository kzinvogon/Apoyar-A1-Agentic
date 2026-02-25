/**
 * Twilio SDK wrapper for sending/receiving SMS
 */

const twilio = require('twilio');

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

let client = null;

/**
 * Get or create the Twilio client (lazy init)
 */
function getClient() {
  if (!client && TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
    client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  }
  return client;
}

/**
 * Send an SMS message
 * @param {string} to - Destination phone number (E.164)
 * @param {string} body - Message text (max 1600 chars for multi-segment)
 * @returns {Promise<object>} Twilio message result
 */
async function sendSms(to, body) {
  const twilioClient = getClient();
  if (!twilioClient) {
    throw new Error('Twilio client not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.');
  }

  if (!TWILIO_PHONE_NUMBER) {
    throw new Error('TWILIO_PHONE_NUMBER not configured.');
  }

  // Truncate to SMS-friendly length (keep under 1600 chars / ~10 segments)
  const truncatedBody = body.length > 1500 ? body.substring(0, 1497) + '...' : body;

  const message = await twilioClient.messages.create({
    body: truncatedBody,
    from: TWILIO_PHONE_NUMBER,
    to
  });

  console.log(`[Twilio] SMS sent to ${to}: SID=${message.sid}`);
  return {
    sid: message.sid,
    status: message.status,
    to: message.to,
    from: message.from
  };
}

/**
 * Validate an incoming Twilio webhook request signature
 * @param {string} url - The full webhook URL
 * @param {object} params - The request body params
 * @param {string} signature - The X-Twilio-Signature header
 * @returns {boolean}
 */
function validateTwilioSignature(url, params, signature) {
  if (!TWILIO_AUTH_TOKEN) {
    console.warn('[Twilio] No auth token configured — skipping signature validation');
    return true;
  }
  return twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, url, params);
}

/**
 * Generate TwiML XML response for inbound SMS
 * @param {string} messageBody - The reply text
 * @returns {string} TwiML XML
 */
function twimlResponse(messageBody) {
  const MessagingResponse = twilio.twiml.MessagingResponse;
  const response = new MessagingResponse();
  response.message(messageBody);
  return response.toString();
}

/**
 * Generate empty TwiML (acknowledge but don't reply)
 * @returns {string} TwiML XML
 */
function twimlEmpty() {
  const MessagingResponse = twilio.twiml.MessagingResponse;
  const response = new MessagingResponse();
  return response.toString();
}

module.exports = {
  sendSms,
  validateTwilioSignature,
  twimlResponse,
  twimlEmpty,
  getClient
};
