#!/usr/bin/env node
/**
 * Schema Parity Check
 *
 * PRODUCTION is the baseline. UAT must have all tables/columns/indexes that PROD has.
 * Fails if UAT is missing any schema element from PROD (unless allowlisted).
 *
 * Usage: node scripts/parity/check-schema-parity.js
 *
 * Environment variables:
 *   PROD_DB_HOST, PROD_DB_PORT, PROD_DB_USER, PROD_DB_PASSWORD
 *   UAT_DB_HOST, UAT_DB_PORT, UAT_DB_USER, UAT_DB_PASSWORD
 */

// Load main .env first, then parity-specific overrides
require('dotenv').config();
require('dotenv').config({ path: require('path').join(__dirname, '.env.parity'), override: true });
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

// Colors for output
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const CYAN = '\x1b[36m';
const NC = '\x1b[0m';

// Load allowlist
const ALLOWLIST_PATH = path.join(__dirname, 'allowlist.schema.json');
let allowlist = {
  allow_missing_tables_in_uat: [],
  allow_missing_columns_in_uat: [],  // format: "table.column"
  allow_missing_indexes_in_uat: [],  // format: "table.index_name"
  allow_type_differences: []         // format: "table.column"
};

if (fs.existsSync(ALLOWLIST_PATH)) {
  try {
    allowlist = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
  } catch (e) {
    console.error(`${RED}Failed to parse allowlist: ${e.message}${NC}`);
  }
}

// Database configurations
const PROD_CONFIG = {
  host: process.env.PROD_DB_HOST || 'tramway.proxy.rlwy.net',
  port: parseInt(process.env.PROD_DB_PORT || '19355', 10),
  user: process.env.PROD_DB_USER || 'root',
  password: process.env.PROD_DB_PASSWORD || process.env.MYSQLPASSWORD || ''
};

const UAT_CONFIG = {
  host: process.env.UAT_DB_HOST || 'tramway.proxy.rlwy.net',
  port: parseInt(process.env.UAT_DB_PORT || '20773', 10),
  user: process.env.UAT_DB_USER || 'serviflow_app',
  password: process.env.UAT_DB_PASSWORD || '5tarry.53rv1fl0w'
};

// Databases to compare
const DATABASES = ['a1_master', 'a1_tenant_apoyar'];

/**
 * Get all tables in a database
 */
async function getTables(conn, database) {
  const [rows] = await conn.query(
    'SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = "BASE TABLE"',
    [database]
  );
  return rows.map(r => r.TABLE_NAME);
}

/**
 * Get columns for a table
 */
async function getColumns(conn, database, table) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    [database, table]
  );
  return rows.map(r => ({
    name: r.COLUMN_NAME,
    type: r.COLUMN_TYPE,
    nullable: r.IS_NULLABLE,
    default: r.COLUMN_DEFAULT,
    key: r.COLUMN_KEY
  }));
}

/**
 * Get indexes for a table
 */
async function getIndexes(conn, database, table) {
  const [rows] = await conn.query(
    `SELECT INDEX_NAME, NON_UNIQUE, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) as COLUMNS
     FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     GROUP BY INDEX_NAME, NON_UNIQUE`,
    [database, table]
  );
  return rows.map(r => ({
    name: r.INDEX_NAME,
    unique: r.NON_UNIQUE === 0,
    columns: r.COLUMNS
  }));
}

/**
 * Compare schemas for a database
 */
