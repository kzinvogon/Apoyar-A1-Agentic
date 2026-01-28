/**
 * UAT Schema Parity Migration
 *
 * Purpose: Bring UAT a1_tenant_apoyar schema to parity with Production
 * Target: UAT MySQL (tramway.proxy.rlwy.net:20773)
 *
 * Missing Tables: 12
 * Missing Columns: tickets (10), users (9)
 */

const mysql = require('mysql2/promise');

// UAT Connection config
const UAT_CONFIG = {
  host: 'tramway.proxy.rlwy.net',
  port: 20773,
  user: 'serviflow_app',
  password: process.env.MYSQLPASSWORD,
  database: 'a1_tenant_apoyar',
  multipleStatements: true
};

// Missing tables to create
const MISSING_TABLES = {
  ai_action_log: `
    CREATE TABLE IF NOT EXISTS ai_action_log (
      id INT NOT NULL AUTO_INCREMENT,
      ticket_id INT NOT NULL,
      user_id INT DEFAULT NULL,
      action_type VARCHAR(100) NOT NULL,
      action_params JSON DEFAULT NULL,
      result JSON DEFAULT NULL,
      executed_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_ticket_id (ticket_id),
      KEY idx_user_id (user_id),
      KEY idx_action_type (action_type),
      KEY idx_executed_at (executed_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `,

  ai_category_mappings: `
    CREATE TABLE IF NOT EXISTS ai_category_mappings (
      id INT NOT NULL AUTO_INCREMENT,
      pattern_text TEXT NOT NULL,
      pattern_type VARCHAR(50) DEFAULT NULL,
      category VARCHAR(100) DEFAULT NULL,
      root_cause VARCHAR(100) DEFAULT NULL,
      priority VARCHAR(20) DEFAULT NULL,
      suggested_assignee VARCHAR(255) DEFAULT NULL,
      match_count INT DEFAULT 0,
      accuracy_score DECIMAL(5,2) DEFAULT NULL,
      last_matched_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      is_active TINYINT(1) DEFAULT 1,
      PRIMARY KEY (id),
      KEY idx_pattern_type (pattern_type),
      KEY idx_category (category),
      KEY idx_active (is_active),
      FULLTEXT KEY idx_pattern_text (pattern_text)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `,

  ai_email_analysis: `
    CREATE TABLE IF NOT EXISTS ai_email_analysis (
      id INT NOT NULL AUTO_INCREMENT,
      ticket_id INT NOT NULL,
      sentiment VARCHAR(20) DEFAULT NULL,
      confidence_score DECIMAL(5,2) DEFAULT NULL,
      ai_category VARCHAR(100) DEFAULT NULL,
      root_cause_type VARCHAR(100) DEFAULT NULL,
      impact_level VARCHAR(20) DEFAULT NULL,
      key_phrases JSON DEFAULT NULL,
      technical_terms JSON DEFAULT NULL,
      suggested_assignee VARCHAR(255) DEFAULT NULL,
      estimated_resolution_time INT DEFAULT NULL,
      similar_ticket_ids JSON DEFAULT NULL,
      analysis_timestamp TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      ai_model_version VARCHAR(50) DEFAULT NULL,
      processing_time_ms INT DEFAULT NULL,
      PRIMARY KEY (id),
      KEY idx_ticket_id (ticket_id),
      KEY idx_sentiment (sentiment),
      KEY idx_root_cause (root_cause_type),
      KEY idx_timestamp (analysis_timestamp)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `,

  ai_insights: `
    CREATE TABLE IF NOT EXISTS ai_insights (
      id INT NOT NULL AUTO_INCREMENT,
      insight_type VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      severity VARCHAR(20) DEFAULT NULL,
      affected_tickets JSON DEFAULT NULL,
      metrics JSON DEFAULT NULL,
      time_range_start DATETIME DEFAULT NULL,
      time_range_end DATETIME DEFAULT NULL,
      status VARCHAR(20) DEFAULT 'active',
      acknowledged_by INT DEFAULT NULL,
      acknowledged_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY acknowledged_by (acknowledged_by),
      KEY idx_type (insight_type),
      KEY idx_severity (severity),
      KEY idx_status (status),
      KEY idx_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `,

  ai_system_metrics: `
    CREATE TABLE IF NOT EXISTS ai_system_metrics (
      id INT NOT NULL AUTO_INCREMENT,
      metric_date DATE NOT NULL,
      emails_analyzed INT DEFAULT 0,
      avg_confidence_score DECIMAL(5,2) DEFAULT NULL,
      avg_processing_time_ms INT DEFAULT NULL,
      correct_predictions INT DEFAULT 0,
      total_predictions INT DEFAULT 0,
      accuracy_rate DECIMAL(5,2) DEFAULT NULL,
      trends_detected INT DEFAULT 0,
      anomalies_detected INT DEFAULT 0,
      recommendations_generated INT DEFAULT 0,
      api_calls_made INT DEFAULT 0,
      api_cost_usd DECIMAL(10,4) DEFAULT NULL,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY unique_date (metric_date),
      KEY idx_date (metric_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `,

  category_sla_mappings: `
    CREATE TABLE IF NOT EXISTS category_sla_mappings (
      id INT NOT NULL AUTO_INCREMENT,
      category VARCHAR(50) NOT NULL,
      sla_definition_id INT NOT NULL,
      is_active TINYINT(1) DEFAULT 1,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_category (category),
      KEY sla_definition_id (sla_definition_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `,

  company_profile: `
    CREATE TABLE IF NOT EXISTS company_profile (
      id INT NOT NULL AUTO_INCREMENT,
      company_name VARCHAR(200) DEFAULT NULL,
      contact_phone VARCHAR(50) DEFAULT NULL,
      mail_from_email VARCHAR(100) DEFAULT NULL,
      company_url_domain VARCHAR(255) DEFAULT NULL,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `,

  notifications: `
    CREATE TABLE IF NOT EXISTS notifications (
      id INT NOT NULL AUTO_INCREMENT,
      ticket_id INT NOT NULL,
      type VARCHAR(64) NOT NULL,
      severity VARCHAR(16) NOT NULL,
      message VARCHAR(255) NOT NULL,
      payload_json JSON DEFAULT NULL,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      delivered_at TIMESTAMP NULL DEFAULT NULL,
      PRIMARY KEY (id),
      KEY idx_ticket_id (ticket_id),
      KEY idx_type (type),
      KEY idx_created_at (created_at),
      KEY idx_delivered_at (delivered_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `,

  slack_user_preferences: `
    CREATE TABLE IF NOT EXISTS slack_user_preferences (
      id INT NOT NULL AUTO_INCREMENT,
      user_id INT NOT NULL,
      slack_user_id VARCHAR(100) DEFAULT NULL,
      mode ENUM('expert','customer') DEFAULT 'customer',
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY unique_user (user_id),
      KEY idx_slack_user_id (slack_user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `,

  teams_user_preferences: `
    CREATE TABLE IF NOT EXISTS teams_user_preferences (
      id INT NOT NULL AUTO_INCREMENT,
      user_id INT NOT NULL,
      teams_user_id VARCHAR(255) DEFAULT NULL,
      mode ENUM('expert','customer') DEFAULT 'expert',
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY unique_user (user_id),
      KEY idx_teams_user_id (teams_user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `,

  tenant_features: `
    CREATE TABLE IF NOT EXISTS tenant_features (
      id INT NOT NULL AUTO_INCREMENT,
      feature_key VARCHAR(100) NOT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 0,
      source ENUM('plan','override','trial','system') DEFAULT 'plan',
      expires_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY idx_feature_key (feature_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `,

  ticket_access_tokens: `
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
      KEY idx_token (token),
      KEY idx_ticket_id (ticket_id),
      KEY idx_expires_at (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `
};

