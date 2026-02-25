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

  const appUrl = process.env.APP_URL || 'https://app.serviflow.app';

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
      password_hash VARCHAR(255) NULL,
      role ENUM('admin', 'expert', 'customer') NOT NULL,
      admin_level ENUM('tenant_admin','system_admin') DEFAULT 'tenant_admin',
      email VARCHAR(100),
      full_name VARCHAR(100),
      phone VARCHAR(50) DEFAULT NULL,
      department VARCHAR(100) DEFAULT NULL,
      receive_email_updates TINYINT(1) DEFAULT 1,
      auth_method ENUM('password','magic_link','both') DEFAULT 'password',
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
      company_domain VARCHAR(255) NOT NULL,
      admin_user_id INT,
      admin_email VARCHAR(100) NOT NULL DEFAULT '',
      contact_phone VARCHAR(20),
      address TEXT,
      sla_level ENUM('basic', 'premium', 'enterprise') DEFAULT 'basic',
      is_active BOOLEAN DEFAULT TRUE,
      notes TEXT,
      sla_definition_id INT,
      admin_receive_emails TINYINT(1) DEFAULT 1 COMMENT 'Company admin gets notified about member tickets',
      members_receive_emails TINYINT(1) DEFAULT 1 COMMENT 'All members receive email notifications (overrides individual)',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_domain (company_domain),
      INDEX idx_admin_user (admin_user_id),
      INDEX idx_is_active (is_active),
      INDEX idx_sla_definition (sla_definition_id)
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
      contact_phone VARCHAR(20),
      address TEXT,
      sla_level ENUM('basic', 'premium', 'enterprise') DEFAULT 'basic',
      company_domain VARCHAR(255),
      sla_override_id INT COMMENT 'Per-user SLA override, takes precedence over company SLA',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (customer_company_id) REFERENCES customer_companies(id) ON DELETE SET NULL,
      INDEX idx_customer_company_id (customer_company_id),
      INDEX idx_sla_override (sla_override_id)
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

  // CMDB V2: Custom Field Definitions table
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS cmdb_custom_field_definitions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      asset_category VARCHAR(100) NOT NULL,
      field_name VARCHAR(100) NOT NULL,
      field_label VARCHAR(150) NOT NULL,
      field_type ENUM('text', 'number', 'date', 'dropdown', 'boolean', 'url') NOT NULL DEFAULT 'text',
      dropdown_options JSON,
      is_required BOOLEAN DEFAULT FALSE,
      display_order INT DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_category_field (asset_category, field_name),
      INDEX idx_asset_category (asset_category),
      INDEX idx_is_active (is_active)
    )
  `);

  // CMDB V2: Custom Field Values table
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS cmdb_custom_field_values (
      id INT AUTO_INCREMENT PRIMARY KEY,
      cmdb_item_id INT NOT NULL,
      field_definition_id INT NOT NULL,
      field_value TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_item_field (cmdb_item_id, field_definition_id),
      INDEX idx_cmdb_item_id (cmdb_item_id),
      INDEX idx_field_definition_id (field_definition_id),
      FOREIGN KEY (cmdb_item_id) REFERENCES cmdb_items(id) ON DELETE CASCADE,
      FOREIGN KEY (field_definition_id) REFERENCES cmdb_custom_field_definitions(id) ON DELETE CASCADE
    )
  `);

  // CMDB V2: Relationships table
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS cmdb_relationships (
      id INT AUTO_INCREMENT PRIMARY KEY,
      source_cmdb_id INT NOT NULL,
      target_cmdb_id INT NOT NULL,
      relationship_type ENUM('depends_on', 'hosts', 'connects_to', 'part_of', 'uses', 'provides', 'backs_up', 'monitors') NOT NULL,
      description TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_relationship (source_cmdb_id, target_cmdb_id, relationship_type),
      INDEX idx_source_cmdb_id (source_cmdb_id),
      INDEX idx_target_cmdb_id (target_cmdb_id),
      INDEX idx_relationship_type (relationship_type),
      INDEX idx_is_active (is_active),
      FOREIGN KEY (source_cmdb_id) REFERENCES cmdb_items(id) ON DELETE CASCADE,
      FOREIGN KEY (target_cmdb_id) REFERENCES cmdb_items(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  // CMDB V2: Change History (Audit Trail) table
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS cmdb_change_history (
      id INT AUTO_INCREMENT PRIMARY KEY,
      cmdb_item_id INT NOT NULL,
      change_type ENUM('created', 'updated', 'deleted', 'relationship_added', 'relationship_removed', 'custom_field_updated') NOT NULL,
      field_name VARCHAR(100),
      old_value TEXT,
      new_value TEXT,
      changed_by INT,
      changed_by_name VARCHAR(100),
      ip_address VARCHAR(45),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_cmdb_item_id (cmdb_item_id),
      INDEX idx_change_type (change_type),
      INDEX idx_changed_by (changed_by),
      INDEX idx_created_at (created_at),
      FOREIGN KEY (cmdb_item_id) REFERENCES cmdb_items(id) ON DELETE CASCADE,
      FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  // CMDB Item Types table (for categorizing CMDB items)
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS cmdb_item_types (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      description TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_name (name),
      INDEX idx_is_active (is_active)
    )
  `);

  // CI Types table (sub-types within CMDB Item Types)
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS ci_types (
      id INT AUTO_INCREMENT PRIMARY KEY,
      cmdb_item_type_id INT NOT NULL,
      name VARCHAR(100) NOT NULL,
      description TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_cmdb_item_type_id (cmdb_item_type_id),
      FOREIGN KEY (cmdb_item_type_id) REFERENCES cmdb_item_types(id) ON DELETE CASCADE
    )
  `);

  // Seed default CMDB Item Types
  await connection.execute(`
    INSERT IGNORE INTO cmdb_item_types (name, description, is_active) VALUES
    ('Hardware', 'Physical hardware assets', TRUE),
    ('Software', 'Software applications and licenses', TRUE),
    ('Network', 'Network equipment and infrastructure', TRUE),
    ('Service', 'Business and IT services', TRUE),
    ('Cloud', 'Cloud resources and subscriptions', TRUE)
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
      pool_status VARCHAR(30) NOT NULL DEFAULT 'OPEN_POOL',
      claimed_by_expert_id INT NULL,
      claimed_until_at TIMESTAMP NULL,
      owned_by_expert_id INT NULL,
      ownership_started_at TIMESTAMP NULL,
      ownership_released_at TIMESTAMP NULL,
      waiting_since_at TIMESTAMP NULL,
      sla_paused_at TIMESTAMP NULL,
      sla_pause_total_seconds INT NOT NULL DEFAULT 0,
      pool_score DECIMAL(5,2) NULL,
      pool_score_updated_at TIMESTAMP NULL,
      work_type VARCHAR(32) NULL,
      execution_mode VARCHAR(24) NULL,
      system_tags JSON NULL,
      classification_confidence DECIMAL(4,3) NULL,
      classification_reason TEXT NULL,
      classified_by VARCHAR(16) NULL,
      classified_at TIMESTAMP NULL,
      sla_skip_penalty_minutes INT NOT NULL DEFAULT 0,
      related_ticket_id INT NULL,
      is_major_incident BOOLEAN DEFAULT FALSE,
      chat_session_id INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (requester_id) REFERENCES users(id),
      FOREIGN KEY (assignee_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (cmdb_item_id) REFERENCES cmdb_items(id) ON DELETE SET NULL,
      INDEX idx_sla_definition_id (sla_definition_id),
      INDEX idx_tickets_pool_status (pool_status),
      INDEX idx_tickets_owned_by (owned_by_expert_id),
      INDEX idx_tickets_claimed_by (claimed_by_expert_id),
      INDEX idx_tickets_work_type (work_type),
      INDEX idx_tickets_source (source),
      INDEX idx_tickets_related (related_ticket_id),
      INDEX idx_tickets_major_incident (is_major_incident)
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
      source VARCHAR(20) NOT NULL DEFAULT 'web',
      actor_type VARCHAR(20) NOT NULL DEFAULT 'user',
      actor_id INT NULL,
      event_key VARCHAR(50) NOT NULL DEFAULT 'ticket.activity',
      meta JSON NULL,
      request_id VARCHAR(64) NULL,
      is_public BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
      INDEX idx_ticket_activity_ticket_created (ticket_id, created_at),
      INDEX idx_ticket_activity_ticket_public_created (ticket_id, is_public, created_at),
      INDEX idx_ticket_activity_event_created (event_key, created_at),
      INDEX idx_ticket_activity_actor_created (actor_id, created_at)
    )
  `);

  // Ticket Classification Events (history/audit trail)
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS ticket_classification_events (
      id INT AUTO_INCREMENT PRIMARY KEY,
      ticket_id INT NOT NULL,
      previous_work_type VARCHAR(32) NULL,
      new_work_type VARCHAR(32) NULL,
      previous_execution_mode VARCHAR(24) NULL,
      new_execution_mode VARCHAR(24) NULL,
      previous_system_tags JSON NULL,
      new_system_tags JSON NULL,
      previous_confidence DECIMAL(4,3) NULL,
      new_confidence DECIMAL(4,3) NULL,
      classified_by VARCHAR(16) NOT NULL,
      user_id INT NULL,
      reason TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_classification_events_ticket (ticket_id),
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
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
      ('sla_check_interval_seconds', '300', 'number', 'How often to check for SLA breaches in seconds (minimum 60)'),
      ('monthly_report_enabled', 'false', 'boolean', 'Enable automatic monthly report email'),
      ('monthly_report_recipients', '[]', 'json', 'JSON array of email addresses to receive monthly report'),
      ('monthly_report_send_day', '1', 'number', 'Day of month to send report (1-28)'),
      ('monthly_report_include_system_tickets', 'false', 'boolean', 'Include system-generated tickets in monthly report')
  `);

  // Report history table
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS report_history (
      id INT AUTO_INCREMENT PRIMARY KEY,
      report_type VARCHAR(50) NOT NULL DEFAULT 'monthly',
      period_month INT NOT NULL,
      period_year INT NOT NULL,
      company_filter VARCHAR(255),
      generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      generated_by INT,
      recipients_json TEXT,
      ticket_count INT,
      cmdb_change_count INT,
      sla_compliance_pct DECIMAL(5,2),
      status VARCHAR(20) DEFAULT 'sent',
      error_message TEXT,
      INDEX idx_period (period_year, period_month)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Email ingest settings table
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS email_ingest_settings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      enabled TINYINT(1) NOT NULL DEFAULT 0,
      server_type ENUM('imap', 'pop3') NOT NULL DEFAULT 'imap',
      server_host VARCHAR(255) NOT NULL DEFAULT 'imap.gmail.com',
      server_port INT NOT NULL DEFAULT 993,
      use_ssl TINYINT(1) NOT NULL DEFAULT 1,
      username VARCHAR(255) NOT NULL DEFAULT '',
      password VARCHAR(255) NOT NULL DEFAULT '',
      check_interval_minutes INT NOT NULL DEFAULT 5,
      last_checked_at TIMESTAMP NULL,
      auth_method ENUM('basic','oauth2') DEFAULT 'basic',
      oauth2_refresh_token TEXT DEFAULT NULL,
      oauth2_access_token TEXT DEFAULT NULL,
      oauth2_token_expiry TIMESTAMP NULL,
      oauth2_email VARCHAR(255) DEFAULT NULL,
      imap_locked_by VARCHAR(64) DEFAULT NULL,
      imap_lock_expires TIMESTAMP NULL,
      graph_delta_link TEXT DEFAULT NULL,
      use_for_outbound TINYINT(1) DEFAULT 0,
      smtp_host VARCHAR(255) DEFAULT NULL,
      smtp_port INT DEFAULT 587,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  // Insert default email ingest settings row
  await connection.execute(`
    INSERT IGNORE INTO email_ingest_settings (enabled, server_type, server_host, server_port, use_ssl, username, password, check_interval_minutes)
    VALUES (FALSE, 'imap', 'imap.gmail.com', 993, TRUE, '', '', 5)
  `);

  // Ticket processing rules table
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS ticket_processing_rules (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_code VARCHAR(50) NOT NULL,
      rule_name VARCHAR(255) NOT NULL,
      description TEXT,
      instruction_text TEXT DEFAULT NULL,
      enabled TINYINT(1) DEFAULT 1,
      search_in ENUM('title', 'body', 'both') DEFAULT 'both',
      search_text VARCHAR(500) DEFAULT NULL,
      case_sensitive TINYINT(1) DEFAULT 0,
      action_type ENUM('delete', 'create_for_customer', 'assign_to_expert', 'set_priority', 'set_status', 'add_tag', 'add_to_monitoring', 'set_sla_deadlines', 'set_sla_definition') NOT NULL,
      action_params JSON,
      ai_interpreted TINYINT(1) DEFAULT 0,
      ai_confidence FLOAT DEFAULT NULL,
      times_triggered INT DEFAULT 0,
      last_triggered_at DATETIME,
      created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_code),
      INDEX idx_enabled (enabled),
      INDEX idx_search (search_text)
    )
  `);

  // Ticket rule executions table
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS ticket_rule_executions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      rule_id INT NOT NULL,
      ticket_id INT NOT NULL,
      action_taken VARCHAR(100) NOT NULL,
      execution_result ENUM('success', 'failure', 'skipped') NOT NULL,
      error_message TEXT,
      executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_rule (rule_id),
      INDEX idx_ticket (ticket_id),
      INDEX idx_executed (executed_at),
      FOREIGN KEY (rule_id) REFERENCES ticket_processing_rules(id) ON DELETE CASCADE,
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
    )
  `);

  // Company profile table (tenant settings)
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS company_profile (
      id INT NOT NULL AUTO_INCREMENT,
      company_name VARCHAR(200) DEFAULT NULL,
      contact_phone VARCHAR(50) DEFAULT NULL,
      mail_from_email VARCHAR(100) DEFAULT NULL,
      company_url_domain VARCHAR(255) DEFAULT NULL,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    )
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

  // Chat Sessions table
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      customer_user_id INT NOT NULL,
      expert_user_id INT NULL,
      status ENUM('waiting', 'active', 'transferred', 'closed') DEFAULT 'waiting',
      queue_position INT NULL,
      started_at TIMESTAMP NULL,
      ended_at TIMESTAMP NULL,
      transferred_from_expert_id INT NULL,
      transfer_reason TEXT NULL,
      satisfaction_rating TINYINT NULL,
      ticket_id INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (expert_user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (transferred_from_expert_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE SET NULL,
      INDEX idx_chat_sessions_status (status),
      INDEX idx_chat_sessions_customer (customer_user_id),
      INDEX idx_chat_sessions_expert (expert_user_id)
    )
  `);

  // Chat Messages table
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      session_id INT NOT NULL,
      sender_user_id INT NULL,
      sender_role ENUM('customer', 'expert', 'system', 'ai') NOT NULL DEFAULT 'customer',
      message_type ENUM('text', 'file', 'canned_action', 'system') NOT NULL DEFAULT 'text',
      content TEXT,
      file_url VARCHAR(500) NULL,
      file_name VARCHAR(255) NULL,
      file_size INT NULL,
      read_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE SET NULL,
      INDEX idx_chat_messages_session (session_id, created_at)
    )
  `);

  // Chat Canned Responses table
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS chat_canned_responses (
      id INT AUTO_INCREMENT PRIMARY KEY,
      label VARCHAR(100) NOT NULL,
      message TEXT NOT NULL,
      action_type ENUM('text', 'create_ticket', 'request_screenshot') DEFAULT 'text',
      sort_order INT DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  // Seed default canned responses
  await connection.execute(`
    INSERT IGNORE INTO chat_canned_responses (label, message, action_type, sort_order) VALUES
    ('Log a Ticket', 'Would you like me to log a support ticket for this issue?', 'create_ticket', 1),
    ('Send Screenshot', 'Could you please share a screenshot of the issue?', 'request_screenshot', 2),
    ('Checking', 'Let me check that for you, one moment please...', 'text', 3),
    ('Anything Else', 'Is there anything else I can help you with?', 'text', 4)
  `);

  // SMS user preferences table
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS sms_user_preferences (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      phone_number VARCHAR(20) NOT NULL,
      mode ENUM('expert', 'customer') DEFAULT 'customer',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_user (user_id),
      UNIQUE KEY unique_phone (phone_number),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // SMS conversation state table
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS sms_conversation_state (
      id INT AUTO_INCREMENT PRIMARY KEY,
      phone_number VARCHAR(20) NOT NULL,
      state_key VARCHAR(50) NOT NULL,
      state_data JSON,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_phone_state (phone_number, state_key),
      INDEX idx_expires (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Ticket access tokens (for public SMS ticket view URLs)
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS ticket_access_tokens (
      id INT NOT NULL AUTO_INCREMENT,
      ticket_id INT NOT NULL,
      token VARCHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      last_accessed_at DATETIME DEFAULT NULL,
      access_count INT DEFAULT 0,
      PRIMARY KEY (id),
      UNIQUE KEY token (token),
      KEY idx_ticket_id (ticket_id),
      KEY idx_expires_at (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Demo personas table (used by demo environment for persona switching)
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS demo_personas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      persona_key VARCHAR(50) NOT NULL UNIQUE,
      display_name VARCHAR(100) NOT NULL,
      user_id INT NOT NULL,
      role ENUM('admin','expert','customer') NOT NULL,
      company_id INT DEFAULT NULL,
      description VARCHAR(255),
      sort_order INT DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (company_id) REFERENCES customer_companies(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Multi-role: user roles table
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS tenant_user_roles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_user_id INT NOT NULL,
      role_key ENUM('admin','expert','customer') NOT NULL,
      granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      granted_by INT NULL,
      UNIQUE KEY unique_user_role (tenant_user_id, role_key),
      FOREIGN KEY (tenant_user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Multi-role: user company memberships
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS tenant_user_company_memberships (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_user_id INT NOT NULL,
      company_id INT NOT NULL,
      membership_role ENUM('member','admin') DEFAULT 'member',
      joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_user_company (tenant_user_id, company_id),
      FOREIGN KEY (tenant_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (company_id) REFERENCES customer_companies(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
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

    // Create admin user (system_admin by default for provisioned tenants)
    const [result] = await tenantConnection.execute(`
      INSERT INTO users (username, password_hash, role, admin_level, email, full_name)
      VALUES (?, ?, 'admin', 'system_admin', ?, ?)
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
      redirectUrl: process.env.APP_URL || 'https://app.serviflow.app'
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
