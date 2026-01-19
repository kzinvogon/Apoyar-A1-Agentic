const { getTenantConnection } = require('./config/database');

async function applyTicketRulesMigration() {
  console.log('🔧 Applying Ticket Processing Rules migration...\n');

  try {
    const connection = await getTenantConnection('apoyar');

    console.log('1️⃣  Creating ticket_processing_rules table...');
    await connection.query(`
      CREATE TABLE IF NOT EXISTS ticket_processing_rules (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_code VARCHAR(50) NOT NULL,
        rule_name VARCHAR(255) NOT NULL,
        description TEXT,
        enabled BOOLEAN DEFAULT TRUE,

        search_in ENUM('title', 'body', 'both') DEFAULT 'both',
        search_text VARCHAR(500) NOT NULL,
        case_sensitive BOOLEAN DEFAULT FALSE,

        action_type ENUM('delete', 'create_for_customer', 'assign_to_expert', 'set_priority', 'set_status', 'add_tag', 'add_to_monitoring') NOT NULL,
        action_params JSON,

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
    console.log('   ✅ ticket_processing_rules table created');

    console.log('\n2️⃣  Creating ticket_rule_executions table...');
    await connection.query(`
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
      )
    `);
    console.log('   ✅ ticket_rule_executions table created');

    console.log('\n3️⃣  Adding sample rules...');

    // Sample rule: Auto-assign infrastructure alerts to infrastructure expert
    await connection.query(`
      INSERT INTO ticket_processing_rules
      (tenant_code, rule_name, description, enabled, search_in, search_text, case_sensitive, action_type, action_params)
      VALUES
      ('apoyar', 'Auto-assign Infrastructure Alerts', 'Automatically assign infrastructure monitoring alerts to infrastructure expert', TRUE, 'title', 'Infrastructure Monitoring', FALSE, 'assign_to_expert', '{"expert_id": 1, "expert_name": "Infrastructure Team"}')
      ON DUPLICATE KEY UPDATE id=id
    `);

    // Sample rule: Delete test tickets
    await connection.query(`
      INSERT INTO ticket_processing_rules
      (tenant_code, rule_name, description, enabled, search_in, search_text, case_sensitive, action_type, action_params)
      VALUES
      ('apoyar', 'Delete Test Tickets', 'Automatically delete tickets marked as test', TRUE, 'both', 'TEST:', TRUE, 'delete', '{}')
      ON DUPLICATE KEY UPDATE id=id
    `);

    console.log('   ✅ Sample rules added');

    await connection.end();

    console.log('\n✅ Migration completed successfully!\n');
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    console.error(error);
    process.exit(1);
  }
}

applyTicketRulesMigration();
