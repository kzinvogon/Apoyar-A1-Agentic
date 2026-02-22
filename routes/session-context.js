/**
 * Session Context Routes — Authenticated endpoints for role/company switching
 *
 * GET  /context        — Current user context (roles, companies, active selections)
 * POST /select-role    — Switch active role
 * POST /select-company — Switch active company (customer role only)
 *
 * Mount at /api/me (requires verifyToken)
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const { getUserContext, issueMultiRoleJWT } = require('../services/magic-link-service');
const { tenantQuery, masterQuery } = require('../config/database');

const JWT_SECRET = process.env.JWT_SECRET;

// All routes require authentication
router.use(verifyToken);

// ── GET /context ───────────────────────────────────────────────────

router.get('/context', async (req, res) => {
  try {
    const { tenantCode, userId } = req.user;

    const context = await getUserContext(tenantCode, userId);

    // Check if this is a demo tenant
    let isDemo = false;
    try {
      const tenantRows = await masterQuery(
        'SELECT is_demo FROM tenants WHERE tenant_code = ?',
        [tenantCode]
      );
      isDemo = tenantRows.length > 0 && tenantRows[0].is_demo === 1;
    } catch (e) { /* is_demo column may not exist */ }

    // Get user info
    const userRows = await tenantQuery(
      tenantCode,
      'SELECT id, username, email, full_name, role FROM users WHERE id = ?',
      [userId]
    );
    const user = userRows[0] || null;

    res.json({
      success: true,
      roles: context.roles,
      active_role: req.user.active_role || null,
      active_company_id: req.user.active_company_id || null,
      companies: context.companies,
      user,
      is_demo: isDemo,
      requires_context: req.user.requires_context || false
    });
  } catch (err) {
    console.error('Error fetching context:', err);
    res.status(500).json({ success: false, message: 'Failed to load context' });
  }
});

// ── POST /select-role ──────────────────────────────────────────────

router.post('/select-role', async (req, res) => {
  try {
    const { role } = req.body;
    if (!role) {
      return res.status(400).json({ success: false, message: 'role is required' });
    }

    const { tenantCode, userId } = req.user;

    // Validate that user actually has this role
    const context = await getUserContext(tenantCode, userId);
    if (!context.roles.includes(role)) {
      return res.status(403).json({ success: false, message: 'You do not have that role' });
    }

    // Auto-set company for customer with single company
    let activeCompanyId = null;
    if (role === 'customer' && context.companies.length === 1) {
      activeCompanyId = context.companies[0].id;
    }

    // Clear company if switching away from customer
    const requiresContext = role === 'customer' && context.companies.length > 1 && !activeCompanyId;

    const token = issueMultiRoleJWT({
      userId,
      username: req.user.username,
      role,
      tenantCode,
      userType: 'tenant',
      roles: context.roles,
      active_role: role,
      active_company_id: activeCompanyId,
      requires_context: requiresContext,
      personaKey: req.user.personaKey || null
    });

    res.json({
      success: true,
      token,
      active_role: role,
      active_company_id: activeCompanyId,
      requires_context: requiresContext,
      companies: role === 'customer' ? context.companies : []
    });
  } catch (err) {
    console.error('Error selecting role:', err);
    res.status(500).json({ success: false, message: 'Failed to switch role' });
  }
});

// ── POST /select-company ───────────────────────────────────────────

router.post('/select-company', async (req, res) => {
  try {
    const { company_id } = req.body;
    if (!company_id) {
      return res.status(400).json({ success: false, message: 'company_id is required' });
    }

    const { tenantCode, userId } = req.user;
    const activeRole = req.user.active_role || req.user.role;

    if (activeRole !== 'customer') {
      return res.status(403).json({ success: false, message: 'Company selection requires customer role' });
    }

    // Validate membership
    const context = await getUserContext(tenantCode, userId);
    const membership = context.companies.find(c => c.id === parseInt(company_id));
    if (!membership) {
      return res.status(403).json({ success: false, message: 'You are not a member of that company' });
    }

    const token = issueMultiRoleJWT({
      userId,
      username: req.user.username,
      role: activeRole,
      tenantCode,
      userType: 'tenant',
      roles: context.roles,
      active_role: activeRole,
      active_company_id: parseInt(company_id),
      requires_context: false,
      personaKey: req.user.personaKey || null
    });

    res.json({
      success: true,
      token,
      active_role: activeRole,
      active_company_id: parseInt(company_id),
      company_name: membership.company_name,
      requires_context: false
    });
  } catch (err) {
    console.error('Error selecting company:', err);
    res.status(500).json({ success: false, message: 'Failed to switch company' });
  }
});

module.exports = router;
