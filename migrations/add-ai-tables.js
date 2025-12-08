#!/usr/bin/env node

const mysql = require('mysql2/promise');
require('dotenv').config();

async function applyMigration() {
  console.log('🚀 Adding AI Tables Migration');
  console.log('==============================\n');

  try {
    // Connect to master database to get tenant list
    const masterConnection = await mysql.createConnection({
      host: process.env.MASTER_DB_HOST || 'localhost',
      port: process.env.MASTER_DB_PORT || 3306,
      user: process.env.MASTER_DB_USER || 'root',
      password: process.env.MASTER_DB_PASSWORD || '',
      database: process.env.MASTER_DB_NAME || 'a1_master'
    });

    // Get all active tenants
    const [tenants] = await masterConnection.query(
      'SELECT tenant_code, database_name FROM tenants WHERE is_active = 1'
    );

    await masterConnection.end();

    if (tenants.length === 0) {
      console.log('⚠️  No active tenants found');
      return;
    }

    console.log(`Found ${tenants.length} active tenant(s)\n`);

    // Apply migration to each tenant database
    for (const tenant of tenants) {
      console.log(`📋 Processing tenant: ${tenant.tenant_code}`);

      try {
        const tenantConnection = await mysql.createConnection({
          host: process.env.MASTER_DB_HOST || 'localhost',
          port: process.env.MASTER_DB_PORT || 3306,
          user: process.env.MASTER_DB_USER || 'root',
          password: process.env.MASTER_DB_PASSWORD || '',
          database: tenant.database_name
        });

        // Create ai_action_log table if not exists
        const [actionLogTables] = await tenantConnection.query(
          "SHOW TABLES LIKE 'ai_action_log'"
        );

        if (actionLogTables.length === 0) {
          await tenantConnection.execute(`
            CREATE TABLE ai_action_log (
              id INT AUTO_INCREMENT PRIMARY KEY,
              ticket_id INT NOT NULL,
              user_id INT NULL,
              action_type VARCHAR(50) NOT NULL,
              action_params JSON,
              executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              success BOOLEAN DEFAULT TRUE,
              error_message TEXT,
              FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
              FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
              INDEX idx_ticket_id (ticket_id),
              INDEX idx_user_id (user_id),
              INDEX idx_action_type (action_type),
              INDEX idx_executed_at (executed_at)
            )
          `);
          console.log(`   ✅ Created ai_action_log table`);
        } else {
          console.log(`   ⏭️  ai_action_log table already exists`);
        }

        // Create ai_email_analysis table if not exists
        const [analysisTables] = await tenantConnection.query(
          "SHOW TABLES LIKE 'ai_email_analysis'"
        );

        if (analysisTables.length === 0) {
          await tenantConnection.execute(`
            CREATE TABLE ai_email_analysis (
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
              INDEX idx_ai_category (ai_category),
              INDEX idx_analysis_timestamp (analysis_timestamp)
            )
          `);
          console.log(`   ✅ Created ai_email_analysis table`);
        } else {
          console.log(`   ⏭️  ai_email_analysis table already exists`);
        }

        // Create ai_insights table if not exists
        const [insightsTables] = await tenantConnection.query(
          "SHOW TABLES LIKE 'ai_insights'"
        );

        if (insightsTables.length === 0) {
          await tenantConnection.execute(`
            CREATE TABLE ai_insights (
              id INT AUTO_INCREMENT PRIMARY KEY,
              insight_type VARCHAR(50) NOT NULL,
              title VARCHAR(200) NOT NULL,
              description TEXT,
              severity VARCHAR(50),
              affected_tickets JSON,
              metrics JSON,
              time_range_start TIMESTAMP,
              time_range_end TIMESTAMP,
              status ENUM('active', 'acknowledged', 'resolved') DEFAULT 'active',
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
              INDEX idx_insight_type (insight_type),
              INDEX idx_severity (severity),
              INDEX idx_status (status),
              INDEX idx_created_at (created_at)
            )
          `);
          console.log(`   ✅ Created ai_insights table`);
        } else {
          console.log(`   ⏭️  ai_insights table already exists`);
        }

        // Add ai_analyzed column to tickets if not exists
        const [columns] = await tenantConnection.query(
          "SHOW COLUMNS FROM tickets LIKE 'ai_analyzed'"
        );

        if (columns.length === 0) {
          await tenantConnection.execute(`
            ALTER TABLE tickets
            ADD COLUMN ai_analyzed BOOLEAN DEFAULT FALSE
          `);
          console.log(`   ✅ Added ai_analyzed column to tickets table`);
        } else {
          console.log(`   ⏭️  ai_analyzed column already exists`);
        }

        await tenantConnection.end();
        console.log(`   ✅ Migration completed for ${tenant.tenant_code}\n`);

      } catch (error) {
        console.error(`   ❌ Error processing tenant ${tenant.tenant_code}:`, error.message);
      }
    }

    console.log('🎉 Migration completed successfully!');

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  }
}

// Run migration
applyMigration().catch(console.error);
