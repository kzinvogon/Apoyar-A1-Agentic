#!/usr/bin/env node

/**
 * AI-Powered KB Article Auto-Generation Script
 *
 * Generates Knowledge Base articles from resolved tickets using Claude AI.
 *
 * ARCHITECTURE (pool-safe, 3-phase):
 *   Phase 1 — DB reads + validation (pool.query, no held connection)
 *   Phase 2 — External API calls (Claude + embeddings, NO DB at all)
 *   Phase 3 — DB writes in a short transaction (withTenantConnection)
 *
 * ZERO code paths hold a MySQL connection across Claude/embedding API calls.
 *
 * Usage:
 *   node scripts/auto-generate-kb-article.js <tenant_code> <ticket_id>
 *
 * Programmatic:
 *   const { autoGenerateKBArticle } = require('./scripts/auto-generate-kb-article');
 *   await autoGenerateKBArticle('apoyar', 123);
 */

require('dotenv').config();

const { getTenantPool, withTenantConnection } = require('../config/database');
const { EmbeddingService } = require('../services/embedding-service');
const { logTicketActivity } = require('../services/activityLogger');

// Constants
const SIMILARITY_THRESHOLD = 0.85;
const MIN_CONTENT_LENGTH = 100;

// Routine ticket patterns that should NOT generate KB articles
const SUPPRESSED_TITLE_PATTERNS = [
  /backup\s+(success|successful|completed|status)/i,
  /scheduled\s+task\s+(completed|success)/i,
  /^(RE|FW|Fwd):\s+/i,
];

/**
 * Main auto-generate function (3-phase, pool-safe)
 */
