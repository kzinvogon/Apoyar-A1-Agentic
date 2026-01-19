/**
 * Tenant Provisioning Service
 * Handles automated tenant creation during self-service signup
 *
 * Creates:
 * - Tenant record in master database
 * - Tenant database with full schema
 * - Admin user in tenant database
 * - Subscription record
 * - Feature sync
 */

const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { getMasterConnection } = require('../config/database');
const stripeService = require('./stripe-service');
const { sendEmail } = require('../config/email');

// Trial duration from environment (default 30 days = 43200 minutes)
const TRIAL_DURATION_MINUTES = parseInt(process.env.TRIAL_DURATION_MINUTES || '43200', 10);

/**
 * Send welcome email to new tenant admin
 */
async function sendWelcomeEmail(email, tenantName, tenantCode, trialEndsAt) {
  const trialEndDate = new Date(trialEndsAt).toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const appUrl = process.env.APP_URL || 'https://www.serviflow.app';

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); color: white; padding: 30px; text-align: center; border-radius: 12px 12px 0 0; }
        .content { background: #f9fafb; padding: 30px; border-radius: 0 0 12px 12px; }
        .button { display: inline-block; background: #6366f1; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600; margin: 10px 0; }
        .step { background: white; padding: 15px; margin: 10px 0; border-radius: 8px; border-left: 4px solid #6366f1; }
        .step-number { background: #6366f1; color: white; width: 24px; height: 24px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: bold; margin-right: 10px; }
        .trial-badge { background: #fef3c7; color: #92400e; padding: 8px 16px; border-radius: 20px; font-size: 14px; display: inline-block; margin-top: 10px; }
        .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1 style="margin:0;font-size:28px;">Welcome to ServiFlow!</h1>
          <p style="margin:10px 0 0 0;opacity:0.9;">Your IT Service Management Platform</p>
        </div>
        <div class="content">
          <p>Hi there,</p>
          <p>Great news! Your ServiFlow account for <strong>${tenantName}</strong> is ready to go.</p>

          <div class="trial-badge">
            🎉 Your free trial is active until ${trialEndDate}
          </div>

          <h3 style="margin-top:25px;">Getting Started in 5 Minutes</h3>

          <div class="step">
            <span class="step-number">1</span>
            <strong>Log In to Your Dashboard</strong>
            <p style="margin:5px 0 0 30px;color:#6b7280;">Access your account at <a href="${appUrl}">${appUrl}</a></p>
            <p style="margin:5px 0 0 30px;color:#6b7280;"><strong>Your login credentials:</strong></p>
            <ul style="margin:5px 0 0 40px;color:#6b7280;">
              <li>Tenant Code: <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px;">${tenantCode}</code></li>
              <li>Username: <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px;">admin</code></li>
              <li>Password: The password you created during registration</li>
            </ul>
          </div>

          <div class="step">
            <span class="step-number">2</span>
            <strong>Add Your Team</strong>
            <p style="margin:5px 0 0 30px;color:#6b7280;">Go to Admin Settings → Expert Registration to add technicians and support staff</p>
          </div>

          <div class="step">
            <span class="step-number">3</span>
            <strong>Configure Your Service Desk</strong>
            <p style="margin:5px 0 0 30px;color:#6b7280;">Set up ticket categories, SLAs, and email integration in Settings</p>
          </div>

          <div class="step">
            <span class="step-number">4</span>
            <strong>Create Your First Ticket</strong>
            <p style="margin:5px 0 0 30px;color:#6b7280;">Click "+ Raise Ticket" to see how easy it is to track issues</p>
          </div>

          <div class="step">
            <span class="step-number">5</span>
            <strong>Explore AI Features</strong>
            <p style="margin:5px 0 0 30px;color:#6b7280;">Try automatic ticket triage and smart routing with our AI assistant</p>
          </div>

          <div style="text-align:center;margin-top:30px;">
            <a href="${appUrl}" class="button">Go to My Dashboard →</a>
          </div>

          <h3 style="margin-top:30px;">Your Account Details</h3>
          <table style="width:100%;background:white;border-radius:8px;padding:15px;">
            <tr><td style="padding:8px;color:#6b7280;">Company:</td><td style="padding:8px;font-weight:600;">${tenantName}</td></tr>
            <tr><td style="padding:8px;color:#6b7280;">Tenant Code:</td><td style="padding:8px;font-family:monospace;background:#f3f4f6;border-radius:4px;">${tenantCode}</td></tr>
            <tr><td style="padding:8px;color:#6b7280;">Admin Email:</td><td style="padding:8px;">${email}</td></tr>
            <tr><td style="padding:8px;color:#6b7280;">Trial Ends:</td><td style="padding:8px;">${trialEndDate}</td></tr>
          </table>

          <h3 style="margin-top:30px;">Need Help?</h3>
          <p>Our support team is here to help you succeed:</p>
          <ul>
            <li>📧 Email: support@serviflow.app</li>
            <li>📚 Documentation: <a href="${appUrl}/docs">Help Center</a></li>
            <li>💬 In-app chat available on your dashboard</li>
          </ul>

          <p style="margin-top:20px;">Best of luck with your service desk!</p>
          <p><strong>The ServiFlow Team</strong></p>
        </div>
        <div class="footer">
          <p>© ${new Date().getFullYear()} ServiFlow. All rights reserved.</p>
          <p>You're receiving this because you signed up for a ServiFlow trial.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    // Send without tenant code check (this is a system email, not tenant-specific)
    const result = await sendEmail(null, {
      to: email,
      subject: `Welcome to ServiFlow - Your ${tenantName} account is ready!`,
      html: html,
      skipUserCheck: true
    });
    console.log(`[Provision] Welcome email sent to ${email}:`, result);
    return result;
  } catch (error) {
    console.error(`[Provision] Failed to send welcome email to ${email}:`, error.message);
    // Don't throw - email failure shouldn't block provisioning
    return { success: false, error: error.message };
  }
}

/**
 * Generate a unique tenant code from company name
 */
function generateTenantCode(companyName) {
  // Remove special characters, convert to lowercase, replace spaces with nothing
  // Limit to 14 chars to leave room for 6-char random suffix (total max 20)
  let code = companyName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '')
    .substring(0, 14);

  // Add random suffix to ensure uniqueness
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${code}${suffix}`;
}

/**
 * Generate a secure random password for database user
 */
function generateDbPassword() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Create the tenant database with full schema
 */
async function createTenantDatabase(connection, tenantCode, dbUser, dbPassword) {
  const databaseName = `a1_tenant_${tenantCode}`;

  // Create the database
  await connection.query(`CREATE DATABASE IF NOT EXISTS \`${databaseName}\``);
  console.log(`[Provision] Created database: ${databaseName}`);

  // Create tenant-specific database connection
  const tenantConnection = await mysql.createConnection({
    host: process.env.MYSQLHOST || process.env.DB_HOST || 'localhost',
    port: process.env.MYSQLPORT || process.env.DB_PORT || 3306,
    user: process.env.MYSQLUSER || process.env.DB_USER || 'root',
    password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || '',
    database: databaseName
  });

  try {
    // Create all tenant tables
    await createTenantTables(tenantConnection);
    console.log(`[Provision] Created tenant tables in ${databaseName}`);
  } finally {
    await tenantConnection.end();
  }

  return databaseName;
}

/**
 * Create all tables in tenant database
 */
async function createTenantTables(connection) {
  // Users table
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('admin', 'expert', 'customer') NOT NULL,
      email VARCHAR(100),
      full_name VARCHAR(100),
      is_active BOOLEAN DEFAULT TRUE,
      last_login TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  // Experts table
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS experts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      skills TEXT,
      availability_status ENUM('available', 'busy', 'offline') DEFAULT 'available',
      max_concurrent_tickets INT DEFAULT 5,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Customer Companies table (for multi-company support)
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS customer_companies (
      id INT AUTO_INCREMENT PRIMARY KEY,
      company_name VARCHAR(100) NOT NULL,
      company_domain VARCHAR(100),
      contact_email VARCHAR(255),
      contact_phone VARCHAR(20),
      address TEXT,
      sla_level ENUM('basic', 'premium', 'enterprise') DEFAULT 'basic',
      notes TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_company_domain (company_domain),
      INDEX idx_is_active (is_active)
    )
  `);

  // Customers table
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS customers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      customer_company_id INT,
      is_company_admin BOOLEAN DEFAULT FALSE,
      job_title VARCHAR(100),
      company_name VARCHAR(100),
      company_domain VARCHAR(100),
      contact_phone VARCHAR(20),
      address TEXT,
      sla_level ENUM('basic', 'premium', 'enterprise') DEFAULT 'basic',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (customer_company_id) REFERENCES customer_companies(id) ON DELETE SET NULL,
      INDEX idx_customer_company_id (customer_company_id)
    )
  `);

  // CMDB Items table (new schema with asset_name, asset_category, etc.)
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS cmdb_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      cmdb_id VARCHAR(50) UNIQUE,
      asset_name VARCHAR(255) NOT NULL,
      asset_category VARCHAR(100) NOT NULL,
      category_field_value VARCHAR(255),
      brand_name VARCHAR(100),
      model_name VARCHAR(100),
      customer_name VARCHAR(255),
      employee_of VARCHAR(255),
      asset_location VARCHAR(255),
      status ENUM('active', 'inactive', 'maintenance') DEFAULT 'active',
      created_by INT,
      comment TEXT,
      sla_definition_id INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
      INDEX idx_asset_category (asset_category),
      INDEX idx_customer_name (customer_name),
      INDEX idx_created_by (created_by),
      INDEX idx_sla_definition_id (sla_definition_id)
    )
  `);

  // Configuration Items table
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS configuration_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      cmdb_item_id INT NOT NULL,
      key_name VARCHAR(100) NOT NULL,
      value TEXT,
      data_type ENUM('string', 'number', 'boolean', 'json') DEFAULT 'string',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (cmdb_item_id) REFERENCES cmdb_items(id) ON DELETE CASCADE
    )
  `);

  // Tickets table
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS tickets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      description TEXT,
      status ENUM('Open', 'In Progress', 'Pending', 'Resolved', 'Closed') DEFAULT 'Open',
      priority ENUM('low', 'medium', 'high', 'critical') DEFAULT 'medium',
      category VARCHAR(50),
      requester_id INT NOT NULL,
      assignee_id INT,
      cmdb_item_id INT,
      source VARCHAR(50) DEFAULT 'web',
      source_metadata JSON,
      sla_deadline TIMESTAMP NULL,
      response_deadline TIMESTAMP NULL,
      first_responded_at TIMESTAMP NULL,
      resolved_at TIMESTAMP NULL,
      resolved_by INT,
      sla_definition_id INT,
      sla_applied_at TIMESTAMP NULL,
      response_due_at TIMESTAMP NULL,
      resolve_due_at TIMESTAMP NULL,
      notified_response_near_at TIMESTAMP NULL,
      notified_response_breached_at TIMESTAMP NULL,
      notified_response_past_at TIMESTAMP NULL,
      notified_resolve_near_at TIMESTAMP NULL,
      notified_resolve_breached_at TIMESTAMP NULL,
      notified_resolve_past_at TIMESTAMP NULL,
      sla_source VARCHAR(16),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (requester_id) REFERENCES users(id),
      FOREIGN KEY (assignee_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (cmdb_item_id) REFERENCES cmdb_items(id) ON DELETE SET NULL,
      INDEX idx_sla_definition_id (sla_definition_id)
    )
  `);

  // Ticket Activity table
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS ticket_activity (
      id INT AUTO_INCREMENT PRIMARY KEY,
      ticket_id INT NOT NULL,
      user_id INT,
      activity_type VARCHAR(50) NOT NULL,
      description TEXT,
      is_public BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  // Tenant audit log
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS tenant_audit_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT,
      action VARCHAR(100) NOT NULL,
      resource_type VARCHAR(50),
      resource_id INT,
      details JSON,
      ip_address VARCHAR(45),
      user_agent TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  // Tenant features table
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS tenant_features (
      id INT AUTO_INCREMENT PRIMARY KEY,
      feature_key VARCHAR(100) NOT NULL UNIQUE,
      enabled BOOLEAN DEFAULT TRUE,
      source ENUM('plan', 'override', 'trial', 'system') DEFAULT 'plan',
      expires_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  // Knowledge base articles
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS knowledge_articles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      content TEXT,
      category VARCHAR(50),
      tags JSON,
      is_published BOOLEAN DEFAULT FALSE,
      author_id INT,
      view_count INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  // Tenant settings
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS tenant_settings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      setting_key VARCHAR(100) NOT NULL UNIQUE,
      setting_value TEXT,
      setting_type VARCHAR(20) DEFAULT 'string',
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  // Insert default tenant settings
  await connection.execute(`
    INSERT IGNORE INTO tenant_settings (setting_key, setting_value, setting_type, description)
    VALUES
      ('customer_billing_enabled', 'false', 'boolean', 'Show Billing and Plans & Upgrades in customer portal'),
      ('enhanced_sla_billing_mode', 'none', 'string', 'SLA uplift tracking mode: none, report_only, or chargeback'),
      ('batch_delay_seconds', '2', 'number', 'Delay in seconds between batch processing operations (minimum 3)'),
      ('batch_size', '5', 'number', 'Maximum number of items to process per batch (maximum 10)'),
      ('sla_check_interval_seconds', '300', 'number', 'How often to check for SLA breaches in seconds (minimum 60)')
  `);

  // Business hours profiles table
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS business_hours_profiles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      timezone VARCHAR(100) NOT NULL DEFAULT 'UTC',
      days_of_week JSON NOT NULL,
      start_time TIME NOT NULL DEFAULT '09:00:00',
      end_time TIME NOT NULL DEFAULT '17:00:00',
      is_24x7 BOOLEAN DEFAULT FALSE,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_name (name)
    )
  `);

  // SLA definitions table
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS sla_definitions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      description TEXT,
      business_hours_profile_id INT,
      response_target_minutes INT NOT NULL DEFAULT 60,
      resolve_target_minutes INT NOT NULL DEFAULT 480,
      resolve_after_response_minutes INT DEFAULT NULL,
      near_breach_percent INT NOT NULL DEFAULT 85,
      past_breach_percent INT NOT NULL DEFAULT 120,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_name (name),
      FOREIGN KEY (business_hours_profile_id) REFERENCES business_hours_profiles(id) ON DELETE RESTRICT
    )
  `);

  // Insert default business hours profiles
  await connection.execute(`
    INSERT IGNORE INTO business_hours_profiles (name, timezone, days_of_week, start_time, end_time, is_24x7)
    VALUES
      ('Standard Business Hours', 'Australia/Sydney', '[1,2,3,4,5]', '09:00:00', '17:00:00', FALSE),
      ('24x7 Support', 'UTC', '[1,2,3,4,5,6,7]', '00:00:00', '23:59:59', TRUE)
  `);

  // Insert default SLA definitions
  await connection.execute(`
    INSERT IGNORE INTO sla_definitions (name, description, business_hours_profile_id, response_target_minutes, resolve_target_minutes)
    VALUES
      ('Basic SLA', 'Standard support SLA', 1, 240, 2880),
      ('Premium SLA', 'Priority support with faster response', 1, 60, 480),
      ('Critical SLA', '24x7 critical system support', 2, 15, 120)
  `);
}

/**
 * Create admin user in tenant database
 */
async function createTenantAdmin(tenantCode, email, password, fullName) {
  const databaseName = `a1_tenant_${tenantCode}`;

  const tenantConnection = await mysql.createConnection({
    host: process.env.MYSQLHOST || process.env.DB_HOST || 'localhost',
    port: process.env.MYSQLPORT || process.env.DB_PORT || 3306,
    user: process.env.MYSQLUSER || process.env.DB_USER || 'root',
    password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || '',
    database: databaseName
  });

  try {
    const passwordHash = await bcrypt.hash(password, 10);

    // Create admin user
    const [result] = await tenantConnection.execute(`
      INSERT INTO users (username, password_hash, role, email, full_name)
      VALUES (?, ?, 'admin', ?, ?)
    `, ['admin', passwordHash, email, fullName || 'Administrator']);

    console.log(`[Provision] Created admin user in ${databaseName}`);
    return result.insertId;
  } finally {
    await tenantConnection.end();
  }
}

/**
 * Sync plan features to tenant database
 */
async function syncPlanFeatures(tenantCode, planSlug) {
  const databaseName = `a1_tenant_${tenantCode}`;
  const masterConn = await getMasterConnection();

  try {
    // Get plan features from master
    const [plans] = await masterConn.query(
      'SELECT features FROM subscription_plans WHERE slug = ?',
      [planSlug]
    );

    if (plans.length === 0) {
      console.warn(`[Provision] Plan not found: ${planSlug}`);
      return;
    }

    const features = typeof plans[0].features === 'string'
      ? JSON.parse(plans[0].features)
      : plans[0].features || [];

    // Connect to tenant database
    const tenantConnection = await mysql.createConnection({
      host: process.env.MYSQLHOST || process.env.DB_HOST || 'localhost',
      port: process.env.MYSQLPORT || process.env.DB_PORT || 3306,
      user: process.env.MYSQLUSER || process.env.DB_USER || 'root',
      password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || '',
      database: databaseName
    });

    try {
      // Clear existing plan features
      await tenantConnection.execute(
        "DELETE FROM tenant_features WHERE source = 'plan'"
      );

      // Insert new features
      for (const featureKey of features) {
        await tenantConnection.execute(`
          INSERT INTO tenant_features (feature_key, enabled, source)
          VALUES (?, TRUE, 'plan')
          ON DUPLICATE KEY UPDATE enabled = TRUE, source = 'plan'
        `, [featureKey]);
      }

      console.log(`[Provision] Synced ${features.length} features for ${tenantCode}`);
    } finally {
      await tenantConnection.end();
    }
  } finally {
    masterConn.release();
  }
}

/**
 * Main provisioning function - creates everything for a new tenant
 */
async function provisionTenant(options) {
  const {
    email,
    tenantName,
    adminPassword,
    planSlug = 'professional',
    numTechnicians = 1,
    numClients = 0,
    signupSessionId = null,
    createStripeCustomer = true
  } = options;

  console.log(`[Provision] Starting provisioning for ${tenantName} (${email})`);

  const masterConn = await getMasterConnection();
  const tenantCode = generateTenantCode(tenantName);
  // Use actual environment password since we share the DB user on Railway
  const dbPassword = process.env.MYSQLPASSWORD || process.env.MYSQL_PASSWORD || '';

  try {
    // 1. Check if company/tenant_code already exists (only active tenants)
    const [existingTenant] = await masterConn.query(
      'SELECT id FROM tenants WHERE (company_name = ? OR tenant_code = ?) AND status = "active"',
      [tenantName, tenantCode]
    );

    if (existingTenant.length > 0) {
      throw new Error('A tenant with this company name already exists');
    }

    // 2. Get plan details
    const [plans] = await masterConn.query(
      'SELECT id, slug, features FROM subscription_plans WHERE slug = ? AND is_active = TRUE',
      [planSlug]
    );

    if (plans.length === 0) {
      throw new Error(`Plan not found: ${planSlug}`);
    }

    const plan = plans[0];

    // 3. Create Stripe customer if configured
    let stripeCustomerId = null;
    if (createStripeCustomer && stripeService.isConfigured()) {
      try {
        const customer = await stripeService.createCustomer(email, tenantName, {
          tenant_code: tenantCode
        });
        stripeCustomerId = customer.id;
      } catch (stripeError) {
        console.warn('[Provision] Stripe customer creation failed:', stripeError.message);
        // Continue without Stripe - can be added later
      }
    }

    // 4. Create tenant record in master database
    const databaseName = `a1_tenant_${tenantCode}`;
    const [tenantResult] = await masterConn.query(`
      INSERT INTO tenants (
        tenant_code, company_name, display_name, database_name,
        database_host, database_port, database_user, database_password,
        max_users, max_tickets, subscription_plan, status,
        signup_source, signup_session_id, stripe_customer_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'marketing_trial', ?, ?)
    `, [
      tenantCode,
      tenantName,
      tenantName,
      databaseName,
      process.env.MYSQLHOST || 'localhost',
      process.env.MYSQLPORT || 3306,
      process.env.MYSQLUSER || 'root',
      dbPassword,
      100, // max_users default
      1000, // max_tickets default
      planSlug,
      signupSessionId,
      stripeCustomerId
    ]);

    const tenantId = tenantResult.insertId;
    console.log(`[Provision] Created tenant record: ${tenantId}`);

    // 5. Create tenant database
    await createTenantDatabase(masterConn, tenantCode, process.env.MYSQLUSER, dbPassword);

    // 6. Create admin user in tenant database
    await createTenantAdmin(tenantCode, email, adminPassword, tenantName + ' Admin');

    // 6b. Create tenant_admins record in master database
    const adminPasswordHash = await bcrypt.hash(adminPassword, 10);
    await masterConn.query(`
      INSERT INTO tenant_admins (tenant_id, username, password_hash, email, full_name)
      VALUES (?, 'admin', ?, ?, ?)
    `, [tenantId, adminPasswordHash, email, tenantName + ' Admin']);
    console.log(`[Provision] Created tenant_admins record for ${email}`);

    // 7. Create subscription record
    const trialEnd = new Date(Date.now() + TRIAL_DURATION_MINUTES * 60 * 1000);

    const [subResult] = await masterConn.query(`
      INSERT INTO tenant_subscriptions (
        tenant_id, plan_id, status, billing_cycle,
        trial_start, trial_end, current_period_start, current_period_end,
        user_count
      ) VALUES (?, ?, 'trial', 'monthly', NOW(), ?, NOW(), ?, ?)
    `, [tenantId, plan.id, trialEnd, trialEnd, numTechnicians]);

    const subscriptionId = subResult.insertId;
    console.log(`[Provision] Created subscription: ${subscriptionId} (trial ends: ${trialEnd})`);

    // 8. Log to subscription history
    await masterConn.query(`
      INSERT INTO subscription_history (
        subscription_id, tenant_id, action, to_plan_id, to_status, notes
      ) VALUES (?, ?, 'trial_started', ?, 'trial', ?)
    `, [subscriptionId, tenantId, plan.id, `Self-service signup from marketing site`]);

    // 9. Sync plan features to tenant database
    await syncPlanFeatures(tenantCode, planSlug);

    // 10. Generate JWT token for immediate login
    const token = jwt.sign(
      {
        userId: 1, // Admin user ID in tenant DB
        username: 'admin',
        role: 'admin',
        tenantCode,
        email
      },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '24h' }
    );

    // 11. Send welcome email (async, don't block on failure)
    sendWelcomeEmail(email, tenantName, tenantCode, trialEnd.toISOString())
      .catch(err => console.error('[Provision] Welcome email error:', err));

    console.log(`[Provision] Tenant provisioning complete for ${tenantCode}`);

    return {
      success: true,
      tenantId,
      tenantCode,
      subscriptionId,
      stripeCustomerId,
      authToken: token,
      trialEndsAt: trialEnd.toISOString(),
      redirectUrl: '/'
    };

  } catch (error) {
    console.error('[Provision] Error:', error);
    throw error;
  } finally {
    masterConn.release();
  }
}

/**
 * Recommend a plan based on technician/client count
 */
function recommendPlan(numTechnicians, numClients) {
  // MSP if managing multiple clients or 10+ technicians
  if (numClients > 10 || numTechnicians > 10) {
    return 'msp';
  }

  // Professional if 3+ technicians or some clients
  if (numTechnicians >= 3 || numClients > 0) {
    return 'professional';
  }

  // Starter for small teams
  return 'starter';
}

/**
 * Check trial expiration for a tenant
 */
async function checkTrialExpired(tenantId) {
  const masterConn = await getMasterConnection();

  try {
    const [subs] = await masterConn.query(`
      SELECT id, status, trial_end
      FROM tenant_subscriptions
      WHERE tenant_id = ? AND status = 'trial'
    `, [tenantId]);

    if (subs.length === 0) {
      return { expired: false, subscription: null };
    }

    const sub = subs[0];
    const now = new Date();
    const trialEnd = new Date(sub.trial_end);

    return {
      expired: now > trialEnd,
      subscription: sub,
      trialEnd: trialEnd.toISOString(),
      daysRemaining: Math.max(0, Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24)))
    };
  } finally {
    masterConn.release();
  }
}

/**
 * Expire trials that have ended
 */
async function expireTrials() {
  const masterConn = await getMasterConnection();

  try {
    // Find expired trials
    const [expired] = await masterConn.query(`
      SELECT ts.id, ts.tenant_id, t.tenant_code, t.company_name
      FROM tenant_subscriptions ts
      JOIN tenants t ON ts.tenant_id = t.id
      WHERE ts.status = 'trial' AND ts.trial_end < NOW()
    `);

    console.log(`[TrialExpiry] Found ${expired.length} expired trials`);

    for (const sub of expired) {
      // Update status
      await masterConn.query(
        "UPDATE tenant_subscriptions SET status = 'expired' WHERE id = ?",
        [sub.id]
      );

      // Log to history
      await masterConn.query(`
        INSERT INTO subscription_history (
          subscription_id, tenant_id, action, from_status, to_status, notes
        ) VALUES (?, ?, 'trial_ended', 'trial', 'expired', 'Trial period ended')
      `, [sub.id, sub.tenant_id]);

      console.log(`[TrialExpiry] Expired trial for ${sub.company_name} (${sub.tenant_code})`);
    }

    return expired.length;
  } finally {
    masterConn.release();
  }
}

module.exports = {
  provisionTenant,
  recommendPlan,
  generateTenantCode,
  syncPlanFeatures,
  checkTrialExpired,
  expireTrials,
  createTenantDatabase,
  createTenantAdmin,
  TRIAL_DURATION_MINUTES
};