async function compareDatabase(prodConn, uatConn, database) {
  console.log(`\n${CYAN}Comparing database: ${database}${NC}`);

  const failures = [];
  const warnings = [];

  // Get tables from both
  let prodTables, uatTables;
  try {
    prodTables = await getTables(prodConn, database);
  } catch (e) {
    console.log(`  ${YELLOW}Cannot access PROD database ${database}: ${e.message}${NC}`);
    return { failures, warnings };
  }

  try {
    uatTables = await getTables(uatConn, database);
  } catch (e) {
    console.log(`  ${YELLOW}Cannot access UAT database ${database}: ${e.message}${NC}`);
    return { failures, warnings };
  }

  const prodTableSet = new Set(prodTables);
  const uatTableSet = new Set(uatTables);

  console.log(`  PROD tables: ${prodTables.length}, UAT tables: ${uatTables.length}`);

  // Check for PROD tables missing in UAT
  for (const table of prodTables) {
    if (!uatTableSet.has(table)) {
      if (allowlist.allow_missing_tables_in_uat.includes(table) ||
          allowlist.allow_missing_tables_in_uat.includes(`${database}.${table}`)) {
        warnings.push(`${database}: UAT missing table '${table}' (allowlisted)`);
      } else {
        failures.push(`${database}: UAT missing table '${table}' that exists in PROD`);
      }
      continue;
    }

    // Compare columns
    const prodCols = await getColumns(prodConn, database, table);
    const uatCols = await getColumns(uatConn, database, table);
    const uatColMap = new Map(uatCols.map(c => [c.name, c]));

    for (const prodCol of prodCols) {
      const uatCol = uatColMap.get(prodCol.name);
      const colKey = `${table}.${prodCol.name}`;
      const fullColKey = `${database}.${table}.${prodCol.name}`;

      if (!uatCol) {
        if (allowlist.allow_missing_columns_in_uat.includes(colKey) ||
            allowlist.allow_missing_columns_in_uat.includes(fullColKey)) {
          warnings.push(`${database}.${table}: UAT missing column '${prodCol.name}' (allowlisted)`);
        } else {
          failures.push(`${database}.${table}: UAT missing column '${prodCol.name}' that exists in PROD`);
        }
      } else {
        // Check type differences
        if (prodCol.type !== uatCol.type) {
          if (allowlist.allow_type_differences.includes(colKey) ||
              allowlist.allow_type_differences.includes(fullColKey)) {
            warnings.push(`${database}.${table}.${prodCol.name}: Type differs (PROD: ${prodCol.type}, UAT: ${uatCol.type}) (allowlisted)`);
          } else {
            // Type differences that matter
            const prodBase = prodCol.type.replace(/\(\d+\)/, '');
            const uatBase = uatCol.type.replace(/\(\d+\)/, '');
            if (prodBase !== uatBase) {
              failures.push(`${database}.${table}.${prodCol.name}: Type mismatch - PROD: ${prodCol.type}, UAT: ${uatCol.type}`);
            } else {
              warnings.push(`${database}.${table}.${prodCol.name}: Type length differs (PROD: ${prodCol.type}, UAT: ${uatCol.type})`);
            }
          }
        }

        // Check nullable differences
        if (prodCol.nullable !== uatCol.nullable) {
          warnings.push(`${database}.${table}.${prodCol.name}: Nullable differs (PROD: ${prodCol.nullable}, UAT: ${uatCol.nullable})`);
        }
      }
    }

    // Compare indexes (important unique constraints)
    const prodIdxs = await getIndexes(prodConn, database, table);
    const uatIdxs = await getIndexes(uatConn, database, table);
    const uatIdxMap = new Map(uatIdxs.map(i => [i.name, i]));

    for (const prodIdx of prodIdxs) {
      const idxKey = `${table}.${prodIdx.name}`;
      const fullIdxKey = `${database}.${table}.${prodIdx.name}`;

      if (!uatIdxMap.has(prodIdx.name)) {
        if (allowlist.allow_missing_indexes_in_uat.includes(idxKey) ||
            allowlist.allow_missing_indexes_in_uat.includes(fullIdxKey)) {
          warnings.push(`${database}.${table}: UAT missing index '${prodIdx.name}' (allowlisted)`);
        } else {
          // Only fail on unique indexes, warn on others
          if (prodIdx.unique && prodIdx.name !== 'PRIMARY') {
            failures.push(`${database}.${table}: UAT missing unique index '${prodIdx.name}' that exists in PROD`);
          } else if (prodIdx.name !== 'PRIMARY') {
            warnings.push(`${database}.${table}: UAT missing index '${prodIdx.name}'`);
          }
        }
      }
    }
  }

  // Report UAT-only tables (informational)
  for (const table of uatTables) {
    if (!prodTableSet.has(table)) {
      warnings.push(`${database}: PROD missing table '${table}' (exists only in UAT)`);
    }
  }

  return { failures, warnings };
}

