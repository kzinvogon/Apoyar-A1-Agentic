#!/usr/bin/env node
/**
 * Smoke Test Script
 * Exercises critical dashboard flows to catch runtime errors before deploy.
 *
 * Usage: npm run smoke [baseUrl] [--readonly]
 * Default baseUrl: http://localhost:3000
 *
 * Environment variables:
 *   SMOKE_TENANT     - Tenant code (default: apoyar)
 *   SMOKE_USER       - Test username (default: expert)
 *   SMOKE_PASS       - Test password (default: password123)
 *   SMOKE_TICKET_ID  - Specific ticket ID for claim/accept tests (UAT only)
 *   SMOKE_READONLY   - Set to "true" to skip mutating tests
 *
 * Production safety (MANDATORY):
 *   - Production (app.serviflow.app) is ALWAYS read-only, no exceptions
 *   - Only GET endpoints are called on production
 *   - Login POST is allowed (required for auth token)
 *   - No claim/accept/escalate/delete/import operations on prod
 *
 * Exit codes:
 *   0 = All tests passed
 *   1 = One or more tests failed
 */

const http = require('http');
const https = require('https');

// Parse command line args
const args = process.argv.slice(2);
const BASE_URL = args.find(a => !a.startsWith('--')) || 'http://localhost:3000';
const CLI_READONLY = args.includes('--readonly');

// Configuration from env vars with defaults
const TENANT = process.env.SMOKE_TENANT || 'apoyar';
const TEST_USER = process.env.SMOKE_USER || 'expert';
const TEST_PASS = process.env.SMOKE_PASS || 'password123';
const SMOKE_TICKET_ID = process.env.SMOKE_TICKET_ID || null;

// PRODUCTION SAFETY LATCH - mandatory readonly, no exceptions
const IS_PROD = BASE_URL.includes('app.serviflow.app');

// Hard safety check: refuse to run destructive tests against production
if (IS_PROD && process.env.SMOKE_READONLY === 'false') {
  console.error('\n❌ SAFETY ERROR: Refusing to run destructive tests against production');
  console.error('   Production smoke tests are ALWAYS read-only. This is not configurable.');
  console.error('   Remove SMOKE_READONLY=false and try again.\n');
  process.exit(1);
}

// Production forces readonly - no override possible
const READONLY = IS_PROD || CLI_READONLY || process.env.SMOKE_READONLY === 'true';

let token = null;
let userId = null;
let versionInfo = null;
let passed = 0;
let failed = 0;