// Missing columns for tickets table
const TICKETS_MISSING_COLUMNS = [
  { name: 'previous_assignee_id', sql: 'ALTER TABLE tickets ADD COLUMN previous_assignee_id INT DEFAULT NULL AFTER assignee_id' },
  { name: 'sla_deadline', sql: 'ALTER TABLE tickets ADD COLUMN sla_deadline TIMESTAMP NULL DEFAULT NULL AFTER cmdb_item_id' },
  { name: 'resolution_status', sql: "ALTER TABLE tickets ADD COLUMN resolution_status ENUM('pending_acceptance','accepted','rejected') DEFAULT NULL AFTER updated_at" },
  { name: 'rejection_reason', sql: 'ALTER TABLE tickets ADD COLUMN rejection_reason VARCHAR(255) DEFAULT NULL AFTER resolution_status' },
  { name: 'rejection_comment', sql: 'ALTER TABLE tickets ADD COLUMN rejection_comment TEXT AFTER rejection_reason' },
  { name: 'csat_rating', sql: 'ALTER TABLE tickets ADD COLUMN csat_rating INT DEFAULT NULL AFTER rejection_comment' },
  { name: 'csat_comment', sql: 'ALTER TABLE tickets ADD COLUMN csat_comment TEXT AFTER csat_rating' },
  { name: 'resolution_comment', sql: 'ALTER TABLE tickets ADD COLUMN resolution_comment TEXT AFTER resolved_by' },
  { name: 'ai_analyzed', sql: 'ALTER TABLE tickets ADD COLUMN ai_analyzed TINYINT(1) DEFAULT 0 AFTER resolution_comment' },
  { name: 'ai_accuracy_feedback', sql: 'ALTER TABLE tickets ADD COLUMN ai_accuracy_feedback INT DEFAULT NULL AFTER ai_analyzed' }
];

