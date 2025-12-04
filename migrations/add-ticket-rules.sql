-- Ticket Processing Rules Module
-- This table stores automated rules for ticket processing

CREATE TABLE IF NOT EXISTS ticket_processing_rules (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_code VARCHAR(50) NOT NULL,
  rule_name VARCHAR(255) NOT NULL,
  description TEXT,
  enabled BOOLEAN DEFAULT TRUE,

  -- Search criteria
  search_in ENUM('title', 'body', 'both') DEFAULT 'both',
  search_text VARCHAR(500) NOT NULL,
  case_sensitive BOOLEAN DEFAULT FALSE,

  -- Action to perform
  action_type ENUM('delete', 'create_for_customer', 'assign_to_expert', 'set_priority', 'set_status', 'add_tag') NOT NULL,

  -- Action parameters (stored as JSON)
  action_params JSON,

  -- Execution tracking
  times_triggered INT DEFAULT 0,
  last_triggered_at DATETIME,

  -- Metadata
  created_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_tenant (tenant_code),
  INDEX idx_enabled (enabled),
  INDEX idx_search (search_text),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Rule execution log
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
  INDEX idx_date (executed_at),
  FOREIGN KEY (rule_id) REFERENCES ticket_processing_rules(id) ON DELETE CASCADE,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);
