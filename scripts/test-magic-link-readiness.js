#!/usr/bin/env node
/**
 * Magic Link UAT/Prod Readiness — Acceptance Tests
 *
 * Validates: bootstrap idempotency, verified-domain enforcement,
 * host binding, no auto-provision on non-demo, failure audit trail.
 *
 * Prerequisites:
 *   - MySQL running locally with a1_master database
 *   - Server running with MAGIC_LINK_AUTH_ENABLED=true
 *
 * Usage:
 *   MAGIC_LINK_AUTH_ENABLED=true JWT_SECRET=test-secret node server.js &
 *   node scripts/test-magic-link-readiness.js
 */

const http = require('http');
const crypto = require('crypto');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_DOMAIN = `mltest-${Date.now()}.example`;
const TEST_EMAIL = `readiness@${TEST_DOMAIN}`;

let passed = 0;
let failed = 0;
const testStart = new Date();

// ── Helpers ──────────────────────────────────────────────────────────

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch { json = null; }
        resolve({ status: res.statusCode, body: json, raw: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

// Direct DB access via the app's own modules
let masterQuery, initializeMasterDatabase;
try {
  ({ masterQuery, initializeMasterDatabase } = require('../config/database'));
} catch (err) {
  console.error('Cannot load database module. Make sure you run from the project root.');
  process.exit(1);
}

// ── Tests ────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n🔗 Magic Link Readiness Tests\n');

  // ── Test 1: createMasterTables idempotency ──────────────────────
  await test('1. createMasterTables is idempotent (runs twice without error)', async () => {
    await initializeMasterDatabase();
    await initializeMasterDatabase();

    // Verify all 10 tables exist
    const tables = await masterQuery(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN ('master_users','tenants','tenant_admins','master_audit_log',
         'audit_log','subscription_plans','tenant_subscriptions',
         'tenant_email_domains','auth_magic_links','auth_events')`
    );
    assert(tables.length >= 10, `Expected 10 tables, found ${tables.length}: ${tables.map(r => r.TABLE_NAME).join(', ')}`);
  });

  // ── Setup: insert test tenant + unverified domain ───────────────
  let testTenantId;
  try {
    // Ensure test tenant exists
    const existing = await masterQuery('SELECT id FROM tenants WHERE tenant_code = ?', ['mltest']);
    if (existing.length > 0) {
      testTenantId = existing[0].id;
    } else {
      const result = await masterQuery(
        `INSERT INTO tenants (tenant_code, company_name, display_name, database_name, database_user, database_password, status, is_demo)
         VALUES ('mltest', 'ML Test Co', 'ML Test', 'a1_tenant_mltest', 'root', '', 'active', 0)`,
        []
      );
      testTenantId = result.insertId;
    }

    // Insert unverified domain
    await masterQuery(
      `INSERT IGNORE INTO tenant_email_domains (tenant_id, domain, is_verified) VALUES (?, ?, 0)`,
      [testTenantId, TEST_DOMAIN]
    );
  } catch (err) {
    console.error('Setup failed:', err.message);
    process.exit(1);
  }

  // ── Test 2: Unverified domain cannot resolve ────────────────────
  await test('2. Unverified domain does not resolve (no token created)', async () => {
    const countBefore = await masterQuery(
      `SELECT COUNT(*) as cnt FROM auth_magic_links WHERE email = ?`,
      [TEST_EMAIL]
    );

    const res = await request('POST', '/api/public/auth/magic/request', { email: TEST_EMAIL });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.body && res.body.ok === true, 'Expected ok: true (anti-enumeration)');

    const countAfter = await masterQuery(
      `SELECT COUNT(*) as cnt FROM auth_magic_links WHERE email = ?`,
      [TEST_EMAIL]
    );
    assert(countAfter[0].cnt === countBefore[0].cnt, 'Token was created despite unverified domain');
  });

  // ── Test 3: Host binding — consume on wrong host fails ──────────
  await test('3. Host binding prevents cross-domain token use', async () => {
    // Insert a token directly with requested_host = demo.serviflow.app
    const tokenPlain = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(tokenPlain).digest('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await masterQuery(
      `INSERT INTO auth_magic_links (email, token_hash, tenant_id, purpose, requested_host, expires_at, status)
       VALUES (?, ?, ?, 'login', 'demo.serviflow.app', ?, 'pending')`,
      [TEST_EMAIL, tokenHash, testTenantId, expiresAt]
    );

    // Consume on localhost — should fail because demo vs non-demo mismatch
    const res = await request('POST', '/api/public/auth/magic/consume', { token: tokenPlain });
    assert(res.status === 401, `Expected 401, got ${res.status}`);
    assert(res.body && res.body.message && res.body.message.includes('domain'), `Unexpected message: ${res.body?.message}`);
  });

  // ── Test 4: No auto-provision on non-demo tenant ───────────────
  await test('4. Non-demo tenant does not auto-provision unknown users', async () => {
    // Insert a token for an email that has no user account on a non-demo tenant
    const tokenPlain = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(tokenPlain).digest('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await masterQuery(
      `INSERT INTO auth_magic_links (email, token_hash, tenant_id, purpose, requested_host, expires_at, status)
       VALUES (?, ?, ?, 'login', 'localhost:3000', ?, 'pending')`,
      [TEST_EMAIL, tokenHash, testTenantId, expiresAt]
    );

    const res = await request('POST', '/api/public/auth/magic/consume', { token: tokenPlain });
    assert(res.status === 401, `Expected 401, got ${res.status}`);
    assert(
      res.body && res.body.message && res.body.message.includes('provision'),
      `Expected provision failure, got: ${res.body?.message}`
    );
  });

  // ── Test 5: Failure events logged in auth_events ───────────────
  await test('5. Consume failures create auth_events audit records', async () => {
    // Query by test email (unique per run) rather than timestamp to avoid timezone issues
    const events = await masterQuery(
      `SELECT event_type, metadata FROM auth_events
       WHERE event_type = 'magic_link.consume.fail'
       AND email = ?`,
      [TEST_EMAIL]
    );
    assert(events.length >= 2, `Expected at least 2 failure events for ${TEST_EMAIL}, found ${events.length}`);

    const reasons = events.map(e => {
      const meta = typeof e.metadata === 'string' ? JSON.parse(e.metadata) : e.metadata;
      return meta.reason;
    });
    assert(reasons.includes('host_mismatch'), 'Missing host_mismatch event');
    // user_provision_failed or tenant_not_found should be present
    assert(
      reasons.includes('user_provision_failed') || reasons.includes('tenant_not_found'),
      `Missing user_provision_failed/tenant_not_found event. Found: ${reasons.join(', ')}`
    );
  });

  // ── Cleanup ─────────────────────────────────────────────────────
  console.log('\n  🧹 Cleaning up test data...');
  try {
    await masterQuery('DELETE FROM auth_magic_links WHERE email = ?', [TEST_EMAIL]);
    await masterQuery('DELETE FROM auth_events WHERE email = ?', [TEST_EMAIL]);
    await masterQuery('DELETE FROM tenant_email_domains WHERE domain = ?', [TEST_DOMAIN]);
    await masterQuery('DELETE FROM tenants WHERE tenant_code = ?', ['mltest']);
  } catch (err) {
    console.error('  Cleanup warning:', err.message);
  }

  // ── Summary ─────────────────────────────────────────────────────
  console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
