#!/usr/bin/env node

/**
 * AI-Powered KB Article Auto-Generation Script
 *
 * Automatically generates Knowledge Base articles from resolved tickets using Claude AI.
 * Analyzes ticket context (title, description, conversation, resolution notes, linked CIs)
 * and creates structured Markdown KB articles.
 *
 * Usage:
 *   node scripts/auto-generate-kb-article.js <tenant_code> <ticket_id>
 *   node scripts/auto-generate-kb-article.js apoyar 123
 *
 * Can also be called programmatically:
 *   const { autoGenerateKBArticle } = require('./scripts/auto-generate-kb-article');
 *   await autoGenerateKBArticle('apoyar', 123);
 */

require('dotenv').config();

const { getTenantConnection } = require('../config/database');
const { KnowledgeBaseService } = require('../services/knowledge-base-service');

// Constants
const SIMILARITY_THRESHOLD = 0.85;  // 85% - flag as potential duplicate
const MIN_CONTENT_LENGTH = 100;     // Minimum ticket content to generate article

/**
 * Main auto-generate function
 * @param {string} tenantCode - The tenant code
 * @param {number} ticketId - The resolved ticket ID
 * @param {object} options - Optional settings
 * @returns {object} - Results of the article generation
 */
async function autoGenerateKBArticle(tenantCode, ticketId, options = {}) {
  const startTime = Date.now();
  const {
    dryRun = false,           // If true, don't actually create the article
    forceRegenerate = false,  // If true, regenerate even if article exists
    userId = null             // User ID to attribute the article to (null = system/AI)
  } = options;

  console.log(`\n📚 Auto-Generate KB Article - Ticket #${ticketId} (Tenant: ${tenantCode})`);
  console.log('='.repeat(60));

  const connection = await getTenantConnection(tenantCode);

  try {
    // Step 1: Fetch the complete ticket context
    console.log('\n📋 Fetching ticket data...');
    const ticketData = await fetchTicketContext(connection, ticketId);

    if (!ticketData) {
      console.log('❌ Ticket not found');
      return { success: false, error: 'Ticket not found' };
    }

    // Validate ticket state
    if (ticketData.status !== 'Resolved' && ticketData.status !== 'Closed') {
      console.log(`⚠️ Ticket is not resolved (status: ${ticketData.status})`);
      return { success: false, error: 'Ticket is not resolved' };
    }

    // Check if article already exists for this ticket
    if (!forceRegenerate) {
      const [existingArticles] = await connection.query(
        'SELECT id, article_id FROM kb_articles WHERE source_ticket_id = ?',
        [ticketId]
      );
      if (existingArticles.length > 0) {
        console.log(`⚠️ KB article already exists for this ticket (${existingArticles[0].article_id})`);
        return {
          success: true,
          skipped: true,
          reason: 'Article already exists',
          article_id: existingArticles[0].article_id
        };
      }
    }

    // Check content length
    const contentLength = (ticketData.title || '').length +
                          (ticketData.description || '').length +
                          (ticketData.resolution_comment || '').length;
    if (contentLength < MIN_CONTENT_LENGTH) {
      console.log(`⚠️ Insufficient content to generate article (${contentLength} chars)`);
      return { success: false, error: 'Insufficient content' };
    }

    console.log(`   Title: ${ticketData.title}`);
    console.log(`   Status: ${ticketData.status}`);
    console.log(`   Category: ${ticketData.category || 'General'}`);
    console.log(`   Resolution: ${(ticketData.resolution_comment || '').substring(0, 50)}...`);
    console.log(`   Messages: ${ticketData.messages?.length || 0}`);
    console.log(`   Linked CIs: ${ticketData.linkedCIs?.length || 0}`);

    // Step 2: Generate article with Claude AI
    console.log('\n🤖 Generating article with Claude AI...');
    const generatedContent = await generateWithClaude(ticketData);

    if (!generatedContent || !generatedContent.title || !generatedContent.content) {
      console.log('❌ Failed to generate article content');
      return { success: false, error: 'AI generation failed' };
    }

    console.log(`   Generated title: ${generatedContent.title}`);
    console.log(`   Confidence: ${generatedContent.confidence}`);
    console.log(`   Tags: ${generatedContent.tags?.join(', ') || 'none'}`);

    // Step 3: Check for similar existing articles
    console.log('\n🔍 Checking for similar articles...');
    const kbService = new KnowledgeBaseService(tenantCode);
    const similarArticles = await kbService.searchArticles(
      generatedContent.title + ' ' + generatedContent.content.substring(0, 500),
      { limit: 5, status: null, minScore: 0.6 }
    );

    let hasSimilar = false;
    let similarityInfo = null;

    if (similarArticles.length > 0) {
      const topMatch = similarArticles[0];
      console.log(`   Top match: "${topMatch.title}" (${Math.round(topMatch.score * 100)}% similar)`);

      if (topMatch.score >= SIMILARITY_THRESHOLD) {
        hasSimilar = true;
        similarityInfo = {
          article_id: topMatch.id,
          title: topMatch.title,
          score: topMatch.score
        };
        console.log(`   ⚠️ High similarity detected - flagging as potential duplicate`);
      }
    } else {
      console.log('   No similar articles found');
    }

    if (dryRun) {
      console.log('\n🔶 DRY RUN - Would create article:');
      console.log(JSON.stringify(generatedContent, null, 2));
      return {
        success: true,
        dryRun: true,
        generatedContent,
        hasSimilar,
        similarityInfo
      };
    }

    // Step 4: Create the KB article
    console.log('\n💾 Creating KB article...');
    const articleResult = await kbService.createArticle({
      title: generatedContent.title,
      content: generatedContent.content,
      summary: generatedContent.summary,
      category: mapTicketCategoryToKB(ticketData.category),
      tags: generatedContent.tags,
      status: hasSimilar ? 'draft' : 'draft', // Always create as draft for review
      visibility: 'internal',
      source_type: 'ai_generated',
      source_ticket_id: ticketId
    }, userId);

    console.log(`   Created article: ${articleResult.article_id} (ID: ${articleResult.id})`);

    // Step 5: Link article to ticket
    await connection.query(`
      INSERT INTO ticket_kb_articles (ticket_id, article_id, relevance_score, link_type, suggested_by, created_by)
      VALUES (?, ?, 1.0, 'created_from', 'auto', ?)
      ON DUPLICATE KEY UPDATE link_type = 'created_from', suggested_by = 'auto'
    `, [ticketId, articleResult.id, userId]);

    // Step 6: If high similarity, create a merge suggestion
    if (hasSimilar && similarityInfo) {
      const id1 = Math.min(articleResult.id, similarityInfo.article_id);
      const id2 = Math.max(articleResult.id, similarityInfo.article_id);

      await connection.query(`
        INSERT IGNORE INTO kb_article_similarities (article_id_1, article_id_2, similarity_score, similarity_type, status)
        VALUES (?, ?, ?, 'combined', 'pending')
      `, [id1, id2, similarityInfo.score]);

      console.log(`   📎 Created merge suggestion with article #${similarityInfo.article_id}`);
    }

    // Step 7: Add activity note to ticket
    await connection.query(`
      INSERT INTO ticket_activity (ticket_id, user_id, activity_type, description)
      VALUES (?, ?, 'comment', ?)
    `, [
      ticketId,
      userId,
      `🤖 AI-generated KB draft created: Article ${articleResult.article_id}${hasSimilar ? ' (potential duplicate detected)' : ''}`
    ]);

    const elapsedTime = Date.now() - startTime;
    console.log(`\n✅ Article generated successfully in ${elapsedTime}ms`);

    return {
      success: true,
      article_id: articleResult.article_id,
      article_db_id: articleResult.id,
      confidence: generatedContent.confidence,
      hasSimilar,
      similarityInfo,
      elapsedTime
    };

  } finally {
    connection.release();
  }
}