// Missing columns for customers table
const CUSTOMERS_MISSING_COLUMNS = [
  { name: 'job_title', sql: 'ALTER TABLE customers ADD COLUMN job_title VARCHAR(100) DEFAULT NULL AFTER is_company_admin' },
  { name: 'company_name', sql: 'ALTER TABLE customers ADD COLUMN company_name VARCHAR(100) DEFAULT NULL AFTER job_title' },
  { name: 'contact_phone', sql: 'ALTER TABLE customers ADD COLUMN contact_phone VARCHAR(20) DEFAULT NULL AFTER company_name' },
  { name: 'sla_level', sql: "ALTER TABLE customers ADD COLUMN sla_level ENUM('basic','premium','enterprise') DEFAULT 'basic' AFTER address" },
  { name: 'updated_at', sql: 'ALTER TABLE customers ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at' },
  { name: 'company_domain', sql: 'ALTER TABLE customers ADD COLUMN company_domain VARCHAR(255) DEFAULT NULL AFTER updated_at' },
  { name: 'sla_override_id', sql: 'ALTER TABLE customers ADD COLUMN sla_override_id INT DEFAULT NULL AFTER company_domain' }
];

// Missing columns for customer_companies table
const CUSTOMER_COMPANIES_MISSING_COLUMNS = [
  { name: 'admin_user_id', sql: 'ALTER TABLE customer_companies ADD COLUMN admin_user_id INT DEFAULT NULL AFTER company_domain' },
  { name: 'admin_email', sql: "ALTER TABLE customer_companies ADD COLUMN admin_email VARCHAR(100) NOT NULL DEFAULT '' AFTER admin_user_id" }
];

// Fix kb_article_similarities column names (UAT has article1_id/article2_id, should be article_id_1/article_id_2)
const KB_ARTICLE_SIMILARITIES_FIXES = [
  { check: 'article1_id', sql: 'ALTER TABLE kb_article_similarities CHANGE COLUMN article1_id article_id_1 INT NOT NULL' },
  { check: 'article2_id', sql: 'ALTER TABLE kb_article_similarities CHANGE COLUMN article2_id article_id_2 INT NOT NULL' },
  { name: 'similarity_type', sql: "ALTER TABLE kb_article_similarities ADD COLUMN similarity_type ENUM('content','title','combined') DEFAULT 'combined' AFTER similarity_score" }
];

// Missing columns for tenant_settings table
const TENANT_SETTINGS_MISSING_COLUMNS = [
  { name: 'setting_type', sql: "ALTER TABLE tenant_settings ADD COLUMN setting_type ENUM('boolean','string','number','json') DEFAULT 'string' AFTER setting_value" },
  { name: 'description', sql: 'ALTER TABLE tenant_settings ADD COLUMN description VARCHAR(255) DEFAULT NULL AFTER setting_type' }
];

