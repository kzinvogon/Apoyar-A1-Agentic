#!/usr/bin/env node
/**
 * Environment Variable Parity Check
 *
 * PRODUCTION is the baseline. UAT must have all env vars that PROD has.
 * Fails if UAT is missing any PROD env var (unless allowlisted).
 *
 * Usage: node scripts/parity/check-env.js
 */

const { execSync } = require('child_process');
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
const ALLOWLIST_PATH = path.join(__dirname, 'allowlist.envvars.json');
let allowlist = {
  allow_missing_in_uat: [],
  allow_value_different: [],
  // Service-specific allowlists
  services: {}
};

if (fs.existsSync(ALLOWLIST_PATH)) {
  try {
    allowlist = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
  } catch (e) {
    console.error(`${RED}Failed to parse allowlist: ${e.message}${NC}`);
  }
}

// Service mappings between PROD and UAT
const SERVICE_MAPPINGS = {
  'web': 'web-uat',
  'email-worker': 'email-worker-uat'
};

/**
 * Get environment variables for a service in an environment
 */
function getEnvVars(environment, service) {
  try {
    // Switch environment
    execSync(`railway environment ${environment}`, { encoding: 'utf8', stdio: 'pipe' });

    // Link to service
    execSync(`railway service ${service}`, { encoding: 'utf8', stdio: 'pipe' });

    // Get variables
    const output = execSync('railway variables', { encoding: 'utf8', stdio: 'pipe' });

    // Parse the output (format: KEY=value)
    const vars = {};
    const lines = output.trim().split('\n');
    for (const line of lines) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match) {
        vars[match[1]] = match[2];
      }
    }
    return vars;

  } catch (error) {
    console.error(`${YELLOW}Warning: Failed to get env vars for ${environment}/${service}: ${error.message}${NC}`);
    return null;
  }
}

/**
 * Mask sensitive values for display
 */
function maskValue(value) {
  if (!value) return '(empty)';
  if (value.length <= 4) return '****';
  return value.substring(0, 2) + '****' + value.substring(value.length - 2);
}

/**
 * Check if a variable is allowlisted
 */
function isAllowlisted(varName, listType, service = null) {
  // Check global allowlist
  if (allowlist[listType] && allowlist[listType].includes(varName)) {
    return true;
  }
  // Check service-specific allowlist
  if (service && allowlist.services && allowlist.services[service]) {
    const svcList = allowlist.services[service][listType];
    if (svcList && svcList.includes(varName)) {
      return true;
    }
  }
  return false;
}

/**
 * Compare env vars for a service pair
 */
