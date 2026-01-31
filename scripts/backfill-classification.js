#!/usr/bin/env node

// Only load dotenv for local development (not when running via Railway)
// Railway provides all necessary env vars; .env has localhost defaults that conflict
if (!process.env.MYSQLHOST) {
  require('dotenv').config();
}

/**
 * Backfill Ticket Classification
 *
 * Production-safe script to classify existing tickets that have no classification.
 * Uses the AI ticket_work_classify task with guardrails and fallback.
 *
 * Usage:
 *   node scripts/backfill-classification.js --tenant apoyar --limit 200
 *   node scripts/backfill-classification.js --tenant apoyar --limit 50 --dry-run
 *   node scripts/backfill-classification.js --tenant apoyar --all --batch 50 --concurrency 1
 *
 * Options:
 *   --tenant <code>      Tenant code (required)
 *   --limit <N>          Max tickets to process (default: 200)
 *   --batch <N>          Batch size for DB queries (default: 100)
 *   --concurrency <N>    Max concurrent AI calls (default: 2)
 *   --all                Classify all open tickets (ignore 90-day filter)
 *   --since-days <N>     Override 90-day default (default: 90)
 *   --dry-run            No DB updates; print what would be written for first 10
 */

const { getTenantConnection } = require('../config/database');
const { AIAnalysisService } = require('../services/ai-analysis-service');

// ============================================================================
// PROVIDER CONFIGURATION
// ============================================================================

/**
 * Determine AI provider and API key based on environment
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
  let effectiveProvider = provider;

  if (provider === 'anthropic' && hasAnthropic) {
    apiKey = anthropicKey;
  } else if (provider === 'openai' && hasOpenAI) {
    apiKey = openaiKey;
  } else if (provider !== 'pattern') {
    // Requested provider not available, fall back to pattern
    effectiveProvider = 'pattern';
  }

  return {
    provider: effectiveProvider,
    requestedProvider: provider,
    apiKey,
    hasOpenAI,
    hasAnthropic
  };
}

// Global provider config (set once at startup)
let providerConfig = null;

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

// Parse CLI arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    tenant: null,
    limit: 200,
    batch: 100,
    concurrency: 2,
    all: false,
    sinceDays: 90,
    dryRun: false
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--tenant':
        opts.tenant = args[++i];
        break;
      case '--limit':
        opts.limit = parseInt(args[++i], 10);
        break;
      case '--batch':
        opts.batch = parseInt(args[++i], 10);
        break;
      case '--concurrency':
        opts.concurrency = parseInt(args[++i], 10);
        break;
      case '--all':
        opts.all = true;
        break;
      case '--since-days':
        opts.sinceDays = parseInt(args[++i], 10);
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
    }
  }

  if (!opts.tenant) {
    console.error('Error: --tenant is required');
    console.error('Usage: node scripts/backfill-classification.js --tenant <code> [options]');
    process.exit(1);
  }

  return opts;
}

// Valid enums
const VALID_WORK_TYPES = [
  'request', 'incident', 'problem', 'change_request',
  'operational_action', 'question', 'feedback', 'unknown'
];
const VALID_EXECUTION_MODES = [
  'automated', 'human_review', 'expert_required', 'escalation_required', 'mixed'
];

// Dangerous keywords that force expert_required
const DANGEROUS_PATTERN = /\b(delete|remove|purge|drop|terminate|destroy|wipe|truncate|erase|format|kill)\b/i;

// Fallback classification when AI fails
const FALLBACK_CLASSIFICATION = {
  work_type: 'unknown',
  execution_mode: 'mixed',
  system_tags: [],
  confidence: 0.2,
  reason: 'Pattern-based classification (AI not configured)'
};

/**
 * Call AI classification with timeout (falls back to pattern silently)
 */
