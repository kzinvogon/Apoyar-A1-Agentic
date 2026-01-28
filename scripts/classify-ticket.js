#!/usr/bin/env node

/**
 * AI-Powered Ticket Work Type Classification Script
 *
 * Classifies tickets into work types and execution modes using AI.
 * Can be triggered automatically on ticket creation or manually.
 *
 * Work Types: request, incident, problem, change_request, operational_action, question, feedback, unknown
 * Execution Modes: automated, human_review, expert_required, escalation_required, mixed
 *
 * Usage:
 *   node scripts/classify-ticket.js <tenant_code> <ticket_id>
 *   node scripts/classify-ticket.js apoyar 123
 *
 * Programmatic:
 *   const { classifyTicket, triggerClassification } = require('./scripts/classify-ticket');
 *   await classifyTicket('apoyar', 123);
 *   triggerClassification('apoyar', 123);  // fire-and-forget
 */

require('dotenv').config();

const { getTenantConnection } = require('../config/database');
const { AIAnalysisService, safeParseJson } = require('../services/ai-analysis-service');

// Valid values for validation
const VALID_WORK_TYPES = [
  'request',
  'incident',
  'problem',
  'change_request',
  'operational_action',
  'question',
  'feedback',
  'unknown'
];

const VALID_EXECUTION_MODES = [
  'automated',
  'human_review',
  'expert_required',
  'escalation_required',
  'mixed'
];

// Dangerous action keywords that require expert_required execution mode
const DANGEROUS_KEYWORDS_REGEX = /\b(delete|remove|purge|drop|terminate|destroy|wipe|erase|truncate|clear all|rm -rf|format|reset to factory)\b/i;

// Minimum confidence threshold - below this, classification is set to unknown/mixed
const MIN_CONFIDENCE_THRESHOLD = 0.5;

/**
 * Main classification function
 * @param {string} tenantCode - The tenant code
 * @param {number} ticketId - The ticket ID to classify
 * @param {object} options - Optional settings
 * @returns {object} - Classification result
 */
async function classifyTicket(tenantCode, ticketId, options = {}) {
  const startTime = Date.now();
  const {
    dryRun = false,           // If true, don't update database
    forceReclassify = false   // If true, reclassify even if already classified
  } = options;

  console.log(`\n🏷️ Classify Ticket - #${ticketId} (Tenant: ${tenantCode})`);
  console.log('='.repeat(60));

  const connection = await getTenantConnection(tenantCode);

  try {
    // Step 1: Fetch the ticket
    console.log('\n📋 Fetching ticket data...');
    const [tickets] = await connection.query(`
      SELECT t.*,
             u.full_name as requester_name,
             c.company_name
      FROM tickets t
      LEFT JOIN users u ON t.requester_id = u.id
      LEFT JOIN customers c ON u.id = c.user_id
      WHERE t.id = ?
    `, [ticketId]);

    if (tickets.length === 0) {
      console.log('❌ Ticket not found');
      return { success: false, error: 'Ticket not found' };
    }

    const ticket = tickets[0];
    console.log(`   Title: ${ticket.title}`);
    console.log(`   Status: ${ticket.status}`);
    console.log(`   Current work_type: ${ticket.work_type || 'None'}`);

    // Skip if already classified by human or AI (unless forced)
    if (!forceReclassify && ticket.classified_by) {
      console.log(`⚠️ Already classified by ${ticket.classified_by}. Use --force to reclassify.`);
      return {
        success: true,
        skipped: true,
        reason: 'Already classified',
        classification: {
          work_type: ticket.work_type,
          execution_mode: ticket.execution_mode,
          system_tags: ticket.system_tags,
          confidence: ticket.classification_confidence,
          classified_by: ticket.classified_by
        }
      };
    }

    // Skip if no meaningful content
    if (!ticket.title && !ticket.description) {
      console.log('⚠️ Ticket has no title or description - skipping');
      return { success: false, error: 'No content to classify' };
    }

    // Step 2: Run AI classification
    console.log('\n🤖 Running AI classification...');
    let classification = await runAIClassification(tenantCode, ticket);

    // Step 3: Apply guardrails
    console.log('\n🛡️ Applying guardrails...');
    classification = applyGuardrails(classification, ticket.title, ticket.description);

    console.log(`   Work Type: ${classification.work_type}`);
    console.log(`   Execution Mode: ${classification.execution_mode}`);
    console.log(`   Confidence: ${(classification.confidence * 100).toFixed(1)}%`);
    console.log(`   Tags: ${(classification.system_tags || []).join(', ') || 'None'}`);
    console.log(`   Reason: ${classification.reason}`);

    // Step 4: Store classification
    if (!dryRun) {
      console.log('\n💾 Saving classification...');
      await connection.query(`
        UPDATE tickets SET
          work_type = ?,
          execution_mode = ?,
          system_tags = ?,
          classification_confidence = ?,
          classification_reason = ?,
          classified_by = 'ai',
          classified_at = NOW()
        WHERE id = ?
      `, [
        classification.work_type,
        classification.execution_mode,
        JSON.stringify(classification.system_tags || []),
        classification.confidence,
        classification.reason,
        ticketId
      ]);

      // Log activity
      await connection.query(`
        INSERT INTO ticket_activity (ticket_id, user_id, activity_type, description)
        VALUES (?, NULL, 'classified', ?)
      `, [
        ticketId,
        `AI classified as ${classification.work_type}/${classification.execution_mode} (${(classification.confidence * 100).toFixed(0)}% confidence)`
      ]);
    }

    const processingTime = Date.now() - startTime;
    console.log(`\n✅ Classification completed in ${processingTime}ms`);

    return {
      success: true,
      ticketId,
      classification,
      processingTime
    };

  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    return { success: false, error: error.message };
  } finally {
    connection.release();
  }
}

