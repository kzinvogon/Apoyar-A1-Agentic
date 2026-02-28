/**
 * Magic Link Auth Routes — Public endpoints (no verifyToken)
 *
 * POST /request  — Send magic link email
 * POST /consume  — Verify token, return JWT
 *
 * Mount at /api/public/auth/magic
 */
const express = require('express');
const router = express.Router();
const { requestMagicLink, consumeMagicLink } = require('../services/magic-link-service');

// ── In-memory rate limiting ────────────────────────────────────────

const emailRateMap = new Map(); // email -> { count, resetAt }
const ipRateMap = new Map();    // ip -> { count, resetAt }

function checkRateLimit(map, key, maxPerWindow, windowMs) {
  const now = Date.now();
  const entry = map.get(key);
  if (!entry || entry.resetAt < now) {
    map.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= maxPerWindow) return false;
  entry.count++;
  return true;
}

// Clean up stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of emailRateMap) if (val.resetAt < now) emailRateMap.delete(key);
  for (const [key, val] of ipRateMap) if (val.resetAt < now) ipRateMap.delete(key);
}, 5 * 60 * 1000);

// ── POST /request ──────────────────────────────────────────────────

router.post('/request', async (req, res) => {
  try {
    const { email } = req.body;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    if (!email || !emailRegex.test(email.trim())) {
      return res.status(400).json({ ok: false, message: 'Valid email is required' });
    }

    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const normalizedEmail = email.toLowerCase().trim();

    // Rate limit: 3/min per email, 10/min per IP
    if (!checkRateLimit(emailRateMap, normalizedEmail, 3, 60_000)) {
      // Anti-enumeration: still return ok
      return res.json({ ok: true });
    }
    if (!checkRateLimit(ipRateMap, ip, 10, 60_000)) {
      return res.status(429).json({ ok: false, message: 'Too many requests — please wait a minute' });
    }

    const host = req.get('host') || req.hostname;
    const userAgent = req.get('user-agent');

    await requestMagicLink(normalizedEmail, host, ip, userAgent);

    // Always return ok (anti-enumeration)
    res.json({ ok: true });
  } catch (err) {
    console.error('Magic link request error:', err);
    // Still return ok to prevent enumeration
    res.json({ ok: true });
  }
});

// ── POST /consume ──────────────────────────────────────────────────

router.post('/consume', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ success: false, message: 'Token is required' });
    }

    const ip = req.ip || req.connection?.remoteAddress || 'unknown';

    // Rate limit: 10/min per IP for consume
    if (!checkRateLimit(ipRateMap, `consume:${ip}`, 10, 60_000)) {
      return res.status(429).json({ success: false, message: 'Too many attempts — please wait' });
    }

    const host = req.get('host') || req.hostname;
    const result = await consumeMagicLink(token, host, ip);

    if (!result.success) {
      return res.status(401).json(result);
    }

    res.json(result);
  } catch (err) {
    console.error('Magic link consume error:', err);
    res.status(500).json({ success: false, message: 'Authentication error' });
  }
});

module.exports = router;
