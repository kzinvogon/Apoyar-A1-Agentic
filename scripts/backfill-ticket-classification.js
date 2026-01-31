#!/usr/bin/env node

/**
 * Backfill Ticket Classification (Pool-First)
 *
 * Safe, resumable script to classify existing tickets with AI work type classification.
 *
 * Phase 1 (pool mode): Only tickets in expert pool that need classification
 * Phase 2 (all mode): All tickets missing classification fields
 *
 * Usage:
 *   node scripts/backfill-ticket-classification.js --tenant apoyar --mode pool
 *   node scripts/backfill-ticket-classification.js --tenant apoyar --mode all --max 100
 *   node scripts/backfill-ticket-classification.js --tenant apoyar --mode pool --from-id 2500 --dry-run
 *
 * Options:
 *   --tenant <code>      Tenant code (default: apoyar)
 *   --mode <pool|all>    Pool mode (default) or all tickets (default: pool)
 *   --batch-size <N>     Batch size for DB queries (default: 25)
 *   --max <N>            Max tickets to process (default: unlimited)
 *   --sleep-ms <N>       Sleep between tickets in ms (default: 300)
 *   --dry-run            No DB writes, print what would be done
 *   --from-id <N>        Resume from ticket ID (default: 0)
 */

// Only load dotenv for local development
if (!process.env.MYSQLHOST) {
  require('dotenv').config();
}

const fs = require('fs');
const path = require('path');
const { getTenantConnection } = require('../config/database');
const { AIAnalysisService } = require('../services/ai-analysis-service');

// ============================================================================
// CLI ARGUMENT PARSING
// ============================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    tenant: 'apoyar',
    mode: 'pool',
    batchSize: 25,
    max: null,
    sleepMs: 300,
    dryRun: false,
    fromId: 0
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--tenant':
        opts.tenant = args[++i];
        break;
      case '--mode':
        opts.mode = args[++i];
        if (!['pool', 'all'].includes(opts.mode)) {
          console.error('Error: --mode must be "pool" or "all"');
          process.exit(1);
        }
        break;
      case '--batch-size':
        opts.batchSize = parseInt(args[++i], 10);
        break;
      case '--max':
        opts.max = parseInt(args[++i], 10);
        break;
      case '--sleep-ms':
        opts.sleepMs = parseInt(args[++i], 10);
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--from-id':
        opts.fromId = parseInt(args[++i], 10);
        break;
      case '--help':
        printHelp();
        process.exit(0);
    }
  }

  return opts;
}

function printHelp() {
  console.log(`
Backfill Ticket Classification

Usage:
  node scripts/backfill-ticket-classification.js [options]

Options:
  --tenant <code>      Tenant code (default: apoyar)
  --mode <pool|all>    pool = expert pool tickets only, all = all tickets (default: pool)
  --batch-size <N>     Batch size for DB queries (default: 25)
  --max <N>            Max tickets to process (default: unlimited)
  --sleep-ms <N>       Sleep between tickets in ms (default: 300)
  --dry-run            No DB writes, print what would be done
  --from-id <N>        Resume from ticket ID (default: 0)

Examples:
  # Pool mode - classify tickets in expert pool (recommended first)
  node scripts/backfill-ticket-classification.js --tenant apoyar --mode pool

  # All mode - classify all tickets with missing fields
  node scripts/backfill-ticket-classification.js --tenant apoyar --mode all --max 500

  # Resume from a specific ticket ID
  node scripts/backfill-ticket-classification.js --tenant apoyar --mode pool --from-id 2500

  # Dry run to see what would be classified
  node scripts/backfill-ticket-classification.js --tenant apoyar --mode pool --max 10 --dry-run
`);
}

// ============================================================================
// CONSTANTS
// ============================================================================

const VALID_WORK_TYPES = [
  'request', 'incident', 'problem', 'change_request',
  'operational_action', 'question', 'feedback', 'unknown'
];

const VALID_EXECUTION_MODES = [
  'automated', 'human_review', 'expert_required', 'escalation_required', 'mixed'
];

const DANGEROUS_PATTERN = /\b(delete|remove|purge|drop|terminate|destroy|wipe|truncate|erase|format|kill|rm -rf)\b/i;

const FALLBACK_CLASSIFICATION = {
  work_type: 'unknown',
  execution_mode: 'mixed',
  system_tags: [],
  confidence: 0.2,
  reason: 'Pattern-based classification (AI not configured)'
};

// Error log file
const ERROR_LOG_PATH = path.join(__dirname, '..', 'logs', 'backfill-classification-errors.jsonl');

// ============================================================================
// PROVIDER CONFIGURATION
// ============================================================================