async function autoGenerateKBArticle(tenantCode, ticketId, options = {}) {
  const startTime = Date.now();
  const {
    dryRun = false,
    forceRegenerate = false,
    userId = null
  } = options;

  console.log(`\n📚 Auto-Generate KB Article - Ticket #${ticketId} (Tenant: ${tenantCode})`);
  console.log('='.repeat(60));

  // =========================================================================
  // PHASE 1 — DB READS + VALIDATION (pool.query, no held connection)
  // =========================================================================
  const phase1Start = Date.now();
  const pool = await getTenantPool(tenantCode);

  // 1a. Fetch ticket with context
  console.log('\n📋 Fetching ticket data...');
  const ticketData = await fetchTicketContext(pool, ticketId);

  if (!ticketData) {
    console.log('❌ Ticket not found');
    return { success: false, error: 'Ticket not found' };
  }

  // 1b. Validate status
  if (ticketData.status !== 'Resolved' && ticketData.status !== 'Closed') {
    console.log(`⚠️ Ticket is not resolved (status: ${ticketData.status})`);
    return { success: false, error: 'Ticket is not resolved' };
  }

  // 1c. Check existing article
  if (!forceRegenerate) {
    const [existingArticles] = await pool.query(
      'SELECT id, article_id FROM kb_articles WHERE source_ticket_id = ?',
      [ticketId]
    );
    if (existingArticles.length > 0) {
      console.log(`⚠️ KB article already exists for this ticket (${existingArticles[0].article_id})`);
      return { success: true, skipped: true, reason: 'Article already exists', article_id: existingArticles[0].article_id };
    }
  }

  // 1d. Content length check
  const contentLength = (ticketData.title || '').length +
                        (ticketData.description || '').length +
                        (ticketData.resolution_comment || '').length;
  if (contentLength < MIN_CONTENT_LENGTH) {
    console.log(`⚠️ Insufficient content to generate article (${contentLength} chars)`);
    return { success: false, error: 'Insufficient content' };
  }

  // 1e. Suppress routine notifications
  for (const pattern of SUPPRESSED_TITLE_PATTERNS) {
    if (pattern.test(ticketData.title)) {
      console.log(`⚠️ Suppressed: title matches routine pattern (${pattern})`);
      return { success: true, skipped: true, reason: 'suppressed' };
    }
  }

  console.log(`   Title: ${ticketData.title}`);
  console.log(`   Status: ${ticketData.status}`);
  console.log(`   Category: ${ticketData.category || 'General'}`);
  console.log(`   Resolution: ${(ticketData.resolution_comment || '').substring(0, 50)}...`);
  console.log(`   Messages: ${ticketData.messages?.length || 0}`);
  console.log(`   Linked CIs: ${ticketData.linkedCIs?.length || 0}`);

  // =========================================================================
  // PHASE 2 — EXTERNAL CALLS (NO DB held at all)
  // =========================================================================
  const phase1Ms = Date.now() - phase1Start;
  console.log(`[KB-Timing] phase1_ms=${phase1Ms} (DB reads + validation)`);

  const phase2Start = Date.now();

  // 2a. Generate article with Claude AI
  console.log('\n🤖 Generating article with Claude AI...');
  const generatedContent = await generateWithClaude(ticketData);

  if (!generatedContent || !generatedContent.title || !generatedContent.content) {
    console.log('❌ Failed to generate article content');
    return { success: false, error: 'AI generation failed' };
  }

  console.log(`   Generated title: ${generatedContent.title}`);
  console.log(`   Confidence: ${generatedContent.confidence}`);
  console.log(`   Tags: ${generatedContent.tags?.join(', ') || 'none'}`);

  // 2b. Generate embeddings for new article
  const embeddingService = new EmbeddingService();
  const textToEmbed = `${generatedContent.title}\n\n${generatedContent.summary || ''}\n\n${generatedContent.content}`;
  const chunks = embeddingService.chunkText(textToEmbed);
  const embeddingRows = [];

  for (let i = 0; i < chunks.length; i++) {
    const vector = await embeddingService.generateEmbedding(chunks[i]);
    embeddingRows.push({
      vector,
      hash: embeddingService.generateEmbeddingHash(vector),
      chunkIndex: i,
      chunkText: chunks[i].substring(0, 500),
    });
  }

  // 2c. Similarity check (short DB read via pool.query, then compute in JS)
  console.log('\n🔍 Checking for similar articles...');
  let hasSimilar = false;
  let similarityInfo = null;

  if (embeddingRows.length > 0) {
    const [existingEmbeddings] = await pool.query(`
      SELECT kae.article_id, kae.embedding_vector, ka.title
      FROM kb_article_embeddings kae
      JOIN kb_articles ka ON kae.article_id = ka.id
      WHERE kae.chunk_index = 0 AND ka.status != 'archived'
    `);

    const newMainVec = embeddingRows[0].vector;

    for (const other of existingEmbeddings) {
      const otherVec = typeof other.embedding_vector === 'string'
        ? JSON.parse(other.embedding_vector)
        : other.embedding_vector;
      const score = embeddingService.cosineSimilarity(newMainVec, otherVec);

      if (score >= SIMILARITY_THRESHOLD) {
        hasSimilar = true;
        similarityInfo = { article_id: other.article_id, title: other.title, score };
        console.log(`   ⚠️ High similarity: "${other.title}" (${Math.round(score * 100)}%)`);
        break;
      }

      // Also log the top match even if below threshold
      if (!similarityInfo || score > (similarityInfo.score || 0)) {
        similarityInfo = { article_id: other.article_id, title: other.title, score };
      }
    }

    if (!hasSimilar && similarityInfo) {
      console.log(`   Top match: "${similarityInfo.title}" (${Math.round(similarityInfo.score * 100)}% similar)`);
      similarityInfo = null; // Only keep if above threshold
    } else if (existingEmbeddings.length === 0) {
      console.log('   No existing articles to compare');
    }
  }

  if (dryRun) {
    console.log('\n🔶 DRY RUN - Would create article:');
    console.log(JSON.stringify(generatedContent, null, 2));
    return { success: true, dryRun: true, generatedContent, hasSimilar, similarityInfo };
  }

  // =========================================================================
  // PHASE 3 — DB WRITES (short transaction via withTenantConnection)
  // =========================================================================
  const phase2Ms = Date.now() - phase2Start;
  console.log(`[KB-Timing] phase2_ms=${phase2Ms} (Claude + embeddings, zero DB held)`);

  const phase3Start = Date.now();
  console.log('\n💾 Creating KB article...');

  const articleId = `KB-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const tags = Array.isArray(generatedContent.tags) ? generatedContent.tags : [];
  const category = mapTicketCategoryToKB(ticketData.category);

  const result = await withTenantConnection(tenantCode, async (conn) => {
    await conn.beginTransaction();
    try {
      // Idempotency guard: re-check no article was created since Phase 1
      const [dupeCheck] = await conn.query(
        'SELECT article_id FROM kb_articles WHERE source_ticket_id = ? LIMIT 1',
        [ticketId]
      );
      if (dupeCheck.length > 0) {
        await conn.rollback();
        console.log(`[KB-Timing] phase3_ms=0 (idempotency: article already created by concurrent job)`);
        return { skipped: true, article_id: dupeCheck[0].article_id };
      }

      // INSERT kb_articles
      const [articleResult] = await conn.query(`
        INSERT INTO kb_articles (
          article_id, title, content, summary, category, tags, status, visibility,
          source_type, source_ticket_id, created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, 'draft', 'internal', 'ai_generated', ?, ?, ?)
      `, [
        articleId,
        generatedContent.title,
        generatedContent.content,
        generatedContent.summary || '',
        category,
        JSON.stringify(tags),
        ticketId,
        userId,
        userId
      ]);
      const newId = articleResult.insertId;

      // INSERT kb_article_versions
      await conn.query(`
        INSERT INTO kb_article_versions (article_id, version_number, title, content, summary, change_reason, created_by)
        VALUES (?, 1, ?, ?, ?, 'Initial creation', ?)
      `, [newId, generatedContent.title, generatedContent.content, generatedContent.summary || '', userId]);

      // INSERT embedding vectors
      for (const emb of embeddingRows) {
        await conn.query(`
          INSERT INTO kb_article_embeddings (article_id, embedding_model, embedding_vector, embedding_hash, chunk_index, chunk_text)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [newId, embeddingService.model, JSON.stringify(emb.vector), emb.hash, emb.chunkIndex, emb.chunkText]);
      }

      // INSERT ticket_kb_articles link
      await conn.query(`
        INSERT INTO ticket_kb_articles (ticket_id, article_id, relevance_score, link_type, suggested_by, created_by)
        VALUES (?, ?, 1.0, 'created_from', 'auto', ?)
        ON DUPLICATE KEY UPDATE link_type = 'created_from', suggested_by = 'auto'
      `, [ticketId, newId, userId]);

      // INSERT kb_article_similarities if duplicate
      if (hasSimilar && similarityInfo) {
        const id1 = Math.min(newId, similarityInfo.article_id);
        const id2 = Math.max(newId, similarityInfo.article_id);
        await conn.query(`
          INSERT IGNORE INTO kb_article_similarities (article_id_1, article_id_2, similarity_score, similarity_type, status)
          VALUES (?, ?, ?, 'combined', 'pending')
        `, [id1, id2, similarityInfo.score]);
      }

      // INSERT ticket_activity
      await logTicketActivity(conn, {
        ticketId, userId, activityType: 'comment',
        description: `AI-generated KB draft created: Article ${articleId}${hasSimilar ? ' (potential duplicate detected)' : ''}`,
        source: 'system', eventKey: 'ticket.kb.generated',
        meta: { articleId, hasSimilar }
      });

      // UPDATE category count
      await conn.query(`
        UPDATE kb_categories SET article_count = (
          SELECT COUNT(*) FROM kb_articles WHERE category = ? AND status = 'published'
        ) WHERE name = ?
      `, [category, category]);

      await conn.commit();
      return { id: newId, article_id: articleId };
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  });

  const phase3Ms = Date.now() - phase3Start;

  // Handle idempotency guard hit
  if (result.skipped) {
    console.log(`⚠️ Article already created by concurrent job: ${result.article_id}`);
    return { success: true, skipped: true, reason: 'concurrent duplicate', article_id: result.article_id };
  }

  console.log(`[KB-Timing] phase3_ms=${phase3Ms} (DB transaction)`);
  console.log(`   Created article: ${result.article_id} (ID: ${result.id})`);

  const elapsedTime = Date.now() - startTime;
  console.log(`[KB-Timing] total_ms=${elapsedTime} phase1=${phase1Ms} phase2=${phase2Ms} phase3=${phase3Ms}`);
  console.log(`\n✅ Article generated successfully in ${elapsedTime}ms`);

  return {
    success: true,
    article_id: result.article_id,
    article_db_id: result.id,
    confidence: generatedContent.confidence,
    hasSimilar,
    similarityInfo: hasSimilar ? similarityInfo : null,
    elapsedTime
  };
}

