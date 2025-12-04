const { getTenantConnection } = require('./config/database');

async function applyAIMigration() {
  console.log('🤖 Applying AI Analytics Migration\n');

  try {
    const connection = await getTenantConnection('apoyar');

    try {
      // Table 1: AI Email Analysis
      console.log('Creating ai_email_analysis table...');
      await connection.query(`
        CREATE TABLE IF NOT EXISTS ai_email_analysis (
          id INT AUTO_INCREMENT PRIMARY KEY,
          ticket_id INT NOT NULL,

          sentiment VARCHAR(20),
          confidence_score DECIMAL(5,2),

          ai_category VARCHAR(100),
          root_cause_type VARCHAR(100),
          impact_level VARCHAR(20),

          key_phrases JSON,
          technical_terms JSON,
          suggested_assignee VARCHAR(255),
          estimated_resolution_time INT,
          similar_ticket_ids JSON,

          analysis_timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          ai_model_version VARCHAR(50),
          processing_time_ms INT,

          FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
          INDEX idx_ticket_id (ticket_id),
          INDEX idx_sentiment (sentiment),
          INDEX idx_root_cause (root_cause_type),
          INDEX idx_timestamp (analysis_timestamp)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      console.log('✅ ai_email_analysis table created\n');

      // Table 2: AI Insights
      console.log('Creating ai_insights table...');
      await connection.query(`
        CREATE TABLE IF NOT EXISTS ai_insights (
          id INT AUTO_INCREMENT PRIMARY KEY,

          insight_type VARCHAR(50) NOT NULL,
          title VARCHAR(255) NOT NULL,
          description TEXT,
          severity VARCHAR(20),

          affected_tickets JSON,
          metrics JSON,
          time_range_start DATETIME,
          time_range_end DATETIME,

          status VARCHAR(20) DEFAULT 'active',
          acknowledged_by INT,
          acknowledged_at TIMESTAMP NULL,

          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

          FOREIGN KEY (acknowledged_by) REFERENCES users(id) ON DELETE SET NULL,
          INDEX idx_type (insight_type),
          INDEX idx_severity (severity),
          INDEX idx_status (status),
          INDEX idx_created (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      console.log('✅ ai_insights table created\n');

      // Table 3: AI Category Mappings
      console.log('Creating ai_category_mappings table...');
      await connection.query(`
        CREATE TABLE IF NOT EXISTS ai_category_mappings (
          id INT AUTO_INCREMENT PRIMARY KEY,

          pattern_text TEXT NOT NULL,
          pattern_type VARCHAR(50),

          category VARCHAR(100),
          root_cause VARCHAR(100),
          priority VARCHAR(20),
          suggested_assignee VARCHAR(255),

          match_count INT DEFAULT 0,
          accuracy_score DECIMAL(5,2),
          last_matched_at TIMESTAMP NULL,

          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          is_active BOOLEAN DEFAULT TRUE,

          INDEX idx_pattern_type (pattern_type),
          INDEX idx_category (category),
          INDEX idx_active (is_active)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      console.log('✅ ai_category_mappings table created\n');

      // Table 4: AI System Metrics
      console.log('Creating ai_system_metrics table...');
      await connection.query(`
        CREATE TABLE IF NOT EXISTS ai_system_metrics (
          id INT AUTO_INCREMENT PRIMARY KEY,

          metric_date DATE NOT NULL,
          emails_analyzed INT DEFAULT 0,
          avg_confidence_score DECIMAL(5,2),
          avg_processing_time_ms INT,

          correct_predictions INT DEFAULT 0,
          total_predictions INT DEFAULT 0,
          accuracy_rate DECIMAL(5,2),

          trends_detected INT DEFAULT 0,
          anomalies_detected INT DEFAULT 0,
          recommendations_generated INT DEFAULT 0,

          api_calls_made INT DEFAULT 0,
          api_cost_usd DECIMAL(10,4),

          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

          UNIQUE KEY unique_date (metric_date),
          INDEX idx_date (metric_date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      console.log('✅ ai_system_metrics table created\n');

      // Add columns to tickets table (check if exists first)
      console.log('Adding AI columns to tickets table...');

      const [columns] = await connection.query(`
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = 'a1_tenant_apoyar'
        AND TABLE_NAME = 'tickets'
        AND COLUMN_NAME IN ('ai_analyzed', 'ai_accuracy_feedback')
      `);

      const existingColumns = columns.map(c => c.COLUMN_NAME);

      if (!existingColumns.includes('ai_analyzed')) {
        await connection.query(`
          ALTER TABLE tickets ADD COLUMN ai_analyzed BOOLEAN DEFAULT FALSE
        `);
        console.log('✅ Added ai_analyzed column');
      } else {
        console.log('⚠️  ai_analyzed column already exists');
      }

      if (!existingColumns.includes('ai_accuracy_feedback')) {
        await connection.query(`
          ALTER TABLE tickets ADD COLUMN ai_accuracy_feedback INT
        `);
        console.log('✅ Added ai_accuracy_feedback column');
      } else {
        console.log('⚠️  ai_accuracy_feedback column already exists');
      }

      // Add index
      try {
        await connection.query(`
          ALTER TABLE tickets ADD INDEX idx_ai_analyzed (ai_analyzed)
        `);
        console.log('✅ Added index on ai_analyzed\n');
      } catch (err) {
        if (err.code === 'ER_DUP_KEYNAME') {
          console.log('⚠️  Index already exists\n');
        } else {
          throw err;
        }
      }

      // Create view
      console.log('Creating view v_tickets_with_ai...');
      await connection.query(`DROP VIEW IF EXISTS v_tickets_with_ai`);
      await connection.query(`
        CREATE VIEW v_tickets_with_ai AS
        SELECT
          t.*,
          ai.sentiment,
          ai.confidence_score,
          ai.ai_category,
          ai.root_cause_type,
          ai.impact_level,
          ai.suggested_assignee,
          ai.estimated_resolution_time,
          ai.similar_ticket_ids,
          ai.analysis_timestamp
        FROM tickets t
        LEFT JOIN ai_email_analysis ai ON t.id = ai.ticket_id
      `);
      console.log('✅ View created\n');

      console.log('🎉 AI Analytics Migration completed successfully!');

    } finally {
      connection.release();
    }

  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  }
}

applyAIMigration()
  .then(() => {
    console.log('\n✅ All done!');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n❌ Failed:', error.message);
    process.exit(1);
  });
