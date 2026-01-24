#!/usr/bin/env node
/**
 * Smoke Test Script
 * Exercises critical dashboard flows to catch runtime errors before deploy.
 *
 * Usage: npm run smoke [baseUrl]
 * Default baseUrl: http://localhost:3000
 *
 * Exit codes:
 *   0 = All tests passed
 *   1 = One or more tests failed
 */

const http = require('http');
const https = require('https');

const BASE_URL = process.argv[2] || 'http://localhost:3000';
const TENANT = 'apoyar';
const TEST_USER = 'expert';
const TEST_PASS = 'password123';

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
  console.log(`\n🧪 Smoke Tests - ${BASE_URL}\n`);

  // Fetch version info first
  try {
    const versionRes = await request('GET', '/api/version');
    if (versionRes.status === 200 && versionRes.data.success) {
      versionInfo = versionRes.data.version;
      console.log('📋 Version Info:');
      console.log(`   Git SHA: ${versionInfo.git_sha_short || 'unknown'}`);
      console.log(`   Build Time: ${versionInfo.build_time || 'unknown'}`);
      console.log(`   Environment: ${versionInfo.environment || 'unknown'}`);
      console.log(`   Node: ${versionInfo.node_version || 'unknown'}`);
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

  // Test 6: Claim and accept ownership (if pool has tickets)
  let claimedTicketId = null;
  if (poolTickets.length > 0) {
    const testTicket = poolTickets[0];
    claimedTicketId = testTicket.id;

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
