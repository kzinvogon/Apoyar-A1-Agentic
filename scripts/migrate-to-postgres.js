#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const bcrypt = require('bcrypt');
const { query, testConnection, initializeDatabase } = require('../config/database');

async function migrateData() {
  console.log('🚀 Starting migration from JSON to PostgreSQL...');
  
  // Test database connection
  const connected = await testConnection();
  if (!connected) {
    console.error('❌ Cannot connect to database. Exiting.');
    process.exit(1);
  }

  // Initialize database schema
  const initialized = await initializeDatabase();
  if (!initialized) {
    console.error('❌ Cannot initialize database schema. Exiting.');
    process.exit(1);
  }

  try {
    // Read JSON data files
    const masterDbPath = path.join(__dirname, '../master-db.json');
    const masterData = JSON.parse(await fs.readFileSync(masterDbPath, 'utf8'));
    
    console.log('📊 Migrating master data...');
    
    // Migrate master users
    if (masterData.masterUsers && masterData.masterUsers.length > 0) {
      for (const user of masterData.masterUsers) {
        await query(
          'INSERT INTO master_users (username, password_hash, name, email, role) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (username) DO NOTHING',
          [user.username, user.password, user.name, user.email, user.role]
        );
      }
      console.log(`✅ Migrated ${masterData.masterUsers.length} master users`);
    }

    // Migrate subscription plans
    if (masterData.plans && masterData.plans.length > 0) {
      for (const plan of masterData.plans) {
        await query(
          `INSERT INTO subscription_plans (name, display_name, description, max_users, max_tickets, max_storage_gb, features, price_monthly, price_yearly, is_trial, trial_days, is_active) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (name) DO NOTHING`,
          [
            plan.name,
            plan.displayName,
            plan.description,
            plan.maxUsers,
            plan.maxTickets,
            plan.maxStorage,
            JSON.stringify(plan.features || []),
            plan.priceMonthly,
            plan.priceYearly,
            plan.isTrial || false,
            plan.trialDays || 0,
            plan.isActive !== false
          ]
        );
      }
      console.log(`✅ Migrated ${masterData.plans.length} subscription plans`);
    }

    // Migrate tenants
    if (masterData.tenants && masterData.tenants.length > 0) {
      for (const tenant of masterData.tenants) {
        await query(
          'INSERT INTO tenants (tenant_id, company_name, domain, contact_email, contact_phone, address, status, email_processing_enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (tenant_id) DO NOTHING',
          [
            tenant.id,
            tenant.companyName,
            tenant.domain,
            tenant.contactEmail,
            tenant.contactPhone,
            tenant.address,
            tenant.status || 'active',
            tenant.emailProcessingEnabled || false
          ]
        );
      }
      console.log(`✅ Migrated ${masterData.tenants.length} tenants`);
    }

    console.log('🎉 Migration completed successfully!');
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

// Run migration if called directly
if (require.main === module) {
  migrateData().then(() => {
    console.log('✅ Migration script completed');
    process.exit(0);
  }).catch(error => {
    console.error('❌ Migration script failed:', error);
    process.exit(1);
  });
}

module.exports = { migrateData };
