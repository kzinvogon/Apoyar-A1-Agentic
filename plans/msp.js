/**
 * MSP Plan Feature Keys
 *
 * For managed service providers.
 * Includes everything in Professional plus: customer channels, billing integrations,
 * full API access, contract-aware SLA, multi-customer operations at scale.
 */

const PROFESSIONAL_FEATURES = require('./professional');

module.exports = [
  // All Professional features
  ...PROFESSIONAL_FEATURES,

  // Customer channels
  'integrations.whatsapp',
  'integrations.sms',

  // Billing integrations
  'integrations.billing.xero',
  'integrations.billing.quickbooks',

  // Monitoring - per-customer and CMDB-linked
  'integrations.monitoring.per_customer',
  'integrations.monitoring.cmdb_linked',

  // MSP operations
  'msp.contracts',
  'msp.multi_customer_routing',
  'msp.governance',
  'msp.audit_extended',

  // SLA - contract-aware
  'sla.contract_aware',
  'customer.sla_override',

  // Full API access
  'api.full_access',
  'api.automation'
];
