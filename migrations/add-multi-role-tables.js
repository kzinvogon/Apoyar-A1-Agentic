/**
 * Migration: Add multi-role tables to ALL tenant databases
 * Tables: tenant_user_roles, tenant_user_company_memberships
 * Also: make password_hash nullable, add auth_method column, backfill roles
 */
const { getMasterConnection, getTenantConnection } = require('../config/database');

async function runMigration() {
  const masterConn = await getMasterConnection();
  let tenants;
  try {
    [tenants] = await masterConn.query(
      "SELECT tenant_code FROM tenants WHERE status = 'active'"
    );
  } finally {
    masterConn.release();
  }

  console.log(`Found ${tenants.length} active tenant(s) to migrate`);

  for (const { tenant_code } of tenants) {
    const conn = await getTenantConnection(tenant_code);
    try {
      console.log(`\nMigrating tenant: ${tenant_code}`);

      // 1. tenant_user_roles
      await conn.query(`
        CREATE TABLE IF NOT EXISTS tenant_user_roles (
          id INT AUTO_INCREMENT PRIMARY KEY,
          tenant_user_id INT NOT NULL,
          role_key ENUM('admin','expert','customer') NOT NULL,
          granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          granted_by INT NULL,
          UNIQUE KEY unique_user_role (tenant_user_id, role_key),
          FOREIGN KEY (tenant_user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      console.log(`  Created tenant_user_roles`);

      // 2. tenant_user_company_memberships
      await conn.query(`
        CREATE TABLE IF NOT EXISTS tenant_user_company_memberships (
          id INT AUTO_INCREMENT PRIMARY KEY,
          tenant_user_id INT NOT NULL,
          company_id INT NOT NULL,
          membership_role ENUM('member','admin') DEFAULT 'member',
          joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY unique_user_company (tenant_user_id, company_id),
          FOREIGN KEY (tenant_user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (company_id) REFERENCES customer_companies(id) ON DELETE CASCADE
        )
      `);
      console.log(`  Created tenant_user_company_memberships`);

      // 3. Make password_hash nullable
      const [cols] = await conn.query(
        `SELECT IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'password_hash'`
      );
      if (cols.length > 0 && cols[0].IS_NULLABLE === 'NO') {
        await conn.query(`ALTER TABLE users MODIFY COLUMN password_hash VARCHAR(255) NULL`);
        console.log(`  Made password_hash nullable`);
      }

      // 4. Add auth_method column if not exists
      const [authCols] = await conn.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'auth_method'`
      );
      if (authCols.length === 0) {
        await conn.query(
          `ALTER TABLE users ADD COLUMN auth_method ENUM('password','magic_link','both') DEFAULT 'password'`
        );
        console.log(`  Added auth_method column`);
      }

      // 5. Backfill: users → tenant_user_roles
      const [backfilled] = await conn.query(`
        INSERT IGNORE INTO tenant_user_roles (tenant_user_id, role_key)
        SELECT id, role FROM users WHERE is_active = TRUE
      `);
      console.log(`  Backfilled ${backfilled.affectedRows} user role(s)`);

      // 6. Backfill: customers → tenant_user_company_memberships
      const [companyBackfilled] = await conn.query(`
        INSERT IGNORE INTO tenant_user_company_memberships (tenant_user_id, company_id, membership_role)
        SELECT c.user_id, c.customer_company_id,
               IF(c.is_company_admin = 1, 'admin', 'member')
        FROM customers c
        WHERE c.customer_company_id IS NOT NULL
      `);
      console.log(`  Backfilled ${companyBackfilled.affectedRows} company membership(s)`);

    } finally {
      conn.release();
    }
  }

  console.log('\nMigration complete!');
}

module.exports = { runMigration };

if (require.main === module) {
  runMigration()
    .then(() => process.exit(0))
    .catch(err => { console.error(err); process.exit(1); });
}
