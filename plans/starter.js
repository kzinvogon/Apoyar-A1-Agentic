/**
 * Starter Plan Feature Keys
 *
 * Basic tier for internal IT or small teams.
 * Includes: ticketing, core CMDB, SLA definitions, email ingest, reporting
 */

module.exports = [
  // Core capabilities - always available
  'core.ticketing',
  'core.cmdb',
  'core.reporting',

  // Email - basic functionality
  'integrations.email.ingest',
  'integrations.email.notifications',

  // Monitoring - basic alerts only
  'integrations.monitoring.basic',

  // Webhooks - inbound only
  'api.webhooks.inbound',

  // SLA - basic business hours support
  'sla.business_hours',
  'sla.definitions'
];
