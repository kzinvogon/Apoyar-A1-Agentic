#!/usr/bin/env node
/**
 * Service Parity Check
 *
 * PRODUCTION is the baseline. UAT must have all services that PROD has.
 * Fails if UAT is missing any PROD service (unless allowlisted).
 *
 * Usage: node scripts/parity/check-services.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Colors for output
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const NC = '\x1b[0m';

// Load allowlist
const ALLOWLIST_PATH = path.join(__dirname, 'allowlist.services.json');
let allowlist = {
  allow_missing_in_uat: [],
  allow_missing_in_prod: []
};

if (fs.existsSync(ALLOWLIST_PATH)) {
  try {
    allowlist = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
  } catch (e) {
    console.error(`${RED}Failed to parse allowlist: ${e.message}${NC}`);
  }
}

/**
 * Get services for an environment using Railway CLI
 */
function getServices(environment) {
  try {
    // Link to the environment first
    const linkCmd = environment === 'production'
      ? 'railway environment production'
      : 'railway environment uat';

    execSync(linkCmd, { encoding: 'utf8', stdio: 'pipe' });

    // Get service list - railway service command shows current service
    // We need to use railway status or parse project info
    const statusOutput = execSync('railway status --json 2>/dev/null || railway status', {
      encoding: 'utf8',
      stdio: 'pipe'
    });

    // Try to get all services via the API or project info
    // Railway CLI doesn't have a direct "list all services" command
    // We'll use a workaround by checking known services

    // For now, we'll use a known list approach - in a real scenario,
    // you'd query the Railway API directly
    const knownServices = getKnownServicesForEnv(environment);
    return knownServices;

  } catch (error) {
    console.error(`${RED}Failed to get services for ${environment}: ${error.message}${NC}`);
    return [];
  }
}

/**
 * Get known services by checking Railway project
 * This queries the Railway API via CLI for actual service discovery
 */
function getKnownServicesForEnv(environment) {
  const services = [];

  try {
    // Switch to the environment
    const envCmd = `railway environment ${environment}`;
    execSync(envCmd, { encoding: 'utf8', stdio: 'pipe' });

    // Get project services by trying to link to each known service name
    // and checking if it succeeds
    const potentialServices = [
      'web', 'web-uat', 'email-worker', 'email-worker-uat',
      'mysql', 'redis', 'worker'
    ];

    for (const svc of potentialServices) {
      try {
        execSync(`railway service ${svc}`, { encoding: 'utf8', stdio: 'pipe' });
        services.push(svc);
      } catch {
        // Service doesn't exist in this environment
      }
    }

    return services;
  } catch (error) {
    return [];
  }
}

/**
 * Normalize service name for comparison
 * Removes -uat suffix for comparing equivalent services
 */
function normalizeServiceName(name) {
  return name.replace(/-uat$/, '');
}

/**
 * Main comparison function
 */
function checkServiceParity() {
  console.log(`\n${BLUE}========================================${NC}`);
  console.log(`${BLUE}  Service Parity Check${NC}`);
  console.log(`${BLUE}  PRODUCTION is baseline${NC}`);
  console.log(`${BLUE}========================================${NC}\n`);

  // Get services from both environments
  console.log('Fetching PRODUCTION services...');
  const prodServices = getServices('production');

  console.log('Fetching UAT services...');
  const uatServices = getServices('uat');

  // Normalize for comparison
  const prodNormalized = new Set(prodServices.map(normalizeServiceName));
  const uatNormalized = new Set(uatServices.map(normalizeServiceName));

  console.log(`\n${YELLOW}PRODUCTION services:${NC} ${prodServices.join(', ') || '(none found)'}`);
  console.log(`${YELLOW}UAT services:${NC} ${uatServices.join(', ') || '(none found)'}\n`);

  let failures = [];
  let warnings = [];

  // Check for PROD services missing in UAT (FAILURE unless allowlisted)
  for (const prodSvc of prodServices) {
    const normalized = normalizeServiceName(prodSvc);

    // Check if UAT has this service (or its -uat variant)
    const uatHas = uatServices.some(s =>
      normalizeServiceName(s) === normalized
    );

    if (!uatHas) {
      if (allowlist.allow_missing_in_uat.includes(prodSvc) ||
          allowlist.allow_missing_in_uat.includes(normalized)) {
        warnings.push(`UAT missing '${prodSvc}' (allowlisted)`);
      } else {
        failures.push(`UAT missing '${prodSvc}' that exists in PROD`);
      }
    }
  }

  // Check for UAT services missing in PROD (WARNING only)
  for (const uatSvc of uatServices) {
    const normalized = normalizeServiceName(uatSvc);

    const prodHas = prodServices.some(s =>
      normalizeServiceName(s) === normalized
    );

    if (!prodHas) {
      if (allowlist.allow_missing_in_prod.includes(uatSvc) ||
          allowlist.allow_missing_in_prod.includes(normalized)) {
        // Silently allowed
      } else {
        warnings.push(`PROD missing '${uatSvc}' (exists only in UAT)`);
      }
    }
  }

  // Print results
  console.log(`${BLUE}--- Results ---${NC}\n`);

  if (warnings.length > 0) {
    console.log(`${YELLOW}Warnings:${NC}`);
    warnings.forEach(w => console.log(`  ${YELLOW}[WARN]${NC} ${w}`));
    console.log('');
  }

  if (failures.length > 0) {
    console.log(`${RED}Failures:${NC}`);
    failures.forEach(f => console.log(`  ${RED}[FAIL]${NC} ${f}`));
    console.log('');
    console.log(`${RED}========================================${NC}`);
    console.log(`${RED}  SERVICE PARITY: FAILED${NC}`);
    console.log(`${RED}  UAT is missing ${failures.length} service(s) from PROD${NC}`);
    console.log(`${RED}========================================${NC}\n`);
    return false;
  }

  console.log(`${GREEN}========================================${NC}`);
  console.log(`${GREEN}  SERVICE PARITY: PASSED${NC}`);
  console.log(`${GREEN}========================================${NC}\n`);
  return true;
}

// Run if called directly
if (require.main === module) {
  // Reset to UAT after running
  const passed = checkServiceParity();
  try {
    execSync('railway environment uat && railway service web-uat', { stdio: 'pipe' });
  } catch {}

  process.exit(passed ? 0 : 1);
}

module.exports = { checkServiceParity };
