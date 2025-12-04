#!/usr/bin/env node

const mysql = require('mysql2/promise');
require('dotenv').config();

async function applyMigration() {
  console.log('🚀 Applying Expert Ticket Permissions Migration');
  console.log('================================================\n');

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
      'SELECT tenant_code, database_name FROM tenants WHERE is_active = TRUE'
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

        // Check if expert_ticket_permissions table already exists
        const [tables] = await tenantConnection.query(
          "SHOW TABLES LIKE 'expert_ticket_permissions'"
        );

        if (tables.length > 0) {
          console.log(`   ⏭️  Table already exists, skipping...`);
          await tenantConnection.end();
          continue;
        }

        // Create expert_ticket_permissions table
        await tenantConnection.execute(`
          CREATE TABLE expert_ticket_permissions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            expert_id INT NOT NULL,
            permission_type ENUM('all_tickets', 'specific_customers', 'title_patterns') NOT NULL DEFAULT 'all_tickets',
            customer_id INT NULL,
            title_pattern VARCHAR(255) NULL,
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            FOREIGN KEY (expert_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE,
            INDEX idx_expert_id (expert_id),
            INDEX idx_customer_id (customer_id),
            INDEX idx_permission_type (permission_type)
          )
        `);

        console.log(`   ✅ Created expert_ticket_permissions table`);

        // Add ticket status support for 'paused'
        await tenantConnection.execute(`
          ALTER TABLE tickets
          MODIFY COLUMN status ENUM('open', 'in_progress', 'paused', 'resolved', 'closed') DEFAULT 'open'
        `);

        console.log(`   ✅ Added 'paused' status to tickets table`);

        // Add columns to track ticket assignment history
        const [columns] = await tenantConnection.query(
          "SHOW COLUMNS FROM tickets LIKE 'previous_assignee_id'"
        );

        if (columns.length === 0) {
          await tenantConnection.execute(`
            ALTER TABLE tickets
            ADD COLUMN previous_assignee_id INT NULL AFTER assignee_id,
            ADD FOREIGN KEY (previous_assignee_id) REFERENCES users(id) ON DELETE SET NULL
          `);
          console.log(`   ✅ Added previous_assignee_id to tickets table`);
        }

        // Create default permission for existing experts (view all tickets)
        await tenantConnection.execute(`
          INSERT INTO expert_ticket_permissions (expert_id, permission_type)
          SELECT id, 'all_tickets'
          FROM users
          WHERE role IN ('admin', 'expert') AND is_active = TRUE
        `);

        console.log(`   ✅ Created default permissions for existing experts`);

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