/**
 * Fetch complete ticket context using pool.query (no held connection)
 */
async function fetchTicketContext(pool, ticketId) {
  const [tickets] = await pool.query(`
    SELECT
      t.*,
      u1.full_name as assignee_name,
      u1.email as assignee_email,
      u2.full_name as requester_name,
      u2.email as requester_email,
      cc.company_name as company_name
    FROM tickets t
    LEFT JOIN users u1 ON t.assignee_id = u1.id
    LEFT JOIN users u2 ON t.requester_id = u2.id
    LEFT JOIN customers c ON t.requester_id = c.user_id
    LEFT JOIN customer_companies cc ON c.customer_company_id = cc.id
    WHERE t.id = ?
  `, [ticketId]);

  if (tickets.length === 0) return null;
  const ticket = tickets[0];

  const [activities] = await pool.query(`
    SELECT
      ta.activity_type,
      ta.description,
      ta.created_at,
      u.full_name as user_name,
      u.role as user_role
    FROM ticket_activity ta
    LEFT JOIN users u ON ta.user_id = u.id
    WHERE ta.ticket_id = ?
    ORDER BY ta.created_at ASC
  `, [ticketId]);

  const [cmdbItems] = await pool.query(`
    SELECT
      ci.id,
      ci.asset_name,
      ci.asset_category,
      ci.brand_name,
      ci.model_name,
      ci.customer_name,
      ci.comment,
      tci.relationship_type
    FROM ticket_cmdb_items tci
    JOIN cmdb_items ci ON tci.cmdb_item_id = ci.id
    WHERE tci.ticket_id = ?
  `, [ticketId]);

  const [configItems] = await pool.query(`
    SELECT
      cfg.ci_name,
      cfg.category_field_value,
      ci.asset_name as parent_asset
    FROM ticket_configuration_items tcfg
    JOIN configuration_items cfg ON tcfg.ci_id = cfg.id
    LEFT JOIN cmdb_items ci ON cfg.cmdb_item_id = ci.id
    WHERE tcfg.ticket_id = ?
  `, [ticketId]);

  const messages = activities
    .filter(a => a.activity_type === 'comment' || a.activity_type === 'note' || a.activity_type === 'reply')
    .map(a => `[${a.user_role || 'system'}] ${a.user_name || 'System'}: ${a.description}`);

  return {
    ...ticket,
    messages,
    linkedCMDB: cmdbItems,
    linkedCIs: configItems,
    activities
  };
}

