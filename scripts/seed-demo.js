#!/usr/bin/env node
/**
 * seed-demo.js — Idempotent demo data seeder for ServiFlow
 *
 * Usage:
 *   node scripts/seed-demo.js           # Seed (skip if already seeded)
 *   node scripts/seed-demo.js --reset   # Wipe + re-seed
 *
 * Safety:
 *   - Requires DEMO_RESET_ENABLED=true
 *   - Refuses to run against known production DB hosts
 *   - Requires DEMO_TENANT_CODE=demo (or unset, defaults to 'demo')
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');

// ─── Safety Guards ──────────────────────────────────────────────────────────

if (process.env.DEMO_RESET_ENABLED !== 'true') {
  console.error('DEMO_RESET_ENABLED is not true. Aborting.');
  process.exit(1);
}

const DEMO_TENANT = process.env.DEMO_TENANT_CODE || 'demo';
if (DEMO_TENANT !== 'demo') {
  console.error(`DEMO_TENANT_CODE is "${DEMO_TENANT}", not "demo". Aborting.`);
  process.exit(1);
}

const dbHost = process.env.MYSQLHOST || process.env.MYSQL_HOST || 'localhost';
const PROD_HOSTS = ['tramway.proxy.rlwy.net'];
if (PROD_HOSTS.includes(dbHost)) {
  console.error(`FATAL: Connected to production DB host (${dbHost}). Aborting.`);
  process.exit(1);
}

const isReset = process.argv.includes('--reset');

// ─── DB Connection ──────────────────────────────────────────────────────────

async function getConnection(database) {
  return mysql.createConnection({
    host: dbHost,
    port: process.env.MYSQLPORT || process.env.MYSQL_PORT || 3306,
    user: process.env.MYSQLUSER || process.env.MYSQL_USER || 'root',
    password: process.env.MYSQLPASSWORD || process.env.MYSQL_PASSWORD || '',
    database: database || undefined,
    multipleStatements: true,
  });
}

// ─── Deterministic Seeded Random ────────────────────────────────────────────

function seededRandom(seed) {
  let s = seed;
  return function () {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

// ─── Password Hashing ──────────────────────────────────────────────────────

async function hash(password) {
  return bcrypt.hash(password, 10);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🎭 ServiFlow Demo Seeder`);
  console.log(`   Host: ${dbHost}`);
  console.log(`   Mode: ${isReset ? 'RESET + Seed' : 'Seed (skip if exists)'}\n`);

  const rootConn = await getConnection();

  try {
    // ── Reset Mode ──────────────────────────────────────────────────────
    if (isReset) {
      console.log('🗑️  Dropping demo tenant database...');
      await rootConn.query('DROP DATABASE IF EXISTS a1_tenant_demo');
      console.log('🗑️  Removing demo tenant from master...');
      await rootConn.query('CREATE DATABASE IF NOT EXISTS a1_master');
      await rootConn.query('USE a1_master');
      // Only delete if table exists
      const [tables] = await rootConn.query(
        `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='a1_master' AND TABLE_NAME='tenants'`
      );
      if (tables.length > 0) {
        await rootConn.query("DELETE FROM tenant_subscriptions WHERE tenant_id IN (SELECT id FROM tenants WHERE tenant_code='demo')").catch(() => {});
        await rootConn.query("DELETE FROM tenants WHERE tenant_code='demo'");
      }
      console.log('✅ Reset complete\n');
    }

    // ── 1. Master DB Setup ──────────────────────────────────────────────
    console.log('📦 Setting up master database...');
    await rootConn.query('CREATE DATABASE IF NOT EXISTS a1_master');
    await rootConn.query('USE a1_master');

    // Create tables (idempotent)
    await rootConn.query(`
      CREATE TABLE IF NOT EXISTS master_users (
        id INT PRIMARY KEY AUTO_INCREMENT,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        full_name VARCHAR(100) NOT NULL,
        role ENUM('super_admin', 'master_admin') NOT NULL DEFAULT 'master_admin',
        is_active BOOLEAN DEFAULT TRUE,
        last_login DATETIME,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    await rootConn.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id INT PRIMARY KEY AUTO_INCREMENT,
        tenant_code VARCHAR(20) UNIQUE NOT NULL,
        company_name VARCHAR(100) NOT NULL,
        display_name VARCHAR(100) NOT NULL,
        database_name VARCHAR(50) NOT NULL,
        database_host VARCHAR(100) DEFAULT 'localhost',
        database_port INT DEFAULT 3306,
        database_user VARCHAR(50) NOT NULL,
        database_password VARCHAR(255) NOT NULL,
        status ENUM('active', 'inactive', 'suspended') DEFAULT 'active',
        is_demo TINYINT(1) NOT NULL DEFAULT 0,
        max_users INT DEFAULT 100,
        max_tickets INT DEFAULT 1000,
        subscription_plan ENUM('basic', 'professional', 'enterprise') DEFAULT 'basic',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        created_by INT,
        FOREIGN KEY (created_by) REFERENCES master_users(id)
      )
    `);

    // Add is_demo column if missing (for existing master tables)
    const [demoCols] = await rootConn.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA='a1_master' AND TABLE_NAME='tenants' AND COLUMN_NAME='is_demo'`
    );
    if (demoCols.length === 0) {
      await rootConn.query('ALTER TABLE tenants ADD COLUMN is_demo TINYINT(1) NOT NULL DEFAULT 0');
      console.log('   Added is_demo column to tenants');
    }

    await rootConn.query(`
      CREATE TABLE IF NOT EXISTS subscription_plans (
        id INT PRIMARY KEY AUTO_INCREMENT,
        slug VARCHAR(50) NOT NULL UNIQUE,
        name VARCHAR(100),
        display_name VARCHAR(100) NOT NULL,
        tagline VARCHAR(255),
        description TEXT,
        price_monthly DECIMAL(10,2) NOT NULL DEFAULT 0,
        price_yearly DECIMAL(10,2) NOT NULL DEFAULT 0,
        price_per_user DECIMAL(10,2) DEFAULT 0,
        features JSON,
        feature_limits JSON,
        is_active TINYINT(1) DEFAULT 1,
        is_featured TINYINT(1) DEFAULT 0,
        badge_text VARCHAR(50),
        display_order INT DEFAULT 0,
        stripe_product_id VARCHAR(255),
        stripe_price_monthly VARCHAR(255),
        stripe_price_yearly VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    await rootConn.query(`
      CREATE TABLE IF NOT EXISTS tenant_subscriptions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT NOT NULL,
        plan_id INT NOT NULL,
        status ENUM('trial', 'active', 'past_due', 'cancelled', 'expired') DEFAULT 'trial',
        billing_cycle ENUM('monthly', 'yearly') DEFAULT 'monthly',
        current_period_start DATE,
        current_period_end DATE,
        trial_start DATE,
        trial_end DATE,
        user_count INT DEFAULT 0,
        ticket_count_this_period INT DEFAULT 0,
        storage_used_gb DECIMAL(10,2) DEFAULT 0,
        stripe_subscription_id VARCHAR(255),
        stripe_customer_id VARCHAR(255),
        previous_plan_id INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_tenant_id (tenant_id)
      )
    `);

    // Check if demo tenant already exists
    const [existing] = await rootConn.query("SELECT id FROM tenants WHERE tenant_code='demo'");
    if (existing.length > 0 && !isReset) {
      console.log('ℹ️  Demo tenant already exists. Use --reset to wipe and re-seed.');
      await rootConn.end();
      return;
    }

    // Insert master admin
    const masterPwHash = await hash('admin123');
    await rootConn.query(`
      INSERT IGNORE INTO master_users (username, email, password_hash, full_name, role)
      VALUES ('admin', 'admin@serviflow.app', ?, 'Master Admin', 'super_admin')
    `, [masterPwHash]);

    // Insert plans
    await rootConn.query(`
      INSERT IGNORE INTO subscription_plans (slug, name, display_name, price_monthly, display_order)
      VALUES
        ('starter', 'Starter', 'Starter', 0, 1),
        ('professional', 'Professional', 'Professional', 29.00, 2),
        ('msp', 'MSP', 'MSP', 99.00, 3)
    `);

    // Insert demo tenant
    const dbUser = process.env.MYSQLUSER || 'root';
    const dbPassword = process.env.MYSQLPASSWORD || '';
    await rootConn.query(`
      INSERT INTO tenants (tenant_code, company_name, display_name, database_name, database_host, database_port, database_user, database_password, status, is_demo, subscription_plan)
      VALUES ('demo', 'ServiFlow Demo MSP', 'ServiFlow Demo', 'a1_tenant_demo', ?, ?, ?, ?, 'active', 1, 'professional')
    `, [dbHost, process.env.MYSQLPORT || 3306, dbUser, dbPassword]);

    // Get tenant ID for subscription
    const [tenantRows] = await rootConn.query("SELECT id FROM tenants WHERE tenant_code='demo'");
    const tenantId = tenantRows[0].id;

    // Get professional plan ID
    const [planRows] = await rootConn.query("SELECT id FROM subscription_plans WHERE slug='professional'");
    const planId = planRows.length > 0 ? planRows[0].id : 2;

    const now = new Date();
    const trialEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    await rootConn.query(`
      INSERT IGNORE INTO tenant_subscriptions (tenant_id, plan_id, status, trial_start, trial_end, current_period_start, current_period_end)
      VALUES (?, ?, 'trial', ?, ?, ?, ?)
    `, [tenantId, planId, now, trialEnd, now, trialEnd]);

    console.log('✅ Master DB ready\n');

    // ── 2. Tenant DB Setup ──────────────────────────────────────────────
    console.log('📦 Creating tenant database...');
    await rootConn.query('CREATE DATABASE IF NOT EXISTS a1_tenant_demo');

    // Use tenant provisioning to create tables
    const { createTenantTables } = require('../services/tenant-provisioning');
    // createTenantTables is not exported, we need to call createTenantDatabase
    // Actually, let's create a direct connection and use it
    const tenantConn = await getConnection('a1_tenant_demo');

    try {
      // We'll create tables manually using the provisioning service's approach
      // First, import and call createTenantDatabase via the provisioning module
      // Since createTenantDatabase needs a specific connection format, we use our own setup
      await createAllTenantTables(tenantConn);
      console.log('✅ Tenant tables created');

      // Run migrations that add tables not in createTenantTables
      console.log('📋 Running migrations...');
      const migrations = [
        { name: 'Knowledge Base', fn: async () => { const { runMigration } = require('../migrations/add-knowledge-base'); await runMigration('demo'); }},
        { name: 'Tenant Settings', fn: async () => { const { migrate } = require('../migrations/add-tenant-settings'); await migrate('demo'); }},
        { name: 'Tenant Features', fn: async () => { const { migrate } = require('../migrations/add-tenant-features'); await migrate('demo', 'professional'); }},
        { name: 'CMDB V2', fn: async () => { const { runMigration } = require('../migrations/add-cmdb-v2-tables'); await runMigration('demo'); }},
        { name: 'Soft Delete', fn: async () => { const { runMigration } = require('../migrations/add-soft-delete-columns'); await runMigration('demo'); }},
        { name: 'Last Login', fn: async () => { const { migrate } = require('../migrations/add-last-login-column'); await migrate('demo'); }},
        { name: 'Ticket-CMDB Relations', fn: async () => { const { runMigration } = require('../migrations/add-ticket-cmdb-relations'); await runMigration('demo'); }},
        { name: 'Category SLA Mappings', fn: async () => { const { runMigration } = require('../migrations/add-category-sla-mappings'); await runMigration('demo'); }},
        { name: 'Email Notifications', fn: async () => { const { runMigration } = require('../migrations/add-email-notifications-column'); await runMigration('demo'); }},
        { name: 'Must Reset Password', fn: async () => { const { runMigration } = require('../migrations/add-must-reset-password'); await runMigration('demo'); }},
        { name: 'Invitation Columns', fn: async () => { const { runMigration } = require('../migrations/add-invitation-columns'); await runMigration('demo'); }},
        { name: 'Ticket Classification', fn: async () => { const { runMigration } = require('../migrations/add-ticket-classification-fields'); await runMigration('demo'); }},
        { name: 'Ticket Ownership', fn: async () => { const { runMigration } = require('../migrations/add-ticket-ownership-workflow'); await runMigration('demo'); }},
      ];
      for (const m of migrations) {
        try { await m.fn(); } catch (e) { console.warn(`   ⚠️ ${m.name}: ${e.message}`); }
      }

      // Patch missing columns that come from standalone migration scripts
      // (scripts that can't be imported because they auto-execute main())
      console.log('🔧 Patching schema for production parity...');
      const { getTenantConnection } = require('../config/database');
      const patchConn = await getTenantConnection('demo');
      try {
        const [existingCols] = await patchConn.query(`
          SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('users', 'tickets')
        `);
        const colSet = new Set(existingCols.map(r => r.COLUMN_NAME));

        // Users table — columns from add-user-profile-columns, add-expert-permissions, etc.
        const userPatches = [
          { col: 'location', sql: "ADD COLUMN location VARCHAR(100) DEFAULT NULL" },
          { col: 'street_address', sql: "ADD COLUMN street_address VARCHAR(255) DEFAULT NULL" },
          { col: 'city', sql: "ADD COLUMN city VARCHAR(100) DEFAULT NULL" },
          { col: 'state', sql: "ADD COLUMN state VARCHAR(100) DEFAULT NULL" },
          { col: 'postcode', sql: "ADD COLUMN postcode VARCHAR(20) DEFAULT NULL" },
          { col: 'country', sql: "ADD COLUMN country VARCHAR(100) DEFAULT NULL" },
          { col: 'timezone', sql: "ADD COLUMN timezone VARCHAR(50) DEFAULT NULL" },
          { col: 'language', sql: "ADD COLUMN language VARCHAR(10) DEFAULT 'en'" },
          { col: 'reset_token', sql: "ADD COLUMN reset_token VARCHAR(255) DEFAULT NULL" },
          { col: 'reset_token_expiry', sql: "ADD COLUMN reset_token_expiry DATETIME DEFAULT NULL" },
        ];
        for (const p of userPatches) {
          if (!colSet.has(p.col)) {
            try { await patchConn.query(`ALTER TABLE users ${p.sql}`); }
            catch (e) { /* already exists */ }
          }
        }

        // Tickets table — columns from uat-schema-parity and various standalone migrations
        const ticketPatches = [
          { col: 'previous_assignee_id', sql: "ADD COLUMN previous_assignee_id INT DEFAULT NULL" },
          { col: 'resolution_status', sql: "ADD COLUMN resolution_status ENUM('pending','accepted','rejected') DEFAULT NULL" },
          { col: 'rejection_reason', sql: "ADD COLUMN rejection_reason VARCHAR(255) DEFAULT NULL" },
          { col: 'rejection_comment', sql: "ADD COLUMN rejection_comment TEXT DEFAULT NULL" },
          { col: 'csat_rating', sql: "ADD COLUMN csat_rating INT DEFAULT NULL" },
          { col: 'csat_comment', sql: "ADD COLUMN csat_comment TEXT DEFAULT NULL" },
          { col: 'resolution_comment', sql: "ADD COLUMN resolution_comment TEXT DEFAULT NULL" },
          { col: 'ai_accuracy_feedback', sql: "ADD COLUMN ai_accuracy_feedback ENUM('accurate','inaccurate','partial') DEFAULT NULL" },
          { col: 'source_metadata', sql: "ADD COLUMN source_metadata JSON DEFAULT NULL" },
          { col: 'email_message_id', sql: "ADD COLUMN email_message_id VARCHAR(255) DEFAULT NULL" },
          { col: 'email_in_reply_to', sql: "ADD COLUMN email_in_reply_to VARCHAR(255) DEFAULT NULL" },
          { col: 'email_references', sql: "ADD COLUMN email_references TEXT DEFAULT NULL" },
        ];
        for (const p of ticketPatches) {
          if (!colSet.has(p.col)) {
            try { await patchConn.query(`ALTER TABLE tickets ${p.sql}`); }
            catch (e) { /* already exists */ }
          }
        }

        console.log('✅ Schema patching complete');
      } finally {
        patchConn.release();
      }

      console.log('✅ Migrations complete\n');

      // ── 3. Seed Users ──────────────────────────────────────────────────
      console.log('👥 Seeding users...');
      const pwHash = await hash('Demo123!');

      const users = [
        { username: 'demo_admin', email: 'demo@serviflow.app', full_name: 'Demo Admin', role: 'admin' },
        { username: 'alex.morgan', email: 'alex.morgan@serviflow.app', full_name: 'Alex Morgan', role: 'admin' },
        { username: 'mike.torres', email: 'mike.torres@serviflow.app', full_name: 'Mike Torres', role: 'expert' },
        { username: 'emma.brooks', email: 'emma.brooks@serviflow.app', full_name: 'Emma Brooks', role: 'expert' },
        { username: 'sarah.chen', email: 'sarah.chen@fintechco.com', full_name: 'Sarah Chen', role: 'customer' },
        { username: 'james.wilson', email: 'james.wilson@medtechsystems.com', full_name: 'James Wilson', role: 'customer' },
        { username: 'priya.patel', email: 'priya.patel@globalretail.com', full_name: 'Priya Patel', role: 'customer' },
      ];

      const userIds = {};
      for (const u of users) {
        const [result] = await tenantConn.query(
          `INSERT INTO users (username, password_hash, role, email, full_name, is_active)
           VALUES (?, ?, ?, ?, ?, TRUE)
           ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
          [u.username, pwHash, u.role, u.email, u.full_name]
        );
        userIds[u.username] = result.insertId;
      }

      // Create expert records
      for (const expertUser of ['mike.torres', 'emma.brooks']) {
        await tenantConn.query(
          `INSERT IGNORE INTO experts (user_id, skills, availability_status)
           VALUES (?, ?, 'available')`,
          [userIds[expertUser], expertUser === 'mike.torres' ? 'Hardware, Network, Desktop Support' : 'Software, Cloud, Security, Database']
        );
      }

      console.log(`   Created ${users.length} users`);

      // ── 4. Seed Customer Companies ────────────────────────────────────
      console.log('🏢 Seeding companies...');

      const companies = [
        { name: 'FinTechCo Ltd', domain: 'fintechco.com', admin: 'sarah.chen' },
        { name: 'MedTech Systems', domain: 'medtechsystems.com', admin: 'james.wilson' },
        { name: 'Global Retail Group', domain: 'globalretail.com', admin: 'priya.patel' },
      ];

      const companyIds = {};
      for (const c of companies) {
        const [result] = await tenantConn.query(
          `INSERT INTO customer_companies (company_name, company_domain, admin_user_id, admin_email, is_active)
           VALUES (?, ?, ?, ?, TRUE)
           ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
          [c.name, c.domain, userIds[c.admin], `admin@${c.domain}`]
        );
        companyIds[c.name] = result.insertId;
      }

      // Create customer records
      const customerCompanyMap = {
        'sarah.chen': { company: 'FinTechCo Ltd', isAdmin: true },
        'james.wilson': { company: 'MedTech Systems', isAdmin: true },
        'priya.patel': { company: 'Global Retail Group', isAdmin: true },
      };

      for (const [username, info] of Object.entries(customerCompanyMap)) {
        await tenantConn.query(
          `INSERT IGNORE INTO customers (user_id, customer_company_id, is_company_admin, company_name, company_domain)
           VALUES (?, ?, ?, ?, ?)`,
          [userIds[username], companyIds[info.company], info.isAdmin, info.company,
           companies.find(c => c.name === info.company).domain]
        );
      }

      console.log(`   Created ${companies.length} companies`);

      // ── 5. Seed CMDB Items ────────────────────────────────────────────
      console.log('🖥️  Seeding CMDB items...');

      const cmdbItems = [
        // Hardware — Laptops
        { name: 'Dell Latitude 5540', cat: 'Hardware', catVal: 'Laptop', brand: 'Dell', model: 'Latitude 5540', customer: 'FinTechCo Ltd', location: 'London Office' },
        { name: 'MacBook Pro 14"', cat: 'Hardware', catVal: 'Laptop', brand: 'Apple', model: 'MacBook Pro 14"', customer: 'FinTechCo Ltd', location: 'London Office' },
        { name: 'Lenovo ThinkPad X1', cat: 'Hardware', catVal: 'Laptop', brand: 'Lenovo', model: 'ThinkPad X1 Carbon', customer: 'MedTech Systems', location: 'Manchester Lab' },
        { name: 'HP EliteBook 840', cat: 'Hardware', catVal: 'Laptop', brand: 'HP', model: 'EliteBook 840 G10', customer: 'MedTech Systems', location: 'Manchester Lab' },
        { name: 'Dell XPS 15', cat: 'Hardware', catVal: 'Laptop', brand: 'Dell', model: 'XPS 15 9530', customer: 'Global Retail Group', location: 'Birmingham HQ' },
        // Hardware — Servers
        { name: 'App Server 01', cat: 'Hardware', catVal: 'Server', brand: 'Dell', model: 'PowerEdge R750', customer: 'FinTechCo Ltd', location: 'AWS eu-west-2' },
        { name: 'DB Server 01', cat: 'Hardware', catVal: 'Server', brand: 'Dell', model: 'PowerEdge R650', customer: 'FinTechCo Ltd', location: 'AWS eu-west-2' },
        { name: 'File Server 01', cat: 'Hardware', catVal: 'Server', brand: 'HP', model: 'ProLiant DL380', customer: 'MedTech Systems', location: 'On-Premise DC' },
        // Hardware — Printers
        { name: 'HP LaserJet M428', cat: 'Hardware', catVal: 'Printer', brand: 'HP', model: 'LaserJet Pro M428fdn', customer: 'Global Retail Group', location: 'Birmingham HQ' },
        { name: 'Xerox VersaLink C405', cat: 'Hardware', catVal: 'Printer', brand: 'Xerox', model: 'VersaLink C405', customer: 'MedTech Systems', location: 'Manchester Lab' },
        // Software
        { name: 'Microsoft 365 E3', cat: 'Software', catVal: 'Productivity Suite', brand: 'Microsoft', model: '365 E3', customer: 'FinTechCo Ltd', location: 'Cloud' },
        { name: 'Microsoft 365 E3 (MT)', cat: 'Software', catVal: 'Productivity Suite', brand: 'Microsoft', model: '365 E3', customer: 'MedTech Systems', location: 'Cloud' },
        { name: 'Salesforce CRM', cat: 'Software', catVal: 'CRM', brand: 'Salesforce', model: 'Enterprise Edition', customer: 'Global Retail Group', location: 'Cloud' },
        { name: 'SAP Business One', cat: 'Software', catVal: 'ERP', brand: 'SAP', model: 'Business One', customer: 'Global Retail Group', location: 'Cloud' },
        { name: 'Jira Service Mgmt', cat: 'Software', catVal: 'ITSM', brand: 'Atlassian', model: 'JSM Premium', customer: 'FinTechCo Ltd', location: 'Cloud' },
        { name: 'Slack Business+', cat: 'Software', catVal: 'Communication', brand: 'Slack', model: 'Business+', customer: 'FinTechCo Ltd', location: 'Cloud' },
        { name: 'Zoom Business', cat: 'Software', catVal: 'Communication', brand: 'Zoom', model: 'Business', customer: 'MedTech Systems', location: 'Cloud' },
        // Network
        { name: 'Core Switch 01', cat: 'Network', catVal: 'Switch', brand: 'Cisco', model: 'Catalyst 9300', customer: 'FinTechCo Ltd', location: 'London Office' },
        { name: 'Core Switch 02', cat: 'Network', catVal: 'Switch', brand: 'Cisco', model: 'Catalyst 9200', customer: 'MedTech Systems', location: 'Manchester Lab' },
        { name: 'Firewall 01', cat: 'Network', catVal: 'Firewall', brand: 'Palo Alto', model: 'PA-820', customer: 'FinTechCo Ltd', location: 'London Office' },
        { name: 'Firewall 02', cat: 'Network', catVal: 'Firewall', brand: 'Fortinet', model: 'FortiGate 60F', customer: 'MedTech Systems', location: 'Manchester Lab' },
        { name: 'WiFi AP Cluster', cat: 'Network', catVal: 'Access Point', brand: 'Ubiquiti', model: 'UniFi U6 Pro', customer: 'Global Retail Group', location: 'Birmingham HQ' },
        { name: 'VPN Gateway', cat: 'Network', catVal: 'VPN', brand: 'Cisco', model: 'ASA 5508-X', customer: 'FinTechCo Ltd', location: 'London Office' },
        // Cloud
        { name: 'AWS Production', cat: 'Cloud', catVal: 'IaaS', brand: 'Amazon', model: 'AWS eu-west-2', customer: 'FinTechCo Ltd', location: 'eu-west-2' },
        { name: 'Azure Dev/Test', cat: 'Cloud', catVal: 'IaaS', brand: 'Microsoft', model: 'Azure UK South', customer: 'MedTech Systems', location: 'UK South' },
        { name: 'GCP Analytics', cat: 'Cloud', catVal: 'IaaS', brand: 'Google', model: 'GCP europe-west2', customer: 'Global Retail Group', location: 'europe-west2' },
        { name: 'CloudFlare CDN', cat: 'Cloud', catVal: 'CDN', brand: 'Cloudflare', model: 'Pro', customer: 'FinTechCo Ltd', location: 'Global' },
        { name: 'Datadog Monitoring', cat: 'Cloud', catVal: 'Monitoring', brand: 'Datadog', model: 'Pro', customer: 'FinTechCo Ltd', location: 'Cloud' },
        { name: 'PagerDuty', cat: 'Cloud', catVal: 'Alerting', brand: 'PagerDuty', model: 'Business', customer: 'MedTech Systems', location: 'Cloud' },
        { name: 'Veeam Backup', cat: 'Cloud', catVal: 'Backup', brand: 'Veeam', model: 'Backup & Replication', customer: 'Global Retail Group', location: 'Cloud' },
      ];

      for (const item of cmdbItems) {
        const cmdbId = `CMDB-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        await tenantConn.query(
          `INSERT IGNORE INTO cmdb_items (cmdb_id, asset_name, asset_category, category_field_value, brand_name, model_name, customer_name, asset_location, status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
          [cmdbId, item.name, item.cat, item.catVal, item.brand, item.model, item.customer, item.location, userIds['demo_admin']]
        );
      }

      console.log(`   Created ${cmdbItems.length} CMDB items`);

      // ── 6. Seed Business Hours & SLA Definitions ──────────────────────
      console.log('⏰ Seeding SLA definitions...');

      await tenantConn.query(`
        INSERT IGNORE INTO business_hours_profiles (name, timezone, days_of_week, start_time, end_time, is_24x7)
        VALUES
          ('Standard Business Hours', 'Europe/London', '[1,2,3,4,5]', '09:00:00', '17:00:00', FALSE),
          ('24x7 Support', 'UTC', '[1,2,3,4,5,6,7]', '00:00:00', '23:59:59', TRUE)
      `);

      await tenantConn.query(`
        INSERT IGNORE INTO sla_definitions (name, description, business_hours_profile_id, response_target_minutes, resolve_target_minutes)
        VALUES
          ('Standard', 'Standard support — 4h response, 48h resolve', 1, 240, 2880),
          ('Priority', 'Priority support — 1h response, 8h resolve', 1, 60, 480),
          ('Critical', '24x7 critical systems — 15min response, 2h resolve', 2, 15, 120)
      `);

      // Get SLA definition IDs
      const [slaDefs] = await tenantConn.query('SELECT id, name FROM sla_definitions ORDER BY id');
      const slaMap = {};
      for (const s of slaDefs) slaMap[s.name] = s.id;

      console.log(`   Created ${slaDefs.length} SLA definitions`);

      // ── 7. Seed Tickets ───────────────────────────────────────────────
      console.log('🎫 Seeding tickets...');

      const rng = seededRandom(42);
      const ticketTemplates = [
        { title: 'Cannot access VPN from home', cat: 'Network', pri: 'high' },
        { title: 'Outlook keeps crashing on startup', cat: 'Software', pri: 'high' },
        { title: 'New laptop request for starter', cat: 'Hardware', pri: 'medium' },
        { title: 'Password reset for AD account', cat: 'Account Access', pri: 'low' },
        { title: 'Printer on 3rd floor not responding', cat: 'Printing', pri: 'medium' },
        { title: 'Email attachment size limit too small', cat: 'Email', pri: 'low' },
        { title: 'Shared drive not accessible after migration', cat: 'Network', pri: 'high' },
        { title: 'Request for additional monitor', cat: 'Hardware', pri: 'low' },
        { title: 'Software license expiring next week', cat: 'Software', pri: 'medium' },
        { title: 'Two-factor authentication not working', cat: 'Account Access', pri: 'critical' },
        { title: 'WiFi dropping in conference room B', cat: 'Network', pri: 'medium' },
        { title: 'Cannot install approved software', cat: 'Software', pri: 'medium' },
        { title: 'Keyboard and mouse replacement', cat: 'Hardware', pri: 'low' },
        { title: 'Suspicious email received', cat: 'Email', pri: 'high' },
        { title: 'Slow internet connection in office', cat: 'Network', pri: 'medium' },
        { title: 'Database server high CPU usage', cat: 'Software', pri: 'critical' },
        { title: 'New user onboarding — 5 accounts', cat: 'Account Access', pri: 'medium' },
        { title: 'Backup job failed overnight', cat: 'Software', pri: 'critical' },
        { title: 'Request for VPN access for contractor', cat: 'Network', pri: 'medium' },
        { title: 'Laptop screen flickering', cat: 'Hardware', pri: 'medium' },
        { title: 'Outlook calendar sync issue', cat: 'Software', pri: 'low' },
        { title: 'Badge access not working for new office', cat: 'Hardware', pri: 'medium' },
        { title: 'Cannot print to network printer', cat: 'Printing', pri: 'medium' },
        { title: 'Request for project management tool', cat: 'Software', pri: 'low' },
        { title: 'Server room temperature alert', cat: 'Hardware', pri: 'critical' },
        { title: 'File recovery from deleted folder', cat: 'Software', pri: 'high' },
        { title: 'Microsoft Teams calls dropping', cat: 'Software', pri: 'high' },
        { title: 'New department email distribution list', cat: 'Email', pri: 'low' },
        { title: 'Laptop docking station not working', cat: 'Hardware', pri: 'medium' },
        { title: 'SSL certificate expiring on web portal', cat: 'Network', pri: 'critical' },
        { title: 'Cannot access SharePoint site', cat: 'Software', pri: 'medium' },
        { title: 'Office 365 license assignment', cat: 'Software', pri: 'low' },
        { title: 'Network port activation for new desk', cat: 'Network', pri: 'low' },
        { title: 'Zoom meeting room setup', cat: 'Software', pri: 'medium' },
        { title: 'Email forwarding rule not working', cat: 'Email', pri: 'medium' },
        { title: 'Workstation not booting', cat: 'Hardware', pri: 'high' },
        { title: 'CRM access for new sales team member', cat: 'Account Access', pri: 'medium' },
        { title: 'Firewall blocking internal application', cat: 'Network', pri: 'high' },
        { title: 'Automated report not sending', cat: 'Software', pri: 'medium' },
        { title: 'UPS battery replacement needed', cat: 'Hardware', pri: 'high' },
        { title: 'Mobile device management enrollment', cat: 'Software', pri: 'low' },
        { title: 'Domain controller replication error', cat: 'Network', pri: 'critical' },
        { title: 'Projector not connecting to laptop', cat: 'Hardware', pri: 'low' },
        { title: 'Azure AD sync failing', cat: 'Software', pri: 'critical' },
        { title: 'Request for remote desktop access', cat: 'Account Access', pri: 'medium' },
        { title: 'Printer toner replacement order', cat: 'Printing', pri: 'low' },
        { title: 'Wi-Fi password change for guest network', cat: 'Network', pri: 'low' },
        { title: 'ERP system running slow', cat: 'Software', pri: 'high' },
        { title: 'New employee equipment order', cat: 'Hardware', pri: 'medium' },
        { title: 'Phishing email campaign detected', cat: 'Email', pri: 'critical' },
        { title: 'Cannot connect to remote file server', cat: 'Network', pri: 'high' },
        { title: 'Software deployment to 20 machines', cat: 'Software', pri: 'medium' },
        { title: 'Broken USB port on laptop', cat: 'Hardware', pri: 'low' },
        { title: 'VoIP phone not registering', cat: 'Network', pri: 'medium' },
        { title: 'Request for data export from old system', cat: 'Software', pri: 'medium' },
        { title: 'Conference room AV equipment setup', cat: 'Hardware', pri: 'low' },
        { title: 'DNS resolution failure for internal apps', cat: 'Network', pri: 'critical' },
        { title: 'Antivirus quarantine false positive', cat: 'Software', pri: 'medium' },
        { title: 'Monthly security patch deployment', cat: 'Software', pri: 'high' },
        { title: 'Network switch firmware upgrade', cat: 'Network', pri: 'medium' },
        { title: 'Laptop battery swelling — urgent', cat: 'Hardware', pri: 'critical' },
        { title: 'Shared mailbox permissions issue', cat: 'Email', pri: 'medium' },
        { title: 'AWS billing alert — unexpected charges', cat: 'Software', pri: 'high' },
        { title: 'New branch office network setup', cat: 'Network', pri: 'high' },
        { title: 'Citrix session freezing randomly', cat: 'Software', pri: 'high' },
        { title: 'Desk phone configuration for new hire', cat: 'Hardware', pri: 'low' },
        { title: 'S3 bucket permissions review', cat: 'Software', pri: 'medium' },
        { title: 'Printer driver compatibility issue', cat: 'Printing', pri: 'medium' },
        { title: 'Active Directory group policy update', cat: 'Account Access', pri: 'medium' },
        { title: 'DHCP scope running out of addresses', cat: 'Network', pri: 'high' },
        { title: 'Laptop webcam not detected in Teams', cat: 'Hardware', pri: 'low' },
        { title: 'Power outage recovery checklist', cat: 'Hardware', pri: 'high' },
        { title: 'SaaS application SSO integration', cat: 'Software', pri: 'medium' },
        { title: 'Email delivery delays for external', cat: 'Email', pri: 'high' },
        { title: 'Storage array capacity warning', cat: 'Hardware', pri: 'high' },
        { title: 'Database backup verification needed', cat: 'Software', pri: 'medium' },
        { title: 'Guest WiFi captive portal broken', cat: 'Network', pri: 'medium' },
        { title: 'Windows 11 upgrade pilot group', cat: 'Software', pri: 'low' },
        { title: 'Replace faulty network cable in rack', cat: 'Network', pri: 'low' },
        { title: 'Onboarding checklist for finance team', cat: 'Account Access', pri: 'medium' },
        { title: 'Cloud migration progress review', cat: 'Software', pri: 'medium' },
        { title: 'Access badge deactivation for leaver', cat: 'Account Access', pri: 'medium' },
        { title: 'Multi-monitor setup for trading desk', cat: 'Hardware', pri: 'medium' },
        { title: 'Email signature template update', cat: 'Email', pri: 'low' },
        { title: 'Network bandwidth upgrade assessment', cat: 'Network', pri: 'medium' },
        { title: 'Replace aging desktop machines', cat: 'Hardware', pri: 'low' },
        { title: 'Slack integration with ticketing system', cat: 'Software', pri: 'low' },
        { title: 'Emergency server restart required', cat: 'Hardware', pri: 'critical' },
        { title: 'Suspected data breach investigation', cat: 'Email', pri: 'critical' },
        { title: 'Compliance audit — access review', cat: 'Account Access', pri: 'high' },
        { title: 'Endpoint detection alert triggered', cat: 'Software', pri: 'critical' },
        { title: 'Office relocation IT planning', cat: 'Hardware', pri: 'medium' },
        { title: 'Load balancer health check failing', cat: 'Network', pri: 'critical' },
        { title: 'Request for development environment', cat: 'Software', pri: 'medium' },
        { title: 'Colour printer calibration needed', cat: 'Printing', pri: 'low' },
        { title: 'Annual IT asset inventory', cat: 'Hardware', pri: 'low' },
        { title: 'Video conferencing codec upgrade', cat: 'Software', pri: 'low' },
        { title: 'Wireless survey for new floor plan', cat: 'Network', pri: 'medium' },
        { title: 'Mobile app not syncing with server', cat: 'Software', pri: 'medium' },
        { title: 'Bulk password reset after breach scare', cat: 'Account Access', pri: 'critical' },
      ];

      const statuses = ['Open', 'In Progress', 'Pending', 'Resolved', 'Closed'];
      const statusWeights = [30, 25, 15, 20, 10]; // approximate distribution
      const workTypes = ['incident', 'service_request', 'problem', 'change'];
      const execModes = ['standard', 'automated', 'manual'];
      const customerUsers = ['sarah.chen', 'james.wilson', 'priya.patel'];
      const expertUsers = ['mike.torres', 'emma.brooks'];
      const slaNames = ['Standard', 'Priority', 'Critical'];

      function weightedPick(rng, items, weights) {
        const total = weights.reduce((a, b) => a + b, 0);
        let r = rng() * total;
        for (let i = 0; i < items.length; i++) {
          r -= weights[i];
          if (r <= 0) return items[i];
        }
        return items[items.length - 1];
      }

      const ticketIds = [];
      for (let i = 0; i < 100; i++) {
        const tmpl = ticketTemplates[i % ticketTemplates.length];
        const status = weightedPick(rng, statuses, statusWeights);
        const requester = pick(rng, customerUsers);
        const assignee = (status === 'Open' && rng() < 0.4) ? null : pick(rng, expertUsers);
        const slaName = tmpl.pri === 'critical' ? 'Critical' : (tmpl.pri === 'high' ? 'Priority' : pick(rng, slaNames));
        const slaId = slaMap[slaName] || slaMap['Standard'];

        // Created date: spread over last 30 days
        const daysAgo = Math.floor(rng() * 30);
        const hoursAgo = Math.floor(rng() * 24);
        const createdAt = new Date(Date.now() - (daysAgo * 24 + hoursAgo) * 60 * 60 * 1000);

        const resolvedAt = (status === 'Resolved' || status === 'Closed')
          ? new Date(createdAt.getTime() + Math.floor(rng() * 48 * 60 * 60 * 1000))
          : null;

        const firstRespondedAt = (status !== 'Open')
          ? new Date(createdAt.getTime() + Math.floor(rng() * 4 * 60 * 60 * 1000))
          : null;

        const wt = pick(rng, workTypes);
        const em = pick(rng, execModes);
        const confidence = (0.7 + rng() * 0.3).toFixed(3);

        const [result] = await tenantConn.query(
          `INSERT INTO tickets (title, description, status, priority, category,
            requester_id, assignee_id, source, sla_definition_id, sla_applied_at,
            response_due_at, resolve_due_at, first_responded_at, resolved_at,
            work_type, execution_mode, classification_confidence, classified_by, classified_at,
            created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'web', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?, ?)`,
          [
            tmpl.title + (i >= ticketTemplates.length ? ` (#${Math.floor(i / ticketTemplates.length) + 1})` : ''),
            `User reported: ${tmpl.title}. Please investigate and resolve.`,
            status,
            tmpl.pri,
            tmpl.cat,
            userIds[requester],
            assignee ? userIds[assignee] : null,
            slaId,
            createdAt,
            new Date(createdAt.getTime() + (slaName === 'Critical' ? 15 : slaName === 'Priority' ? 60 : 240) * 60 * 1000),
            new Date(createdAt.getTime() + (slaName === 'Critical' ? 120 : slaName === 'Priority' ? 480 : 2880) * 60 * 1000),
            firstRespondedAt,
            resolvedAt,
            wt, em, confidence, createdAt,
            createdAt,
            resolvedAt || createdAt,
          ]
        );
        ticketIds.push(result.insertId);
      }

      console.log(`   Created ${ticketIds.length} tickets`);

      // ── 8. Seed Ticket Activity ───────────────────────────────────────
      console.log('📋 Seeding ticket activity...');

      let activityCount = 0;
      for (let i = 0; i < ticketIds.length; i++) {
        const ticketId = ticketIds[i];
        const requester = pick(rng, customerUsers);

        // Every ticket gets a "created" activity
        await tenantConn.query(
          `INSERT INTO ticket_activity (ticket_id, user_id, activity_type, description, created_at)
           VALUES (?, ?, 'created', 'Ticket created', NOW() - INTERVAL ? DAY)`,
          [ticketId, userIds[requester], Math.floor(rng() * 30)]
        );
        activityCount++;

        // ~50% get an assignment activity
        if (rng() < 0.5) {
          const expert = pick(rng, expertUsers);
          await tenantConn.query(
            `INSERT INTO ticket_activity (ticket_id, user_id, activity_type, description, created_at)
             VALUES (?, ?, 'assigned', ?, NOW() - INTERVAL ? DAY)`,
            [ticketId, userIds[expert], `Assigned to ${expert}`, Math.floor(rng() * 25)]
          );
          activityCount++;
        }

        // ~40% get a comment
        if (rng() < 0.4) {
          const commenter = pick(rng, expertUsers);
          await tenantConn.query(
            `INSERT INTO ticket_activity (ticket_id, user_id, activity_type, description, created_at)
             VALUES (?, ?, 'comment', 'Looking into this issue. Will update shortly.', NOW() - INTERVAL ? DAY)`,
            [ticketId, userIds[commenter], Math.floor(rng() * 20)]
          );
          activityCount++;
        }

        // Resolved/Closed tickets get a resolved activity
        if (i < ticketIds.length) {
          const tmpl = ticketTemplates[i % ticketTemplates.length];
          const status = weightedPick(seededRandom(42 + i), statuses, statusWeights);
          if (status === 'Resolved' || status === 'Closed') {
            const expert = pick(rng, expertUsers);
            await tenantConn.query(
              `INSERT INTO ticket_activity (ticket_id, user_id, activity_type, description, created_at)
               VALUES (?, ?, 'resolved', 'Issue resolved and verified', NOW() - INTERVAL ? DAY)`,
              [ticketId, userIds[expert], Math.floor(rng() * 10)]
            );
            activityCount++;
          }
        }
      }

      console.log(`   Created ${activityCount} activity records`);

      // ── 9. Seed KB Articles ───────────────────────────────────────────
      console.log('📚 Seeding knowledge base articles...');

      const kbArticles = [
        { id: 'KB-0001', title: 'Getting Started with ServiFlow', cat: 'Getting Started', content: '# Getting Started with ServiFlow\n\nWelcome to ServiFlow, your IT Service Management platform.\n\n## Quick Start\n1. Log in with your credentials\n2. Navigate to the Dashboard to see an overview\n3. Click "Raise Ticket" to create a new support request\n4. Track your tickets in the Tickets section\n\n## Key Features\n- **Dashboard**: Real-time overview of ticket stats and SLA performance\n- **Ticket Management**: Create, assign, and track IT support tickets\n- **CMDB**: Configuration Management Database for your IT assets\n- **Knowledge Base**: Self-service articles for common issues\n- **SLA Tracking**: Automated Service Level Agreement monitoring' },
        { id: 'KB-0002', title: 'How to Connect to the VPN', cat: 'Network', content: '# How to Connect to the VPN\n\n## Prerequisites\n- VPN client software installed (Cisco AnyConnect or GlobalProtect)\n- Active directory credentials\n- Two-factor authentication app configured\n\n## Steps\n1. Open the VPN client application\n2. Enter the VPN server address: `vpn.company.com`\n3. Enter your username and password\n4. Approve the 2FA push notification\n5. Wait for connection to be established\n\n## Troubleshooting\n- If connection fails, check your internet connectivity\n- Ensure your password hasn\'t expired\n- Try restarting the VPN client\n- Contact IT support if the issue persists' },
        { id: 'KB-0003', title: 'Resetting Your Password', cat: 'Getting Started', content: '# Resetting Your Password\n\n## Self-Service Reset\n1. Go to the password reset portal: `reset.company.com`\n2. Enter your username or email address\n3. Verify your identity via email or SMS code\n4. Create a new password meeting the complexity requirements\n\n## Password Requirements\n- Minimum 12 characters\n- At least one uppercase letter\n- At least one lowercase letter\n- At least one number\n- At least one special character\n- Cannot reuse last 5 passwords\n\n## If Self-Service Doesn\'t Work\nContact the IT Help Desk to request a manual password reset.' },
        { id: 'KB-0004', title: 'Setting Up Email on Mobile Devices', cat: 'Software', content: '# Setting Up Email on Mobile Devices\n\n## iPhone/iPad\n1. Go to Settings > Mail > Accounts > Add Account\n2. Select Microsoft Exchange\n3. Enter your email address and tap Next\n4. Enter your password when prompted\n5. Select the data you want to sync\n\n## Android\n1. Open the Outlook app from the Play Store\n2. Tap "Add Account"\n3. Enter your email address\n4. Enter your password\n5. Follow the prompts to complete setup\n\n## Common Issues\n- Ensure you have a stable internet connection\n- Check that your account is not locked\n- Verify two-factor authentication is configured' },
        { id: 'KB-0005', title: 'Network Printer Troubleshooting', cat: 'Network', content: '# Network Printer Troubleshooting\n\n## Basic Checks\n1. Verify the printer is powered on and online\n2. Check for any error messages on the printer display\n3. Ensure you are connected to the correct network\n4. Try printing a test page from the printer itself\n\n## Re-add the Printer\n1. Open Settings > Printers & Scanners\n2. Remove the existing printer\n3. Click "Add Printer"\n4. Select the printer from the network list\n5. Install any required drivers\n\n## Still Not Working?\n- Check printer queue for stuck jobs\n- Restart the print spooler service\n- Verify network connectivity to the printer IP\n- Log a ticket with IT support' },
        { id: 'KB-0006', title: 'Security Best Practices', cat: 'Security', content: '# Security Best Practices\n\n## Password Hygiene\n- Use unique passwords for each service\n- Use a password manager to store credentials\n- Enable two-factor authentication wherever possible\n- Never share your passwords\n\n## Email Safety\n- Be cautious of unexpected attachments\n- Verify sender email addresses carefully\n- Don\'t click links in suspicious emails\n- Report phishing attempts to IT Security\n\n## Device Security\n- Keep your operating system updated\n- Don\'t install unapproved software\n- Lock your screen when away from your desk\n- Use encrypted USB drives for sensitive data\n- Report lost or stolen devices immediately' },
        { id: 'KB-0007', title: 'Requesting New Software', cat: 'Software', content: '# Requesting New Software\n\n## Process\n1. Check the approved software catalogue first\n2. If the software is listed, raise a ticket with category "Software"\n3. For new software not in the catalogue:\n   - Submit a Software Request form\n   - Include business justification\n   - Provide licensing cost information\n   - Wait for approval from your manager and IT\n\n## Timeline\n- Approved catalogue software: 1-2 business days\n- New software requests: 5-10 business days (includes security review)\n\n## Licensing\nAll software must be properly licensed. Personal licenses cannot be used for work purposes.' },
        { id: 'KB-0008', title: 'WiFi Troubleshooting Guide', cat: 'Network', content: '# WiFi Troubleshooting Guide\n\n## Quick Fixes\n1. Turn WiFi off and back on\n2. Forget the network and reconnect\n3. Restart your device\n4. Move closer to an access point\n\n## Network Names\n- **CORP-WiFi**: Main corporate network (requires domain credentials)\n- **GUEST-WiFi**: Guest network (limited access, no internal resources)\n- **IoT-Network**: For approved IoT devices only\n\n## Slow WiFi?\n- Check how many devices are connected\n- Try a different frequency band (5GHz vs 2.4GHz)\n- Report persistent issues with your location for a WiFi survey\n\n## Cannot Connect?\n- Verify your credentials are correct\n- Check if your device is registered in MDM\n- Contact IT for device-specific issues' },
        { id: 'KB-0009', title: 'Data Classification Policy', cat: 'Policies', content: '# Data Classification Policy\n\n## Classification Levels\n\n### Public\n- Marketing materials, public website content\n- No restrictions on sharing\n\n### Internal\n- General business documents, procedures\n- Share within the organisation only\n\n### Confidential\n- Financial data, HR records, customer PII\n- Need-to-know basis, encrypted storage required\n\n### Restricted\n- Trade secrets, unreleased product information\n- Requires explicit authorisation for access\n\n## Handling Guidelines\n- Label documents with their classification level\n- Use encrypted channels for Confidential and Restricted data\n- Never store classified data on personal devices\n- Report any suspected data breaches immediately' },
        { id: 'KB-0010', title: 'Remote Working IT Guide', cat: 'Getting Started', content: '# Remote Working IT Guide\n\n## Essential Setup\n1. Connect to VPN before accessing internal resources\n2. Use your company laptop (not personal devices)\n3. Ensure your home WiFi is password-protected\n4. Keep your operating system and software updated\n\n## Tools for Remote Work\n- **Microsoft Teams**: Video calls and messaging\n- **SharePoint/OneDrive**: File storage and sharing\n- **VPN**: Secure access to internal networks\n- **Remote Desktop**: Access office computers remotely\n\n## Best Practices\n- Lock your screen when stepping away\n- Don\'t work on sensitive documents in public spaces\n- Use a headset for confidential calls\n- Report any security concerns immediately' },
        { id: 'KB-0011', title: 'Multi-Factor Authentication Setup', cat: 'Security', content: '# Multi-Factor Authentication (MFA) Setup\n\n## Why MFA?\nMFA adds an extra layer of security to your accounts by requiring a second form of verification.\n\n## Setting Up MFA\n1. Download the Microsoft Authenticator app\n2. Go to https://aka.ms/mfasetup\n3. Sign in with your work credentials\n4. Follow the prompts to add your account\n5. Scan the QR code with the Authenticator app\n6. Enter the verification code to confirm\n\n## Backup Methods\n- Add a phone number for SMS codes\n- Print recovery codes and store securely\n\n## Lost Your Phone?\n- Contact IT immediately to reset your MFA\n- Use a backup verification method if available' },
        { id: 'KB-0012', title: 'Approved Software Catalogue', cat: 'Software', content: '# Approved Software Catalogue\n\n## Productivity\n- Microsoft 365 (Word, Excel, PowerPoint, Outlook)\n- Adobe Acrobat Reader DC\n- Notepad++\n- 7-Zip\n\n## Communication\n- Microsoft Teams\n- Zoom (approved for external meetings)\n- Slack (team-specific approval required)\n\n## Development\n- Visual Studio Code\n- Git for Windows\n- Node.js (LTS versions)\n- Python 3.x\n\n## Security\n- CrowdStrike Falcon (required — do not uninstall)\n- BitLocker (required — do not disable)\n\n## How to Request\nRaise a ticket with category "Software" and specify the application name.' },
        { id: 'KB-0013', title: 'Incident Management Process', cat: 'Policies', content: '# Incident Management Process\n\n## What is an Incident?\nAn unplanned interruption or reduction in quality of an IT service.\n\n## Priority Levels\n- **Critical**: Major business impact, multiple users affected\n- **High**: Significant impact, workaround may exist\n- **Medium**: Moderate impact, service degraded\n- **Low**: Minimal impact, cosmetic issues\n\n## Response Times\n| Priority | Response | Resolution |\n|----------|----------|------------|\n| Critical | 15 min | 2 hours |\n| High | 1 hour | 8 hours |\n| Medium | 4 hours | 48 hours |\n| Low | 8 hours | 5 days |\n\n## Escalation\nTickets are automatically escalated if SLA targets are at risk.' },
        { id: 'KB-0014', title: 'Acceptable Use Policy', cat: 'Policies', content: '# Acceptable Use Policy\n\n## Purpose\nThis policy defines acceptable use of IT resources provided by the company.\n\n## Acceptable Use\n- Work-related activities and communications\n- Reasonable personal use during breaks\n- Professional development and training\n\n## Prohibited Activities\n- Installing unauthorised software\n- Accessing inappropriate or illegal content\n- Sharing credentials or access tokens\n- Using company resources for personal business\n- Bypassing security controls\n- Downloading copyrighted material without license\n\n## Monitoring\nIT systems are monitored for security purposes. Users should have no expectation of privacy on company devices.\n\n## Violations\nViolations may result in disciplinary action.' },
        { id: 'KB-0015', title: 'How to Use the CMDB', cat: 'Getting Started', content: '# How to Use the CMDB\n\n## What is the CMDB?\nThe Configuration Management Database (CMDB) tracks all IT assets and their relationships.\n\n## Browsing Assets\n1. Navigate to the CMDB section from the sidebar\n2. Use filters to narrow by category, company, or status\n3. Click on any asset to view its details\n\n## Asset Categories\n- **Hardware**: Laptops, servers, printers, network equipment\n- **Software**: Licenses, applications, SaaS subscriptions\n- **Network**: Switches, routers, firewalls, access points\n- **Cloud**: Cloud instances, services, and subscriptions\n\n## Linking to Tickets\nWhen raising a ticket, you can link it to an affected CMDB item for better context and reporting.\n\n## Reporting\nCMDB data feeds into reports showing asset health, distribution, and SLA coverage.' },
      ];

      // Ensure kb_categories has entries for all article categories
      const articleCats = [...new Set(kbArticles.map(a => a.cat))];
      for (let i = 0; i < articleCats.length; i++) {
        const catName = articleCats[i];
        const slug = catName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        await tenantConn.query(
          `INSERT IGNORE INTO kb_categories (name, slug, sort_order) VALUES (?, ?, ?)`,
          [catName, slug, 10 + i]
        );
      }

      for (const kb of kbArticles) {
        await tenantConn.query(
          `INSERT IGNORE INTO kb_articles (article_id, title, content, category, status, visibility, source_type, created_by, published_at)
           VALUES (?, ?, ?, ?, 'published', 'public', 'manual', ?, NOW())`,
          [kb.id, kb.title, kb.content, kb.cat, userIds['demo_admin']]
        );
      }

      console.log(`   Created ${kbArticles.length} KB articles`);

      // ── 10. Seed Demo Personas ────────────────────────────────────────
      console.log('🎭 Seeding demo personas...');

      const personas = [
        { key: 'admin', display: 'Admin', user: 'demo_admin', role: 'admin', company: null, desc: 'Full admin access — settings, SLA, integrations', sort: 0 },
        { key: 'service_manager', display: 'Service Manager', user: 'alex.morgan', role: 'admin', company: null, desc: 'Service delivery manager view', sort: 1 },
        { key: 'expert_l1', display: 'Expert L1', user: 'mike.torres', role: 'expert', company: null, desc: 'First-line support — hardware & network', sort: 2 },
        { key: 'expert_l2', display: 'Expert L2', user: 'emma.brooks', role: 'expert', company: null, desc: 'Second-line — software & cloud', sort: 3 },
        { key: 'customer_fintech', display: 'Customer (FinTechCo)', user: 'sarah.chen', role: 'customer', company: 'FinTechCo Ltd', desc: 'Financial services company customer', sort: 4 },
        { key: 'customer_medtech', display: 'Customer (MedTech)', user: 'james.wilson', role: 'customer', company: 'MedTech Systems', desc: 'Healthcare technology customer', sort: 5 },
        { key: 'customer_retail', display: 'Customer (Retail)', user: 'priya.patel', role: 'customer', company: 'Global Retail Group', desc: 'Retail group customer', sort: 6 },
      ];

      for (const p of personas) {
        await tenantConn.query(
          `INSERT IGNORE INTO demo_personas (persona_key, display_name, user_id, role, company_id, description, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [p.key, p.display, userIds[p.user], p.role, p.company ? companyIds[p.company] : null, p.desc, p.sort]
        );
      }

      console.log(`   Created ${personas.length} personas`);

      // ── 11. Seed Tenant Settings ──────────────────────────────────────
      console.log('⚙️  Seeding tenant settings...');

      const settings = [
        { key: 'company_name', value: 'ServiFlow Demo MSP', type: 'string' },
        { key: 'timezone', value: 'Europe/London', type: 'string' },
        { key: 'date_format', value: 'DD/MM/YYYY', type: 'string' },
        { key: 'auto_assign', value: 'true', type: 'boolean' },
        { key: 'email_notifications', value: 'true', type: 'boolean' },
        { key: 'ai_classification', value: 'true', type: 'boolean' },
        { key: 'enable_chatbot', value: 'true', type: 'boolean' },
        { key: 'enable_knowledge_base', value: 'true', type: 'boolean' },
      ];

      // Create table if not exists (migration may not have run)
      await tenantConn.query(`
        CREATE TABLE IF NOT EXISTS tenant_settings (
          id INT AUTO_INCREMENT PRIMARY KEY,
          setting_key VARCHAR(100) NOT NULL UNIQUE,
          setting_value TEXT,
          setting_type ENUM('boolean', 'string', 'number', 'json') DEFAULT 'string',
          description TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_setting_key (setting_key)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      for (const s of settings) {
        await tenantConn.query(
          `INSERT IGNORE INTO tenant_settings (setting_key, setting_value, setting_type)
           VALUES (?, ?, ?)`,
          [s.key, s.value, s.type]
        );
      }

      console.log(`   Created ${settings.length} settings`);

      // ── 12. Seed tenant_features ──────────────────────────────────────
      console.log('🎛️  Seeding tenant features...');
      await tenantConn.query(`
        CREATE TABLE IF NOT EXISTS tenant_features (
          id INT AUTO_INCREMENT PRIMARY KEY,
          feature_key VARCHAR(100) NOT NULL UNIQUE,
          enabled BOOLEAN NOT NULL DEFAULT FALSE,
          plan_requirement VARCHAR(50) DEFAULT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_feature_key (feature_key)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      const features = [
        { key: 'cmdb', enabled: true },
        { key: 'knowledge_base', enabled: true },
        { key: 'sla_management', enabled: true },
        { key: 'ai_classification', enabled: true },
        { key: 'email_ingest', enabled: true },
        { key: 'chatbot', enabled: true },
        { key: 'reports', enabled: true },
        { key: 'teams_integration', enabled: true },
        { key: 'slack_integration', enabled: true },
      ];

      for (const f of features) {
        await tenantConn.query(
          `INSERT IGNORE INTO tenant_features (feature_key, enabled)
           VALUES (?, ?)`,
          [f.key, f.enabled]
        );
      }

      console.log(`   Created ${features.length} features`);

      // ── 13. Create AI tables and seed AI email analysis ─────────────────
      console.log('🧠 Seeding AI analysis data...');

      // Create AI tables if they don't exist
      await tenantConn.query(`
        CREATE TABLE IF NOT EXISTS ai_email_analysis (
          id INT AUTO_INCREMENT PRIMARY KEY,
          ticket_id INT NOT NULL,
          sentiment VARCHAR(50),
          confidence_score INT,
          ai_category VARCHAR(100),
          root_cause_type VARCHAR(100),
          impact_level VARCHAR(50),
          key_phrases JSON,
          technical_terms JSON,
          suggested_assignee VARCHAR(100),
          estimated_resolution_time INT,
          similar_ticket_ids JSON,
          analysis_timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          ai_model_version VARCHAR(100),
          processing_time_ms INT,
          FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
          INDEX idx_ticket_id (ticket_id),
          INDEX idx_sentiment (sentiment),
          INDEX idx_ai_category (ai_category)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      await tenantConn.query(`
        CREATE TABLE IF NOT EXISTS ai_insights (
          id INT AUTO_INCREMENT PRIMARY KEY,
          insight_type VARCHAR(50) NOT NULL,
          title VARCHAR(200) NOT NULL,
          description TEXT,
          severity VARCHAR(50),
          affected_tickets JSON,
          metrics JSON,
          time_range_start TIMESTAMP NULL,
          time_range_end TIMESTAMP NULL,
          status ENUM('active', 'acknowledged', 'resolved') DEFAULT 'active',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_insight_type (insight_type),
          INDEX idx_severity (severity),
          INDEX idx_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      await tenantConn.query(`
        CREATE TABLE IF NOT EXISTS ai_action_log (
          id INT AUTO_INCREMENT PRIMARY KEY,
          ticket_id INT NOT NULL,
          user_id INT NULL,
          action_type VARCHAR(50) NOT NULL,
          action_params JSON,
          executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          success BOOLEAN DEFAULT TRUE,
          error_message TEXT,
          FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
          INDEX idx_ticket_id (ticket_id),
          INDEX idx_action_type (action_type)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      // Add ai_analyzed column to tickets if missing
      const [aiAnalyzedCol] = await tenantConn.query(
        "SHOW COLUMNS FROM tickets LIKE 'ai_analyzed'"
      );
      if (aiAnalyzedCol.length === 0) {
        await tenantConn.query('ALTER TABLE tickets ADD COLUMN ai_analyzed BOOLEAN DEFAULT FALSE');
      }

      // Seed ai_email_analysis for ~85 of the 100 tickets
      const sentiments = ['positive', 'neutral', 'negative', 'urgent'];
      const sentimentWeights = [20, 45, 25, 10];
      const aiCategories = ['Hardware Failure', 'Software Bug', 'Network Connectivity', 'Access Management',
                            'Configuration Issue', 'Performance Degradation', 'Security Concern', 'Service Request'];
      const rootCauses = ['Configuration', 'Hardware Failure', 'Software Bug', 'User Error',
                          'Network Issue', 'Capacity', 'Security', 'Third Party'];
      const impactLevels = ['individual', 'team', 'department', 'organization'];

      const rng2 = seededRandom(99);
      let aiAnalysisCount = 0;

      for (let i = 0; i < ticketIds.length; i++) {
        if (rng2() > 0.85) continue; // skip ~15%

        const sentiment = weightedPick(rng2, sentiments, sentimentWeights);
        const confidence = Math.floor(70 + rng2() * 30);
        const aiCat = pick(rng2, aiCategories);
        const rootCause = pick(rng2, rootCauses);
        const impact = pick(rng2, impactLevels);
        const estResolution = Math.floor(30 + rng2() * 240); // 30-270 minutes
        const processingTime = Math.floor(800 + rng2() * 3000);

        const keyPhrases = JSON.stringify(
          [pick(rng2, ['cannot access', 'not working', 'slow performance', 'error message', 'keeps crashing']),
           pick(rng2, ['since yesterday', 'intermittent', 'affecting team', 'urgent', 'recurring issue'])]
        );
        const techTerms = JSON.stringify(
          [pick(rng2, ['VPN', 'DHCP', 'DNS', 'Active Directory', 'SSL', 'API', 'SMTP', 'TCP/IP']),
           pick(rng2, ['firewall', 'proxy', 'endpoint', 'registry', 'driver', 'firmware', 'cache'])]
        );

        // Pick a suggested assignee from experts
        const suggestedAssignee = pick(rng2, expertUsers);

        // Created at: around the ticket creation time (within a few hours)
        const ticketAge = 30 - Math.floor(i * 30 / ticketIds.length);
        const analysisDate = new Date(Date.now() - (ticketAge * 24 - 2) * 60 * 60 * 1000);

        await tenantConn.query(
          `INSERT INTO ai_email_analysis
           (ticket_id, sentiment, confidence_score, ai_category, root_cause_type,
            impact_level, key_phrases, technical_terms, suggested_assignee,
            estimated_resolution_time, similar_ticket_ids, analysis_timestamp,
            ai_model_version, processing_time_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, 'claude-3-5-sonnet-20241022', ?)`,
          [ticketIds[i], sentiment, confidence, aiCat, rootCause,
           impact, keyPhrases, techTerms, suggestedAssignee,
           estResolution, analysisDate, processingTime]
        );
        aiAnalysisCount++;
      }

      // Mark analyzed tickets
      await tenantConn.query(
        `UPDATE tickets SET ai_analyzed = TRUE WHERE id IN (
          SELECT ticket_id FROM ai_email_analysis
        )`
      );

      console.log(`   Created ${aiAnalysisCount} AI email analyses`);

      // ── 14. Seed AI Insights ────────────────────────────────────────────
      console.log('📊 Seeding AI insights...');

      const now = new Date();
      const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
      const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

      const insights = [
        {
          type: 'volume_spike', title: 'Network Ticket Volume Spike Detected',
          desc: 'Network-related tickets increased 180% over the past 7 days compared to the previous period. 12 new network tickets were created, versus an average of 4.3 per week.',
          severity: 'warning',
          tickets: JSON.stringify(ticketIds.slice(0, 8)),
          metrics: JSON.stringify({ avgCount: 4.3, currentCount: 12, percentIncrease: 180, category: 'Network' }),
          start: twoWeeksAgo, end: oneWeekAgo,
          status: 'active'
        },
        {
          type: 'sentiment_trend', title: 'Negative Sentiment Rising in FinTechCo Tickets',
          desc: 'Sentiment analysis shows 65% of FinTechCo tickets in the past 5 days carry negative or urgent sentiment, up from 30% the previous week. Consider proactive outreach.',
          severity: 'warning',
          tickets: JSON.stringify(ticketIds.slice(10, 18)),
          metrics: JSON.stringify({ currentNegativePct: 65, previousNegativePct: 30, company: 'FinTechCo Ltd', period: '5 days' }),
          start: fiveDaysAgo, end: now,
          status: 'active'
        },
        {
          type: 'sla_risk', title: 'SLA Compliance Dropping Below Threshold',
          desc: 'SLA compliance has dropped to 82% this week (target: 90%). 6 tickets breached response SLA and 3 breached resolution SLA. Primary cause: unassigned tickets in the queue.',
          severity: 'critical',
          tickets: JSON.stringify(ticketIds.slice(20, 29)),
          metrics: JSON.stringify({ compliancePct: 82, target: 90, responseBreaches: 6, resolveBreaches: 3 }),
          start: oneWeekAgo, end: now,
          status: 'active'
        },
        {
          type: 'category_trend', title: 'Recurring Printing Issues — Potential Hardware Problem',
          desc: 'Printing category tickets have appeared 8 times in the past 10 days, affecting 2 companies. The pattern suggests a shared infrastructure issue rather than isolated incidents.',
          severity: 'info',
          tickets: JSON.stringify(ticketIds.slice(30, 38)),
          metrics: JSON.stringify({ category: 'Printing', count: 8, period: '10 days', affectedCompanies: 2 }),
          start: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000), end: now,
          status: 'active'
        },
        {
          type: 'resolution_trend', title: 'Average Resolution Time Improved by 25%',
          desc: 'Average ticket resolution time decreased from 18.4 hours to 13.8 hours this week. Largest improvement in Software category (42% faster). AI-assisted routing may be contributing.',
          severity: 'info',
          tickets: JSON.stringify([]),
          metrics: JSON.stringify({ previousAvgHours: 18.4, currentAvgHours: 13.8, improvementPct: 25, bestCategory: 'Software', bestCategoryImprovement: 42 }),
          start: oneWeekAgo, end: now,
          status: 'active'
        },
        {
          type: 'workload_alert', title: 'Expert L1 Workload Exceeding Capacity',
          desc: 'mike.torres has 12 active tickets assigned, exceeding the recommended maximum of 8. Consider redistributing 4 tickets to emma.brooks who has capacity.',
          severity: 'warning',
          tickets: JSON.stringify(ticketIds.slice(40, 52)),
          metrics: JSON.stringify({ expert: 'mike.torres', activeTickets: 12, maxRecommended: 8, alternateExpert: 'emma.brooks', alternateCapacity: 4 }),
          start: threeDaysAgo, end: now,
          status: 'active'
        },
        {
          type: 'root_cause', title: 'Configuration Issues Are Top Root Cause',
          desc: 'AI analysis identified Configuration as the root cause in 34% of tickets this month, followed by User Error (22%) and Hardware Failure (18%). Consider updating documentation and deployment checklists.',
          severity: 'info',
          tickets: JSON.stringify([]),
          metrics: JSON.stringify({ topCause: 'Configuration', topCausePct: 34, secondCause: 'User Error', secondCausePct: 22, thirdCause: 'Hardware Failure', thirdCausePct: 18 }),
          start: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), end: now,
          status: 'acknowledged'
        },
        {
          type: 'volume_spike', title: 'Account Access Tickets Spike on Monday Mornings',
          desc: 'Pattern detected: Account Access tickets are 3x higher on Mondays between 8-10 AM. This is likely due to password expiry policies hitting over the weekend. Consider adjusting expiry windows.',
          severity: 'info',
          tickets: JSON.stringify(ticketIds.slice(55, 62)),
          metrics: JSON.stringify({ category: 'Account Access', peakDay: 'Monday', peakHours: '08:00-10:00', multiplier: 3 }),
          start: new Date(now.getTime() - 21 * 24 * 60 * 60 * 1000), end: now,
          status: 'resolved'
        },
      ];

      let insightCount = 0;
      for (const ins of insights) {
        await tenantConn.query(
          `INSERT INTO ai_insights (insight_type, title, description, severity, affected_tickets, metrics, time_range_start, time_range_end, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [ins.type, ins.title, ins.desc, ins.severity, ins.tickets, ins.metrics, ins.start, ins.end, ins.status,
           new Date(ins.end.getTime() - Math.floor(Math.random() * 2 * 60 * 60 * 1000))]
        );
        insightCount++;
      }

      console.log(`   Created ${insightCount} AI insights`);

      // ── 15. Seed ticket-CMDB links ──────────────────────────────────────
      console.log('🔗 Seeding ticket-CMDB links...');

      // Get CMDB item IDs
      const [cmdbRows] = await tenantConn.query('SELECT id, asset_name, asset_category FROM cmdb_items ORDER BY id');
      let cmdbLinkCount = 0;

      for (let i = 0; i < Math.min(ticketIds.length, 60); i++) {
        if (rng2() > 0.6) continue; // ~60% of first 60 tickets get a CMDB link
        const cmdbItem = cmdbRows[Math.floor(rng2() * cmdbRows.length)];
        const relTypes = ['affected', 'caused_by', 'related'];
        const matchMethods = ['ai', 'manual', 'auto'];
        try {
          await tenantConn.query(
            `INSERT IGNORE INTO ticket_cmdb_items (ticket_id, cmdb_item_id, relationship_type, confidence_score, matched_by, match_reason, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [ticketIds[i], cmdbItem.id, pick(rng2, relTypes),
             (70 + rng2() * 30).toFixed(2), pick(rng2, matchMethods),
             `Matched based on ${cmdbItem.asset_category} category and ticket context`,
             userIds[pick(rng2, expertUsers)]]
          );
          cmdbLinkCount++;
        } catch (e) { /* skip duplicates */ }
      }

      console.log(`   Created ${cmdbLinkCount} ticket-CMDB links`);

      // ── 16. Seed CMDB change history ────────────────────────────────────
      console.log('📝 Seeding CMDB change history...');

      const changeTypes = ['created', 'updated', 'relationship_added', 'custom_field_updated'];
      let changeCount = 0;

      for (const item of cmdbRows) {
        // Each CMDB item gets 1-4 change records
        const numChanges = 1 + Math.floor(rng2() * 4);
        for (let j = 0; j < numChanges; j++) {
          const daysAgo = Math.floor(rng2() * 30);
          const changeType = j === 0 ? 'created' : pick(rng2, changeTypes);
          const changeDesc = changeType === 'created' ? `${item.asset_name} added to CMDB`
            : changeType === 'relationship_added' ? `Linked to configuration item`
            : changeType === 'custom_field_updated' ? `Custom field updated for ${item.asset_name}`
            : `${item.asset_name} details updated`;

          await tenantConn.query(
            `INSERT INTO cmdb_change_history (cmdb_item_id, change_type, field_name, old_value, new_value, changed_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, NOW() - INTERVAL ? DAY)`,
            [item.id, changeType,
             changeType === 'updated' ? 'status' : changeType === 'custom_field_updated' ? 'asset_location' : null,
             changeType === 'updated' ? 'inactive' : null,
             changeType === 'updated' ? 'active' : changeDesc,
             userIds[pick(rng2, ['demo_admin', 'mike.torres', 'emma.brooks'])],
             daysAgo]
          );
          changeCount++;
        }
      }

      console.log(`   Created ${changeCount} CMDB change records`);

      // ── 17. Seed expert profiles ────────────────────────────────────────
      console.log('👨‍💻 Seeding expert profiles...');

      await tenantConn.query(
        `UPDATE experts SET skills = ?, availability_status = 'available', max_concurrent_tickets = 10
         WHERE user_id = ?`,
        ['Network, Hardware, Account Access, Printing', userIds['mike.torres']]
      );
      await tenantConn.query(
        `UPDATE experts SET skills = ?, availability_status = 'available', max_concurrent_tickets = 8
         WHERE user_id = ?`,
        ['Software, Email, Security, Cloud, Network', userIds['emma.brooks']]
      );

      console.log('   Updated 2 expert profiles');

      // ── 18. Seed report history ─────────────────────────────────────────
      console.log('📄 Seeding report history...');

      const reportMonths = [
        { month: 1, year: 2026, label: 'January 2026' },
        { month: 12, year: 2025, label: 'December 2025' },
      ];

      for (const rm of reportMonths) {
        await tenantConn.query(
          `INSERT IGNORE INTO report_history
           (report_type, period_month, period_year, company_filter, generated_by,
            recipients_json, ticket_count, cmdb_change_count, sla_compliance_pct,
            status, generated_at)
           VALUES ('monthly', ?, ?, NULL, ?, ?, ?, ?, ?, 'sent', ?)`,
          [rm.month, rm.year, userIds['demo_admin'],
           JSON.stringify(['admin@serviflowdemo.com', 'reports@serviflowdemo.com']),
           Math.floor(80 + Math.random() * 40),
           Math.floor(20 + Math.random() * 30),
           (82 + Math.random() * 15).toFixed(1),
           new Date(rm.year, rm.month, 1)] // generated on the 1st of the following month
        );
      }

      console.log(`   Created ${reportMonths.length} report history records`);

      // ── 19. Seed AI action log ──────────────────────────────────────────
      console.log('🤖 Seeding AI action log...');

      const actionTypes = ['classify', 'suggest_priority', 'suggest_assignee', 'auto_respond', 'detect_sentiment'];
      let actionCount = 0;

      for (let i = 0; i < 40; i++) {
        const ticketId = ticketIds[Math.floor(rng2() * ticketIds.length)];
        const actionType = pick(rng2, actionTypes);
        const daysAgo = Math.floor(rng2() * 30);

        await tenantConn.query(
          `INSERT INTO ai_action_log (ticket_id, user_id, action_type, action_params, executed_at, success)
           VALUES (?, ?, ?, ?, NOW() - INTERVAL ? DAY, TRUE)`,
          [ticketId, userIds[pick(rng2, expertUsers)], actionType,
           JSON.stringify({ model: 'claude-3-5-sonnet', confidence: (0.75 + rng2() * 0.25).toFixed(3) }),
           daysAgo]
        );
        actionCount++;
      }

      console.log(`   Created ${actionCount} AI action log entries`);

    } finally {
      await tenantConn.end();
    }

    console.log('\n✅ Demo seeding complete!');
    console.log('   Login: demo@serviflow.app / Demo123!');
    console.log('   Tenant code: demo\n');

  } finally {
    await rootConn.end();
  }
}

// ─── Create Tenant Tables ───────────────────────────────────────────────────
// Replicates the schema from tenant-provisioning.js createTenantTables()
// We call the actual function if possible, otherwise create manually

async function createAllTenantTables(conn) {
  // Try to use the real provisioning function
  try {
    const provisioning = require('../services/tenant-provisioning');
    // createTenantTables is not exported, but createTenantDatabase is
    // However createTenantDatabase creates the DB too, which we already did
    // So we'll create a shim that passes our connection to the internal function
    // Actually, let's just create the DB via provisioning if the function is available
  } catch (e) {
    // ignore
  }

  // Use the provisioning service's createTenantDatabase approach:
  // We already have the database, just need to create tables
  // Call the provisioning module's exported createTenantDatabase won't work
  // because it expects root connection + creates DB. Instead we directly
  // execute the schema. We import the provisioning module to keep in sync.

  // The simplest approach: create a temporary root connection, drop into the DB,
  // and let createTenantDatabase handle it. But we already created it.
  // Let's just use the provisioning module indirectly.

  const mysql2 = require('mysql2/promise');
  const rootConn = await mysql2.createConnection({
    host: dbHost,
    port: process.env.MYSQLPORT || process.env.MYSQL_PORT || 3306,
    user: process.env.MYSQLUSER || process.env.MYSQL_USER || 'root',
    password: process.env.MYSQLPASSWORD || process.env.MYSQL_PASSWORD || '',
  });

  try {
    const { createTenantDatabase } = require('../services/tenant-provisioning');
    const dbUser = process.env.MYSQLUSER || 'root';
    const dbPassword = process.env.MYSQLPASSWORD || '';
    await createTenantDatabase(rootConn, 'demo', dbUser, dbPassword);
  } finally {
    await rootConn.end();
  }
}

// ─── Run ────────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