/**
 * Run AI classification using the AI Analysis Service
 */
async function runAIClassification(tenantCode, ticket) {
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.AI_API_KEY;

  // If no API key, fall back to pattern matching
  if (!apiKey || apiKey === 'your_anthropic_api_key_here' || !apiKey.startsWith('sk-')) {
    console.log('   ⚠️ No valid Anthropic API key - falling back to pattern matching');
    return classifyWithPatterns(ticket.title, ticket.description);
  }

  try {
    const aiService = new AIAnalysisService(tenantCode, {
      apiKey,
      aiProvider: 'anthropic',
      task: 'ticket_work_classify'
    });

    const emailData = {
      subject: ticket.title,
      body: ticket.description || '',
      customerName: ticket.requester_name,
      companyName: ticket.company_name,
      currentStatus: ticket.status,
      currentPriority: ticket.priority
    };

    const result = await aiService.analyze(emailData, { task: 'ticket_work_classify' });

    // Validate and normalize the result
    return {
      work_type: VALID_WORK_TYPES.includes(result.work_type) ? result.work_type : 'unknown',
      execution_mode: VALID_EXECUTION_MODES.includes(result.execution_mode) ? result.execution_mode : 'mixed',
      system_tags: Array.isArray(result.system_tags) ? result.system_tags.slice(0, 5) : [],
      confidence: typeof result.confidence === 'number' ? Math.min(Math.max(result.confidence, 0), 1) : 0.5,
      reason: result.reason || 'AI classification'
    };

  } catch (error) {
    console.log(`   ⚠️ AI classification failed: ${error.message}`);
    console.log('   Falling back to pattern matching...');
    return classifyWithPatterns(ticket.title, ticket.description);
  }
}

/**
 * Pattern-based classification fallback
 * @param {string} title - Ticket title
 * @param {string} description - Ticket description
 * @returns {object} Classification result
 */
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
  if (/(compliance|audit|regulation|gdpr|hipaa|pci)/i.test(text)) {
    system_tags.push('compliance');
  }
  if (/(backup|restore|recovery|disaster)/i.test(text)) {
    system_tags.push('backup');
  }
  if (/(performance|slow|latency|timeout|response time)/i.test(text)) {
    system_tags.push('performance');
  }

  return {
    work_type,
    execution_mode,
    system_tags: [...new Set(system_tags)].slice(0, 3),
    confidence,
    reason: reasons.length > 0 ? reasons.join('; ') : 'Pattern-based classification'
  };
}

/**
 * Apply guardrails to classification results
 * @param {object} classification - Raw classification from AI or patterns
 * @param {string} title - Ticket title
 * @param {string} description - Ticket description
 * @returns {object} Classification with guardrails applied
 */
function applyGuardrails(classification, title, description) {
  const text = `${title || ''} ${description || ''}`;
  const result = { ...classification };

  // Guardrail 1: Dangerous actions require expert_required
  if (result.work_type === 'operational_action' && DANGEROUS_KEYWORDS_REGEX.test(text)) {
    console.log('   ⚠️ Guardrail: Dangerous keywords detected, forcing expert_required');
    result.execution_mode = 'expert_required';
    result.reason = `${result.reason}; Guardrail: dangerous action detected`;

    // Add relevant tag if not present
    if (!result.system_tags.includes('security')) {
      result.system_tags = [...result.system_tags, 'security'].slice(0, 5);
    }
  }

  // Guardrail 2: Low confidence sets to unknown/mixed
  if (result.confidence < MIN_CONFIDENCE_THRESHOLD) {
    console.log('   ⚠️ Guardrail: Low confidence, setting to unknown/mixed');
    result.work_type = 'unknown';
    result.execution_mode = 'mixed';
    result.reason = `${result.reason}; Guardrail: low confidence (${(result.confidence * 100).toFixed(0)}%)`;
  }

  // Guardrail 3: Security-related incidents should escalate
  if (result.work_type === 'incident' &&
      /(security breach|unauthorized access|data leak|hack|malware|ransomware|phishing)/i.test(text)) {
    console.log('   ⚠️ Guardrail: Security incident detected, forcing escalation_required');
    result.execution_mode = 'escalation_required';
    result.reason = `${result.reason}; Guardrail: security incident`;
    if (!result.system_tags.includes('security')) {
      result.system_tags = ['security', ...result.system_tags].slice(0, 5);
    }
  }

  // Guardrail 4: VIP/executive mentions should be flagged
  if (/(ceo|cfo|cto|cio|executive|vip|board|director|c-level)/i.test(text)) {
    console.log('   ⚠️ Guardrail: VIP/executive mentioned, adding vip tag');
    if (!result.system_tags.includes('vip')) {
      result.system_tags = ['vip', ...result.system_tags].slice(0, 5);
    }
    // VIP issues should at least be human_review
    if (result.execution_mode === 'automated') {
      result.execution_mode = 'human_review';
    }
  }

  return result;
}