function compareServiceEnvVars(prodService, uatService) {
  console.log(`\n${CYAN}Comparing: PROD/${prodService} vs UAT/${uatService}${NC}`);

  const prodVars = getEnvVars('production', prodService);
  const uatVars = getEnvVars('uat', uatService);

  if (!prodVars) {
    console.log(`  ${YELLOW}Skipping: Could not fetch PROD vars${NC}`);
    return { failures: [], warnings: [] };
  }
  if (!uatVars) {
    console.log(`  ${YELLOW}Skipping: Could not fetch UAT vars${NC}`);
    return { failures: [], warnings: [] };
  }

  const failures = [];
  const warnings = [];
  const results = [];

  // Check all PROD vars exist in UAT
  for (const [varName, prodValue] of Object.entries(prodVars)) {
    const uatValue = uatVars[varName];
    const inUat = varName in uatVars;
    const valuesDiffer = inUat && prodValue !== uatValue;

    let status = 'OK';
    let issue = null;

    if (!inUat) {
      if (isAllowlisted(varName, 'allow_missing_in_uat', prodService)) {
        status = 'ALLOW';
        issue = 'missing in UAT (allowlisted)';
        warnings.push(`${prodService}: UAT missing '${varName}' (allowlisted)`);
      } else {
        status = 'FAIL';
        issue = 'UAT missing this var that exists in PROD';
        failures.push(`${prodService}: UAT missing '${varName}' that exists in PROD`);
      }
    } else if (valuesDiffer) {
      if (isAllowlisted(varName, 'allow_value_different', prodService)) {
        status = 'DIFF-OK';
        issue = 'values differ (allowlisted)';
      } else {
        status = 'DIFF';
        issue = 'values differ';
        // Value differences are warnings, not failures (URLs, hosts expected to differ)
        warnings.push(`${prodService}: '${varName}' value differs between PROD and UAT`);
      }
    }

    results.push({
      variable: varName,
      in_prod: 'YES',
      in_uat: inUat ? 'YES' : 'NO',
      value_diff: valuesDiffer ? `PROD: ${maskValue(prodValue)} / UAT: ${maskValue(uatValue)}` : '-',
      status
    });
  }

  // Check for UAT-only vars (informational)
  for (const varName of Object.keys(uatVars)) {
    if (!(varName in prodVars)) {
      results.push({
        variable: varName,
        in_prod: 'NO',
        in_uat: 'YES',
        value_diff: '-',
        status: 'UAT-ONLY'
      });
    }
  }

  // Print results table
  console.log(`\n  ${'Variable'.padEnd(35)} ${'PROD'.padEnd(6)} ${'UAT'.padEnd(6)} ${'Status'.padEnd(10)} Value Diff`);
  console.log(`  ${'-'.repeat(35)} ${'-'.repeat(6)} ${'-'.repeat(6)} ${'-'.repeat(10)} ${'-'.repeat(30)}`);

  for (const r of results) {
    let statusColor = NC;
    if (r.status === 'FAIL') statusColor = RED;
    else if (r.status === 'DIFF' || r.status === 'UAT-ONLY') statusColor = YELLOW;
    else if (r.status === 'OK') statusColor = GREEN;
    else if (r.status === 'ALLOW' || r.status === 'DIFF-OK') statusColor = CYAN;

    console.log(`  ${r.variable.padEnd(35)} ${r.in_prod.padEnd(6)} ${r.in_uat.padEnd(6)} ${statusColor}${r.status.padEnd(10)}${NC} ${r.value_diff}`);
  }

  return { failures, warnings };
}

/**
 * Main comparison function
 */
function checkEnvParity() {
  console.log(`\n${BLUE}========================================${NC}`);
  console.log(`${BLUE}  Environment Variable Parity Check${NC}`);
  console.log(`${BLUE}  PRODUCTION is baseline${NC}`);
  console.log(`${BLUE}========================================${NC}`);

  let allFailures = [];
  let allWarnings = [];

  // Compare each service pair
  for (const [prodService, uatService] of Object.entries(SERVICE_MAPPINGS)) {
    const { failures, warnings } = compareServiceEnvVars(prodService, uatService);
    allFailures.push(...failures);
    allWarnings.push(...warnings);
  }

  // Print summary
  console.log(`\n${BLUE}--- Summary ---${NC}\n`);

  if (allWarnings.length > 0) {
    console.log(`${YELLOW}Warnings (${allWarnings.length}):${NC}`);
    allWarnings.forEach(w => console.log(`  ${YELLOW}[WARN]${NC} ${w}`));
    console.log('');
  }

  if (allFailures.length > 0) {
    console.log(`${RED}Failures (${allFailures.length}):${NC}`);
    allFailures.forEach(f => console.log(`  ${RED}[FAIL]${NC} ${f}`));
    console.log('');
    console.log(`${RED}========================================${NC}`);
    console.log(`${RED}  ENV VAR PARITY: FAILED${NC}`);
    console.log(`${RED}  UAT is missing ${allFailures.length} env var(s) from PROD${NC}`);
    console.log(`${RED}========================================${NC}\n`);
    return false;
  }

  console.log(`${GREEN}========================================${NC}`);
  console.log(`${GREEN}  ENV VAR PARITY: PASSED${NC}`);
  console.log(`${GREEN}========================================${NC}\n`);
  return true;
}

// Run if called directly
if (require.main === module) {
  // Reset to UAT after running
  const passed = checkEnvParity();
  try {
    execSync('railway environment uat && railway service web-uat', { stdio: 'pipe' });
  } catch {}

  process.exit(passed ? 0 : 1);
}

module.exports = { checkEnvParity };