/**
 * Generate KB article content using Claude AI
 */
async function generateWithClaude(ticketData) {
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.AI_API_KEY;

  if (!apiKey || apiKey === 'your_anthropic_api_key_here' || !apiKey.startsWith('sk-')) {
    console.log('   ⚠️ No valid Anthropic API key - using template generation');
    return generateFromTemplate(ticketData);
  }

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey });

    const ticketContext = buildTicketContext(ticketData);

    const systemPrompt = `You are an expert technical writer creating Knowledge Base articles for an IT support team. Your job is to transform resolved support tickets into clear, helpful KB articles that can help solve similar issues in the future.

Guidelines:
1. Write in clear, professional language
2. Focus on the problem and solution, not the specific customer
3. NEVER include: customer names, email addresses, ticket IDs, internal employee names, or any PII
4. Use generic terms like "the user" or "the system" instead of specific names
5. Structure the article with clear sections
6. Include actionable resolution steps
7. Add relevant tags for searchability

Output format - provide ONLY the following JSON structure (no markdown code blocks):
{
  "title": "Clear, descriptive title (not the ticket title)",
  "summary": "One sentence summary of the issue and resolution",
  "content": "Full Markdown content with sections: ## Symptoms, ## Environment, ## Root Cause, ## Resolution Steps, ## Prevention, ## Related Issues",
  "tags": ["tag1", "tag2", "tag3"],
  "confidence": "High" | "Medium" | "Low"
}

Confidence levels:
- High: Clear problem with documented resolution
- Medium: Issue resolved but root cause unclear
- Low: Limited information or unusual edge case`;

    const userPrompt = `Create a KB article from this resolved support ticket:\n\n${ticketContext}\n\nRemember: Output ONLY valid JSON, no explanations or markdown code blocks.`;

    const response = await anthropic.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const responseText = response.content[0].text.trim();

    try {
      let jsonStr = responseText;
      const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
      }

      const result = JSON.parse(jsonStr);
      if (!result.title || !result.content) {
        throw new Error('Missing required fields');
      }

      return {
        title: result.title,
        summary: result.summary || '',
        content: result.content,
        tags: Array.isArray(result.tags) ? result.tags : [],
        confidence: result.confidence || 'Medium'
      };
    } catch (parseError) {
      console.error('   Failed to parse AI response:', parseError.message);
      console.log('   Response was:', responseText.substring(0, 200));
      return generateFromTemplate(ticketData);
    }

  } catch (error) {
    console.error('   Claude API error:', error.message);
    return generateFromTemplate(ticketData);
  }
}

/**
 * Build context string for Claude
 */
