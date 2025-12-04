-- AI Email Analysis Tables
-- Run this migration to add AI-powered analytics capabilities

-- Table to store AI analysis of each email/ticket
CREATE TABLE IF NOT EXISTS ai_email_analysis (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ticket_id INT NOT NULL,

  -- AI-detected attributes
  sentiment VARCHAR(20), -- positive, neutral, negative, urgent
  confidence_score DECIMAL(5,2), -- 0.00 to 100.00

  -- Categorization
  ai_category VARCHAR(100), -- AI-detected category (more specific than manual)
  root_cause_type VARCHAR(100), -- hardware, software, network, user_error, etc.
  impact_level VARCHAR(20), -- low, medium, high, critical

  -- Analysis details
  key_phrases JSON, -- Important phrases extracted from email
  technical_terms JSON, -- Technical terms detected
  suggested_assignee VARCHAR(255), -- AI recommendation for best assignee
  estimated_resolution_time INT, -- Minutes estimated to resolve
  similar_ticket_ids JSON, -- Array of similar past ticket IDs

  -- Metadata
  analysis_timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ai_model_version VARCHAR(50), -- Track which AI model was used
  processing_time_ms INT, -- How long analysis took

  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  INDEX idx_ticket_id (ticket_id),
  INDEX idx_sentiment (sentiment),
  INDEX idx_root_cause (root_cause_type),
  INDEX idx_timestamp (analysis_timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table to store AI-detected trends and insights
CREATE TABLE IF NOT EXISTS ai_insights (
  id INT AUTO_INCREMENT PRIMARY KEY,

  -- Insight details
  insight_type VARCHAR(50) NOT NULL, -- trend, anomaly, recommendation, alert
  title VARCHAR(255) NOT NULL,
  description TEXT,
  severity VARCHAR(20), -- info, warning, critical

  -- Data
  affected_tickets JSON, -- Array of ticket IDs related to this insight
  metrics JSON, -- Statistical data supporting the insight
  time_range_start DATETIME,
  time_range_end DATETIME,

  -- Status
  status VARCHAR(20) DEFAULT 'active', -- active, acknowledged, resolved, dismissed
  acknowledged_by INT, -- User ID who acknowledged
  acknowledged_at TIMESTAMP NULL,

  -- Metadata
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  FOREIGN KEY (acknowledged_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_type (insight_type),
  INDEX idx_severity (severity),
  INDEX idx_status (status),
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table to store AI category mappings and learning
CREATE TABLE IF NOT EXISTS ai_category_mappings (
  id INT AUTO_INCREMENT PRIMARY KEY,

  -- Pattern matching
  pattern_text TEXT NOT NULL,
  pattern_type VARCHAR(50), -- subject, body, keyword, regex

  -- Mapping result
  category VARCHAR(100),
  root_cause VARCHAR(100),
  priority VARCHAR(20),
  suggested_assignee VARCHAR(255),

  -- Learning data
  match_count INT DEFAULT 0,
  accuracy_score DECIMAL(5,2), -- How often this mapping was correct
  last_matched_at TIMESTAMP NULL,

  -- Metadata
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_active BOOLEAN DEFAULT TRUE,

  INDEX idx_pattern_type (pattern_type),
  INDEX idx_category (category),
  INDEX idx_active (is_active),
  FULLTEXT idx_pattern_text (pattern_text)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table to track AI system performance metrics
CREATE TABLE IF NOT EXISTS ai_system_metrics (
  id INT AUTO_INCREMENT PRIMARY KEY,

  -- Metrics
  metric_date DATE NOT NULL,
  emails_analyzed INT DEFAULT 0,
  avg_confidence_score DECIMAL(5,2),
  avg_processing_time_ms INT,

  -- Accuracy tracking
  correct_predictions INT DEFAULT 0,
  total_predictions INT DEFAULT 0,
  accuracy_rate DECIMAL(5,2),

  -- Insights
  trends_detected INT DEFAULT 0,
  anomalies_detected INT DEFAULT 0,
  recommendations_generated INT DEFAULT 0,

  -- Resource usage
  api_calls_made INT DEFAULT 0,
  api_cost_usd DECIMAL(10,4),

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY unique_date (metric_date),
  INDEX idx_date (metric_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Add AI-related columns to existing tickets table (if not exists)
-- These allow manual feedback for AI learning
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS ai_analyzed BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ai_accuracy_feedback INT, -- 1-5 rating of AI accuracy
  ADD INDEX IF NOT EXISTS idx_ai_analyzed (ai_analyzed);

-- View for easy access to tickets with AI analysis
CREATE OR REPLACE VIEW v_tickets_with_ai AS
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
LEFT JOIN ai_email_analysis ai ON t.id = ai.ticket_id;
