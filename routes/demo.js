/**
 * Demo Routes — Persona listing and switching
 *
 * Only mounted when DEMO_FEATURES_ENABLED=true.
 * All endpoints require tenant auth and double-lock check.
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const { isDemoRequest, attachDemoFlag } = require('../middleware/demoMode');
const { getTenantConnection } = require('../config/database');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = '24h';

// All demo routes require authentication + demo flag
router.use(verifyToken);
router.use(attachDemoFlag);

/**
 * GET /api/demo/personas
 * Returns list of available demo personas
 */
router.get('/personas', async (req, res) => {
  if (!isDemoRequest(req)) {
    return res.status(404).json({ message: 'Not found' });
  }

  const tenantCode = req.user.tenantCode;
  const connection = await getTenantConnection(tenantCode);

  try {
    const [personas] = await connection.query(`
      SELECT dp.persona_key, dp.display_name, dp.role, dp.description, dp.sort_order,
             u.username, u.full_name, u.email,
             cc.company_name
      FROM demo_personas dp
      JOIN users u ON dp.user_id = u.id
      LEFT JOIN customer_companies cc ON dp.company_id = cc.id
      ORDER BY dp.sort_order ASC
    `);

    res.json({ success: true, personas });
  } catch (err) {
    console.error('Error fetching personas:', err);
    res.status(500).json({ success: false, message: 'Failed to load personas' });
  } finally {
    connection.release();
  }
});

/**
 * POST /api/demo/switch-persona
 * Switch to a different demo persona (issues a new JWT)
 */
router.post('/switch-persona', async (req, res) => {
  if (!isDemoRequest(req)) {
    return res.status(404).json({ message: 'Not found' });
  }

  const { persona_key } = req.body;
  if (!persona_key) {
    return res.status(400).json({ success: false, message: 'persona_key is required' });
  }

  const tenantCode = req.user.tenantCode;
  const connection = await getTenantConnection(tenantCode);

  try {
    const [rows] = await connection.query(`
      SELECT dp.*, u.username, u.full_name, u.email,
             cc.company_name
      FROM demo_personas dp
      JOIN users u ON dp.user_id = u.id
      LEFT JOIN customer_companies cc ON dp.company_id = cc.id
      WHERE dp.persona_key = ?
      LIMIT 1
    `, [persona_key]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Persona not found' });
    }

    const persona = rows[0];

    // Issue a new JWT with persona context
    const token = jwt.sign(
      {
        userId: persona.user_id,
        username: persona.username,
        role: persona.role,
        tenantCode,
        userType: 'tenant',
        personaKey: persona.persona_key,
        activeCompanyId: persona.company_id || null
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.json({
      success: true,
      token,
      persona: {
        persona_key: persona.persona_key,
        display_name: persona.display_name,
        role: persona.role,
        username: persona.username,
        full_name: persona.full_name,
        email: persona.email,
        company_name: persona.company_name,
        description: persona.description
      }
    });
  } catch (err) {
    console.error('Error switching persona:', err);
    res.status(500).json({ success: false, message: 'Failed to switch persona' });
  } finally {
    connection.release();
  }
});

/**
 * GET /api/demo/status
 * Returns demo mode status (for frontend detection)
 */
router.get('/status', (req, res) => {
  res.json({
    success: true,
    demo: isDemoRequest(req),
    personaKey: req.user.personaKey || null
  });
});

module.exports = router;