/**
 * Determine AI provider and API key based on environment
 * Returns { provider, apiKey, isValid, hasOpenAI, hasAnthropic }
 */
function getProviderConfig() {
  const provider = process.env.AI_PROVIDER || process.env.AI_PROVIDER_PRIMARY || 'pattern';

  // Check for valid API keys
  const anthropicKey = process.env.ANTHROPIC_API_KEY || process.env.AI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  // Validate Anthropic key (must start with 'sk-ant-')
  const hasAnthropic = !!(anthropicKey &&
    anthropicKey !== 'your_anthropic_api_key_here' &&
    anthropicKey.startsWith('sk-ant-'));

  // Validate OpenAI key (must start with 'sk-' or 'sk-proj-')
  const hasOpenAI = !!(openaiKey &&
    openaiKey !== 'your_openai_api_key_here' &&
    (openaiKey.startsWith('sk-') || openaiKey.startsWith('sk-proj-')));

  let apiKey = null;
  let isValid = false;
  let effectiveProvider = provider;

  if (provider === 'anthropic' && hasAnthropic) {
    apiKey = anthropicKey;
    isValid = true;
  } else if (provider === 'openai' && hasOpenAI) {
    apiKey = openaiKey;
    isValid = true;
  } else if (provider === 'pattern') {
    // Pattern provider doesn't need an API key
    isValid = true;
    effectiveProvider = 'pattern';
  } else {
    // Requested provider not available, fall back to pattern
    effectiveProvider = 'pattern';
    isValid = true;
  }

  return {
    provider: effectiveProvider,
    requestedProvider: provider,
    apiKey,
    isValid,
    hasOpenAI,
    hasAnthropic
  };
}

// Global provider config (set once at startup)
let providerConfig = null;
let providerWarningLogged = false;

// ============================================================================
// PATTERN-BASED CLASSIFICATION
// ============================================================================

function classifyWithPatterns(title, description) {
  const text = `${title || ''} ${description || ''}`.toLowerCase();

  let work_type = 'unknown';
  let execution_mode = 'human_review';
  let confidence = 0.6;
  const system_tags = [];
  const reasons = [];

  // Incident patterns (something is broken)
  if (/(down|outage|error|fail|crash|broken|not working|doesn't work|can't access|unable to|stopped|issue|problem with|bug)/i.test(text)) {
    work_type = 'incident';
    confidence = 0.75;
    reasons.push('Contains incident keywords');

    if (/(critical|urgent|emergency|production down|system down|major)/i.test(text)) {
      execution_mode = 'expert_required';
      system_tags.push('urgent');
      confidence = 0.85;
    }
  }

  // Request patterns (asking for something new)
  else if (/(request|need access|grant|create|setup|provision|install|configure|add user|new account|please provide|could you|can you set up)/i.test(text)) {
    work_type = 'request';
    confidence = 0.7;
    reasons.push('Contains request keywords');

    if (/(access|permission|account)/i.test(text)) {
      system_tags.push('access');
    }
  }

  // Question patterns
  else if (/(how do i|how to|what is|can i|is it possible|wondering|question|info|information|explain|help me understand)/i.test(text)) {
    work_type = 'question';
    execution_mode = 'human_review';
    confidence = 0.7;
    reasons.push('Contains question keywords');
    system_tags.push('training');
  }

  // Change request patterns
  else if (/(change|modify|update|upgrade|migrate|move|transfer|replace|switch|convert)/i.test(text)) {
    work_type = 'change_request';
    execution_mode = 'human_review';
    confidence = 0.65;
    reasons.push('Contains change keywords');
  }

  // Operational action patterns
  else if (/(maintenance|scheduled|routine|backup|patch|reboot|restart|renew|certificate|expire)/i.test(text)) {
    work_type = 'operational_action';
    execution_mode = 'automated';
    confidence = 0.7;
    reasons.push('Contains operational keywords');
    system_tags.push('maintenance');
  }

  // Feedback patterns
  else if (/(feedback|suggestion|complaint|compliment|improve|feature request|would be nice|thank you for)/i.test(text)) {
    work_type = 'feedback';
    execution_mode = 'human_review';
    confidence = 0.65;
    reasons.push('Contains feedback keywords');
  }

  // Problem investigation patterns
  else if (/(root cause|recurring|keeps happening|again|investigate|analysis|multiple incidents|pattern)/i.test(text)) {
    work_type = 'problem';
    execution_mode = 'expert_required';
    confidence = 0.7;
    reasons.push('Contains problem investigation keywords');
  }

  // Add category-based tags
  if (/(database|mysql|sql|postgres|oracle|mongo)/i.test(text)) {
    system_tags.push('database');
  }
  if (/(network|vpn|firewall|dns|connectivity|connection)/i.test(text)) {
    system_tags.push('network');
  }
  if (/(security|password|authentication|unauthorized|breach|vulnerability)/i.test(text)) {
    system_tags.push('security');
    if (work_type === 'incident') {
      execution_mode = 'escalation_required';
    }
  }

  return {
    work_type,
    execution_mode,
    system_tags: [...new Set(system_tags)].slice(0, 3),
    confidence,
    reason: reasons.length > 0 ? `Pattern: ${reasons.join('; ')}` : 'Pattern-based classification'
  };
}

