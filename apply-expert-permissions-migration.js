/**
 * Migration script to create expert_ticket_permissions table
 * Run with: node apply-expert-permissions-migration.js
 */

const mysql = require('mysql2/promise');
require('dotenv').config();

const createTableSQL = `
CREATE TABLE IF NOT EXISTS expert_ticket_permissions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  expert_id INT NOT NULL,
  permission_type ENUM('all_tickets', 'specific_customers', 'title_patterns') NOT NULL,
  customer_id INT NULL,
  title_pattern VARCHAR(255) NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  FOREIGN KEY (expert_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE,

  INDEX idx_expert_id (expert_id),
  INDEX idx_customer_id (customer_id),
  INDEX idx_permission_type (permission_type),
  INDEX idx_is_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

async function runMigration() {
  let connection;

  try {
    // Connect to main database to get tenant list
    connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      multipleStatements: true
    });

    console.log('Connected to database server');

    // Get all tenant databases
    const [databases] = await connection.query(
      "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE '%_tenant'"
    );

    console.log(`Found ${databases.length} tenant databases`);

    for (const db of databases) {
      const dbName = db.SCHEMA_NAME;
      console.log(`\nProcessing: ${dbName}`);

      try {
        await connection.query(`USE ${dbName}`);
        await connection.query(createTableSQL);
        console.log(`  ✅ Created expert_ticket_permissions table`);
      } catch (err) {
        if (err.code === 'ER_TABLE_EXISTS_ERROR') {
          console.log(`  ⏭️  Table already exists`);
        } else {
          console.error(`  ❌ Error: ${err.message}`);
        }
      }
    }

    console.log('\n✅ Migration completed!');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    if (connection) await connection.end();
  }
}

runMigration();
