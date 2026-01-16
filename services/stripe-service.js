/**
 * Stripe Service
 * Wrapper for Stripe API operations
 *
 * Handles:
 * - Customer management
 * - Subscription creation/management
 * - Payment method handling
 * - Checkout sessions
 * - Webhook verification
 */

const Stripe = require('stripe');

// Initialize Stripe with test/live key from environment
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder', {
  apiVersion: '2023-10-16'
});

// Get publishable key for frontend
const getPublishableKey = () => process.env.STRIPE_PUBLISHABLE_KEY || 'pk_test_placeholder';

/**
 * Customer Management
 */

/**
 * Create a new Stripe customer
 */
async function createCustomer(email, name, metadata = {}) {
  try {
    const customer = await stripe.customers.create({
      email,
      name,
      metadata: {
        ...metadata,
        created_by: 'serviflow'
      }
    });
    console.log(`[Stripe] Created customer: ${customer.id} for ${email}`);
    return customer;
  } catch (error) {
    console.error('[Stripe] Error creating customer:', error.message);
    throw error;
  }
}

/**
 * Get a Stripe customer by ID
 */
async function getCustomer(customerId) {
  try {
    return await stripe.customers.retrieve(customerId);
  } catch (error) {
    console.error('[Stripe] Error retrieving customer:', error.message);
    throw error;
  }
}

/**
 * Update a Stripe customer
 */
async function updateCustomer(customerId, data) {
  try {
    return await stripe.customers.update(customerId, data);
  } catch (error) {
    console.error('[Stripe] Error updating customer:', error.message);
    throw error;
  }
}

/**
 * Payment Methods
 */

/**
 * Attach a payment method to a customer
 */
async function attachPaymentMethod(paymentMethodId, customerId) {
  try {
    const paymentMethod = await stripe.paymentMethods.attach(paymentMethodId, {
      customer: customerId
    });
    console.log(`[Stripe] Attached payment method ${paymentMethodId} to customer ${customerId}`);
    return paymentMethod;
  } catch (error) {
    console.error('[Stripe] Error attaching payment method:', error.message);
    throw error;
  }
}

/**
 * Detach a payment method from a customer
 */
async function detachPaymentMethod(paymentMethodId) {
  try {
    const paymentMethod = await stripe.paymentMethods.detach(paymentMethodId);
    console.log(`[Stripe] Detached payment method ${paymentMethodId}`);
    return paymentMethod;
  } catch (error) {
    console.error('[Stripe] Error detaching payment method:', error.message);
    throw error;
  }
}

/**
 * Set the default payment method for a customer
 */
async function setDefaultPaymentMethod(customerId, paymentMethodId) {
  try {
    return await stripe.customers.update(customerId, {
      invoice_settings: {
        default_payment_method: paymentMethodId
      }
    });
  } catch (error) {
    console.error('[Stripe] Error setting default payment method:', error.message);
    throw error;
  }
}

/**
 * List payment methods for a customer
 */
async function listPaymentMethods(customerId, type = 'card') {
  try {
    const paymentMethods = await stripe.paymentMethods.list({
      customer: customerId,
      type
    });
    return paymentMethods.data;
  } catch (error) {
    console.error('[Stripe] Error listing payment methods:', error.message);
    throw error;
  }
}

/**
 * Create a SetupIntent for saving a card without immediate charge
 */
async function createSetupIntent(customerId) {
  try {
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card']
    });
    return setupIntent;
  } catch (error) {
    console.error('[Stripe] Error creating setup intent:', error.message);
    throw error;
  }
}

/**
 * Subscriptions
 */

/**
 * Create a subscription
 */
async function createSubscription(customerId, priceId, options = {}) {
  try {
    const subscriptionData = {
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      payment_settings: {
        save_default_payment_method: 'on_subscription'
      },
      expand: ['latest_invoice.payment_intent'],
      ...options
    };

    // Add trial if specified
    if (options.trialEnd) {
      subscriptionData.trial_end = options.trialEnd;
    } else if (options.trialDays) {
      subscriptionData.trial_period_days = options.trialDays;
    }

    const subscription = await stripe.subscriptions.create(subscriptionData);
    console.log(`[Stripe] Created subscription ${subscription.id} for customer ${customerId}`);
    return subscription;
  } catch (error) {
    console.error('[Stripe] Error creating subscription:', error.message);
    throw error;
  }
}

/**
 * Update a subscription
 */
async function updateSubscription(subscriptionId, data) {
  try {
    const subscription = await stripe.subscriptions.update(subscriptionId, data);
    console.log(`[Stripe] Updated subscription ${subscriptionId}`);
    return subscription;
  } catch (error) {
    console.error('[Stripe] Error updating subscription:', error.message);
    throw error;
  }
}

/**
 * Cancel a subscription
 */
async function cancelSubscription(subscriptionId, atPeriodEnd = true) {
  try {
    let subscription;
    if (atPeriodEnd) {
      // Cancel at the end of the billing period
      subscription = await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: true
      });
    } else {
      // Cancel immediately
      subscription = await stripe.subscriptions.cancel(subscriptionId);
    }
    console.log(`[Stripe] Cancelled subscription ${subscriptionId} (atPeriodEnd: ${atPeriodEnd})`);
    return subscription;
  } catch (error) {
    console.error('[Stripe] Error cancelling subscription:', error.message);
    throw error;
  }
}

