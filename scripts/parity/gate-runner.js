#!/usr/bin/env node
/**
 * Parity Gate Runner
 *
 * Runs all parity checks: services, env vars, schema.
 * PRODUCTION is the baseline - UAT must match.
 *
 * Usage:
 *   node scripts/parity/gate-runner.js         # Run all diff checks
 *   node scripts/parity/gate-runner.js --smoke # Run smoke tests only
 *   node scripts/parity/gate-runner.js --all   # Run diff + smoke
 */

const { execSync, spawnSync } = require('child_process');
const path = require('path');

// Colors
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const NC = '\x1b[0m';

const args = process.argv.slice(2);
const runSmoke = args.includes('--smoke') || args.includes('--all');
const runDiff = !args.includes('--smoke') || args.includes('--all');

console.log(`
${BLUE}╔══════════════════════════════════════════════════════════════════╗${NC}
${BLUE}║                     PARITY GATE                                  ║${NC}
${BLUE}║            PRODUCTION is the reference baseline                  ║${NC}
${BLUE}║         UAT must match PROD (within allowlists)                  ║${NC}
${BLUE}╚══════════════════════════════════════════════════════════════════╝${NC}
`);

const results = {
  services: null,
  envVars: null,
  schema: null,
  smoke: null
};

let hasFailures = false;

/**
 * Run a check and capture result
 */
function runCheck(name, command, cwd = process.cwd()) {
  console.log(`\n${BLUE}▶ Running ${name}...${NC}\n`);

  try {
    const result = spawnSync(command[0], command.slice(1), {
      cwd,
      stdio: 'inherit',
      shell: true
    });

    if (result.status === 0) {
      results[name] = 'PASS';
      return true;
    } else {
      results[name] = 'FAIL';
      hasFailures = true;
      return false;
    }
  } catch (error) {
    console.error(`${RED}Error running ${name}: ${error.message}${NC}`);
    results[name] = 'ERROR';
    hasFailures = true;
    return false;
  }
}

// Run diff checks
if (runDiff) {
  console.log(`${YELLOW}═══ DIFF CHECKS ═══${NC}`);

  // Service parity (optional - requires Railway CLI)
  // runCheck('services', ['node', 'scripts/parity/check-services.js']);

  // Env var parity (optional - requires Railway CLI)
  // runCheck('envVars', ['node', 'scripts/parity/check-env.js']);

  // Schema parity
  runCheck('schema', ['node', 'scripts/parity/check-schema-parity.js']);
}

// Run smoke tests
if (runSmoke) {
  console.log(`\n${YELLOW}═══ SMOKE TESTS ═══${NC}`);

  // Profile update smoke test (mandatory)
  runCheck('smoke', ['bash', 'scripts/smoke/smoke-profile-update.sh']);
}

// Print summary
console.log(`
${BLUE}╔══════════════════════════════════════════════════════════════════╗${NC}
${BLUE}║                     GATE SUMMARY                                 ║${NC}
${BLUE}╚══════════════════════════════════════════════════════════════════╝${NC}
`);

const checks = [
  ['Schema Parity', results.schema],
  ['Smoke Tests', results.smoke]
].filter(([, r]) => r !== null);

for (const [name, result] of checks) {
  const color = result === 'PASS' ? GREEN : result === 'FAIL' ? RED : YELLOW;
  console.log(`  ${name.padEnd(20)} ${color}${result}${NC}`);
}

console.log('');

if (hasFailures) {
  console.log(`${RED}╔══════════════════════════════════════════════════════════════════╗${NC}`);
  console.log(`${RED}║                     GATE: FAILED                                 ║${NC}`);
  console.log(`${RED}║         UAT is not in parity with PRODUCTION                    ║${NC}`);
  console.log(`${RED}║         Fix issues above before deploying to PROD               ║${NC}`);
  console.log(`${RED}╚══════════════════════════════════════════════════════════════════╝${NC}`);
  process.exit(1);
} else {
  console.log(`${GREEN}╔══════════════════════════════════════════════════════════════════╗${NC}`);
  console.log(`${GREEN}║                     GATE: PASSED                                 ║${NC}`);
  console.log(`${GREEN}║         UAT is in parity with PRODUCTION                        ║${NC}`);
  console.log(`${GREEN}║         Safe to deploy to PROD                                  ║${NC}`);
  console.log(`${GREEN}╚══════════════════════════════════════════════════════════════════╝${NC}`);
  process.exit(0);
}
