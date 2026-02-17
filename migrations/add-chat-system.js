const { getTenantConnection } = require('../config/database');

async function runMigration(tenantCode) {
  const connection = await getTenantConnection(tenantCode);
  try {
    // Add sla_skip_penalty_minutes to tickets
    try {
      await connection.execute(`ALTER TABLE tickets ADD COLUMN sla_skip_penalty_minutes INT NOT NULL DEFAULT 0`);
      console.log(`  ✅ Added sla_skip_penalty_minutes to tickets`);
    } catch (e) {
      if (!e.message.includes('Duplicate column')) throw e;
    }

    // Add related_ticket_id to tickets
    try {
      await connection.execute(`ALTER TABLE tickets ADD COLUMN related_ticket_id INT NULL`);
      console.log(`  ✅ Added related_ticket_id to tickets`);
    } catch (e) {
      if (!e.message.includes('Duplicate column')) throw e;
    }

    // Add is_major_incident to tickets
    try {
      await connection.execute(`ALTER TABLE tickets ADD COLUMN is_major_incident BOOLEAN DEFAULT FALSE`);
      console.log(`  ✅ Added is_major_incident to tickets`);
    } catch (e) {
      if (!e.message.includes('Duplicate column')) throw e;
    }

    // Add chat_session_id to tickets
    try {
      await connection.execute(`ALTER TABLE tickets ADD COLUMN chat_session_id INT NULL`);
      console.log(`  ✅ Added chat_session_id to tickets`);
    } catch (e) {
      if (!e.message.includes('Duplicate column')) throw e;
    }

    // Add index on source
    try {
      await connection.execute(`ALTER TABLE tickets ADD INDEX idx_tickets_source (source)`);
    } catch (e) { /* index may exist */ }

    // Add index on related_ticket_id
    try {
      await connection.execute(`ALTER TABLE tickets ADD INDEX idx_tickets_related (related_ticket_id)`);
    } catch (e) { /* index may exist */ }

    // Add index on is_major_incident
    try {
      await connection.execute(`ALTER TABLE tickets ADD INDEX idx_tickets_major_incident (is_major_incident)`);
    } catch (e) { /* index may exist */ }

    // Create chat_sessions table
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
        INDEX idx_chat_sessions_status (status),
        INDEX idx_chat_sessions_customer (customer_user_id),
        INDEX idx_chat_sessions_expert (expert_user_id)
      )
    `);
    console.log(`  ✅ Created chat_sessions table`);

    // Create chat_messages table
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
        INDEX idx_chat_messages_session (session_id, created_at)
      )
    `);
    console.log(`  ✅ Created chat_messages table`);

    // Create chat_canned_responses table
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
    console.log(`  ✅ Created chat_canned_responses table`);

    // Seed default canned responses
    await connection.execute(`
      INSERT IGNORE INTO chat_canned_responses (label, message, action_type, sort_order) VALUES
      ('Log a Ticket', 'Would you like me to log a support ticket for this issue?', 'create_ticket', 1),
      ('Send Screenshot', 'Could you please share a screenshot of the issue?', 'request_screenshot', 2),
      ('Checking', 'Let me check that for you, one moment please...', 'text', 3),
      ('Anything Else', 'Is there anything else I can help you with?', 'text', 4)
    `);

    console.log(`✅ Chat system migration complete for tenant: ${tenantCode}`);
  } finally {
    connection.release();
  }
}

module.exports = { runMigration };