/**
 * Get a subscription
 */
async function getSubscription(subscriptionId) {
  try {
    return await stripe.subscriptions.retrieve(subscriptionId);
  } catch (error) {
    console.error('[Stripe] Error retrieving subscription:', error.message);
    throw error;
  }
}

/**
 * Resume a cancelled subscription
 */
async function resumeSubscription(subscriptionId) {
  try {
    const subscription = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: false
    });
    console.log(`[Stripe] Resumed subscription ${subscriptionId}`);
    return subscription;
  } catch (error) {
    console.error('[Stripe] Error resuming subscription:', error.message);
    throw error;
  }
}

/**
 * Checkout Sessions
 */

/**
 * Create a Checkout Session for subscription signup/upgrade
 */
async function createCheckoutSession(options) {
  const {
    customerId,
    priceId,
    successUrl,
    cancelUrl,
    mode = 'subscription',
    metadata = {},
    trialDays,
    allowPromotionCodes = true
  } = options;

  try {
    const sessionData = {
      customer: customerId,
      mode,
      line_items: [{
        price: priceId,
        quantity: 1
      }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata,
      allow_promotion_codes: allowPromotionCodes
    };

    // Add trial if specified and mode is subscription
    if (mode === 'subscription' && trialDays) {
      sessionData.subscription_data = {
        trial_period_days: trialDays
      };
    }

    const session = await stripe.checkout.sessions.create(sessionData);
    console.log(`[Stripe] Created checkout session ${session.id}`);
    return session;
  } catch (error) {
    console.error('[Stripe] Error creating checkout session:', error.message);
    throw error;
  }
}

/**
 * Create a Customer Portal session for self-service management
 */
async function createPortalSession(customerId, returnUrl) {
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl
    });
    return session;
  } catch (error) {
    console.error('[Stripe] Error creating portal session:', error.message);
    throw error;
  }
}

/**
 * Invoices
 */

/**
 * List invoices for a customer
 */
async function listInvoices(customerId, options = {}) {
  try {
    const invoices = await stripe.invoices.list({
      customer: customerId,
      limit: options.limit || 10,
      ...options
    });
    return invoices.data;
  } catch (error) {
    console.error('[Stripe] Error listing invoices:', error.message);
    throw error;
  }
}

/**
 * Get an invoice
 */
async function getInvoice(invoiceId) {
  try {
    return await stripe.invoices.retrieve(invoiceId);
  } catch (error) {
    console.error('[Stripe] Error retrieving invoice:', error.message);
    throw error;
  }
}

/**
 * Products & Prices
 */

/**
 * Create a product in Stripe
 */
async function createProduct(name, description, metadata = {}) {
  try {
    const product = await stripe.products.create({
      name,
      description,
      metadata
    });
    console.log(`[Stripe] Created product ${product.id}: ${name}`);
    return product;
  } catch (error) {
    console.error('[Stripe] Error creating product:', error.message);
    throw error;
  }
}

/**
 * Create a price for a product
 */
async function createPrice(productId, unitAmount, currency, recurring = { interval: 'month' }) {
  try {
    const price = await stripe.prices.create({
      product: productId,
      unit_amount: unitAmount, // in cents
      currency,
      recurring
    });
    console.log(`[Stripe] Created price ${price.id} for product ${productId}`);
    return price;
  } catch (error) {
    console.error('[Stripe] Error creating price:', error.message);
    throw error;
  }
}

/**
 * Webhooks
 */

/**
 * Construct and verify a webhook event
 */
function constructWebhookEvent(payload, signature) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new Error('STRIPE_WEBHOOK_SECRET not configured');
  }

  try {
    return stripe.webhooks.constructEvent(payload, signature, webhookSecret);
  } catch (error) {
    console.error('[Stripe] Webhook signature verification failed:', error.message);
    throw error;
  }
}

/**
 * Check if Stripe is properly configured
 */
function isConfigured() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
  return !!(secretKey && publishableKey && !secretKey.includes('placeholder'));
}

/**
 * Get Stripe mode (test or live)
 */
function getMode() {
  const secretKey = process.env.STRIPE_SECRET_KEY || '';
  return secretKey.startsWith('sk_live_') ? 'live' : 'test';
}

module.exports = {
  // Customer
  createCustomer,
  getCustomer,
  updateCustomer,

  // Payment Methods
  attachPaymentMethod,
  detachPaymentMethod,
  setDefaultPaymentMethod,
  listPaymentMethods,
  createSetupIntent,

  // Subscriptions
  createSubscription,
  updateSubscription,
  cancelSubscription,
  getSubscription,
  resumeSubscription,

  // Checkout
  createCheckoutSession,
  createPortalSession,

  // Invoices
  listInvoices,
  getInvoice,

  // Products & Prices
  createProduct,
  createPrice,

  // Webhooks
  constructWebhookEvent,

  // Utility
  isConfigured,
  getMode,
  getPublishableKey,

  // Raw Stripe instance for advanced use
  stripe
};
