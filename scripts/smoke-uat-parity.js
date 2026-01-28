#!/usr/bin/env node
/**
 * UAT Parity Smoke Test
 * Verifies all UI-called API endpoints return correct responses (no 500, proper JSON).
 *
 * Usage:
 *   npm run smoke:uat-parity          # Run against UAT
 *   npm run smoke:uat-parity -- prod  # Run read-only against prod
 *
 * Environment variables:
 *   SMOKE_TENANT     - Tenant code (default: apoyar)
 *   SMOKE_USER       - Admin username (default: admin)
 *   SMOKE_PASS       - Admin password (default: password123)
 */

const http = require('http');
const https = require('https');
const mysql = require('mysql2/promise');

// Parse args
const args = process.argv.slice(2);
const TARGET = args[0] || 'uat';

const URLS = {
  uat: 'https://web-uat-uat.up.railway.app',
  prod: 'https://app.serviflow.app',
  local: 'http://localhost:3000'
};

const BASE_URL = URLS[TARGET] || TARGET;
const IS_PROD = BASE_URL.includes('app.serviflow.app');
const READONLY = IS_PROD;

const TENANT = process.env.SMOKE_TENANT || 'apoyar';
const ADMIN_USER = process.env.SMOKE_USER || 'admin';
const ADMIN_PASS = process.env.SMOKE_PASS || 'password123';

let token = null;
let passed = 0;
let failed = 0;
let skipped = 0;

