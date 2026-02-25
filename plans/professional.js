/**
 * Professional Plan Feature Keys
 *
 * For SLA-backed service delivery.
 * Includes everything in Starter plus: multi-company customers, customer portal,
 * SLA notifications, category SLA mapping, collaboration tools, identity providers.
 */

const STARTER_FEATURES = require('./starter');

module.exports = [
  // All Starter features
  ...STARTER_FEATURES,

  // Collaboration
  'integrations.teams',
  'integrations.slack',
  'integrations.sms',

  // Monitoring - advanced classification
  'integrations.monitoring.classification',
  'integrations.monitoring.sla_aware',

  // Identity & SSO
  'integrations.sso.azure_ad',
  'integrations.sso.google',

  // Escalation integrations
  'integrations.jira',
  'integrations.github',
  'integrations.gitlab',

  // Webhooks - outbound
  'api.webhooks.outbound',

  // Customer portal
  'customer.portal',
  'customer.multi_company',

  // SLA - two-phase tracking
  'sla.two_phase',
  'sla.notifications',
  'sla.category_mapping'
];