// ============================================================================
// AI CLASSIFICATION
// ============================================================================

async function classifyWithAI(tenantCode, title, description, timeoutMs = 25000) {
  // Use pattern fallback if no valid AI provider
  if (providerConfig.provider === 'pattern') {
    return { success: true, data: classifyWithPatterns(title, description), usedPattern: true };
  }

  return new Promise(async (resolve) => {
    const timer = setTimeout(() => {
      // Timeout - fall back to pattern
      resolve({ success: true, data: classifyWithPatterns(title, description), usedPattern: true, timeout: true });
    }, timeoutMs);

    try {
      const aiService = new AIAnalysisService(tenantCode, {
        apiKey: providerConfig.apiKey,
        aiProvider: providerConfig.provider,
        task: 'ticket_work_classify'
      });

      const emailData = {
        subject: title || '(no subject)',
        body: description || '(no description)'
      };

      const result = await aiService.analyze(emailData, { task: 'ticket_work_classify' });

      clearTimeout(timer);

      if (!result) {
        // Empty response - fall back to pattern
        resolve({ success: true, data: classifyWithPatterns(title, description), usedPattern: true });
        return;
      }

      resolve({ success: true, data: result, usedPattern: false });
    } catch (error) {
      clearTimeout(timer);
      // AI error - fall back to pattern silently
      resolve({ success: true, data: classifyWithPatterns(title, description), usedPattern: true, aiError: error.message });
    }
  });
}

// ============================================================================
// VALIDATION & GUARDRAILS
// ============================================================================

function validateAndApplyGuardrails(classification, title, description) {
  const result = { ...FALLBACK_CLASSIFICATION };

  if (!classification || typeof classification !== 'object') {
    return result;
  }

  // Validate work_type
  if (classification.work_type && VALID_WORK_TYPES.includes(classification.work_type)) {
    result.work_type = classification.work_type;
  }

  // Validate execution_mode
  if (classification.execution_mode && VALID_EXECUTION_MODES.includes(classification.execution_mode)) {
    result.execution_mode = classification.execution_mode;
  }

  // Validate system_tags
  if (Array.isArray(classification.system_tags)) {
    result.system_tags = classification.system_tags
      .filter(t => typeof t === 'string')
      .map(t => t.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''))
      .filter(t => t.length > 0)
      .slice(0, 6);
  }

  // Validate confidence
  if (typeof classification.confidence === 'number' && classification.confidence >= 0 && classification.confidence <= 1) {
    result.confidence = classification.confidence;
  } else {
    result.confidence = 0.5;
  }

  // Validate reason
  if (typeof classification.reason === 'string') {
    result.reason = classification.reason.slice(0, 500);
  }

  // GUARDRAIL: Dangerous keywords force expert_required
  const combinedText = `${title || ''} ${description || ''}`;
  if (DANGEROUS_PATTERN.test(combinedText)) {
    if (result.execution_mode === 'automated' || result.execution_mode === 'human_review') {
      result.execution_mode = 'expert_required';
      result.reason = (result.reason || '') + '; Guardrail: dangerous action detected';
    }
    if (!result.system_tags.includes('security')) {
      result.system_tags = [...result.system_tags.slice(0, 5), 'security'];
    }
  }

  // GUARDRAIL: Low confidence forces unknown/mixed
  if (result.confidence < 0.4) {
    result.work_type = 'unknown';
    result.execution_mode = 'mixed';
  }

  return result;
}

// ============================================================================
// ERROR LOGGING
// ============================================================================

function logError(ticketId, error) {
  try {
    const logDir = path.dirname(ERROR_LOG_PATH);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      ticketId,
      error
    });
    fs.appendFileSync(ERROR_LOG_PATH, entry + '\n');
  } catch (e) {
    // Ignore logging errors
  }
}

// ============================================================================
// DATABASE QUERIES
// ============================================================================

/**
 * Count tickets missing classification (pool + all)
 */
