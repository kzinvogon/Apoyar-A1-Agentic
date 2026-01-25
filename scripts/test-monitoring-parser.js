#!/usr/bin/env node
/**
 * Test script for parseMonitoringAlert() and normaliseCorrelationKey()
 * Step 3.1 Evidence: Parses Nagios sample and prints extracted fields
 *
 * Usage: node scripts/test-monitoring-parser.js
 */

const { parseMonitoringAlert, normaliseCorrelationKey } = require('../services/email-processor');

// ============================================================================
// TEST FIXTURES
// ============================================================================

// Nagios PROBLEM alert (from manual-create-ticket.js)
const nagiosProblem = {
  subject: '** PROBLEM Service Alert: Volumes/FreeNAS is CRITICAL **',
  body: `***** Nagios *****
Notification Type: PROBLEM
Service: Volumes
Host: FreeNAS
Address: san
State: CRITICAL
Date/Time: Mon Nov 24 02:29:08 GMT 2025
Additional Info:

CRITICAL - Volume Apoyar is DEGRADED`
};

// Nagios RECOVERY alert
const nagiosRecovery = {
  subject: '** RECOVERY Service Alert: Volumes/FreeNAS is OK **',
  body: `***** Nagios *****
Notification Type: RECOVERY
Service: Volumes
Host: FreeNAS
Address: san
State: OK
Date/Time: Mon Nov 24 03:15:22 GMT 2025
Additional Info:

OK - Volume Apoyar is healthy`
};

// Nagios with whitespace/quotes edge cases
const nagiosEdgeCases = {
  subject: '** PROBLEM Service Alert **',
  body: `***** Nagios *****
Notification Type: PROBLEM
Service:   "MySQL Backup"
Host:  '  Server-01  '
State: WARNING`
};

// Prometheus/Alertmanager format
const prometheusAlert = {
  subject: '[FIRING] High CPU Usage',
  body: `Alert: High CPU Usage
Status: CRITICAL
Host: prometheus-node-01
Service: cpu_usage
Labels: severity=critical`
};

// Zabbix format
const zabbixAlert = {
  subject: 'Problem: Disk space is low',
  body: `Trigger: Disk space is low
Hostname: zabbix-agent-02
Status: PROBLEM
Severity: Warning`
};

// Minimal/broken alert (should handle gracefully)
const minimalAlert = {
  subject: 'Server alert',
  body: 'Something went wrong on the server'
};

// ============================================================================
// TEST RUNNER
// ============================================================================

console.log('='.repeat(70));
console.log('STEP 3.1 EVIDENCE: Monitoring Alert Parser Test');
console.log('='.repeat(70));

const testCases = [
  { name: 'Nagios PROBLEM', email: nagiosProblem },
  { name: 'Nagios RECOVERY', email: nagiosRecovery },
  { name: 'Nagios Edge Cases (whitespace/quotes)', email: nagiosEdgeCases },
  { name: 'Prometheus/Alertmanager', email: prometheusAlert },
  { name: 'Zabbix', email: zabbixAlert },
  { name: 'Minimal/Unknown', email: minimalAlert }
];

let passed = 0;
let failed = 0;

for (const tc of testCases) {
  console.log(`\n--- ${tc.name} ---`);
  console.log(`Subject: ${tc.email.subject}`);

  try {
    const result = parseMonitoringAlert(tc.email);
    console.log('\nParsed Result:');
    console.log(JSON.stringify(result, null, 2));
    passed++;
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
    failed++;
  }
}

// ============================================================================
// NORMALISATION TESTS
// ============================================================================

console.log('\n' + '='.repeat(70));
console.log('normaliseCorrelationKey() Tests');
console.log('='.repeat(70));

const normTests = [
  { host: 'FreeNAS', service: 'Volumes', expected: 'freenas:volumes' },
  { host: '  Server-01  ', service: '"MySQL Backup"', expected: 'server-01:mysql backup' },
  { host: "  'quoted'  ", service: '  spaced  out  ', expected: 'quoted:spaced out' },
  { host: null, service: 'Service', expected: 'unknown:service' },
  { host: 'Host', service: null, expected: 'host:unknown' },
  { host: '', service: '', expected: 'unknown:unknown' },
  { host: 'UPPERCASE', service: 'MixedCase', expected: 'uppercase:mixedcase' }
];

for (const nt of normTests) {
  const result = normaliseCorrelationKey(nt.host, nt.service);
  const status = result === nt.expected ? 'PASS' : 'FAIL';
  if (status === 'PASS') passed++; else failed++;
  console.log(`\n[${status}] normaliseCorrelationKey(${JSON.stringify(nt.host)}, ${JSON.stringify(nt.service)})`);
  console.log(`  Expected: "${nt.expected}"`);
  console.log(`  Got:      "${result}"`);
}

// ============================================================================
// SUMMARY
// ============================================================================

console.log('\n' + '='.repeat(70));
console.log(`SUMMARY: ${passed} passed, ${failed} failed`);
console.log('='.repeat(70));

process.exit(failed > 0 ? 1 : 0);
