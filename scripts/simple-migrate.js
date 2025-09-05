#!/usr/bin/env node

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Database configuration
const pool = new Pool({
  user: 'davidhamilton',
  host: 'localhost',
  database: 'a1_support_dashboard',
  password: '',
  port: 5432,
});

async function migrateData() {
  console.log('🚀 Starting migration from JSON to PostgreSQL...');
  
  try {
    // Test connection
    const client = await pool.connect();
    console.log('✅ PostgreSQL connected successfully');
    
    // Read and execute schema
    const schemaPath = path.join(__dirname, '../database/simple-schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    await client.query(schema);
    console.log('✅ Database schema initialized');
    
    // Read master data
    const masterDbPath = path.join(__dirname, '../master-db.json');
    const masterData = JSON.parse(fs.readFileSync(masterDbPath, 'utf8'));
    
    // Migrate master users
    if (masterData.masterUsers && masterData.masterUsers.length > 0) {
      for (const user of masterData.masterUsers) {
        try {
          await client.query(
            'INSERT INTO master_users (username, password_hash, name, email, role) VALUES ($1, $2, $3, $4, $5)',
            [user.username, user.password, user.name, user.email || 'master@example.com', user.role]
          );
        } catch (err) {
          if (err.code === '23505') { // Unique violation
            console.log(`  ⚠️  User ${user.username} already exists, skipping`);
          } else {
            throw err;
          }
        }
      }
      console.log(`✅ Migrated ${masterData.masterUsers.length} master users`);
    }
    
    // Migrate subscription plans
    if (masterData.plans && masterData.plans.length > 0) {
      for (const plan of masterData.plans) {
        try {
          await client.query(
            `INSERT INTO subscription_plans (name, display_name, description, max_users, max_tickets, max_storage_gb, features, price_monthly, price_yearly, is_trial, trial_days, is_active) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
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
        } catch (err) {
          if (err.code === '23505') { // Unique violation
            console.log(`  ⚠️  Plan ${plan.name} already exists, skipping`);
          } else {
            throw err;
          }
        }
      }
      console.log(`✅ Migrated ${masterData.plans.length} subscription plans`);
    }
    
    // Migrate tenants - handle both field name formats
    if (masterData.tenants && masterData.tenants.length > 0) {
      for (const tenant of masterData.tenants) {
        try {
          // Handle different field name formats
          const tenantId = tenant.tenantId || tenant.id;
          const companyName = tenant.companyName || tenant.company_name;
          const domain = tenant.domain;
          const contactEmail = tenant.contactEmail || tenant.adminEmail;
          const contactPhone = tenant.contactPhone;
          const address = tenant.address;
          const status = tenant.status || 'active';
          const emailProcessingEnabled = tenant.emailProcessingEnabled || false;
          
          if (!tenantId) {
            console.log(`  ⚠️  Skipping tenant with missing ID:`, tenant);
            continue;
          }
          
          await client.query(
            'INSERT INTO tenants (tenant_id, company_name, domain, contact_email, contact_phone, address, status, email_processing_enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [tenantId, companyName, domain, contactEmail, contactPhone, address, status, emailProcessingEnabled]
          );
        } catch (err) {
          if (err.code === '23505') { // Unique violation
            console.log(`  ⚠️  Tenant ${tenant.tenantId || tenant.id} already exists, skipping`);
          } else {
            console.error(`  ❌ Error migrating tenant:`, err.message);
            throw err;
          }
        }
      }
      console.log(`✅ Migrated ${masterData.tenants.length} tenants`);
    }
    
    // Migrate tenant subscriptions
    if (masterData.subscriptions && masterData.subscriptions.length > 0) {
      for (const subscription of masterData.subscriptions) {
        try {
          // Get plan ID
          const planResult = await client.query('SELECT id FROM subscription_plans WHERE name = $1', [subscription.plan || subscription.planName]);
          const planId = planResult.rows[0]?.id;

          if (planId) {
            await client.query(
              `INSERT INTO tenant_subscriptions (tenant_id, plan_id, status, start_date, end_date, trial_end_date, auto_renew) 
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [
                subscription.tenantId,
                planId,
                subscription.status || 'active',
                subscription.startDate ? new Date(subscription.startDate) : new Date(),
                subscription.endDate ? new Date(subscription.endDate) : null,
                subscription.trialEndDate ? new Date(subscription.trialEndDate) : null,
                subscription.autoRenew !== false
              ]
            );
          }
        } catch (err) {
          if (err.code === '23505') { // Unique violation
            console.log(`  ⚠️  Subscription for ${subscription.tenantId} already exists, skipping`);
          } else {
            throw err;
          }
        }
      }
      console.log(`✅ Migrated ${masterData.subscriptions.length} tenant subscriptions`);
    }
    
    client.release();
    console.log('🎉 Migration completed successfully!');
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrateData();