async function classifyWithAI(tenantCode, title, description, timeoutMs = 20000) {
  // Use pattern fallback if no valid AI provider
  if (providerConfig.provider === 'pattern' || !providerConfig.apiKey) {
    return { success: true, data: classifyWithPatterns(title, description), usedPattern: true };
  }

  return new Promise(async (resolve) => {
    const timer = setTimeout(() => {
      // Timeout - fall back to pattern silently
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
        // Empty response - fall back to pattern silently
        resolve({ success: true, data: classifyWithPatterns(title, description), usedPattern: true });
        return;
      }

      // Result is already parsed by AIAnalysisService
      resolve({ success: true, data: result, usedPattern: false });
    } catch (error) {
      clearTimeout(timer);
      // AI error - fall back to pattern silently
      resolve({ success: true, data: classifyWithPatterns(title, description), usedPattern: true, aiError: error.message });
    }
  });
}

/**
 * Validate and apply guardrails to classification
 */
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
    // Add security tag if not present
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

/**
 * Semaphore for concurrency control
 */
class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    await new Promise(resolve => this.queue.push(resolve));
    this.current++;
  }

  release() {
    this.current--;
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next();
    }
  }
}

/**
 * Process a single ticket
 */
async function processTicket(ticket, semaphore, stats, opts) {
  await semaphore.acquire();

  try {
    const startTime = Date.now();

    // Call AI (falls back to pattern silently)
    const aiResult = await classifyWithAI(opts.tenant, ticket.title, ticket.description);

    // Always succeeds now (pattern fallback)
    const classification = validateAndApplyGuardrails(aiResult.data, ticket.title, ticket.description);
    const classifiedBy = aiResult.usedPattern ? 'pattern' : 'ai';

    const elapsed = Date.now() - startTime;

    if (opts.dryRun) {
      if (stats.processed < 10) {
        console.log(`\n[DRY-RUN] Ticket #${ticket.id}:`);
        console.log(`  Title: ${(ticket.title || '').slice(0, 60)}...`);
        console.log(`  Classification: ${classification.work_type}/${classification.execution_mode}`);
        console.log(`  Tags: [${classification.system_tags.join(', ')}]`);
        console.log(`  Confidence: ${classification.confidence}`);
        console.log(`  Classified by: ${classifiedBy}`);
        console.log(`  Reason: ${(classification.reason || '').slice(0, 80)}...`);
        console.log(`  Time: ${elapsed}ms`);
      }
      stats.processed++;
      return { ticket, classification, classifiedBy };
    }

    // Persist to DB
    const connection = await getTenantConnection(opts.tenant);
    try {
      await connection.query(`
        UPDATE tickets
        SET work_type = ?,
            execution_mode = ?,
            system_tags = ?,
            classification_confidence = ?,
            classification_reason = ?,
            classified_by = ?,
            classified_at = NOW()
        WHERE id = ?
      `, [
        classification.work_type,
        classification.execution_mode,
        JSON.stringify(classification.system_tags),
        classification.confidence,
        classification.reason,
        classifiedBy,
        ticket.id
      ]);
      stats.updated++;
    } catch (dbError) {
      // DB update failed - this is a real error
      stats.failed++;
      console.error(`  DB ERROR #${ticket.id}: ${dbError.message}`);
    }

    stats.processed++;
    return { ticket, classification, classifiedBy, elapsed };

  } catch (error) {
    stats.failed++;
    console.error(`  Error processing ticket #${ticket.id}: ${error.message}`);
    return { ticket, error: error.message };
  } finally {
    semaphore.release();
  }
}

/**
 * Fetch unclassified tickets
 */
async function fetchTickets(connection, opts, offset) {
  const conditions = [
    "(work_type IS NULL OR work_type = '' OR work_type = 'unknown')",
    "status NOT IN ('Resolved', 'Closed')"
  ];

  if (!opts.all) {
    conditions.push(`created_at >= NOW() - INTERVAL ${opts.sinceDays} DAY`);
  }

  const whereClause = conditions.join(' AND ');
  const limit = Math.min(opts.batch, opts.limit - offset);

  const [rows] = await connection.query(`
    SELECT id, title, description
    FROM tickets
    WHERE ${whereClause}
    ORDER BY created_at ASC
    LIMIT ? OFFSET ?
  `, [limit, offset]);

  return rows;
}