function request(method, path, body = null) {
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
      },
      timeout: 15000
    };

    if (token) {
      options.headers['Authorization'] = `Bearer ${token}`;
    }

    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
        } catch (e) {
          reject(new Error(`Non-JSON response: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function test(name, fn) {
  process.stdout.write(`  ${name}... `);
  try {
    const result = await fn();
    console.log('✅ PASS');
    passed++;
    return result;
  } catch (err) {
    console.log(`❌ FAIL: ${err.message}`);
    failed++;
    return null;
  }
}

async function runTests() {
  console.log(`\n🧪 Smoke Tests\n`);

  // ============================================================================
  // AUDIT HEADER - provides evidence of test configuration
  // ============================================================================
  console.log('┌─────────────────────────────────────────────────┐');
  console.log('│ SMOKE TEST AUDIT LOG                            │');
  console.log('├─────────────────────────────────────────────────┤');
  console.log(`│ Target URL:    ${BASE_URL.padEnd(32)}│`);
  console.log(`│ Tenant:        ${TENANT.padEnd(32)}│`);
  console.log(`│ Test User:     ${TEST_USER.padEnd(32)}│`);
  console.log(`│ READ-ONLY:     ${String(READONLY).padEnd(32)}│`);
  if (IS_PROD) {
    console.log('│ MODE:          PRODUCTION (mandatory read-only) │');
  } else if (READONLY) {
    console.log('│ MODE:          READ-ONLY (mutating tests skip)  │');
  } else {
    console.log('│ MODE:          FULL (includes state changes)    │');
  }
  console.log('└─────────────────────────────────────────────────┘');
  console.log('');

  // Fetch version info for audit trail
  try {
    const versionRes = await request('GET', '/api/version');
    if (versionRes.status === 200 && versionRes.data.success) {
      versionInfo = versionRes.data.version;
      console.log('┌─────────────────────────────────────────────────┐');
      console.log('│ SERVER VERSION                                  │');
      console.log('├─────────────────────────────────────────────────┤');
      console.log(`│ Git SHA:       ${(versionInfo.git_sha_short || 'unknown').padEnd(32)}│`);
      console.log(`│ Build Time:    ${(versionInfo.build_time || 'unknown').substring(0, 32).padEnd(32)}│`);
      console.log(`│ Environment:   ${(versionInfo.environment || 'unknown').padEnd(32)}│`);
      console.log(`│ Node:          ${(versionInfo.node_version || 'unknown').padEnd(32)}│`);
      console.log('└─────────────────────────────────────────────────┘');
      console.log('');
    }
  } catch (e) {
    console.log('⚠️  Could not fetch version info\n');
  }

  console.log('=' .repeat(50));

  // Test 1: Health check
  await test('Health endpoint returns JSON', async () => {
    const res = await request('GET', '/health');
    if (res.status !== 200) throw new Error(`Status ${res.status}`);
    if (!res.data.status) throw new Error('Missing status field');
  });

  // Test 2: Version endpoint
  await test('Version endpoint returns build info', async () => {
    const res = await request('GET', '/api/version');
    if (res.status !== 200) throw new Error(`Status ${res.status}`);
    if (!res.data.success) throw new Error('Version endpoint failed');
    if (!res.data.version.git_sha) throw new Error('Missing git_sha');
    if (!res.data.version.build_time) throw new Error('Missing build_time');
    if (!res.data.version.environment) throw new Error('Missing environment');
  });

  // Test 3: Login as expert
  await test('Login as expert user', async () => {
    const res = await request('POST', '/api/auth/tenant/login', {
      tenant_code: TENANT,
      username: TEST_USER,
      password: TEST_PASS
    });
    if (res.status !== 200) throw new Error(`Status ${res.status}: ${JSON.stringify(res.data)}`);
    if (!res.data.token) throw new Error('No token in response');
    token = res.data.token;
    userId = res.data.user?.id;
  });

  // Test 4: Fetch tickets (the flow that broke)
  let ticketsBefore = [];
  await test('Fetch tickets list (fetchTicketsFromAPI)', async () => {
    const res = await request('GET', `/api/tickets/${TENANT}`);
    if (res.status !== 200) throw new Error(`Status ${res.status}`);
    if (!res.data.success) throw new Error(`API error: ${res.data.message}`);
    if (!Array.isArray(res.data.tickets)) throw new Error('tickets is not an array');
    ticketsBefore = res.data.tickets;
  });

  // Test 5: Fetch ticket pool
  let poolTickets = [];
  await test('Fetch ticket pool', async () => {
    const res = await request('GET', `/api/tickets/${TENANT}/pool`);
    if (res.status !== 200) throw new Error(`Status ${res.status}`);
    if (!res.data.success) throw new Error(`API error: ${res.data.message}`);
    if (!Array.isArray(res.data.pool)) throw new Error('pool is not an array');
    poolTickets = res.data.pool;
  });

  // Test 6: Claim and accept ownership (mutating tests - skipped in readonly mode)
  let claimedTicketId = null;

  if (READONLY) {
    console.log('  ⏭️  Skipping claim/accept/escalate tests (readonly mode)');
  } else {
    // Determine which ticket to use
    if (SMOKE_TICKET_ID) {
      // Use dedicated test ticket from env var
      claimedTicketId = parseInt(SMOKE_TICKET_ID, 10);
      console.log(`  📌 Using dedicated test ticket #${claimedTicketId}`);
    } else if (poolTickets.length > 0) {
      // Use first ticket from pool
      claimedTicketId = poolTickets[0].id;
    }

    if (claimedTicketId) {
      await test(`Claim ticket #${claimedTicketId}`, async () => {
        const res = await request('POST', `/api/tickets/${TENANT}/${claimedTicketId}/claim`);
        if (res.status !== 200) throw new Error(`Status ${res.status}: ${JSON.stringify(res.data)}`);
        if (!res.data.success) throw new Error(`API error: ${res.data.message}`);
        if (!res.data.ticket) throw new Error('No ticket in response');
      });

      await test(`Accept ownership of ticket #${claimedTicketId}`, async () => {
        const res = await request('POST', `/api/tickets/${TENANT}/${claimedTicketId}/accept-ownership`);
        if (res.status !== 200) throw new Error(`Status ${res.status}: ${JSON.stringify(res.data)}`);
        if (!res.data.success) throw new Error(`API error: ${res.data.message}`);
        if (!res.data.ticket) throw new Error('No ticket in response');
        // Verify ownership was set
        if (res.data.ticket.owner_id !== userId && res.data.ticket.status !== 'In Progress') {
          throw new Error('Ticket not properly owned or status not updated');
        }
      });

      await test('Verify ticket removed from pool after ownership', async () => {
        const res = await request('GET', `/api/tickets/${TENANT}/pool`);
        if (res.status !== 200) throw new Error(`Status ${res.status}`);
        if (!res.data.success) throw new Error(`API error: ${res.data.message}`);
        const stillInPool = res.data.pool.find(t => t.id === claimedTicketId);
        if (stillInPool) throw new Error('Owned ticket still appears in pool');
      });

      // Cleanup: Release ownership by escalating back to pool
      await test(`Cleanup: Escalate ticket #${claimedTicketId} back to pool`, async () => {
        const res = await request('POST', `/api/tickets/${TENANT}/${claimedTicketId}/escalate`, {
          reason: 'Smoke test cleanup'
        });
        if (res.status !== 200) throw new Error(`Status ${res.status}: ${JSON.stringify(res.data)}`);
        if (!res.data.success) throw new Error(`API error: ${res.data.message}`);
      });
    } else {
      console.log('  ⚠️  No tickets in pool - skipping claim/accept tests');
    }
  }

  // Test 7: Get system control settings
  await test('Get system control settings', async () => {
    const res = await request('GET', `/api/tickets/settings/${TENANT}`);
    if (res.status !== 200) throw new Error(`Status ${res.status}`);
    if (!res.data.success) throw new Error(`API error: ${res.data.message}`);
  });

  // ============================================================================
  // CMDB/Asset Endpoints
  // ============================================================================
  console.log('\n--- CMDB Endpoints ---');

  // Test 8: Get CMDB items
  let cmdbItems = [];
  await test('Fetch CMDB items list', async () => {
    const res = await request('GET', `/api/cmdb/${TENANT}/items`);
    if (res.status !== 200) throw new Error(`Status ${res.status}`);
    if (!res.data.success) throw new Error(`API error: ${res.data.message}`);
    if (!Array.isArray(res.data.items)) throw new Error('items is not an array');
    cmdbItems = res.data.items;
  });

  // Test 9: Get CMDB item types
  await test('Fetch CMDB item types', async () => {
    const res = await request('GET', `/api/cmdb-types/${TENANT}/item-types`);
    if (res.status !== 200) throw new Error(`Status ${res.status}`);
    if (!res.data.success) throw new Error(`API error: ${res.data.message}`);
    if (!Array.isArray(res.data.itemTypes)) throw new Error('itemTypes is not an array');
  });

  // Test 10: Get custom field definitions
  await test('Fetch custom field definitions', async () => {
    const res = await request('GET', `/api/cmdb/${TENANT}/custom-fields`);
    if (res.status !== 200) throw new Error(`Status ${res.status}`);
    if (!res.data.success) throw new Error(`API error: ${res.data.message}`);
    if (!Array.isArray(res.data.fields)) throw new Error('fields is not an array');
  });

  // Test 11: Get CMDB item relationships (must never return 500)
  await test('Fetch CMDB relationships (no 500)', async () => {
    // Use real CMDB ID if available, otherwise use dummy
    const testCmdbId = cmdbItems.length > 0 ? cmdbItems[0].cmdb_id : 'DUMMY-SMOKE-TEST';
    const res = await request('GET', `/api/cmdb/${TENANT}/items/${testCmdbId}/relationships`);

    // 500 is always a failure - indicates server error
    if (res.status === 500) throw new Error('Got 500 Internal Server Error');

    // 200 with arrays or 404 not found are acceptable
    if (res.status === 200) {
      if (!res.data.success) throw new Error(`API error: ${res.data.message}`);
      if (!Array.isArray(res.data.outgoing)) throw new Error('outgoing is not an array');
      if (!Array.isArray(res.data.incoming)) throw new Error('incoming is not an array');
    } else if (res.status !== 404) {
      throw new Error(`Unexpected status ${res.status}`);
    }
  });

  // ============================================================================
  // Knowledge Base Endpoints
  // ============================================================================
  console.log('\n--- Knowledge Base Endpoints ---');
  console.log(`  📚 KB smoke checks enabled: ${READONLY ? 'READ-ONLY' : 'FULL'}`);

  // Helper: Check if response is HTML (indicates missing route - always a failure)
  const isHtmlResponse = (data) => {
    if (typeof data === 'string') {
      return data.includes('<!DOCTYPE') || data.includes('<html');
    }
    if (data && data.error && typeof data.error === 'string') {
      return data.error.includes('<!DOCTYPE') || data.error.includes('<html');
    }
    return false;
  };

  // Test 12: Get KB categories
  await test('KB categories (200 + JSON)', async () => {
    const res = await request('GET', `/api/kb/${TENANT}/categories`);
    if (isHtmlResponse(res.data)) throw new Error('Got HTML instead of JSON');
    if (res.status === 500) throw new Error('500 Internal Server Error');
    if (res.status !== 200) throw new Error(`Status ${res.status}`);
    if (!res.data.success) throw new Error(`API error: ${res.data.message}`);
    if (!Array.isArray(res.data.categories)) throw new Error('categories is not an array');
    console.log(`     → ${res.data.categories.length} categories`);
  });

  // Test 13: Get KB articles with pagination
  await test('KB articles (200 + JSON + pagination)', async () => {
    const res = await request('GET', `/api/kb/${TENANT}/articles`);
    if (isHtmlResponse(res.data)) throw new Error('Got HTML instead of JSON');
    if (res.status === 500) throw new Error('500 Internal Server Error');
    if (res.status !== 200) throw new Error(`Status ${res.status}`);
    if (!res.data.success) throw new Error(`API error: ${res.data.message}`);
    if (!Array.isArray(res.data.articles)) throw new Error('articles is not an array');
    if (!res.data.pagination) throw new Error('pagination object missing');
    console.log(`     → ${res.data.articles.length} articles, page ${res.data.pagination.page}/${res.data.pagination.pages}`);
  });

  // Test 14: KB search
  await test('KB search (200 + JSON)', async () => {
    const res = await request('GET', `/api/kb/${TENANT}/search?q=test`);
    if (isHtmlResponse(res.data)) throw new Error('Got HTML instead of JSON');
    if (res.status === 500) throw new Error('500 Internal Server Error');
    if (res.status !== 200) throw new Error(`Status ${res.status}`);
    if (!res.data.success) throw new Error(`API error: ${res.data.message}`);
    if (!Array.isArray(res.data.results)) throw new Error('results is not an array');
    console.log(`     → ${res.data.results.length} search results`);
  });

  // Test 15: KB suggest-for-ticket (accepts 200 or 404, fails on 500)
  await test('KB suggest-for-ticket (no 500)', async () => {
    // Use first ticket ID if available, otherwise use dummy
    const testTicketId = ticketsBefore.length > 0 ? ticketsBefore[0].id : 99999;
    const res = await request('GET', `/api/kb/${TENANT}/suggest-for-ticket/${testTicketId}`);
    if (isHtmlResponse(res.data)) throw new Error('Got HTML instead of JSON');
    if (res.status === 500) throw new Error('500 Internal Server Error');
    // 200 with suggestions or 404 not found are acceptable
    if (res.status === 200) {
      // success: false means ticket not found (no message in current API)
      if (res.data.success === false) {
        console.log(`     → ticket #${testTicketId} not found or no suggestions`);
      } else {
        console.log(`     → ${(res.data.suggestions || []).length} suggestions for ticket #${testTicketId}`);
      }
    } else if (res.status === 404) {
      console.log(`     → 404 (ticket not found) - OK`);
    } else {
      throw new Error(`Unexpected status ${res.status}`);
    }
  });

  // Test 16: KB stats (admin/expert only - accepts 200 or 403, fails on 500)
  await test('KB stats (200/403, no 500)', async () => {
    const res = await request('GET', `/api/kb/${TENANT}/stats`);
    if (isHtmlResponse(res.data)) throw new Error('Got HTML instead of JSON');
    if (res.status === 500) throw new Error('500 Internal Server Error');
    if (res.status === 200) {
      if (!res.data.success) throw new Error(`API error: ${res.data.message}`);
      if (typeof res.data.stats !== 'object') throw new Error('stats is not an object');
      console.log(`     → ${res.data.stats.totalViews || 0} views, ${res.data.stats.pendingMerges || 0} pending merges`);
    } else if (res.status === 403) {
      console.log(`     → 403 (requires admin/expert) - OK`);
    } else {
      throw new Error(`Unexpected status ${res.status}`);
    }
  });

  console.log('=' .repeat(50));
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);

  if (versionInfo) {
    console.log(`📋 Tested: ${versionInfo.git_sha_short} @ ${versionInfo.environment}`);
  }
  console.log('');

  if (failed > 0) {
    console.log('❌ SMOKE TESTS FAILED\n');
    process.exit(1);
  } else {
    console.log('✅ ALL SMOKE TESTS PASSED\n');
    process.exit(0);
  }
}

// Handle connection refused gracefully
runTests().catch(err => {
  console.error(`\n❌ Fatal error: ${err.message}`);
  console.error('Is the server running?');
  process.exit(1);
});