// Missing columns for users table
const USERS_MISSING_COLUMNS = [
  { name: 'must_reset_password', sql: 'ALTER TABLE users ADD COLUMN must_reset_password TINYINT(1) DEFAULT 0 AFTER is_active' },
  { name: 'reset_token', sql: 'ALTER TABLE users ADD COLUMN reset_token VARCHAR(100) DEFAULT NULL AFTER department' },
  { name: 'reset_token_expiry', sql: 'ALTER TABLE users ADD COLUMN reset_token_expiry DATETIME DEFAULT NULL AFTER reset_token' },
  { name: 'invitation_token', sql: 'ALTER TABLE users ADD COLUMN invitation_token VARCHAR(255) DEFAULT NULL AFTER email_notifications_enabled' },
  { name: 'invitation_expires', sql: 'ALTER TABLE users ADD COLUMN invitation_expires DATETIME DEFAULT NULL AFTER invitation_token' },
  { name: 'invitation_sent_at', sql: 'ALTER TABLE users ADD COLUMN invitation_sent_at DATETIME DEFAULT NULL AFTER invitation_expires' },
  { name: 'invitation_accepted_at', sql: 'ALTER TABLE users ADD COLUMN invitation_accepted_at DATETIME DEFAULT NULL AFTER invitation_sent_at' },
  { name: 'deleted_at', sql: 'ALTER TABLE users ADD COLUMN deleted_at DATETIME DEFAULT NULL AFTER invitation_accepted_at' },
  { name: 'deleted_by', sql: 'ALTER TABLE users ADD COLUMN deleted_by INT DEFAULT NULL AFTER deleted_at' }
];

async function columnExists(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) as cnt FROM information_schema.columns
     WHERE table_schema = 'a1_tenant_apoyar' AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return rows[0].cnt > 0;
}

