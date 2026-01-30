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
  reason: 'Classification failed validation.'
};

/**
 * Call AI classification with timeout
 */
async function classifyWithAI(tenantCode, title, description, timeoutMs = 20000) {
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.AI_API_KEY;

  // If no API key, return failure immediately
  if (!apiKey || apiKey === 'your_anthropic_api_key_here' || !apiKey.startsWith('sk-')) {
    return { success: false, error: 'No valid Anthropic API key configured' };
  }

  return new Promise(async (resolve) => {
    const timer = setTimeout(() => {
      resolve({ success: false, error: 'AI timeout' });
    }, timeoutMs);

    try {
      const aiService = new AIAnalysisService(tenantCode, {
        apiKey,
        aiProvider: 'anthropic',
        task: 'ticket_work_classify'
      });

      const emailData = {
        subject: title || '(no subject)',
        body: description || '(no description)'
      };

      const result = await aiService.analyze(emailData, { task: 'ticket_work_classify' });

      clearTimeout(timer);

      if (!result) {
        resolve({ success: false, error: 'Empty AI response' });
        return;
      }

      // Result is already parsed by AIAnalysisService
      resolve({ success: true, data: result });
    } catch (error) {
      clearTimeout(timer);
      resolve({ success: false, error: error.message });
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

    // Call AI
    const aiResult = await classifyWithAI(opts.tenant, ticket.title, ticket.description);

    let classification;
    let classifiedBy = 'ai';

    if (aiResult.success) {
      classification = validateAndApplyGuardrails(aiResult.data, ticket.title, ticket.description);
    } else {
      // Fallback
      classification = { ...FALLBACK_CLASSIFICATION };
      classification.reason = `AI failed: ${aiResult.error}`;
      classifiedBy = 'rule';
      stats.failed++;
    }

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
    } finally {
      connection.release();
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
  console.log('========== BACKFILL CLASSIFICATION ==========');
  console.log(`Tenant: ${opts.tenant}`);
  console.log(`Limit: ${opts.limit}`);
  console.log(`Batch size: ${opts.batch}`);
  console.log(`Concurrency: ${opts.concurrency}`);
  console.log(`Since days: ${opts.all ? 'ALL' : opts.sinceDays}`);
  console.log(`Dry run: ${opts.dryRun}`);
  console.log('');

  const stats = {
    processed: 0,
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
  console.log(`Total failed: ${stats.failed}`);
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