/**
 * Classify text directly (without ticket ID)
 * Useful for preview/testing
 * @param {string} tenantCode - Tenant code for AI service config
 * @param {string} subject - Ticket subject/title
 * @param {string} body - Ticket body/description
 * @returns {object} Classification result
 */
async function classifyText(tenantCode, subject, body) {
  const mockTicket = {
    title: subject,
    description: body,
    requester_name: 'Unknown',
    company_name: 'Unknown',
    status: 'Open',
    priority: 'medium'
  };

  let classification = await runAIClassification(tenantCode, mockTicket);
  classification = applyGuardrails(classification, subject, body);

  return classification;
}

/**
 * Trigger classification for a ticket (fire-and-forget)
 * Used as a hook from ticket creation routes
 * @param {string} tenantCode - Tenant code
 * @param {number} ticketId - Ticket ID
 */
function triggerClassification(tenantCode, ticketId) {
  // Fire and forget - don't await
  setImmediate(async () => {
    try {
      await classifyTicket(tenantCode, ticketId);
    } catch (error) {
      console.error(`Classification background task failed for ticket ${ticketId}:`, error.message);
    }
  });
}

/**
 * Update classification manually (human override)
 * @param {string} tenantCode - Tenant code
 * @param {number} ticketId - Ticket ID
 * @param {object} classification - New classification values
 * @param {number} userId - User ID making the change
 * @returns {object} Result
 */
async function updateClassification(tenantCode, ticketId, classification, userId) {
  const connection = await getTenantConnection(tenantCode);

  try {
    // Validate inputs
    if (classification.work_type && !VALID_WORK_TYPES.includes(classification.work_type)) {
      return { success: false, error: `Invalid work_type: ${classification.work_type}` };
    }
    if (classification.execution_mode && !VALID_EXECUTION_MODES.includes(classification.execution_mode)) {
      return { success: false, error: `Invalid execution_mode: ${classification.execution_mode}` };
    }

    // Build update query
    const updates = [];
    const values = [];

    if (classification.work_type) {
      updates.push('work_type = ?');
      values.push(classification.work_type);
    }
    if (classification.execution_mode) {
      updates.push('execution_mode = ?');
      values.push(classification.execution_mode);
    }
    if (classification.system_tags !== undefined) {
      updates.push('system_tags = ?');
      values.push(JSON.stringify(classification.system_tags || []));
    }
    if (classification.reason) {
      updates.push('classification_reason = ?');
      values.push(classification.reason);
    }

    // Human override always has confidence = 1.0
    updates.push('classification_confidence = 1.0');
    updates.push("classified_by = 'human'");
    updates.push('classified_at = NOW()');

    values.push(ticketId);

    await connection.query(
      `UPDATE tickets SET ${updates.join(', ')} WHERE id = ?`,
      values
    );

    // Log activity
    await connection.query(`
      INSERT INTO ticket_activity (ticket_id, user_id, activity_type, description)
      VALUES (?, ?, 'classified', ?)
    `, [
      ticketId,
      userId,
      `Manually classified as ${classification.work_type || 'N/A'}/${classification.execution_mode || 'N/A'}`
    ]);

    return { success: true };

  } finally {
    connection.release();
  }
}

// CLI execution
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log('Usage: node scripts/classify-ticket.js <tenant_code> <ticket_id> [--dry-run] [--force]');
    console.log('');
    console.log('Examples:');
    console.log('  node scripts/classify-ticket.js apoyar 123');
    console.log('  node scripts/classify-ticket.js apoyar 123 --dry-run');
    console.log('  node scripts/classify-ticket.js apoyar 123 --force');
    process.exit(1);
  }

  const tenantCode = args[0];
  const ticketId = parseInt(args[1]);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');

  if (isNaN(ticketId)) {
    console.error('Error: ticket_id must be a number');
    process.exit(1);
  }

  classifyTicket(tenantCode, ticketId, { dryRun, forceReclassify: force })
    .then(result => {
      if (result.success) {
        console.log('\n✨ Classification completed successfully');
        process.exit(0);
      } else {
        console.error(`\n❌ Classification failed: ${result.error}`);
        process.exit(1);
      }
    })
    .catch(error => {
      console.error('\n❌ Unexpected error:', error);
      process.exit(1);
    });
}

module.exports = {
  classifyTicket,
  triggerClassification,
  classifyText,
  updateClassification,
  classifyWithPatterns,
  applyGuardrails,
  VALID_WORK_TYPES,
  VALID_EXECUTION_MODES
};