/**
 * Fetch complete ticket context including messages and linked CIs
 */
async function fetchTicketContext(connection, ticketId) {
  // Get ticket details
  const [tickets] = await connection.query(`
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

  // Get ticket activity/messages
  const [activities] = await connection.query(`
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

  // Get linked CMDB items
  const [cmdbItems] = await connection.query(`
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

  // Get linked configuration items
  const [configItems] = await connection.query(`
    SELECT
      cfg.ci_name,
      cfg.category_field_value,
      ci.asset_name as parent_asset
    FROM ticket_configuration_items tcfg
    JOIN configuration_items cfg ON tcfg.ci_id = cfg.id
    LEFT JOIN cmdb_items ci ON cfg.cmdb_item_id = ci.id
    WHERE tcfg.ticket_id = ?
  `, [ticketId]);

  // Format messages for context
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

    // Build comprehensive context
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

    const userPrompt = `Create a KB article from this resolved support ticket:

${ticketContext}

Remember: Output ONLY valid JSON, no explanations or markdown code blocks.`;

    const response = await anthropic.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: userPrompt
      }]
    });

    const responseText = response.content[0].text.trim();

    // Parse the JSON response
    try {
      // Try to extract JSON if wrapped in code blocks
      let jsonStr = responseText;
      const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
      }

      const result = JSON.parse(jsonStr);

      // Validate required fields
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

  // Add conversation history
  if (ticketData.messages && ticketData.messages.length > 0) {
    context += `\nCONVERSATION HISTORY (${ticketData.messages.length} messages):\n`;
    // Include last 10 messages for context
    const recentMessages = ticketData.messages.slice(-10);
    context += recentMessages.join('\n---\n');
  }

  // Add linked CMDB context
  if (ticketData.linkedCMDB && ticketData.linkedCMDB.length > 0) {
    context += `\nAFFECTED INFRASTRUCTURE:\n`;
    ticketData.linkedCMDB.forEach(item => {
      context += `- ${item.asset_name} (${item.asset_category || 'General'})`;
      if (item.brand_name) context += ` - ${item.brand_name}`;
      if (item.model_name) context += ` ${item.model_name}`;
      context += `\n`;
    });
  }

  // Add configuration items
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

  // Extract basic tags from content
  const tags = extractTags(ticketData);

  return {
    title: `How to resolve: ${title}`,
    summary: `Resolution guide for ${category.toLowerCase()} issues related to ${title.substring(0, 50)}`,
    content,
    tags,
    confidence: 'Low'
  };
}

/**
 * Sanitize title - remove PII and ticket references
 */
function sanitizeTitle(title) {
  if (!title) return 'Untitled Issue';

  return title
    .replace(/ticket\s*#?\d+/gi, '')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, '[phone]')
    .trim() || 'Untitled Issue';
}

/**
 * Sanitize content - remove PII
 */
function sanitizeContent(content) {
  if (!content) return '';

  return content
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, '[phone]')
    .replace(/ticket\s*#?\d+/gi, 'the ticket')
    .trim();
}

/**
 * Extract tags from ticket data
 */
function extractTags(ticketData) {
  const tags = new Set();

  // Add category as tag
  if (ticketData.category) {
    tags.add(ticketData.category.toLowerCase());
  }

  // Add priority as tag for critical/high
  if (ticketData.priority === 'critical' || ticketData.priority === 'high') {
    tags.add(ticketData.priority);
  }

  // Extract keywords from title
  const keywords = (ticketData.title || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 3 && !['the', 'and', 'for', 'with', 'from', 'this', 'that'].includes(w));

  keywords.slice(0, 3).forEach(k => tags.add(k));

  // Add infrastructure tags
  if (ticketData.linkedCMDB?.length > 0) {
    ticketData.linkedCMDB.forEach(item => {
      if (item.asset_category) tags.add(item.asset_category.toLowerCase());
    });
  }

  return Array.from(tags).slice(0, 8);
}

/**
 * Map ticket category to KB category
 */
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
