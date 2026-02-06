/**
 * Billing API Routes
 * Authenticated endpoints for subscription and payment management
 *
 * Endpoints:
 * - GET /api/billing/subscription - Get current subscription
 * - GET /api/billing/invoices - Get invoice history
 * - GET /api/billing/payment-methods - List saved cards
 * - POST /api/billing/payment-methods - Add new card
 * - DELETE /api/billing/payment-methods/:id - Remove card
 * - POST /api/billing/checkout - Create Stripe checkout session
 * - POST /api/billing/upgrade - Upgrade subscription
 * - POST /api/billing/cancel - Cancel subscription
 * - POST /api/billing/webhook - Stripe webhook handler
 */

const express = require('express');
const router = express.Router();
const { getMasterConnection } = require('../config/database');
const stripeService = require('../services/stripe-service');
const { syncPlanFeatures } = require('../services/tenant-provisioning');

// Middleware to verify tenant auth
const requireTenantAuth = (req, res, next) => {
  // Check for auth token in header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');

    // Only allow admin users to manage billing
    if (decoded.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    req.user = decoded;
    req.tenantCode = decoded.tenantCode;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

/**
 * GET /api/billing/subscription
 * Get current subscription details
 */
router.get('/subscription', requireTenantAuth, async (req, res) => {
  try {
    const connection = await getMasterConnection();

    try {
      // Get tenant and subscription
      const [results] = await connection.query(`
        SELECT
          t.id as tenant_id,
          t.company_name,
          t.stripe_customer_id,
          ts.id as subscription_id,
          ts.plan_id,
          ts.status,
          ts.billing_cycle,
          ts.trial_start,
          ts.trial_end,
          ts.current_period_start,
          ts.current_period_end,
          ts.next_billing_date,
          ts.user_count,
          ts.stripe_subscription_id,
          ts.auto_renew,
          sp.slug as plan_slug,
          sp.display_name as plan_name,
          sp.price_monthly,
          sp.price_yearly,
          sp.features,
          sp.feature_limits
        FROM tenants t
        LEFT JOIN tenant_subscriptions ts ON t.id = ts.tenant_id
        LEFT JOIN subscription_plans sp ON ts.plan_id = sp.id
        WHERE t.tenant_code = ?
      `, [req.tenantCode]);

      if (results.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Tenant not found'
        });
      }

      const data = results[0];

      // Calculate trial status (using Stripe-native 'trialing' status)
      const now = new Date();
      const trialEnd = data.trial_end ? new Date(data.trial_end) : null;
      const isInTrial = data.status === 'trialing' && trialEnd && trialEnd > now;
      const trialDaysRemaining = isInTrial
        ? Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24))
        : 0;

      // Parse JSON fields
      const features = typeof data.features === 'string' ? JSON.parse(data.features) : data.features;
      const featureLimits = typeof data.feature_limits === 'string' ? JSON.parse(data.feature_limits) : data.feature_limits;

      res.json({
        success: true,
        subscription: {
          id: data.subscription_id,
          tenant_id: data.tenant_id,
          company_name: data.company_name,
          status: data.status,
          billing_cycle: data.billing_cycle,
          trial_end: data.trial_end,
          trial_days_remaining: trialDaysRemaining,
          is_in_trial: isInTrial,
          current_period_start: data.current_period_start,
          current_period_end: data.current_period_end,
          next_billing_date: data.next_billing_date,
          user_count: data.user_count,
          auto_renew: data.auto_renew,
          stripe_subscription_id: data.stripe_subscription_id,
          stripe_customer_id: data.stripe_customer_id,
          plan: {
            slug: data.plan_slug,
            name: data.plan_name,
            price_monthly: parseFloat(data.price_monthly || 0),
            price_yearly: parseFloat(data.price_yearly || 0),
            features,
            feature_limits: featureLimits
          }
        }
      });

    } finally {
      connection.release();
    }

  } catch (error) {
    console.error('[Billing] Error getting subscription:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get subscription'
    });
  }
});

/**
 * GET /api/billing/plans
 * Get available plans for upgrade
 */