/**
 * Main function
 */
async function checkSchemaParity() {
  console.log(`\n${BLUE}========================================${NC}`);
  console.log(`${BLUE}  Schema Parity Check${NC}`);
  console.log(`${BLUE}  PRODUCTION is baseline${NC}`);
  console.log(`${BLUE}========================================${NC}`);

  console.log(`\nPROD: ${PROD_CONFIG.host}:${PROD_CONFIG.port}`);
  console.log(`UAT:  ${UAT_CONFIG.host}:${UAT_CONFIG.port}`);

  let prodConn, uatConn;

  try {
    console.log('\nConnecting to PROD...');
    prodConn = await mysql.createConnection(PROD_CONFIG);
    await prodConn.ping();
    console.log(`${GREEN}PROD connected${NC}`);

    console.log('Connecting to UAT...');
    uatConn = await mysql.createConnection(UAT_CONFIG);
    await uatConn.ping();
    console.log(`${GREEN}UAT connected${NC}`);

  } catch (error) {
    console.error(`${RED}Database connection failed: ${error.message}${NC}`);
    if (prodConn) await prodConn.end();
    if (uatConn) await uatConn.end();
    return false;
  }

  let allFailures = [];
  let allWarnings = [];

  try {
    for (const database of DATABASES) {
      const { failures, warnings } = await compareDatabase(prodConn, uatConn, database);
      allFailures.push(...failures);
      allWarnings.push(...warnings);
    }
  } finally {
    await prodConn.end();
    await uatConn.end();
  }

  // Print summary
  console.log(`\n${BLUE}--- Summary ---${NC}\n`);

  if (allWarnings.length > 0) {
    console.log(`${YELLOW}Warnings (${allWarnings.length}):${NC}`);
    // Group warnings to avoid spam
    const groupedWarnings = {};
    allWarnings.forEach(w => {
      const key = w.split(':')[0];
      if (!groupedWarnings[key]) groupedWarnings[key] = [];
      groupedWarnings[key].push(w);
    });

    for (const [key, warns] of Object.entries(groupedWarnings)) {
      if (warns.length <= 3) {
        warns.forEach(w => console.log(`  ${YELLOW}[WARN]${NC} ${w}`));
      } else {
        console.log(`  ${YELLOW}[WARN]${NC} ${key}: ${warns.length} warnings (showing first 3)`);
        warns.slice(0, 3).forEach(w => console.log(`    ${w}`));
      }
    }
    console.log('');
  }

  if (allFailures.length > 0) {
    console.log(`${RED}Failures (${allFailures.length}):${NC}`);
    allFailures.forEach(f => console.log(`  ${RED}[FAIL]${NC} ${f}`));
    console.log('');
    console.log(`${RED}========================================${NC}`);
    console.log(`${RED}  SCHEMA PARITY: FAILED${NC}`);
    console.log(`${RED}  UAT is missing ${allFailures.length} schema element(s) from PROD${NC}`);
    console.log(`${RED}========================================${NC}\n`);
    return false;
  }

  console.log(`${GREEN}========================================${NC}`);
  console.log(`${GREEN}  SCHEMA PARITY: PASSED${NC}`);
  console.log(`${GREEN}========================================${NC}\n`);
  return true;
}

// Run if called directly
if (require.main === module) {
  checkSchemaParity()
    .then(passed => process.exit(passed ? 0 : 1))
    .catch(err => {
      console.error(`${RED}Error: ${err.message}${NC}`);
      process.exit(1);
    });
}

module.exports = { checkSchemaParity };
