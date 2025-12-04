#!/usr/bin/env node

const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
require('dotenv').config();

async function applyMigration() {
  console.log('🚀 Applying Customer Companies Migration');
  console.log('=========================================\n');
  console.log('This migration creates a one-to-many relationship:');
  console.log('  - customer_companies (Master) - One per company domain');
  console.log('  - customers (Team Members) - Many users per company\n');

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

        // Check if customer_companies table already exists
        const [tables] = await tenantConnection.query(
          "SHOW TABLES LIKE 'customer_companies'"
        );

        if (tables.length > 0) {
          console.log(`   ⏭️  customer_companies table already exists, skipping...`);
          await tenantConnection.end();
          continue;
        }

        // Start transaction
        await tenantConnection.beginTransaction();

        // 1. Create customer_companies (Master) table
        await tenantConnection.execute(`
          CREATE TABLE customer_companies (
            id INT AUTO_INCREMENT PRIMARY KEY,
            company_name VARCHAR(100) NOT NULL,
            company_domain VARCHAR(255) NOT NULL UNIQUE,
            admin_user_id INT NULL,
            admin_email VARCHAR(100) NOT NULL,
            contact_phone VARCHAR(20) NULL,
            address TEXT NULL,
            sla_level ENUM('basic', 'premium', 'enterprise') DEFAULT 'basic',
            is_active BOOLEAN DEFAULT TRUE,
            notes TEXT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_company_domain (company_domain),
            INDEX idx_admin_user_id (admin_user_id),
            INDEX idx_is_active (is_active)
          )
        `);
        console.log(`   ✅ Created customer_companies table`);

        // 2. Add customer_company_id to customers table
        const [columns] = await tenantConnection.query(
          "SHOW COLUMNS FROM customers LIKE 'customer_company_id'"
        );

        if (columns.length === 0) {
          await tenantConnection.execute(`
            ALTER TABLE customers
            ADD COLUMN customer_company_id INT NULL AFTER user_id,
            ADD COLUMN is_company_admin BOOLEAN DEFAULT FALSE AFTER customer_company_id,
            ADD COLUMN job_title VARCHAR(100) NULL AFTER is_company_admin,
            ADD INDEX idx_customer_company_id (customer_company_id)
          `);
          console.log(`   ✅ Added customer_company_id, is_company_admin, job_title to customers table`);
        }

        // 3. Migrate existing customer data
        // Get all unique company domains from existing customers
        const [existingCustomers] = await tenantConnection.query(`
          SELECT DISTINCT
            c.company_domain,
            c.company_name,
            c.contact_phone,
            c.address,
            c.sla_level
          FROM customers c
          WHERE c.company_domain IS NOT NULL AND c.company_domain != ''
        `);

        console.log(`   📊 Found ${existingCustomers.length} unique company domain(s) to migrate`);

        for (const customer of existingCustomers) {
          // Create admin email from domain
          const adminEmail = `admin@${customer.company_domain}`;

          // Insert into customer_companies
          const [insertResult] = await tenantConnection.execute(`
            INSERT INTO customer_companies (company_name, company_domain, admin_email, contact_phone, address, sla_level)
            VALUES (?, ?, ?, ?, ?, ?)
          `, [
            customer.company_name || customer.company_domain,
            customer.company_domain,
            adminEmail,
            customer.contact_phone || null,
            customer.address || null,
            customer.sla_level || 'basic'
          ]);

          const companyId = insertResult.insertId;

          // Update all customers with this domain to link to the new company
          await tenantConnection.execute(`
            UPDATE customers c
            SET c.customer_company_id = ?
            WHERE c.company_domain = ?
          `, [companyId, customer.company_domain]);

          // Find or create admin user for this company
          // First check if there's an existing user with admin@ email
          const [existingAdmin] = await tenantConnection.query(`
            SELECT u.id FROM users u
            JOIN customers c ON u.id = c.user_id
            WHERE u.email = ? OR (c.company_domain = ? AND u.username LIKE '%admin%')
            LIMIT 1
          `, [adminEmail, customer.company_domain]);

          if (existingAdmin.length > 0) {
            // Mark existing user as company admin
            await tenantConnection.execute(`
              UPDATE customers SET is_company_admin = TRUE WHERE user_id = ?
            `, [existingAdmin[0].id]);

            // Set as admin for the company
            await tenantConnection.execute(`
              UPDATE customer_companies SET admin_user_id = ? WHERE id = ?
            `, [existingAdmin[0].id, companyId]);

            console.log(`   📌 Set existing user as admin for ${customer.company_domain}`);
          } else {
            // Create new admin user for this company
            const tempPassword = Math.random().toString(36).slice(-10);
            const hashedPassword = await bcrypt.hash(tempPassword, 10);
            const adminUsername = `${customer.company_domain.split('.')[0]}_admin`;

            const [userResult] = await tenantConnection.execute(`
              INSERT INTO users (username, email, password_hash, full_name, role, is_active)
              VALUES (?, ?, ?, ?, 'customer', TRUE)
            `, [
              adminUsername,
              adminEmail,
              hashedPassword,
              `${customer.company_name || customer.company_domain} Admin`
            ]);

            const newUserId = userResult.insertId;

            // Create customer profile for admin
            await tenantConnection.execute(`
              INSERT INTO customers (user_id, customer_company_id, is_company_admin, company_name, company_domain, sla_level)
              VALUES (?, ?, TRUE, ?, ?, ?)
            `, [
              newUserId,
              companyId,
              customer.company_name || customer.company_domain,
              customer.company_domain,
              customer.sla_level || 'basic'
            ]);

            // Set as admin for the company
            await tenantConnection.execute(`
              UPDATE customer_companies SET admin_user_id = ? WHERE id = ?
            `, [newUserId, companyId]);

            console.log(`   👤 Created admin user for ${customer.company_domain}: ${adminUsername} (temp password: ${tempPassword})`);
          }

          console.log(`   ✅ Migrated company: ${customer.company_domain}`);
        }

        // 4. Add foreign key constraint (after data migration)
        await tenantConnection.execute(`
          ALTER TABLE customers
          ADD CONSTRAINT fk_customer_company
          FOREIGN KEY (customer_company_id) REFERENCES customer_companies(id)
          ON DELETE SET NULL
        `);
        console.log(`   ✅ Added foreign key constraint`);

        // 5. Update customer_companies admin_user_id foreign key
        await tenantConnection.execute(`
          ALTER TABLE customer_companies
          ADD CONSTRAINT fk_admin_user
          FOREIGN KEY (admin_user_id) REFERENCES users(id)
          ON DELETE SET NULL
        `);
        console.log(`   ✅ Added admin_user_id foreign key constraint`);

        // Commit transaction
        await tenantConnection.commit();

        await tenantConnection.end();
        console.log(`   ✅ Migration completed for ${tenant.tenant_code}\n`);

      } catch (error) {
        console.error(`   ❌ Error processing tenant ${tenant.tenant_code}:`, error.message);
        console.error(error);
      }
    }

    console.log('🎉 Customer Companies Migration completed successfully!');
    console.log('\nNew Structure:');
    console.log('  customer_companies (Master) - One per company domain');
    console.log('    └── customers (Team Members) - Many users per company');
    console.log('\nAdmin users created with email: admin@{company_domain}');

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  }
}

// Run migration
applyMigration().catch(console.error);
