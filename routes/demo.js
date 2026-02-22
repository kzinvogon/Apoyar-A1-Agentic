/**
 * Demo Routes — Persona listing and switching
 *
 * Only mounted when DEMO_FEATURES_ENABLED=true.
 * All endpoints require tenant auth and double-lock check.
 * Persona switch validates against user's tenant_user_roles + tenant_user_company_memberships (RBAC).
 */
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const { isDemoRequest, attachDemoFlag } = require('../middleware/demoMode');
const { getTenantConnection } = require('../config/database');
const { issueMultiRoleJWT, getUserContext } = require('../services/magic-link-service');

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
 * Switch to a different demo persona (issues a new JWT).
 * Validates persona role/company against user's RBAC assignments.
 * Audit logs record actor_email + acting_as_persona_key.
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
    // Fetch persona
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

    // RBAC: validate persona's role exists in user's tenant_user_roles
    const context = await getUserContext(tenantCode, req.user.userId);
    if (!context.roles.includes(persona.role)) {
      return res.status(403).json({
        success: false,
        message: `You do not have the '${persona.role}' role required for this persona`
      });
    }

    // RBAC: validate persona's company membership (if persona has a company)
    if (persona.company_id) {
      const hasCompany = context.companies.some(c => c.id === persona.company_id);
      if (!hasCompany) {
        return res.status(403).json({
          success: false,
          message: 'You are not a member of this persona\'s company'
        });
      }
    }

    // Load persona user's roles for the JWT
    const personaContext = await getUserContext(tenantCode, persona.user_id);

    // Issue a new JWT with multi-role payload + persona info
    const token = issueMultiRoleJWT({
      userId: persona.user_id,
      username: persona.username,
      role: persona.role,
      tenantCode,
      userType: 'tenant',
      roles: personaContext.roles,
      active_role: persona.role,
      active_company_id: persona.company_id || null,
      requires_context: false,
      personaKey: persona.persona_key
    });

    // Audit log: record both identities
    try {
      // Get actual user's email for audit
      const [actorRows] = await connection.query(
        'SELECT email FROM users WHERE id = ?',
        [req.user.userId]
      );
      const actorEmail = actorRows[0]?.email || req.user.username;

      await connection.query(
        `INSERT INTO tenant_audit_log (user_id, action, details, ip_address)
         VALUES (?, 'demo_persona_switch', ?, ?)`,
        [
          req.user.userId,
          JSON.stringify({
            actor_email: actorEmail,
            acting_as_persona_key: persona.persona_key,
            persona_user_id: persona.user_id,
            persona_role: persona.role,
            persona_company_id: persona.company_id
          }),
          req.ip || null
        ]
      );
    } catch (auditErr) {
      console.error('Audit log error (non-fatal):', auditErr.message);
    }

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
