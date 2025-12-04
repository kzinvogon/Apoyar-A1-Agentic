#!/usr/bin/env node

const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
require('dotenv').config();

async function fixMigration() {
  console.log('🔧 Fixing Customer Companies Migration');
  console.log('======================================\n');

  try {
    const tenantConnection = await mysql.createConnection({
      host: process.env.MASTER_DB_HOST || 'localhost',
      port: process.env.MASTER_DB_PORT || 3306,
      user: process.env.MASTER_DB_USER || 'root',
      password: process.env.MASTER_DB_PASSWORD || '',
      database: 'a1_tenant_apoyar'
    });

    // Check current state
    console.log('📊 Checking current state...\n');

    // Check if customer_companies exists
    const [tables] = await tenantConnection.query("SHOW TABLES LIKE 'customer_companies'");
    console.log(`   customer_companies table exists: ${tables.length > 0}`);

    if (tables.length > 0) {
      const [companies] = await tenantConnection.query('SELECT * FROM customer_companies');
      console.log(`   Companies in table: ${companies.length}`);
      companies.forEach(c => console.log(`     - ${c.company_domain} (${c.company_name})`));
    }

    // Check if customers table has new columns
    const [columns] = await tenantConnection.query("SHOW COLUMNS FROM customers LIKE 'customer_company_id'");
    console.log(`   customer_company_id column exists: ${columns.length > 0}`);

    // Check customers with/without company_id
    if (columns.length > 0) {
      const [linked] = await tenantConnection.query('SELECT COUNT(*) as count FROM customers WHERE customer_company_id IS NOT NULL');
      const [unlinked] = await tenantConnection.query('SELECT COUNT(*) as count FROM customers WHERE customer_company_id IS NULL');
      console.log(`   Customers linked to companies: ${linked[0].count}`);
      console.log(`   Customers NOT linked: ${unlinked[0].count}`);
    }

    // Get all existing domains
    const [domains] = await tenantConnection.query(`
      SELECT DISTINCT company_domain
      FROM customers
      WHERE company_domain IS NOT NULL AND company_domain != ''
    `);
    console.log(`\n   Unique domains in customers table: ${domains.length}`);
    domains.forEach(d => console.log(`     - ${d.company_domain}`));

    // Now fix - link any unlinked customers
    console.log('\n🔗 Linking unlinked customers to their companies...\n');

    for (const domain of domains) {
      // Check if company exists
      const [existing] = await tenantConnection.query(
        'SELECT id FROM customer_companies WHERE company_domain = ?',
        [domain.company_domain]
      );

      let companyId;

      if (existing.length === 0) {
        // Get company info from one of its customers
        const [customerInfo] = await tenantConnection.query(`
          SELECT company_name, contact_phone, address, sla_level
          FROM customers
          WHERE company_domain = ?
          LIMIT 1
        `, [domain.company_domain]);

        const info = customerInfo[0] || {};
        const adminEmail = `admin@${domain.company_domain}`;

        // Create company
        const [insertResult] = await tenantConnection.execute(`
          INSERT INTO customer_companies (company_name, company_domain, admin_email, contact_phone, address, sla_level)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [
          info.company_name || domain.company_domain,
          domain.company_domain,
          adminEmail,
          info.contact_phone || null,
          info.address || null,
          info.sla_level || 'basic'
        ]);

        companyId = insertResult.insertId;
        console.log(`   ✅ Created company: ${domain.company_domain} (ID: ${companyId})`);

        // Create admin user
        const tempPassword = Math.random().toString(36).slice(-10);
        const hashedPassword = await bcrypt.hash(tempPassword, 10);
        const adminUsername = `${domain.company_domain.split('.')[0]}_admin`;

        // Check if admin user already exists
        const [existingUser] = await tenantConnection.query(
          'SELECT id FROM users WHERE email = ?',
          [adminEmail]
        );

        if (existingUser.length === 0) {
          const [userResult] = await tenantConnection.execute(`
            INSERT INTO users (username, email, password_hash, full_name, role, is_active)
            VALUES (?, ?, ?, ?, 'customer', TRUE)
          `, [
            adminUsername,
            adminEmail,
            hashedPassword,
            `${info.company_name || domain.company_domain} Admin`
          ]);

          const newUserId = userResult.insertId;

          // Create customer profile for admin
          await tenantConnection.execute(`
            INSERT INTO customers (user_id, customer_company_id, is_company_admin, company_name, company_domain, sla_level)
            VALUES (?, ?, TRUE, ?, ?, ?)
          `, [
            newUserId,
            companyId,
            info.company_name || domain.company_domain,
            domain.company_domain,
            info.sla_level || 'basic'
          ]);

          // Set as admin for the company
          await tenantConnection.execute(
            'UPDATE customer_companies SET admin_user_id = ? WHERE id = ?',
            [newUserId, companyId]
          );

          console.log(`   👤 Created admin: ${adminUsername} (password: ${tempPassword})`);
        }
      } else {
        companyId = existing[0].id;
        console.log(`   ℹ️  Company exists: ${domain.company_domain} (ID: ${companyId})`);
      }

      // Link all customers with this domain to the company
      const [updateResult] = await tenantConnection.execute(`
        UPDATE customers
        SET customer_company_id = ?
        WHERE company_domain = ? AND (customer_company_id IS NULL OR customer_company_id != ?)
      `, [companyId, domain.company_domain, companyId]);

      if (updateResult.affectedRows > 0) {
        console.log(`   🔗 Linked ${updateResult.affectedRows} customer(s) to ${domain.company_domain}`);
      }
    }

    // Add foreign key if not exists
    try {
      await tenantConnection.execute(`
        ALTER TABLE customers
        ADD CONSTRAINT fk_customer_company
        FOREIGN KEY (customer_company_id) REFERENCES customer_companies(id)
        ON DELETE SET NULL
      `);
      console.log(`\n   ✅ Added foreign key constraint`);
    } catch (e) {
      if (e.code === 'ER_DUP_KEYNAME') {
        console.log(`\n   ℹ️  Foreign key constraint already exists`);
      }
    }

    // Add admin foreign key if not exists
    try {
      await tenantConnection.execute(`
        ALTER TABLE customer_companies
        ADD CONSTRAINT fk_admin_user
        FOREIGN KEY (admin_user_id) REFERENCES users(id)
        ON DELETE SET NULL
      `);
      console.log(`   ✅ Added admin_user_id foreign key constraint`);
    } catch (e) {
      if (e.code === 'ER_DUP_KEYNAME') {
        console.log(`   ℹ️  Admin user foreign key constraint already exists`);
      }
    }

    // Final status
    console.log('\n📊 Final Status:');
    const [finalCompanies] = await tenantConnection.query('SELECT * FROM customer_companies');
    console.log(`   Total customer companies: ${finalCompanies.length}`);

    const [finalLinked] = await tenantConnection.query('SELECT COUNT(*) as count FROM customers WHERE customer_company_id IS NOT NULL');
    const [finalUnlinked] = await tenantConnection.query('SELECT COUNT(*) as count FROM customers WHERE customer_company_id IS NULL');
    console.log(`   Customers linked: ${finalLinked[0].count}`);
    console.log(`   Customers unlinked: ${finalUnlinked[0].count}`);

    await tenantConnection.end();
    console.log('\n🎉 Fix completed successfully!');

  } catch (error) {
    console.error('❌ Fix failed:', error.message);
    console.error(error);
    process.exit(1);
  }
}

fixMigration().catch(console.error);