async function countMissingClassification(connection) {
  const missingCondition = `(
    work_type IS NULL OR execution_mode IS NULL
    OR system_tags IS NULL OR classification_confidence IS NULL
    OR classified_at IS NULL OR classified_by IS NULL
  )`;

  // Pool count
  const [poolResult] = await connection.query(`
    SELECT COUNT(*) as count FROM tickets
    WHERE pool_status IN ('OPEN_POOL', 'CLAIMED_LOCKED')
      AND status NOT IN ('Resolved', 'Closed')
      AND ${missingCondition}
  `);

  // All count
  const [allResult] = await connection.query(`
    SELECT COUNT(*) as count FROM tickets
    WHERE ${missingCondition}
  `);

  return {
    pool: poolResult[0].count,
    all: allResult[0].count
  };
}

/**
 * Fetch candidate tickets for classification
 */
async function fetchCandidates(connection, opts, fromId) {
  const missingCondition = `(
    work_type IS NULL OR execution_mode IS NULL
    OR system_tags IS NULL OR classification_confidence IS NULL
    OR classified_at IS NULL OR classified_by IS NULL
  )`;

  let whereClause;
  if (opts.mode === 'pool') {
    whereClause = `
      pool_status IN ('OPEN_POOL', 'CLAIMED_LOCKED')
      AND status NOT IN ('Resolved', 'Closed')
      AND ${missingCondition}
      AND id >= ?
    `;
  } else {
    whereClause = `
      ${missingCondition}
      AND id >= ?
    `;
  }

  const [rows] = await connection.query(`
    SELECT id, title, description
    FROM tickets
    WHERE ${whereClause}
    ORDER BY id ASC
    LIMIT ?
  `, [fromId, opts.batchSize]);

  return rows;
}

// ============================================================================
// PROCESS SINGLE TICKET
// ============================================================================

async function processTicket(connection, ticket, opts, stats) {
  const startTime = Date.now();

  try {
    // Call AI classification (will fall back to pattern if needed)
    const aiResult = await classifyWithAI(opts.tenant, ticket.title, ticket.description);

    // Apply validation and guardrails
    const classification = validateAndApplyGuardrails(aiResult.data, ticket.title, ticket.description);

    const elapsed = Date.now() - startTime;
    stats.totalMs += elapsed;

    if (opts.dryRun) {
      const source = aiResult.usedPattern ? 'pattern' : 'ai';
      console.log(`  [DRY-RUN] #${ticket.id}: ${classification.work_type}/${classification.execution_mode} (${(classification.confidence * 100).toFixed(0)}%) [${source}] - ${elapsed}ms`);
      stats.processed++;
      stats.lastId = ticket.id;
      return;
    }

    // Write to database - ONLY classification fields
    try {
      await connection.query(`
        UPDATE tickets SET
          work_type = ?,
          execution_mode = ?,
          system_tags = ?,
          classification_confidence = ?,
          classification_reason = ?,
          classified_by = 'backfill',
          classified_at = NOW()
        WHERE id = ?
      `, [
        classification.work_type,
        classification.execution_mode,
        JSON.stringify(classification.system_tags),
        classification.confidence,
        classification.reason,
        ticket.id
      ]);

      stats.updated++;
    } catch (dbError) {
      // DB update failed - this is a real error
      stats.errors++;
      logError(ticket.id, `DB update failed: ${dbError.message}`);
      console.error(`  DB ERROR #${ticket.id}: ${dbError.message}`);
    }

    stats.processed++;
    stats.lastId = ticket.id;

    // Progress output every 10 tickets
    if (stats.processed % 10 === 0) {
      const avgMs = (stats.totalMs / stats.processed).toFixed(0);
      console.log(`  Processed ${stats.processed} (updated=${stats.updated}, errors=${stats.errors}, avg=${avgMs}ms, lastId=${ticket.id})`);
    }

  } catch (error) {
    // Unexpected error during processing
    stats.errors++;
    stats.processed++;
    stats.lastId = ticket.id;
    logError(ticket.id, error.message);
    console.error(`  ERROR #${ticket.id}: ${error.message}`);
    // Continue to next ticket
  }
}

// ============================================================================
// MAIN BACKFILL
// ============================================================================