router.get('/plans', requireTenantAuth, async (req, res) => {
  try {
    const connection = await getMasterConnection();

    try {
      const [plans] = await connection.query(`
        SELECT id, slug, display_name, tagline, description,
               price_monthly, price_yearly, features, feature_limits,
               is_featured, badge_text, stripe_price_monthly, stripe_price_yearly
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
    console.error('[Billing] Error getting plans:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get plans'
    });
  }
});

/**
 * POST /api/billing/checkout
 * Create Stripe checkout session for upgrade
 */
router.post('/checkout', requireTenantAuth, async (req, res) => {
  try {
    const { plan_slug, billing_cycle = 'monthly' } = req.body;

    if (!plan_slug) {
      return res.status(400).json({
        success: false,
        message: 'Plan selection is required'
      });
    }

    const connection = await getMasterConnection();

    try {
      // Get tenant info
      const [tenants] = await connection.query(
        'SELECT id, stripe_customer_id, company_name FROM tenants WHERE tenant_code = ?',
        [req.tenantCode]
      );

      if (tenants.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Tenant not found'
        });
      }

      const tenant = tenants[0];

      // Get plan info
      const priceColumn = billing_cycle === 'yearly' ? 'stripe_price_yearly' : 'stripe_price_monthly';
      const [plans] = await connection.query(`
        SELECT id, slug, display_name, price_monthly, price_yearly, ${priceColumn} as stripe_price_id
        FROM subscription_plans
        WHERE slug = ? AND is_active = TRUE
      `, [plan_slug]);

      if (plans.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Plan not found'
        });
      }

      const plan = plans[0];

      // Check if Stripe is configured
      if (!stripeService.isConfigured()) {
        // Return mock checkout for testing
        return res.json({
          success: true,
          mode: 'test',
          message: 'Stripe not configured - simulating checkout',
          checkout_url: `/billing/checkout-success?plan=${plan_slug}&cycle=${billing_cycle}&tenant=${req.tenantCode}`,
          plan: {
            slug: plan.slug,
            name: plan.display_name,
            price: billing_cycle === 'yearly' ? plan.price_yearly : plan.price_monthly,
            billing_cycle
          }
        });
      }

      // Create or get Stripe customer
      let customerId = tenant.stripe_customer_id;
      if (!customerId) {
        const customer = await stripeService.createCustomer(
          req.user.email,
          tenant.company_name,
          { tenant_code: req.tenantCode }
        );
        customerId = customer.id;

        // Save customer ID
        await connection.query(
          'UPDATE tenants SET stripe_customer_id = ? WHERE id = ?',
          [customerId, tenant.id]
        );
      }

      // Check if Stripe price exists
      if (!plan.stripe_price_id) {
        return res.status(400).json({
          success: false,
          message: 'Stripe pricing not configured for this plan'
        });
      }

      // Create checkout session
      const baseUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
      const session = await stripeService.createCheckoutSession({
        customerId,
        priceId: plan.stripe_price_id,
        successUrl: `${baseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${baseUrl}/billing/cancel`,
        metadata: {
          tenant_id: tenant.id,
          tenant_code: req.tenantCode,
          plan_slug: plan.slug,
          billing_cycle
        }
      });

      res.json({
        success: true,
        checkout_url: session.url,
        session_id: session.id
      });

    } finally {
      connection.release();
    }

  } catch (error) {
    console.error('[Billing] Error creating checkout:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create checkout session'
    });
  }
});

/**
 * POST /api/billing/upgrade
 * Direct upgrade with existing payment method
 */
router.post('/upgrade', requireTenantAuth, async (req, res) => {
  try {
    const { plan_slug, billing_cycle = 'monthly' } = req.body;

    if (!plan_slug) {
      return res.status(400).json({
        success: false,
        message: 'Plan selection is required'
      });
    }

    const connection = await getMasterConnection();

    try {
      // Get tenant and subscription
      const [results] = await connection.query(`
        SELECT t.id as tenant_id, t.stripe_customer_id,
               ts.id as subscription_id, ts.plan_id, ts.status,
               ts.stripe_subscription_id
        FROM tenants t
        LEFT JOIN tenant_subscriptions ts ON t.id = ts.tenant_id
        WHERE t.tenant_code = ?
      `, [req.tenantCode]);

      if (results.length === 0) {
        return res.status(404).json({ success: false, message: 'Tenant not found' });
      }

      const data = results[0];

      // Get new plan
      const [plans] = await connection.query(
        'SELECT id, slug, display_name, features FROM subscription_plans WHERE slug = ?',
        [plan_slug]
      );

      if (plans.length === 0) {
        return res.status(404).json({ success: false, message: 'Plan not found' });
      }

      const newPlan = plans[0];

      // Update subscription
      const periodEnd = new Date();
      if (billing_cycle === 'yearly') {
        periodEnd.setFullYear(periodEnd.getFullYear() + 1);
      } else {
        periodEnd.setMonth(periodEnd.getMonth() + 1);
      }

      await connection.query(`
        UPDATE tenant_subscriptions
        SET plan_id = ?, status = 'active', billing_cycle = ?,
            current_period_start = NOW(), current_period_end = ?,
            next_billing_date = ?, trial_end = NULL
        WHERE id = ?
      `, [newPlan.id, billing_cycle, periodEnd, periodEnd, data.subscription_id]);

      // Log history
      await connection.query(`
        INSERT INTO subscription_history (
          subscription_id, tenant_id, action, from_plan_id, to_plan_id,
          from_status, to_status, notes, performed_by
        ) VALUES (?, ?, 'upgraded', ?, ?, ?, 'active', ?, ?)
      `, [
        data.subscription_id,
        data.tenant_id,
        data.plan_id,
        newPlan.id,
        data.status,
        `Upgraded to ${newPlan.display_name} (${billing_cycle})`,
        req.user.userId
      ]);

      // Sync features
      await syncPlanFeatures(req.tenantCode, plan_slug);

      // Record transaction (mock for now)
      const price = billing_cycle === 'yearly'
        ? parseFloat(newPlan.price_yearly || 0)
        : parseFloat(newPlan.price_monthly || 0);

      await connection.query(`
        INSERT INTO billing_transactions (
          tenant_id, subscription_id, type, amount, currency_code,
          description, status, transaction_date
        ) VALUES (?, ?, 'charge', ?, 'USD', ?, 'succeeded', NOW())
      `, [
        data.tenant_id,
        data.subscription_id,
        price,
        `Upgrade to ${newPlan.display_name} (${billing_cycle})`
      ]);

      console.log(`[Billing] Upgraded ${req.tenantCode} to ${plan_slug}`);

      res.json({
        success: true,
        message: 'Subscription upgraded successfully',
        subscription: {
          plan_slug: newPlan.slug,
          plan_name: newPlan.display_name,
          status: 'active',
          billing_cycle,
          period_end: periodEnd.toISOString()
        }
      });

    } finally {
      connection.release();
    }

  } catch (error) {
    console.error('[Billing] Error upgrading:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upgrade subscription'
    });
  }
});

/**
 * POST /api/billing/cancel
 * Cancel subscription at period end
 */
router.post('/cancel', requireTenantAuth, async (req, res) => {
  try {
    const { reason } = req.body;

    const connection = await getMasterConnection();

    try {
      // Get subscription
      const [results] = await connection.query(`
        SELECT t.id as tenant_id, ts.id as subscription_id,
               ts.status, ts.stripe_subscription_id, ts.current_period_end
        FROM tenants t
        JOIN tenant_subscriptions ts ON t.id = ts.tenant_id
        WHERE t.tenant_code = ?
      `, [req.tenantCode]);

      if (results.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Subscription not found'
        });
      }

      const data = results[0];

      // Update subscription status (using Stripe-native 'canceled' spelling)
      await connection.query(`
        UPDATE tenant_subscriptions
        SET status = 'canceled', auto_renew = FALSE, cancelled_at = NOW()
        WHERE id = ?
      `, [data.subscription_id]);

      // Log history
      await connection.query(`
        INSERT INTO subscription_history (
          subscription_id, tenant_id, action, from_status, to_status, notes, performed_by
        ) VALUES (?, ?, 'cancelled', ?, 'canceled', ?, ?)
      `, [
        data.subscription_id,
        data.tenant_id,
        data.status,
        reason || 'User requested cancellation',
        req.user.userId
      ]);

      // Cancel in Stripe if applicable
      if (data.stripe_subscription_id && stripeService.isConfigured()) {
        try {
          await stripeService.cancelSubscription(data.stripe_subscription_id, true);
        } catch (stripeError) {
          console.warn('[Billing] Stripe cancellation failed:', stripeError.message);
        }
      }

      console.log(`[Billing] Cancelled subscription for ${req.tenantCode}`);

      res.json({
        success: true,
        message: 'Subscription cancelled. You will have access until the end of your billing period.',
        access_until: data.current_period_end
      });

    } finally {
      connection.release();
    }

  } catch (error) {
    console.error('[Billing] Error cancelling:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel subscription'
    });
  }
});

/**
 * GET /api/billing/invoices
 * Get invoice/transaction history
 */
router.get('/invoices', requireTenantAuth, async (req, res) => {
  try {
    const connection = await getMasterConnection();

    try {
      // Get tenant ID
      const [tenants] = await connection.query(
        'SELECT id FROM tenants WHERE tenant_code = ?',
        [req.tenantCode]
      );

      if (tenants.length === 0) {
        return res.status(404).json({ success: false, message: 'Tenant not found' });
      }

      const tenantId = tenants[0].id;

      // Get transactions
      const [transactions] = await connection.query(`
        SELECT id, type, amount, currency_code, description,
               status, transaction_date, stripe_invoice_id
        FROM billing_transactions
        WHERE tenant_id = ?
        ORDER BY transaction_date DESC
        LIMIT 50
      `, [tenantId]);

      res.json({
        success: true,
        invoices: transactions
      });

    } finally {
      connection.release();
    }

  } catch (error) {
    console.error('[Billing] Error getting invoices:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get invoices'
    });
  }
});

/**
 * GET /api/billing/payment-methods
 * List saved payment methods
 */
router.get('/payment-methods', requireTenantAuth, async (req, res) => {
  try {
    const connection = await getMasterConnection();

    try {
      const [tenants] = await connection.query(
        'SELECT id, stripe_customer_id FROM tenants WHERE tenant_code = ?',
        [req.tenantCode]
      );

      if (tenants.length === 0) {
        return res.status(404).json({ success: false, message: 'Tenant not found' });
      }

      const tenantId = tenants[0].id;

      // Get from database
      const [methods] = await connection.query(`
        SELECT id, card_brand, card_last_four, card_exp_month, card_exp_year, is_default
        FROM payment_methods
        WHERE tenant_id = ? AND is_active = TRUE
        ORDER BY is_default DESC, created_at DESC
      `, [tenantId]);

      res.json({
        success: true,
        payment_methods: methods
      });

    } finally {
      connection.release();
    }

  } catch (error) {
    console.error('[Billing] Error getting payment methods:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get payment methods'
    });
  }
});

/**
 * POST /api/billing/payment-methods/setup
 * Create SetupIntent for adding new card
 */
router.post('/payment-methods/setup', requireTenantAuth, async (req, res) => {
  try {
    const connection = await getMasterConnection();

    try {
      const [tenants] = await connection.query(
        'SELECT id, stripe_customer_id, company_name FROM tenants WHERE tenant_code = ?',
        [req.tenantCode]
      );

      if (tenants.length === 0) {
        return res.status(404).json({ success: false, message: 'Tenant not found' });
      }

      const tenant = tenants[0];

      if (!stripeService.isConfigured()) {
        return res.json({
          success: true,
          mode: 'test',
          message: 'Stripe not configured - mock setup intent',
          client_secret: 'seti_mock_' + Date.now()
        });
      }

      // Create or get customer
      let customerId = tenant.stripe_customer_id;
      if (!customerId) {
        const customer = await stripeService.createCustomer(
          req.user.email,
          tenant.company_name,
          { tenant_code: req.tenantCode }
        );
        customerId = customer.id;

        await connection.query(
          'UPDATE tenants SET stripe_customer_id = ? WHERE id = ?',
          [customerId, tenant.id]
        );
      }

      const setupIntent = await stripeService.createSetupIntent(customerId);

      res.json({
        success: true,
        client_secret: setupIntent.client_secret,
        publishable_key: stripeService.getPublishableKey()
      });

    } finally {
      connection.release();
    }

  } catch (error) {
    console.error('[Billing] Error creating setup intent:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create setup intent'
    });
  }
});

/**
 * POST /api/billing/webhook
 * Stripe webhook handler with idempotency
 */
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];

  if (!stripeService.isConfigured()) {
    return res.status(200).json({ received: true, mode: 'test' });
  }

  let event;
  try {
    // Use rawBody saved by express.json verify option
    event = stripeService.constructWebhookEvent(req.rawBody || req.body, sig);
  } catch (err) {
    console.error('[Webhook] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const connection = await getMasterConnection();

  try {
    // Idempotency check - skip if already processed
    const [existing] = await connection.query(
      'SELECT id FROM stripe_webhook_events WHERE event_id = ?',
      [event.id]
    );

    if (existing.length > 0) {
      console.log(`[Webhook] Already processed event ${event.id}, skipping`);
      return res.json({ received: true, duplicate: true });
    }

    // Record event for idempotency
    await connection.query(`
      INSERT INTO stripe_webhook_events (event_id, event_type, payload)
      VALUES (?, ?, ?)
    `, [event.id, event.type, JSON.stringify(event.data.object)]);

    console.log(`[Webhook] Processing ${event.type}: ${event.id}`);

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        console.log('[Webhook] Checkout completed:', session.id);

        if (session.metadata?.tenant_id) {
          // Get subscription details from Stripe to determine status
          let status = 'active';
          if (session.subscription) {
            try {
              const sub = await stripeService.getSubscription(session.subscription);
              status = sub.status; // trialing, active, etc.
            } catch (e) {
              console.warn('[Webhook] Could not fetch subscription:', e.message);
            }
          }

          await connection.query(`
            UPDATE tenant_subscriptions ts
            JOIN tenants t ON ts.tenant_id = t.id
            SET ts.status = ?, ts.stripe_subscription_id = ?
            WHERE t.id = ?
          `, [status, session.subscription, session.metadata.tenant_id]);

          // Sync features
          if (session.metadata.plan_slug) {
            const [tenants] = await connection.query(
              'SELECT tenant_code FROM tenants WHERE id = ?',
              [session.metadata.tenant_id]
            );
            if (tenants.length > 0) {
              await syncPlanFeatures(tenants[0].tenant_code, session.metadata.plan_slug);
            }
          }

          // Log history
          await connection.query(`
            INSERT INTO subscription_history (
              tenant_id, action, to_status, notes
            ) SELECT ?, 'created', ?, 'Subscription created via Stripe Checkout'
            FROM tenants WHERE id = ?
          `, [session.metadata.tenant_id, status, session.metadata.tenant_id]);
        }
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        console.log(`[Webhook] Subscription ${event.type.split('.')[2]}:`, subscription.id);

        // Map Stripe status directly (they match our ENUM)
        const status = subscription.status; // trialing, active, past_due, unpaid, canceled, incomplete

        // Find tenant by customer ID or subscription ID
        const [tenants] = await connection.query(`
          SELECT t.id as tenant_id, ts.id as subscription_id, ts.status as old_status
          FROM tenants t
          LEFT JOIN tenant_subscriptions ts ON t.id = ts.tenant_id
          WHERE t.stripe_customer_id = ? OR ts.stripe_subscription_id = ?
        `, [subscription.customer, subscription.id]);

        if (tenants.length > 0) {
          const tenant = tenants[0];

          // Update subscription
          await connection.query(`
            UPDATE tenant_subscriptions
            SET status = ?,
                stripe_subscription_id = ?,
                current_period_start = FROM_UNIXTIME(?),
                current_period_end = FROM_UNIXTIME(?),
                next_billing_date = FROM_UNIXTIME(?)
            WHERE tenant_id = ?
          `, [
            status,
            subscription.id,
            subscription.current_period_start,
            subscription.current_period_end,
            subscription.current_period_end,
            tenant.tenant_id
          ]);

          // Log status change if different
          if (tenant.old_status && tenant.old_status !== status) {
            await connection.query(`
              INSERT INTO subscription_history (
                subscription_id, tenant_id, action, from_status, to_status, notes
              ) VALUES (?, ?, 'updated', ?, ?, ?)
            `, [
              tenant.subscription_id,
              tenant.tenant_id,
              tenant.old_status,
              status,
              `Status changed via Stripe webhook`
            ]);
          }
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        console.log('[Webhook] Subscription deleted:', subscription.id);

        await connection.query(`
          UPDATE tenant_subscriptions
          SET status = 'canceled', cancelled_at = NOW()
          WHERE stripe_subscription_id = ?
        `, [subscription.id]);

        // Log history
        const [subs] = await connection.query(
          'SELECT id, tenant_id FROM tenant_subscriptions WHERE stripe_subscription_id = ?',
          [subscription.id]
        );
        if (subs.length > 0) {
          await connection.query(`
            INSERT INTO subscription_history (
              subscription_id, tenant_id, action, to_status, notes
            ) VALUES (?, ?, 'cancelled', 'canceled', 'Subscription ended via Stripe')
          `, [subs[0].id, subs[0].tenant_id]);
        }
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object;
        console.log('[Webhook] Invoice paid:', invoice.id);

        if (invoice.customer) {
          const [tenants] = await connection.query(
            'SELECT id FROM tenants WHERE stripe_customer_id = ?',
            [invoice.customer]
          );

          if (tenants.length > 0) {
            // If was past_due, restore to active
            await connection.query(`
              UPDATE tenant_subscriptions
              SET status = 'active'
              WHERE tenant_id = ? AND status = 'past_due'
            `, [tenants[0].id]);

            // Record transaction
            await connection.query(`
              INSERT INTO billing_transactions (
                tenant_id, type, amount, currency_code, description,
                status, stripe_invoice_id, stripe_charge_id, transaction_date
              ) VALUES (?, 'charge', ?, ?, ?, 'succeeded', ?, ?, NOW())
            `, [
              tenants[0].id,
              invoice.amount_paid / 100,
              invoice.currency.toUpperCase(),
              `Invoice ${invoice.number || invoice.id}`,
              invoice.id,
              invoice.charge
            ]);
          }
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        console.log('[Webhook] Invoice payment failed:', invoice.id);

        if (invoice.customer) {
          const [tenants] = await connection.query(
            'SELECT id FROM tenants WHERE stripe_customer_id = ?',
            [invoice.customer]
          );

          if (tenants.length > 0) {
            // Update subscription status to past_due
            await connection.query(`
              UPDATE tenant_subscriptions
              SET status = 'past_due'
              WHERE tenant_id = ? AND status IN ('active', 'trialing')
            `, [tenants[0].id]);

            // Record failed transaction
            await connection.query(`
              INSERT INTO billing_transactions (
                tenant_id, type, amount, currency_code, description,
                status, stripe_invoice_id, failure_message, transaction_date
              ) VALUES (?, 'charge', ?, ?, ?, 'failed', ?, ?, NOW())
            `, [
              tenants[0].id,
              invoice.amount_due / 100,
              invoice.currency.toUpperCase(),
              `Invoice ${invoice.number || invoice.id} - Payment Failed`,
              invoice.id,
              invoice.last_finalization_error?.message || 'Payment failed'
            ]);
          }
        }
        break;
      }

      default:
        console.log(`[Webhook] Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });

  } catch (error) {
    console.error('[Webhook] Error handling event:', error);
    res.status(500).json({ error: 'Webhook handler failed' });
  } finally {
    connection.release();
  }
});

module.exports = router;