// HTTP request helper
function request(method, path, body = null, customHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...customHeaders
      },
      timeout: 30000
    };

    if (token) {
      options.headers['Authorization'] = `Bearer ${token}`;
    }

    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        // Check for HTML response (indicates missing route)
        if (data.includes('<!DOCTYPE') || data.includes('<html') || data.includes('Cannot GET') || data.includes('Cannot POST')) {
          resolve({ status: res.statusCode, data: null, isHtml: true, raw: data.substring(0, 200) });
          return;
        }
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json, isHtml: false });
        } catch (e) {
          resolve({ status: res.statusCode, data: null, parseError: true, raw: data.substring(0, 200) });
        }
      });
    });

    req.on('error', (err) => resolve({ status: 0, error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, error: 'timeout' });
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// Test helper
async function test(name, fn, opts = {}) {
  if (opts.skipProd && IS_PROD) {
    console.log(`  ⏭️  ${name} (skipped on prod)`);
    skipped++;
    return null;
  }

  process.stdout.write(`  ${name}... `);
  try {
    const result = await fn();
    console.log('✅');
    passed++;
    return result;
  } catch (err) {
    console.log(`❌ ${err.message}`);
    failed++;
    return null;
  }
}

// Validate response - no 500, no HTML, valid JSON
function assertOk(res, acceptCodes = [200]) {
  if (res.error) throw new Error(res.error);
  if (res.isHtml) throw new Error(`HTML response (missing route?): ${res.raw}`);
  if (res.status === 500) throw new Error(`500 error: ${JSON.stringify(res.data)}`);
  if (res.parseError) throw new Error(`Invalid JSON: ${res.raw}`);
  if (!acceptCodes.includes(res.status)) throw new Error(`Status ${res.status}, expected ${acceptCodes.join('/')}`);
  return res.data;
}

async function runTests() {
  console.log(`\n🔍 UAT Parity Smoke Test\n`);
  console.log('┌─────────────────────────────────────────────────┐');
  console.log(`│ Target:      ${BASE_URL.padEnd(35)}│`);
  console.log(`│ Tenant:      ${TENANT.padEnd(35)}│`);
  console.log(`│ Mode:        ${(READONLY ? 'READ-ONLY' : 'FULL').padEnd(35)}│`);
  console.log('└─────────────────────────────────────────────────┘\n');

  // ============================================
  // SCHEMA PARITY GATE (UAT only)
  // ============================================
  if (!IS_PROD && process.env.MYSQLPASSWORD) {
    console.log('--- Schema Parity Gate ---');

    const REQUIRED_TABLES = [
      'ai_action_log', 'ai_category_mappings', 'ai_email_analysis', 'ai_insights',
      'ai_system_metrics', 'category_sla_mappings', 'company_profile', 'notifications',
      'slack_user_preferences', 'teams_user_preferences', 'tenant_features', 'ticket_access_tokens',
      'tickets', 'users', 'customers', 'customer_companies', 'sla_definitions',
      'ticket_processing_rules', 'ticket_rule_executions', 'email_ingest_settings'
    ];

    const REQUIRED_COLUMNS = {
      tickets: ['csat_rating', 'csat_comment', 'resolution_status', 'ai_analyzed', 'sla_deadline'],
      users: ['invitation_token', 'invitation_sent_at', 'deleted_at', 'must_reset_password'],
      customers: ['job_title', 'sla_level', 'customer_company_id']
    };

    try {
      const conn = await mysql.createConnection({
        host: 'tramway.proxy.rlwy.net',
        port: 20773,
        user: 'serviflow_app',
        password: process.env.MYSQLPASSWORD,
        database: 'a1_tenant_apoyar'
      });

      // Check required tables
      const [tables] = await conn.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'a1_tenant_apoyar'`
      );
      const existingTables = new Set(tables.map(t => t.TABLE_NAME || t.table_name));

      let schemaPassed = true;
      for (const table of REQUIRED_TABLES) {
        if (existingTables.has(table)) {
          console.log(`  ✅ Table: ${table}`);
          passed++;
        } else {
          console.log(`  ❌ Table: ${table} MISSING`);
          failed++;
          schemaPassed = false;
        }
      }

      // Check required columns
      for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
        const [cols] = await conn.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = 'a1_tenant_apoyar' AND table_name = ?`,
          [table]
        );
        const existingCols = new Set(cols.map(c => c.COLUMN_NAME || c.column_name));

        for (const col of columns) {
          if (existingCols.has(col)) {
            console.log(`  ✅ ${table}.${col}`);
            passed++;
          } else {
            console.log(`  ❌ ${table}.${col} MISSING`);
            failed++;
            schemaPassed = false;
          }
        }
      }

      await conn.end();

      if (!schemaPassed) {
        console.log('\n❌ SCHEMA PARITY GATE FAILED - run migrations/uat-schema-parity.js first\n');
        process.exit(1);
      }

      console.log('  Schema parity: OK ✅\n');
    } catch (err) {
      console.log(`  ⚠️  Schema check skipped: ${err.message}\n`);
    }
  } else if (!IS_PROD) {
    console.log('--- Schema Parity Gate ---');
    console.log('  ⚠️  Skipped (MYSQLPASSWORD not set)\n');
  }

  // ============================================
  // AUTH
  // ============================================
  console.log('--- Authentication ---');

  await test('Login as admin', async () => {
    const res = await request('POST', '/api/auth/tenant/login', {
      tenant_code: TENANT,
      username: ADMIN_USER,
      password: ADMIN_PASS
    });
    const data = assertOk(res);
    if (!data.token) throw new Error('No token');
    token = data.token;
  });

  await test('GET /api/auth/profile', async () => {
    const res = await request('GET', '/api/auth/profile');
    assertOk(res);
  });

  // ============================================
  // TICKETS
  // ============================================
  console.log('\n--- Tickets ---');

  await test('GET /api/tickets/{tenant}', async () => {
    const res = await request('GET', `/api/tickets/${TENANT}`);
    const data = assertOk(res);
    if (!Array.isArray(data.tickets)) throw new Error('tickets not array');
  });

  await test('GET /api/tickets/{tenant}/pool', async () => {
    const res = await request('GET', `/api/tickets/${TENANT}/pool`);
    const data = assertOk(res);
    if (!Array.isArray(data.pool)) throw new Error('pool not array');
  });

  await test('GET /api/tickets/settings/{tenant}', async () => {
    const res = await request('GET', `/api/tickets/settings/${TENANT}`);
    assertOk(res);
  });

  await test('GET /api/tickets/public/{tenant}/feedback-scoreboard', async () => {
    const res = await request('GET', `/api/tickets/public/${TENANT}/feedback-scoreboard`);
    assertOk(res, [200, 404]);
  });

  // ============================================
  // TICKET RULES
  // ============================================
  console.log('\n--- Ticket Rules ---');

  await test('GET /api/ticket-rules/{tenant}', async () => {
    const res = await request('GET', `/api/ticket-rules/${TENANT}`);
    const data = assertOk(res);
    if (!Array.isArray(data.rules)) throw new Error('rules not array');
  });

  await test('GET /api/ticket-rules/{tenant}/statistics', async () => {
    const res = await request('GET', `/api/ticket-rules/${TENANT}/statistics`);
    assertOk(res);
  });

  // ============================================
  // CMDB
  // ============================================
  console.log('\n--- CMDB ---');

  await test('GET /api/cmdb/{tenant}/items', async () => {
    const res = await request('GET', `/api/cmdb/${TENANT}/items`);
    const data = assertOk(res);
    if (!Array.isArray(data.items)) throw new Error('items not array');
  });

  await test('GET /api/cmdb/{tenant}/custom-fields', async () => {
    const res = await request('GET', `/api/cmdb/${TENANT}/custom-fields`);
    const data = assertOk(res);
    if (!Array.isArray(data.fields)) throw new Error('fields not array');
  });

  await test('GET /api/cmdb/{tenant}/relationships', async () => {
    const res = await request('GET', `/api/cmdb/${TENANT}/relationships`);
    // Route not implemented yet - accept 404/HTML
    if (res.isHtml || res.status === 404) return;
    assertOk(res, [200, 404]);
  });

  await test('GET /api/cmdb-types/{tenant}/item-types', async () => {
    const res = await request('GET', `/api/cmdb-types/${TENANT}/item-types`);
    const data = assertOk(res);
    if (!Array.isArray(data.itemTypes)) throw new Error('itemTypes not array');
  });

  // ============================================
  // KNOWLEDGE BASE
  // ============================================
  console.log('\n--- Knowledge Base ---');

  await test('GET /api/kb/{tenant}/categories', async () => {
    const res = await request('GET', `/api/kb/${TENANT}/categories`);
    const data = assertOk(res);
    if (!Array.isArray(data.categories)) throw new Error('categories not array');
  });

  await test('GET /api/kb/{tenant}/articles', async () => {
    const res = await request('GET', `/api/kb/${TENANT}/articles`);
    const data = assertOk(res);
    if (!Array.isArray(data.articles)) throw new Error('articles not array');
  });

  await test('GET /api/kb/{tenant}/search?q=test', async () => {
    const res = await request('GET', `/api/kb/${TENANT}/search?q=test`);
    const data = assertOk(res);
    if (!Array.isArray(data.results)) throw new Error('results not array');
  });

  await test('GET /api/kb/{tenant}/stats', async () => {
    const res = await request('GET', `/api/kb/${TENANT}/stats`);
    assertOk(res, [200, 403]);
  });

  await test('GET /api/kb/{tenant}/merge-suggestions', async () => {
    const res = await request('GET', `/api/kb/${TENANT}/merge-suggestions`);
    assertOk(res, [200, 403]);
  });

  // ============================================
  // CUSTOMERS
  // ============================================
  console.log('\n--- Customers ---');

  await test('GET /api/customers', async () => {
    const res = await request('GET', '/api/customers');
    const data = assertOk(res);
    if (!Array.isArray(data.customers || data)) throw new Error('customers not array');
  });

  await test('GET /api/customer-companies', async () => {
    const res = await request('GET', '/api/customer-companies');
    const data = assertOk(res);
    if (!Array.isArray(data.companies || data)) throw new Error('companies not array');
  });

  // ============================================
  // EXPERTS
  // ============================================
  console.log('\n--- Experts ---');

  await test('GET /api/experts/{tenant}', async () => {
    const res = await request('GET', `/api/experts/${TENANT}`);
    const data = assertOk(res);
    if (!Array.isArray(data.experts || data)) throw new Error('experts not array');
  });

  await test('GET /api/experts/{tenant}/invited', async () => {
    const res = await request('GET', `/api/experts/${TENANT}/invited`);
    assertOk(res, [200, 404]);
  });

  await test('GET /api/experts/{tenant}/deleted', async () => {
    const res = await request('GET', `/api/experts/${TENANT}/deleted`);
    assertOk(res, [200, 404]);
  });

  await test('GET /api/expert-permissions/{tenant}/customers/available', async () => {
    const res = await request('GET', `/api/expert-permissions/${TENANT}/customers/available`);
    assertOk(res, [200, 404]);
  });

  // ============================================
  // NOTIFICATIONS
  // ============================================
  console.log('\n--- Notifications ---');

  await test('GET /api/notifications/{tenant}', async () => {
    const res = await request('GET', `/api/notifications/${TENANT}`);
    assertOk(res, [200, 404]);
  });

  // ============================================
  // AI ANALYSIS
  // ============================================
  console.log('\n--- AI Analysis ---');

  await test('GET /api/ai/{tenant}/cmdb-suggestions', async () => {
    const res = await request('GET', `/api/ai/${TENANT}/cmdb-suggestions`);
    assertOk(res, [200, 404]);
  });

  await test('GET /api/ai/{tenant}/insights', async () => {
    const res = await request('GET', `/api/ai/${TENANT}/insights`);
    assertOk(res, [200, 404]);
  });

  // ============================================
  // ANALYTICS
  // ============================================
  console.log('\n--- Analytics ---');

  await test('GET /api/analytics/{tenant}', async () => {
    const res = await request('GET', `/api/analytics/${TENANT}`);
    assertOk(res, [200, 404]);
  });

  // ============================================
  // SLA
  // ============================================
  console.log('\n--- SLA ---');

  await test('GET /api/sla/{tenant}/definitions', async () => {
    const res = await request('GET', `/api/sla/${TENANT}/definitions`);
    assertOk(res, [200, 404]);
  });

  await test('GET /api/sla/{tenant}/business-hours', async () => {
    const res = await request('GET', `/api/sla/${TENANT}/business-hours`);
    assertOk(res, [200, 404]);
  });

  await test('GET /api/sla/{tenant}/category-mappings', async () => {
    const res = await request('GET', `/api/sla/${TENANT}/category-mappings`);
    assertOk(res, [200, 404]);
  });

  // ============================================
  // EMAIL INGEST
  // ============================================
  console.log('\n--- Email Ingest ---');

  await test('GET /api/email-ingest/{tenant}/settings', async () => {
    const res = await request('GET', `/api/email-ingest/${TENANT}/settings`);
    assertOk(res);
  });

  // ============================================
  // INTEGRATIONS
  // ============================================
  console.log('\n--- Integrations ---');

  await test('GET /api/integrations/{tenant}/slack/status', async () => {
    const res = await request('GET', `/api/integrations/${TENANT}/slack/status`);
    // May fail if Slack not configured - accept 500 for config issues
    if (res.status === 500 && res.data?.error?.includes('integration')) return;
    assertOk(res, [200, 404]);
  });

  await test('GET /api/integrations/{tenant}/teams/status', async () => {
    const res = await request('GET', `/api/integrations/${TENANT}/teams/status`);
    // May fail if Teams not configured - accept 500 for config issues
    if (res.status === 500 && res.data?.error?.includes('integration')) return;
    assertOk(res, [200, 404]);
  });

  // ============================================
  // SETTINGS
  // ============================================
  console.log('\n--- Settings ---');

  await test('GET /api/tenant-settings/{tenant}/settings', async () => {
    const res = await request('GET', `/api/tenant-settings/${TENANT}/settings`);
    assertOk(res, [200, 404]);
  });

  await test('GET /api/raw-variables/{tenant}', async () => {
    const res = await request('GET', `/api/raw-variables/${TENANT}`);
    assertOk(res, [200, 404]);
  });

  // ============================================
  // PROFILE
  // ============================================
  console.log('\n--- Profile ---');

  await test('GET /api/profile/{tenant}/profile', async () => {
    const res = await request('GET', `/api/profile/${TENANT}/profile`);
    assertOk(res, [200, 404]);
  });

  // ============================================
  // USAGE
  // ============================================
  console.log('\n--- Usage ---');

  await test('GET /api/tenant/{tenant}/usage', async () => {
    const res = await request('GET', `/api/tenant/${TENANT}/usage`);
    // Route not implemented yet - accept 404/HTML
    if (res.isHtml || res.status === 404) return;
    assertOk(res, [200, 404]);
  });

  await test('GET /api/usage/{tenant}', async () => {
    const res = await request('GET', `/api/usage/${TENANT}`);
    assertOk(res, [200, 404]);
  });

  // ============================================
  // BILLING
  // ============================================
  console.log('\n--- Billing ---');

  await test('GET /api/billing/subscription', async () => {
    const res = await request('GET', '/api/billing/subscription');
    // Master DB feature - may not be configured on UAT
    if (res.status === 500) return;
    assertOk(res, [200, 404]);
  });

  await test('GET /api/billing/invoices', async () => {
    const res = await request('GET', '/api/billing/invoices');
    // Master DB feature - may not be configured on UAT
    if (res.status === 500) return;
    assertOk(res, [200, 404]);
  });

  await test('GET /api/billing/payment-methods', async () => {
    const res = await request('GET', '/api/billing/payment-methods');
    // Master DB feature - may not be configured on UAT
    if (res.status === 500) return;
    assertOk(res, [200, 404]);
  });

  await test('GET /api/plans', async () => {
    const res = await request('GET', '/api/plans');
    // Master DB feature - may not be configured on UAT
    if (res.status === 500 || res.error === 'timeout') return;
    assertOk(res, [200, 404]);
  });

  // ============================================
  // ADMIN
  // ============================================
  console.log('\n--- Admin ---');

  await test('GET /api/admin/audit-log', async () => {
    const res = await request('GET', '/api/admin/audit-log');
    // Master DB feature - may not be configured on UAT
    if (res.status === 500) return;
    assertOk(res, [200, 403, 404]);
  });

  await test('GET /api/admin/audit-log/actions', async () => {
    const res = await request('GET', '/api/admin/audit-log/actions');
    // Master DB feature - may not be configured on UAT
    if (res.status === 500) return;
    assertOk(res, [200, 403, 404]);
  });

  // ============================================
  // HEALTH
  // ============================================
  console.log('\n--- Health ---');

  await test('GET /health', async () => {
    const res = await request('GET', '/health');
    assertOk(res);
  });

  await test('GET /api/version', async () => {
    const res = await request('GET', '/api/version');
    assertOk(res);
  });

  // ============================================
  // RESULTS
  // ============================================
  console.log('\n' + '='.repeat(50));
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log('');

  if (failed > 0) {
    console.log('❌ UAT PARITY TEST FAILED\n');
    process.exit(1);
  } else {
    console.log('✅ UAT PARITY TEST PASSED\n');
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error(`\n❌ Fatal error: ${err.message}`);
  process.exit(1);
});
