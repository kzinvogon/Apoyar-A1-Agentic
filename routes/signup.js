/**
 * Signup API Routes
 * Public endpoints for self-service trial signup (no auth required)
 *
 * Endpoints:
 * - POST /api/signup/start - Begin signup, create session
 * - POST /api/signup/create-trial - Create tenant and start trial
 * - GET /api/signup/session/:token - Get session status
 * - POST /api/signup/validate-email - Check if email is available
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getMasterConnection } = require('../config/database');
const { provisionTenant, recommendPlan } = require('../services/tenant-provisioning');
const rateLimit = require('express-rate-limit');

// Rate limiting for signup endpoints
const signupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 requests per window
  message: { success: false, message: 'Too many signup attempts. Please try again later.' }
});

// Session expiry time (1 hour)
const SESSION_EXPIRY_MS = 60 * 60 * 1000;

/**
 * Generate a secure session token
 */
function generateSessionToken() {
  return 'sess_' + crypto.randomBytes(32).toString('hex');
}

/**
 * Generate tenant code from company name
 */
function generateTenantCode(companyName) {
  let code = companyName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '')
    .substring(0, 15);

  // Add random suffix
  const suffix = crypto.randomBytes(2).toString('hex');
  return `${code}${suffix}`;
}

/**
 * POST /api/signup/start
 * Begin signup process - collect initial info and create session
 */
router.post('/start', signupLimiter, async (req, res) => {
  try {
    const { email, tenant_name, num_technicians, num_clients } = req.body;

    // Validate required fields
    if (!email || !tenant_name) {
      return res.status(400).json({
        success: false,
        message: 'Email and company name are required'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format'
      });
    }

    const connection = await getMasterConnection();

    try {
      // Check if email already exists in any tenant
      const [existingEmail] = await connection.query(`
        SELECT t.id, t.company_name
        FROM tenants t
        JOIN tenant_admins ta ON t.id = ta.tenant_id
        WHERE ta.email = ?
      `, [email]);

      if (existingEmail.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'An account with this email already exists',
          existing_company: existingEmail[0].company_name
        });
      }

      // Check if company name is too similar to existing
      const [existingCompany] = await connection.query(
        'SELECT id FROM tenants WHERE company_name = ?',
        [tenant_name]
      );

      if (existingCompany.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'A company with this name already exists. Please use a different name.'
        });
      }

      // Generate session token and tenant code
      const sessionToken = generateSessionToken();
      const tenantCode = generateTenantCode(tenant_name);
      const expiresAt = new Date(Date.now() + SESSION_EXPIRY_MS);

      // Create signup session
      await connection.query(`
        INSERT INTO signup_sessions (
          session_token, email, tenant_name, tenant_code,
          num_technicians, num_clients, step, expires_at,
          ip_address, user_agent, referrer
        ) VALUES (?, ?, ?, ?, ?, ?, 'quiz', ?, ?, ?, ?)
      `, [
        sessionToken,
        email,
        tenant_name,
        tenantCode,
        num_technicians || 1,
        num_clients || 0,
        expiresAt,
        req.ip,
        req.get('user-agent'),
        req.get('referrer')
      ]);

      // Recommend a plan based on inputs
      const recommended = recommendPlan(num_technicians || 1, num_clients || 0);

      // Get all active plans for selection
      const [plans] = await connection.query(`
        SELECT slug, display_name, tagline, price_monthly, price_yearly,
               features, feature_limits, is_featured, badge_text
        FROM subscription_plans
        WHERE is_active = TRUE
        ORDER BY display_order
      `);

      // Parse JSON fields
      const formattedPlans = plans.map(p => ({
        ...p,
        features: typeof p.features === 'string' ? JSON.parse(p.features) : p.features,
        feature_limits: typeof p.feature_limits === 'string' ? JSON.parse(p.feature_limits) : p.feature_limits,
        price_monthly: parseFloat(p.price_monthly),
        price_yearly: parseFloat(p.price_yearly)
      }));

      console.log(`[Signup] Session created for ${email} (${tenant_name})`);

      res.json({
        success: true,
        session_token: sessionToken,
        tenant_code: tenantCode,
        recommended_plan: recommended,
        plans: formattedPlans,
        expires_at: expiresAt.toISOString()
      });

    } finally {
      connection.release();
    }

  } catch (error) {
    console.error('[Signup] Error starting signup:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to start signup process'
    });
  }
});

/**
 * POST /api/signup/create-trial
 * Complete signup - create tenant and start trial
 */