async function backfill(opts) {
  // Initialize provider config once
  providerConfig = getProviderConfig();

  console.log('\n========== BACKFILL TICKET CLASSIFICATION ==========');

  // Print provider info
  console.log('\nProvider Configuration:');
  console.log(`  Selected provider: ${providerConfig.provider}`);
  if (providerConfig.requestedProvider !== providerConfig.provider) {
    console.log(`  ⚠️  Requested provider '${providerConfig.requestedProvider}' not available; using '${providerConfig.provider}' fallback`);
  }
  console.log(`  hasOpenAI: ${providerConfig.hasOpenAI}`);
  console.log(`  hasAnthropic: ${providerConfig.hasAnthropic}`);

  // Print DB connection info
  const mysqlHost = process.env.MYSQLHOST || process.env.MYSQL_HOST || 'localhost';
  const mysqlPort = process.env.MYSQLPORT || process.env.MYSQL_PORT || '3306';
  const mysqlUser = process.env.MYSQLUSER || process.env.MYSQL_USER || 'root';
  console.log(`\nDatabase: ${mysqlHost}:${mysqlPort} (user: ${mysqlUser})`);
  console.log(`Target schema: a1_tenant_${opts.tenant}`);

  console.log('\nRun Configuration:');
  console.log(`  Tenant: ${opts.tenant}`);
  console.log(`  Mode: ${opts.mode}`);
  console.log(`  Batch size: ${opts.batchSize}`);
  console.log(`  Max tickets: ${opts.max || 'unlimited'}`);
  console.log(`  Sleep between tickets: ${opts.sleepMs}ms`);
  console.log(`  Resume from ID: ${opts.fromId}`);
  console.log(`  Dry run: ${opts.dryRun}`);
  console.log('');

  const connection = await getTenantConnection(opts.tenant);

  try {
    // Get server UUID
    const [uuidResult] = await connection.query('SELECT @@server_uuid as uuid');
    console.log(`Server UUID: ${uuidResult[0].uuid}`);
    console.log('');

    // BEFORE: Count missing classification
    console.log('Counting tickets missing classification...');
    const beforeCounts = await countMissingClassification(connection);
    console.log(`  Pool tickets missing: ${beforeCounts.pool}`);
    console.log(`  All tickets missing: ${beforeCounts.all}`);
    console.log('');

    const stats = {
      processed: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      totalMs: 0,
      lastId: opts.fromId,
      startTime: Date.now()
    };

    let currentFromId = opts.fromId;
    let batchNum = 0;

    // Process batches
    while (true) {
      // Check max limit
      if (opts.max && stats.processed >= opts.max) {
        console.log(`\nReached max limit (${opts.max})`);
        break;
      }

      batchNum++;
      const candidates = await fetchCandidates(connection, opts, currentFromId);

      if (candidates.length === 0) {
        console.log(`\nNo more candidates found.`);
        break;
      }

      console.log(`\nBatch ${batchNum}: ${candidates.length} tickets (starting ID ${candidates[0].id})`);

      for (const ticket of candidates) {
        // Check max limit
        if (opts.max && stats.processed >= opts.max) {
          break;
        }

        await processTicket(connection, ticket, opts, stats);

        // Sleep between tickets
        if (opts.sleepMs > 0) {
          await new Promise(r => setTimeout(r, opts.sleepMs));
        }
      }

      // Move cursor forward
      currentFromId = stats.lastId + 1;
    }

    // AFTER: Count missing classification
    console.log('\n========== RESULTS ==========');
    const afterCounts = await countMissingClassification(connection);
    console.log(`\nBefore:`);
    console.log(`  Pool tickets missing: ${beforeCounts.pool}`);
    console.log(`  All tickets missing: ${beforeCounts.all}`);
    console.log(`\nAfter:`);
    console.log(`  Pool tickets missing: ${afterCounts.pool}`);
    console.log(`  All tickets missing: ${afterCounts.all}`);

    const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(1);
    const avgMs = stats.processed > 0 ? (stats.totalMs / stats.processed).toFixed(0) : 0;

    console.log(`\nSummary:`);
    console.log(`  Processed: ${stats.processed}`);
    console.log(`  Updated: ${stats.updated}`);
    console.log(`  Skipped: ${stats.skipped}`);
    console.log(`  Errors: ${stats.errors}`);
    console.log(`  Avg ms/ticket: ${avgMs}`);
    console.log(`  Total time: ${elapsed}s`);
    console.log(`  Last processed ID: ${stats.lastId} (use --from-id ${stats.lastId + 1} to resume)`);

    if (stats.errors > 0) {
      console.log(`\nErrors logged to: ${ERROR_LOG_PATH}`);
    }

  } finally {
    connection.release();
  }
}

// ============================================================================
// RUN
// ============================================================================

const opts = parseArgs();

backfill(opts)
  .then(() => {
    console.log('\nBackfill complete.');
    process.exit(0);
  })
  .catch(err => {
    console.error('\nFatal error:', err);
    process.exit(1);
  });