function buildTicketContext(ticketData) {
  let context = `TICKET INFORMATION:
Title: ${ticketData.title}
Category: ${ticketData.category || 'General'}
Priority: ${ticketData.priority}
Status: ${ticketData.status}

DESCRIPTION:
${ticketData.description || 'No description provided'}

RESOLUTION:
${ticketData.resolution_comment || 'No resolution notes'}
`;

  if (ticketData.messages && ticketData.messages.length > 0) {
    context += `\nCONVERSATION HISTORY (${ticketData.messages.length} messages):\n`;
    const recentMessages = ticketData.messages.slice(-10);
    context += recentMessages.join('\n---\n');
  }

  if (ticketData.linkedCMDB && ticketData.linkedCMDB.length > 0) {
    context += `\nAFFECTED INFRASTRUCTURE:\n`;
    ticketData.linkedCMDB.forEach(item => {
      context += `- ${item.asset_name} (${item.asset_category || 'General'})`;
      if (item.brand_name) context += ` - ${item.brand_name}`;
      if (item.model_name) context += ` ${item.model_name}`;
      context += `\n`;
    });
  }

  if (ticketData.linkedCIs && ticketData.linkedCIs.length > 0) {
    context += `\nCONFIGURATION ITEMS:\n`;
    ticketData.linkedCIs.forEach(ci => {
      context += `- ${ci.ci_name}: ${ci.category_field_value || 'N/A'}`;
      if (ci.parent_asset) context += ` (on ${ci.parent_asset})`;
      context += `\n`;
    });
  }

  return context;
}

/**
 * Fallback template-based generation when AI is unavailable
 */
function generateFromTemplate(ticketData) {
  const title = sanitizeTitle(ticketData.title);
  const category = ticketData.category || 'General';

  const content = `## Symptoms

${sanitizeContent(ticketData.description) || 'Issue reported by user.'}

## Environment

- Category: ${category}
- Priority: ${ticketData.priority}
${ticketData.linkedCMDB?.length > 0 ? `- Affected Systems: ${ticketData.linkedCMDB.map(c => c.asset_name).join(', ')}` : ''}

## Root Cause

To be determined - please review and update.

## Resolution Steps

${sanitizeContent(ticketData.resolution_comment) || 'Resolution steps not documented.'}

## Prevention

Review this article and add prevention steps if applicable.

## Related Issues

- Original ticket category: ${category}
`;

  const tags = extractTags(ticketData);

  return {
    title: `How to resolve: ${title}`,
    summary: `Resolution guide for ${category.toLowerCase()} issues related to ${title.substring(0, 50)}`,
    content,
    tags,
    confidence: 'Low'
  };
}

function sanitizeTitle(title) {
  if (!title) return 'Untitled Issue';
  return title
    .replace(/ticket\s*#?\d+/gi, '')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, '[phone]')
    .trim() || 'Untitled Issue';
}

function sanitizeContent(content) {
  if (!content) return '';
  return content
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, '[phone]')
    .replace(/ticket\s*#?\d+/gi, 'the ticket')
    .trim();
}

function extractTags(ticketData) {
  const tags = new Set();
  if (ticketData.category) tags.add(ticketData.category.toLowerCase());
  if (ticketData.priority === 'critical' || ticketData.priority === 'high') tags.add(ticketData.priority);

  const keywords = (ticketData.title || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 3 && !['the', 'and', 'for', 'with', 'from', 'this', 'that'].includes(w));
  keywords.slice(0, 3).forEach(k => tags.add(k));

  if (ticketData.linkedCMDB?.length > 0) {
    ticketData.linkedCMDB.forEach(item => {
      if (item.asset_category) tags.add(item.asset_category.toLowerCase());
    });
  }

  return Array.from(tags).slice(0, 8);
}

function mapTicketCategoryToKB(category) {
  const mapping = {
    'General': 'General',
    'Technical': 'Troubleshooting',
    'Bug': 'Troubleshooting',
    'Feature Request': 'How-To Guides',
    'Question': 'FAQs',
    'Account': 'FAQs',
    'Billing': 'FAQs',
    'Network': 'Technical Documentation',
    'Hardware': 'Technical Documentation',
    'Software': 'Troubleshooting'
  };
  return mapping[category] || 'General';
}

// CLI execution
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log('Usage: node scripts/auto-generate-kb-article.js <tenant_code> <ticket_id> [--dry-run]');
    console.log('Example: node scripts/auto-generate-kb-article.js apoyar 123');
    process.exit(1);
  }

  const [tenantCode, ticketId] = args;
  const dryRun = args.includes('--dry-run');

  autoGenerateKBArticle(tenantCode, parseInt(ticketId), { dryRun })
    .then(result => {
      console.log('\n📊 Result:', JSON.stringify(result, null, 2));
      process.exit(result.success ? 0 : 1);
    })
    .catch(error => {
      console.error('\n❌ Fatal error:', error);
      process.exit(1);
    });
}

module.exports = { autoGenerateKBArticle };