/**
 * Print final distribution report
 */
async function printReport(connection) {
  console.log('\n========== CLASSIFICATION DISTRIBUTION ==========\n');

  const [distribution] = await connection.query(`
    SELECT
      COALESCE(work_type, 'NULL') as work_type,
      COALESCE(execution_mode, 'NULL') as execution_mode,
      COUNT(*) as n
    FROM tickets
    GROUP BY work_type, execution_mode
    ORDER BY n DESC
  `);

  console.log('work_type           | execution_mode      | count');
  console.log('--------------------|---------------------|------');
  distribution.forEach(row => {
    const wt = (row.work_type || 'NULL').padEnd(19);
    const em = (row.execution_mode || 'NULL').padEnd(19);
    console.log(`${wt} | ${em} | ${row.n}`);
  });

  const [remaining] = await connection.query(`
    SELECT COUNT(*) as remaining
    FROM tickets
    WHERE (work_type IS NULL OR work_type = '' OR work_type = 'unknown')
      AND status NOT IN ('Resolved', 'Closed')
  `);

  console.log(`\nRemaining unclassified (open): ${remaining[0].remaining}`);
}

/**
 * Main backfill function
 */
async function backfill(opts) {
  // Initialize provider config once at startup
  providerConfig = getProviderConfig();

  console.log('\n========== BACKFILL CLASSIFICATION ==========');

  // Print provider info (once at startup)
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
  console.log(`  Limit: ${opts.limit}`);
  console.log(`  Batch size: ${opts.batch}`);
  console.log(`  Concurrency: ${opts.concurrency}`);
  console.log(`  Since days: ${opts.all ? 'ALL' : opts.sinceDays}`);
  console.log(`  Dry run: ${opts.dryRun}`);
  console.log('');

  const stats = {
    processed: 0,
    updated: 0,
    failed: 0,
    startTime: Date.now()
  };

  const semaphore = new Semaphore(opts.concurrency);
  let offset = 0;
  let batchNum = 0;

  while (offset < opts.limit) {
    batchNum++;
    const batchStart = Date.now();

    // Get connection for batch fetch
    const connection = await getTenantConnection(opts.tenant);
    let tickets;
    try {
      tickets = await fetchTickets(connection, opts, offset);
    } finally {
      connection.release();
    }

    if (tickets.length === 0) {
      console.log(`\nBatch ${batchNum}: No more tickets to process.`);
      break;
    }

    console.log(`\nBatch ${batchNum}: Processing ${tickets.length} tickets (offset ${offset})...`);

    // Process batch with concurrency
    const promises = tickets.map(ticket => processTicket(ticket, semaphore, stats, opts));
    await Promise.all(promises);

    const batchElapsed = Date.now() - batchStart;
    const rate = (tickets.length / (batchElapsed / 1000)).toFixed(1);

    console.log(`  Completed: ${stats.processed} processed, ${stats.failed} failed, ${rate} tickets/sec`);

    offset += tickets.length;

    // Small delay between batches to be nice to the DB
    if (offset < opts.limit && tickets.length === opts.batch) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  const totalElapsed = ((Date.now() - stats.startTime) / 1000).toFixed(1);
  console.log(`\n========== SUMMARY ==========`);
  console.log(`Total processed: ${stats.processed}`);
  console.log(`Total updated: ${stats.updated}`);
  console.log(`Total failed (DB errors): ${stats.failed}`);
  console.log(`Total time: ${totalElapsed}s`);

  if (!opts.dryRun) {
    // Print distribution report
    const connection = await getTenantConnection(opts.tenant);
    try {
      await printReport(connection);
    } finally {
      connection.release();
    }
  }
}

// Run
const opts = parseArgs();
backfill(opts)
  .then(() => {
    console.log('\nBackfill complete.');
    process.exit(0);
  })
  .catch(err => {
    console.error('Backfill error:', err);
    process.exit(1);
  });