async function tableExists(conn, table) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) as cnt FROM information_schema.tables
     WHERE table_schema = 'a1_tenant_apoyar' AND table_name = ?`,
    [table]
  );
  return rows[0].cnt > 0;
}

async function runMigration() {
  console.log('='.repeat(60));
  console.log('UAT Schema Parity Migration');
  console.log('='.repeat(60));
  console.log(`Target: ${UAT_CONFIG.host}:${UAT_CONFIG.port}/${UAT_CONFIG.database}`);
  console.log('');

  if (!UAT_CONFIG.password) {
    console.error('ERROR: MYSQLPASSWORD environment variable not set');
    console.log('Run: source railway-env.sh uat && export MYSQLPASSWORD=$(railway variables --json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get(\'MYSQLPASSWORD\',\'\'))")');
    process.exit(1);
  }

  const conn = await mysql.createConnection(UAT_CONFIG);
  console.log('Connected to UAT MySQL\n');

  let tablesCreated = 0;
  let columnsAdded = 0;
  let errors = [];

  // Create missing tables
  console.log('--- Creating Missing Tables ---');
  for (const [tableName, createSQL] of Object.entries(MISSING_TABLES)) {
    const exists = await tableExists(conn, tableName);
    if (exists) {
      console.log(`  ${tableName}: already exists ✓`);
    } else {
      try {
        await conn.query(createSQL);
        console.log(`  ${tableName}: CREATED ✅`);
        tablesCreated++;
      } catch (err) {
        console.log(`  ${tableName}: FAILED ❌ - ${err.message}`);
        errors.push({ type: 'table', name: tableName, error: err.message });
      }
    }
  }

  // Add missing columns to tickets
  console.log('\n--- Adding Missing Columns to tickets ---');
  for (const col of TICKETS_MISSING_COLUMNS) {
    const exists = await columnExists(conn, 'tickets', col.name);
    if (exists) {
      console.log(`  ${col.name}: already exists ✓`);
    } else {
      try {
        await conn.query(col.sql);
        console.log(`  ${col.name}: ADDED ✅`);
        columnsAdded++;
      } catch (err) {
        console.log(`  ${col.name}: FAILED ❌ - ${err.message}`);
        errors.push({ type: 'column', table: 'tickets', name: col.name, error: err.message });
      }
    }
  }

  // Add missing columns to users
  console.log('\n--- Adding Missing Columns to users ---');
  for (const col of USERS_MISSING_COLUMNS) {
    const exists = await columnExists(conn, 'users', col.name);
    if (exists) {
      console.log(`  ${col.name}: already exists ✓`);
    } else {
      try {
        await conn.query(col.sql);
        console.log(`  ${col.name}: ADDED ✅`);
        columnsAdded++;
      } catch (err) {
        console.log(`  ${col.name}: FAILED ❌ - ${err.message}`);
        errors.push({ type: 'column', table: 'users', name: col.name, error: err.message });
      }
    }
  }

  // Add missing columns to customers
  console.log('\n--- Adding Missing Columns to customers ---');
  for (const col of CUSTOMERS_MISSING_COLUMNS) {
    const exists = await columnExists(conn, 'customers', col.name);
    if (exists) {
      console.log(`  ${col.name}: already exists ✓`);
    } else {
      try {
        await conn.query(col.sql);
        console.log(`  ${col.name}: ADDED ✅`);
        columnsAdded++;
      } catch (err) {
        console.log(`  ${col.name}: FAILED ❌ - ${err.message}`);
        errors.push({ type: 'column', table: 'customers', name: col.name, error: err.message });
      }
    }
  }

  // Add missing columns to customer_companies
  console.log('\n--- Adding Missing Columns to customer_companies ---');
  for (const col of CUSTOMER_COMPANIES_MISSING_COLUMNS) {
    const exists = await columnExists(conn, 'customer_companies', col.name);
    if (exists) {
      console.log(`  ${col.name}: already exists ✓`);
    } else {
      try {
        await conn.query(col.sql);
        console.log(`  ${col.name}: ADDED ✅`);
        columnsAdded++;
      } catch (err) {
        console.log(`  ${col.name}: FAILED ❌ - ${err.message}`);
        errors.push({ type: 'column', table: 'customer_companies', name: col.name, error: err.message });
      }
    }
  }

  // Fix kb_article_similarities schema
  console.log('\n--- Fixing kb_article_similarities schema ---');
  for (const fix of KB_ARTICLE_SIMILARITIES_FIXES) {
    if (fix.check) {
      // This is a column rename - check if old column exists
      const oldExists = await columnExists(conn, 'kb_article_similarities', fix.check);
      if (oldExists) {
        try {
          await conn.query(fix.sql);
          console.log(`  ${fix.check} -> renamed ✅`);
          columnsAdded++;
        } catch (err) {
          console.log(`  ${fix.check}: FAILED ❌ - ${err.message}`);
        }
      } else {
        console.log(`  ${fix.check}: already renamed ✓`);
      }
    } else {
      // This is a new column
      const exists = await columnExists(conn, 'kb_article_similarities', fix.name);
      if (exists) {
        console.log(`  ${fix.name}: already exists ✓`);
      } else {
        try {
          await conn.query(fix.sql);
          console.log(`  ${fix.name}: ADDED ✅`);
          columnsAdded++;
        } catch (err) {
          console.log(`  ${fix.name}: FAILED ❌ - ${err.message}`);
        }
      }
    }
  }

  // Add missing columns to tenant_settings
  console.log('\n--- Adding Missing Columns to tenant_settings ---');
  for (const col of TENANT_SETTINGS_MISSING_COLUMNS) {
    const exists = await columnExists(conn, 'tenant_settings', col.name);
    if (exists) {
      console.log(`  ${col.name}: already exists ✓`);
    } else {
      try {
        await conn.query(col.sql);
        console.log(`  ${col.name}: ADDED ✅`);
        columnsAdded++;
      } catch (err) {
        console.log(`  ${col.name}: FAILED ❌ - ${err.message}`);
        errors.push({ type: 'column', table: 'tenant_settings', name: col.name, error: err.message });
      }
    }
  }

  // Add indexes that may be missing
  console.log('\n--- Adding Missing Indexes ---');
  const indexes = [
    { name: 'idx_invitation_token', sql: 'ALTER TABLE users ADD INDEX idx_invitation_token (invitation_token)' },
    { name: 'idx_deleted_at', sql: 'ALTER TABLE users ADD INDEX idx_deleted_at (deleted_at)' },
    { name: 'idx_ai_analyzed', sql: 'ALTER TABLE tickets ADD INDEX idx_ai_analyzed (ai_analyzed)' },
    { name: 'previous_assignee_id', sql: 'ALTER TABLE tickets ADD INDEX previous_assignee_id (previous_assignee_id)' }
  ];

  for (const idx of indexes) {
    try {
      await conn.query(idx.sql);
      console.log(`  ${idx.name}: ADDED ✅`);
    } catch (err) {
      if (err.code === 'ER_DUP_KEYNAME') {
        console.log(`  ${idx.name}: already exists ✓`);
      } else {
        console.log(`  ${idx.name}: SKIPPED (${err.code})`);
      }
    }
  }

  await conn.end();

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('Migration Summary');
  console.log('='.repeat(60));
  console.log(`Tables created: ${tablesCreated}`);
  console.log(`Columns added: ${columnsAdded}`);
  console.log(`Errors: ${errors.length}`);

  if (errors.length > 0) {
    console.log('\nErrors:');
    errors.forEach(e => console.log(`  - ${e.type} ${e.name}: ${e.error}`));
  }

  console.log('\nMigration complete.');
  return errors.length === 0;
}

runMigration()
  .then(success => process.exit(success ? 0 : 1))
  .catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