router.post('/create-trial', signupLimiter, async (req, res) => {
  try {
    const { session_token, plan_slug, admin_password } = req.body;

    // Validate required fields
    if (!session_token || !admin_password) {
      return res.status(400).json({
        success: false,
        message: 'Session token and password are required'
      });
    }

    // Validate password strength
    if (admin_password.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters'
      });
    }

    const connection = await getMasterConnection();

    try {
      // Get signup session
      const [sessions] = await connection.query(`
        SELECT * FROM signup_sessions
        WHERE session_token = ? AND step != 'completed' AND expires_at > NOW()
      `, [session_token]);

      if (sessions.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Invalid or expired session. Please start over.'
        });
      }

      const session = sessions[0];

      // Update session step
      await connection.query(
        "UPDATE signup_sessions SET step = 'password', selected_plan_slug = ? WHERE id = ?",
        [plan_slug || 'professional', session.id]
      );

      // Provision the tenant
      const result = await provisionTenant({
        email: session.email,
        tenantName: session.tenant_name,
        adminPassword: admin_password,
        planSlug: plan_slug || 'professional',
        numTechnicians: session.num_technicians,
        numClients: session.num_clients,
        signupSessionId: session.id,
        createStripeCustomer: true
      });

      // Mark session as completed
      await connection.query(
        "UPDATE signup_sessions SET step = 'completed', completed_at = NOW() WHERE id = ?",
        [session.id]
      );

      console.log(`[Signup] Trial created for ${session.email} (tenant: ${result.tenantCode})`);

      res.json({
        success: true,
        tenant_code: result.tenantCode,
        auth_token: result.authToken,
        redirect_url: result.redirectUrl,
        trial_ends_at: result.trialEndsAt,
        subscription_id: result.subscriptionId
      });

    } finally {
      connection.release();
    }

  } catch (error) {
    console.error('[Signup] Error creating trial:', error);

    // Provide user-friendly error messages
    let message = 'Failed to create trial. Please try again.';
    if (error.message.includes('already exists')) {
      message = error.message;
    }

    res.status(500).json({
      success: false,
      message,
      error_detail: error.message // Include actual error for debugging
    });
  }
});

/**
 * GET /api/signup/session/:token
 * Get status of a signup session
 */
router.get('/session/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const connection = await getMasterConnection();

    try {
      const [sessions] = await connection.query(`
        SELECT session_token, email, tenant_name, tenant_code,
               num_technicians, num_clients, selected_plan_slug,
               step, expires_at, completed_at
        FROM signup_sessions
        WHERE session_token = ?
      `, [token]);

      if (sessions.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Session not found'
        });
      }

      const session = sessions[0];
      const now = new Date();
      const expired = new Date(session.expires_at) < now;

      res.json({
        success: true,
        session: {
          ...session,
          is_expired: expired,
          is_completed: session.step === 'completed'
        }
      });

    } finally {
      connection.release();
    }

  } catch (error) {
    console.error('[Signup] Error getting session:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get session status'
    });
  }
});

/**
 * POST /api/signup/validate-email
 * Check if email is available for signup
 */
router.post('/validate-email', signupLimiter, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    const connection = await getMasterConnection();

    try {
      // Check tenant admins
      const [existing] = await connection.query(`
        SELECT t.company_name
        FROM tenants t
        JOIN tenant_admins ta ON t.id = ta.tenant_id
        WHERE ta.email = ?
      `, [email]);

      if (existing.length > 0) {
        return res.json({
          success: true,
          available: false,
          message: 'An account with this email already exists'
        });
      }

      res.json({
        success: true,
        available: true
      });

    } finally {
      connection.release();
    }

  } catch (error) {
    console.error('[Signup] Error validating email:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to validate email'
    });
  }
});

/**
 * GET /api/signup/plans
 * Get available plans for signup (public)
 */
router.get('/plans', async (req, res) => {
  try {
    const connection = await getMasterConnection();

    try {
      const [plans] = await connection.query(`
        SELECT slug, display_name, tagline, description,
               price_monthly, price_yearly, features, feature_limits,
               is_featured, badge_text
        FROM subscription_plans
        WHERE is_active = TRUE
        ORDER BY display_order
      `);

      const formattedPlans = plans.map(p => ({
        ...p,
        features: typeof p.features === 'string' ? JSON.parse(p.features) : p.features,
        feature_limits: typeof p.feature_limits === 'string' ? JSON.parse(p.feature_limits) : p.feature_limits,
        price_monthly: parseFloat(p.price_monthly),
        price_yearly: parseFloat(p.price_yearly)
      }));

      res.json({
        success: true,
        plans: formattedPlans
      });

    } finally {
      connection.release();
    }

  } catch (error) {
    console.error('[Signup] Error getting plans:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get plans'
    });
  }
});

module.exports = router;
