#!/usr/bin/env node
/**
 * Migration: Add phone, department, receive_email_updates columns to users table
 *
 * Fixes APO-54 Item #5: Profile update internal server error
 */

if (!process.env.MYSQLHOST) {
  require('dotenv').config();
}

const { getMasterConnection, getTenantConnection } = require('../config/database');

async function addColumnsToTenant(tenantCode) {
  const connection = await getTenantConnection(tenantCode);
  try {
    // Check if columns exist first
    const [columns] = await connection.query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'users'
      AND COLUMN_NAME IN ('phone', 'department', 'receive_email_updates')
    `);

    const existingColumns = columns.map(c => c.COLUMN_NAME);

    // Add phone if missing
    if (!existingColumns.includes('phone')) {
      await connection.query(`
        ALTER TABLE users ADD COLUMN phone VARCHAR(50) DEFAULT NULL AFTER full_name
      `);
      console.log(`  + Added 'phone' column`);
    }

    // Add department if missing
    if (!existingColumns.includes('department')) {
      await connection.query(`
        ALTER TABLE users ADD COLUMN department VARCHAR(100) DEFAULT NULL AFTER phone
      `);
      console.log(`  + Added 'department' column`);
    }

    // Add receive_email_updates if missing
    if (!existingColumns.includes('receive_email_updates')) {
      await connection.query(`
        ALTER TABLE users ADD COLUMN receive_email_updates TINYINT(1) DEFAULT 1 AFTER department
      `);
      console.log(`  + Added 'receive_email_updates' column`);
    }

    if (existingColumns.length === 3) {
      console.log(`  ✓ All columns already exist`);
    }

    console.log(`✅ Tenant ${tenantCode} migrated`);
  } finally {
    connection.release();
  }
}

async function main() {
  console.log('=== Migration: Add user profile columns ===\n');

  const masterConn = await getMasterConnection();
  try {
    const [tenants] = await masterConn.query("SELECT tenant_code FROM tenants WHERE status = 'active'");
    console.log(`Found ${tenants.length} active tenant(s)\n`);

    for (const tenant of tenants) {
      console.log(`Processing tenant: ${tenant.tenant_code}`);
      await addColumnsToTenant(tenant.tenant_code);
    }

    console.log('\n✅ Migration complete');
  } finally {
    masterConn.release();
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
