/**
 * Migration: Enhance Subscription Plans System
 * Creates subscription_plans and plan_features tables for unified plan management
 *
 * Run with: node migrations/enhance-subscription-plans.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

const config = {
  host: process.env.MYSQLHOST || process.env.DB_HOST,
  port: process.env.MYSQLPORT || process.env.DB_PORT || 3306,
  user: process.env.MYSQLUSER || process.env.DB_USER,
  password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD,
  database: process.env.MYSQLDATABASE || 'railway'
};

async function runMigration() {
  console.log('Starting subscription plans enhancement migration...');
  console.log(`Connecting to database: ${config.database}`);

  const connection = await mysql.createConnection(config);

  try {
    // Create subscription_plans table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS subscription_plans (
        id INT AUTO_INCREMENT PRIMARY KEY,
        slug VARCHAR(50) NOT NULL UNIQUE,
        name VARCHAR(100) NOT NULL,
        display_name VARCHAR(100) NOT NULL,
        tagline VARCHAR(255),
        description TEXT,
        price_monthly DECIMAL(10,2) DEFAULT 0,
        price_yearly DECIMAL(10,2) DEFAULT 0,
        price_per_user DECIMAL(10,2) DEFAULT 0,
        features JSON,
        feature_limits JSON,
        display_order INT DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        is_featured BOOLEAN DEFAULT FALSE,
        badge_text VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_slug (slug),
        INDEX idx_display_order (display_order),
        INDEX idx_is_active (is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅ Created subscription_plans table');

    // Create plan_features catalog table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS plan_features (
        id INT AUTO_INCREMENT PRIMARY KEY,
        feature_key VARCHAR(100) NOT NULL UNIQUE,
        name VARCHAR(100) NOT NULL,
        marketing_name VARCHAR(100),
        description TEXT,
        category VARCHAR(50),
        display_order INT DEFAULT 0,
        is_visible_marketing BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_feature_key (feature_key),
        INDEX idx_category (category),
        INDEX idx_display_order (display_order)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅ Created plan_features table');

    // Check if plans already exist
    const [existingPlans] = await connection.query('SELECT COUNT(*) as count FROM subscription_plans');

    if (existingPlans[0].count === 0) {
      // Seed initial plans based on current marketing pricing
      const starterFeatures = JSON.stringify([
        'core.ticketing',
        'core.cmdb',
        'core.reporting',
        'core.knowledge_base',
        'core.basic_rules',
        'integrations.email.ingest',
        'integrations.monitoring.basic',
        'sla.basic',
        'sla.business_hours'
      ]);

      const professionalFeatures = JSON.stringify([
        // All starter features
        'core.ticketing',
        'core.cmdb',
        'core.reporting',
        'core.knowledge_base',
        'core.basic_rules',
        'integrations.email.ingest',
        'integrations.monitoring.basic',
        'sla.basic',
        'sla.business_hours',
        // Professional additions
        'customer.portal',
        'customer.service_catalogue',
        'ai.triage',
        'ai.cmdb_matching',
        'integrations.teams',
        'integrations.slack',
        'integrations.jira',
        'integrations.sso',
        'sla.two_phase',
        'sla.notifications',
        'api.webhooks.inbound',
        'api.webhooks.outbound'
      ]);

      const mspFeatures = JSON.stringify([
        // All professional features
        'core.ticketing',
        'core.cmdb',
        'core.reporting',
        'core.knowledge_base',
        'core.basic_rules',
        'integrations.email.ingest',
        'integrations.monitoring.basic',
        'sla.basic',
        'sla.business_hours',
        'customer.portal',
        'customer.service_catalogue',
        'ai.triage',
        'ai.cmdb_matching',
        'integrations.teams',
        'integrations.slack',
        'integrations.jira',
        'integrations.sso',
        'sla.two_phase',
        'sla.notifications',
        'api.webhooks.inbound',
        'api.webhooks.outbound',
        // MSP/Pro additions
        'ai.expert_matching',
        'ai.trends',
        'ai.full_suite',
        'sla.contract_aware',
        'msp.contracts',
        'msp.governance',
        'msp.audit',
        'integrations.github',
        'integrations.gitlab',
        'integrations.billing.xero',
        'integrations.billing.quickbooks',
        'integrations.whatsapp',
        'integrations.sms',
        'api.full_access',
        'customer.multi_company'
      ]);

      await connection.query(`
        INSERT INTO subscription_plans
        (slug, name, display_name, tagline, description, price_monthly, price_yearly, price_per_user, features, feature_limits, display_order, is_active, is_featured, badge_text)
        VALUES
        ('starter', 'Starter', 'Starter', 'For internal IT or small teams',
         'Perfect for internal IT departments or small teams getting started with professional service management.',
         29.00, 290.00, 29.00, ?,
         '{"max_users": 5, "max_tickets": 500, "max_storage_gb": 5}',
         1, TRUE, FALSE, NULL),

        ('professional', 'Professional', 'Growth', 'Growing teams with integrations',
         'Ideal for growing teams that need customer portals, AI-powered features, and seamless integrations.',
         49.00, 490.00, 49.00, ?,
         '{"max_users": 25, "max_tickets": 2500, "max_storage_gb": 25}',
         2, TRUE, FALSE, NULL),

        ('msp', 'MSP', 'Pro', 'Multi-customer operations at scale',
         'Full-featured solution for MSPs and enterprises managing multiple customers with contract-aware SLAs.',
         79.00, 790.00, 79.00, ?,
         '{"max_users": -1, "max_tickets": -1, "max_storage_gb": 100}',
         3, TRUE, TRUE, 'BEST FOR MSPs')
      `, [starterFeatures, professionalFeatures, mspFeatures]);
      console.log('✅ Seeded initial plans (Starter, Professional, MSP)');
    } else {
      console.log('ℹ️  Plans already exist, skipping seed');
    }

    // Check if features already exist
    const [existingFeatures] = await connection.query('SELECT COUNT(*) as count FROM plan_features');

    if (existingFeatures[0].count === 0) {
      // Seed feature catalog
      await connection.query(`
        INSERT INTO plan_features (feature_key, name, marketing_name, description, category, display_order, is_visible_marketing)
        VALUES
        -- Core features
        ('core.ticketing', 'Ticketing System', 'Ticketing & CMDB', 'Full ticketing system with workflow management', 'core', 1, TRUE),
        ('core.cmdb', 'CMDB', 'Configuration Management', 'Configuration management database', 'core', 2, TRUE),
        ('core.reporting', 'Reporting', 'Basic Reporting', 'Standard reports and dashboards', 'core', 3, TRUE),
        ('core.knowledge_base', 'Knowledge Base', 'Knowledge Base', 'Documentation and article management', 'core', 4, TRUE),
        ('core.basic_rules', 'Basic Rules', 'Basic Routing Rules', 'Ticket routing and assignment rules', 'core', 5, TRUE),

        -- Customer features
        ('customer.portal', 'Customer Portal', 'Customer Portal', 'Self-service portal for customers', 'customer', 10, TRUE),
        ('customer.service_catalogue', 'Service Catalogue', 'Service Catalogue', 'Requestable services catalog', 'customer', 11, TRUE),
        ('customer.multi_company', 'Multi-Company', 'Multi-Customer Support', 'Manage multiple customer organizations', 'customer', 12, TRUE),

        -- AI features
        ('ai.triage', 'AI Triage', 'AI Triage & Categorization', 'Automatic ticket categorization and routing', 'ai', 20, TRUE),
        ('ai.cmdb_matching', 'AI CMDB Matching', 'AI CMDB Matching', 'Intelligent asset matching', 'ai', 21, TRUE),
        ('ai.expert_matching', 'AI Expert Matching', 'AI Expert Matching', 'Smart assignment to best expert', 'ai', 22, TRUE),
        ('ai.trends', 'AI Trends', 'AI Trends & Analytics', 'Predictive analytics and insights', 'ai', 23, TRUE),
        ('ai.full_suite', 'Full AI Suite', 'Full AI Suite', 'Complete AI capabilities', 'ai', 24, FALSE),

        -- Integration features
        ('integrations.email.ingest', 'Email Ingest', 'Email Ingest', 'Create tickets from email', 'integrations', 30, TRUE),
        ('integrations.teams', 'Microsoft Teams', 'Teams Integration', 'Manage tickets from Teams', 'integrations', 31, TRUE),
        ('integrations.slack', 'Slack', 'Slack Integration', 'Manage tickets from Slack', 'integrations', 32, TRUE),
        ('integrations.jira', 'Jira', 'Jira Integration', 'Sync with Jira projects', 'integrations', 33, TRUE),
        ('integrations.github', 'GitHub', 'GitHub Integration', 'Link to GitHub issues', 'integrations', 34, TRUE),
        ('integrations.gitlab', 'GitLab', 'GitLab Integration', 'Link to GitLab issues', 'integrations', 35, TRUE),
        ('integrations.sso', 'SSO', 'Single Sign-On', 'SAML/OIDC authentication', 'integrations', 36, TRUE),
        ('integrations.monitoring.basic', 'Basic Monitoring', 'Monitoring & Alerts', 'Nagios, Zabbix, PRTG, Datadog', 'integrations', 37, TRUE),
        ('integrations.billing.xero', 'Xero', 'Xero Billing', 'Xero accounting integration', 'integrations', 38, TRUE),
        ('integrations.billing.quickbooks', 'QuickBooks', 'QuickBooks Billing', 'QuickBooks integration', 'integrations', 39, TRUE),
        ('integrations.whatsapp', 'WhatsApp', 'WhatsApp', 'Customer communication via WhatsApp', 'integrations', 40, TRUE),
        ('integrations.sms', 'SMS', 'SMS Notifications', 'SMS alerts and notifications', 'integrations', 41, TRUE),

        -- SLA features
        ('sla.basic', 'Basic SLA', 'SLA Definitions', 'Response and resolution targets', 'sla', 50, TRUE),
        ('sla.business_hours', 'Business Hours', 'Business Hours SLA', 'SLA with business hours support', 'sla', 51, TRUE),
        ('sla.two_phase', 'Two-Phase SLA', 'Advanced SLA Tracking', 'Response and resolution phase tracking', 'sla', 52, TRUE),
        ('sla.notifications', 'SLA Notifications', 'SLA Breach Alerts', 'Proactive SLA breach notifications', 'sla', 53, TRUE),
        ('sla.contract_aware', 'Contract-Aware SLA', 'Contract-Aware SLA', 'Per-customer SLA contracts', 'sla', 54, TRUE),

        -- MSP features
        ('msp.contracts', 'Contracts', 'Contract Management', 'Customer contract management', 'msp', 60, TRUE),
        ('msp.governance', 'Governance', 'Governance & Compliance', 'Compliance and governance tools', 'msp', 61, TRUE),
        ('msp.audit', 'Audit Logging', 'Full Audit Trail', 'Complete audit logging', 'msp', 62, TRUE),

        -- API features
        ('api.webhooks.inbound', 'Inbound Webhooks', 'Inbound Webhooks', 'Receive events via webhooks', 'api', 70, TRUE),
        ('api.webhooks.outbound', 'Outbound Webhooks', 'Outbound Webhooks', 'Send events to external systems', 'api', 71, TRUE),
        ('api.full_access', 'Full API Access', 'Full API Access', 'Complete API access', 'api', 72, TRUE)
      `);
      console.log('✅ Seeded feature catalog');
    } else {
      console.log('ℹ️  Features already exist, skipping seed');
    }

    console.log('\n✅ Migration completed successfully!');
    console.log('\nNext steps:');
    console.log('1. Deploy the public plans API');
    console.log('2. Update marketing site to fetch from /api/plans');
    console.log('3. Update feature-flags service to read from database');

  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

runMigration();
