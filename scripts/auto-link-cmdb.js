#!/usr/bin/env node

/**
 * AI-Powered CMDB Auto-Linking Script
 *
 * Analyzes ticket content using Claude AI and automatically links relevant
 * CMDB items and Configuration Items to tickets.
 *
 * Usage:
 *   node scripts/auto-link-cmdb.js <tenant_code> <ticket_id>
 *   node scripts/auto-link-cmdb.js apoyar 123
 *
 * Can also be called programmatically:
 *   const { autoLinkCMDB } = require('./scripts/auto-link-cmdb');
 *   await autoLinkCMDB('apoyar', 123);
 */

require('dotenv').config();

const { getTenantConnection } = require('../config/database');

// Constants
const MIN_CONFIDENCE_FOR_SUGGESTION = 0.6;  // 60% - store as ai_suggested
const MIN_CONFIDENCE_FOR_AUTO_LINK = 0.9;   // 90% - auto-apply without review
const AUTO_APPLY_THRESHOLD = 0.95;          // 95% - auto-apply even if manual links exist

/**
 * Main auto-link function
 * @param {string} tenantCode - The tenant code
 * @param {number} ticketId - The ticket ID to analyze
 * @param {object} options - Optional settings
 * @returns {object} - Results of the auto-linking operation
 */
async function autoLinkCMDB(tenantCode, ticketId, options = {}) {
  const startTime = Date.now();
  const {
    dryRun = false,           // If true, don't actually insert links
    forceReanalyze = false,   // If true, re-analyze even if already linked
    userId = null             // User ID to attribute the links to (null = system)
  } = options;

  console.log(`\n🔗 Auto-Link CMDB - Ticket #${ticketId} (Tenant: ${tenantCode})`);
  console.log('='.repeat(60));

  const connection = await getTenantConnection(tenantCode);

  try {
    // Step 1: Fetch the ticket with all relevant data
    console.log('\n📋 Fetching ticket data...');
    const ticketData = await fetchTicketData(connection, ticketId);

    if (!ticketData) {
      console.log('❌ Ticket not found');
      return { success: false, error: 'Ticket not found' };
    }

    // Skip if no meaningful content to analyze
    if (!ticketData.description && !ticketData.title) {
      console.log('⚠️ Ticket has no title or description - skipping');
      return { success: false, error: 'No content to analyze' };
    }

    console.log(`   Title: ${ticketData.title}`);
    console.log(`   Customer: ${ticketData.requester_name || 'Unknown'}`);
    console.log(`   Company: ${ticketData.company_name || 'Unknown'}`);
    console.log(`   Status: ${ticketData.status}`);

    // Step 2: Get existing manual links for context
    console.log('\n📎 Checking existing links...');
    const existingLinks = await getExistingLinks(connection, ticketId);
    console.log(`   Manual CMDB links: ${existingLinks.manualCMDB.length}`);
    console.log(`   Manual CI links: ${existingLinks.manualCI.length}`);
    console.log(`   AI-suggested links: ${existingLinks.aiSuggested.length}`);

    if (!forceReanalyze && existingLinks.aiSuggested.length > 0) {
      console.log('⚠️ AI suggestions already exist. Use --force to re-analyze.');
      return {
        success: true,
        skipped: true,
        reason: 'Already analyzed',
        existingLinks
      };
    }

    // Step 3: Fetch top CMDB items
    console.log('\n🗄️ Fetching CMDB items...');
    const cmdbItems = await fetchRelevantCMDBItems(connection, ticketData);
    console.log(`   Found ${cmdbItems.length} relevant CMDB items`);

    if (cmdbItems.length === 0) {
      console.log('⚠️ No CMDB items in database - skipping');
      return { success: false, error: 'No CMDB items available' };
    }

    // Step 4: Call Claude AI for matching
    console.log('\n🤖 Analyzing with Claude AI...');
    const aiMatches = await analyzeWithClaude(ticketData, cmdbItems, existingLinks);

    if (!aiMatches || aiMatches.length === 0) {
      console.log('   No relevant matches found by AI');
      return { success: true, matches: [], linkedCount: 0 };
    }

    console.log(`   AI found ${aiMatches.length} potential matches`);

    // Step 5: Process and store the matches
    console.log('\n💾 Processing matches...');
    const results = await processMatches(
      connection,
      ticketId,
      aiMatches,
      existingLinks,
      { dryRun, userId }
    );

    const processingTime = Date.now() - startTime;
    console.log(`\n✅ Completed in ${processingTime}ms`);
    console.log(`   Auto-linked: ${results.autoLinked}`);
    console.log(`   AI-suggested: ${results.aiSuggested}`);
    console.log(`   Skipped (conflicts): ${results.skipped}`);

    // Log the analysis
    if (!dryRun) {
      await logAnalysis(connection, ticketId, aiMatches, processingTime);
    }

    return {
      success: true,
      ticketId,
      matches: aiMatches,
      results,
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
 * Fetch complete ticket data including messages and resolution
 */
async function fetchTicketData(connection, ticketId) {
  const [tickets] = await connection.query(`
    SELECT
      t.*,
      u.full_name as requester_name,
      u.email as requester_email,
      c.company_name,
      cc.company_name as customer_company_name,
      assignee.full_name as assignee_name
    FROM tickets t
    LEFT JOIN users u ON t.requester_id = u.id
    LEFT JOIN customers c ON u.id = c.user_id
    LEFT JOIN customer_companies cc ON c.customer_company_id = cc.id
    LEFT JOIN users assignee ON t.assignee_id = assignee.id
    WHERE t.id = ?
  `, [ticketId]);

  if (tickets.length === 0) {
    return null;
  }

  const ticket = tickets[0];

  // Fetch conversation/activity messages
  const [activities] = await connection.query(`
    SELECT activity_type, description, created_at
    FROM ticket_activity
    WHERE ticket_id = ? AND activity_type IN ('comment', 'message', 'note', 'reply')
    ORDER BY created_at ASC
  `, [ticketId]);

  ticket.messages = activities.map(a => a.description).filter(Boolean);
  ticket.company_name = ticket.company_name || ticket.customer_company_name;

  return ticket;
}

/**
 * Get existing links for the ticket
 */
async function getExistingLinks(connection, ticketId) {
  // Get CMDB item links
  const [cmdbLinks] = await connection.query(`
    SELECT tcm.*, ci.asset_name, ci.asset_category
    FROM ticket_cmdb_items tcm
    JOIN cmdb_items ci ON tcm.cmdb_item_id = ci.id
    WHERE tcm.ticket_id = ?
  `, [ticketId]);

  // Get CI links
  const [ciLinks] = await connection.query(`
    SELECT tci.*, cfg.ci_name, cfg.category_field_value
    FROM ticket_configuration_items tci
    JOIN configuration_items cfg ON tci.ci_id = cfg.id
    WHERE tci.ticket_id = ?
  `, [ticketId]);

  return {
    manualCMDB: cmdbLinks.filter(l => l.matched_by === 'manual'),
    manualCI: ciLinks.filter(l => l.matched_by === 'manual'),
    aiSuggested: [
      ...cmdbLinks.filter(l => l.matched_by === 'ai' || l.matched_by === 'auto'),
      ...ciLinks.filter(l => l.matched_by === 'ai' || l.matched_by === 'auto')
    ],
    allCMDB: cmdbLinks,
    allCI: ciLinks
  };
}

/**
 * Fetch relevant CMDB items for the ticket context
 */
async function fetchRelevantCMDBItems(connection, ticketData) {
  // Build a smart query that prioritizes items matching customer/keywords
  const customerName = ticketData.company_name || '';
  const searchTerms = extractKeyTerms(ticketData.title + ' ' + (ticketData.description || ''));

  // Build keyword search conditions
  const keywordConditions = searchTerms.slice(0, 10).map(term =>
    `(ci.asset_name LIKE '%${term}%' OR ci.asset_category LIKE '%${term}%' OR ci.brand_name LIKE '%${term}%' OR ci.comment LIKE '%${term}%')`
  ).join(' OR ');

  // Get all active CMDB items (up to 100) with priority scoring
  const query = `
    SELECT
      ci.id,
      ci.cmdb_id,
      ci.asset_name,
      ci.asset_category,
      ci.brand_name,
      ci.model_name,
      ci.customer_name,
      ci.employee_of,
      ci.asset_location,
      ci.comment,
      ci.status,
      (SELECT COUNT(*) FROM configuration_items WHERE cmdb_item_id = ci.id) as ci_count,
      (SELECT GROUP_CONCAT(CONCAT(cfg.ci_name, ': ', COALESCE(cfg.category_field_value, '')) SEPARATOR '; ')
       FROM configuration_items cfg WHERE cfg.cmdb_item_id = ci.id LIMIT 5) as sample_cis,
      CASE
        WHEN ci.customer_name LIKE ? THEN 100
        ${keywordConditions ? `WHEN ${keywordConditions} THEN 50` : ''}
        ELSE 0
      END as relevance_score
    FROM cmdb_items ci
    WHERE ci.status = 'active'
    ORDER BY relevance_score DESC, ci.created_at DESC
    LIMIT 100
  `;

  const [items] = await connection.query(query, [`%${customerName}%`]);
  console.log(`   Found ${items.length} CMDB items to analyze`);

  return items;
}

/**
 * Extract key terms from text for matching
 */
function extractKeyTerms(text) {
  if (!text) return [];

  // Remove common words and extract significant terms
  const stopWords = ['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
                     'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
                     'would', 'could', 'should', 'may', 'might', 'can', 'to',
                     'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'or',
                     'and', 'not', 'this', 'that', 'these', 'those', 'it', 'its'];

  const words = text.toLowerCase()
    .replace(/[^a-z0-9\s.-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.includes(w));

  return [...new Set(words)];
}

/**
 * Analyze ticket with Claude AI to find CMDB matches
 */
async function analyzeWithClaude(ticketData, cmdbItems, existingLinks) {
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.AI_API_KEY;

  if (!apiKey || apiKey === 'your_anthropic_api_key_here' || !apiKey.startsWith('sk-')) {
    console.log('   ⚠️ No valid Anthropic API key - falling back to pattern matching');
    return analyzeWithPatterns(ticketData, cmdbItems);
  }

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey });

    // Build context about ticket
    const ticketContext = `
TICKET #${ticketData.id}
Title: ${ticketData.title}
Description: ${ticketData.description || 'No description provided'}
Category: ${ticketData.category || 'General'}
Priority: ${ticketData.priority}
Customer: ${ticketData.requester_name || 'Unknown'}
Company: ${ticketData.company_name || 'Unknown'}
${ticketData.resolution_comment ? `Resolution: ${ticketData.resolution_comment}` : ''}
${ticketData.messages && ticketData.messages.length > 0 ? `\nConversation:\n${ticketData.messages.slice(0, 5).join('\n---\n')}` : ''}
`;

    // Build CMDB context
    const cmdbContext = cmdbItems.map(item =>
      `ID:${item.id} | Name: ${item.asset_name} | Category: ${item.asset_category || 'N/A'} | ` +
      `Customer: ${item.customer_name || 'N/A'} | Location: ${item.asset_location || 'N/A'} | ` +
      `Details: ${item.comment || 'N/A'}` +
      (item.sample_cis ? ` | CIs: ${item.sample_cis}` : '')
    ).join('\n');

    // Build existing links context
    const existingContext = existingLinks.manualCMDB.length > 0
      ? `\nEXISTING MANUAL LINKS (respect these as primary):\n${existingLinks.manualCMDB.map(l =>
          `- ${l.asset_name} (${l.relationship_type})`).join('\n')}`
      : '';

    const systemPrompt = `You are an expert IT infrastructure analyst. Your job is to match support tickets to Configuration Management Database (CMDB) items.

Analyze the ticket and identify which CMDB items (servers, services, applications, network devices) are:
1. AFFECTED by the issue described
2. CAUSED_BY - the root cause of the issue
3. RELATED - peripherally related but worth noting

Consider:
- Customer/company name matches
- Asset names mentioned in ticket
- Technical keywords (servers, databases, IP addresses, service names)
- Category alignment (e.g., "database error" → database servers)
- Location references

Respond with ONLY valid JSON (no markdown, no explanation):
[
  {
    "ci_id": <number - the CMDB item ID>,
    "link_type": "affected" | "caused_by" | "related",
    "confidence": <number 0.0-1.0>,
    "reason": "<brief explanation>"
  }
]

Rules:
- Only include matches with confidence >= ${MIN_CONFIDENCE_FOR_SUGGESTION}
- Maximum 5 matches per ticket
- Order by confidence descending
- If no relevant matches, return empty array []`;

    const response = await anthropic.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: `Match this support ticket to relevant CMDB items:

${ticketContext}

AVAILABLE CMDB ITEMS:
${cmdbContext}
${existingContext}

Respond with JSON array only.`
      }]
    });

    const responseText = response.content[0].text.trim();

    // Parse JSON response
    let jsonText = responseText;
    if (responseText.includes('```')) {
      jsonText = responseText.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    }

    const matches = JSON.parse(jsonText);

    // Validate and enrich matches with CMDB item details
    return matches
      .filter(m => m.ci_id && m.confidence >= MIN_CONFIDENCE_FOR_SUGGESTION)
      .map(match => {
        const cmdbItem = cmdbItems.find(i => i.id === match.ci_id);
        if (!cmdbItem) return null;

        return {
          ci_id: match.ci_id,
          cmdb_item: cmdbItem,
          link_type: match.link_type || 'affected',
          confidence: Math.min(match.confidence, 1.0),
          reason: match.reason || 'AI-matched'
        };
      })
      .filter(Boolean)
      .slice(0, 5);

  } catch (error) {
    console.log(`   ⚠️ Claude API error: ${error.message}`);
    console.log('   Falling back to pattern matching...');
    return analyzeWithPatterns(ticketData, cmdbItems);
  }
}

/**
 * Extract keywords from text (removes common words)
 */
function extractKeywords(text) {
  const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
    'must', 'shall', 'can', 'need', 'dare', 'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with',
    'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'between', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why',
    'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only',
    'own', 'same', 'so', 'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or', 'because', 'until',
    'while', 'this', 'that', 'these', 'those', 'am', 'i', 'you', 'he', 'she', 'it', 'we', 'they',
    'what', 'which', 'who', 'whom', 'its', 'his', 'her', 'their', 'our', 'my', 'your', 'please',
    'hi', 'hello', 'thanks', 'thank', 'regards', 'dear', 'issue', 'problem', 'help', 'need', 'want']);

  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length >= 3 && !stopWords.has(word));
}

/**
 * Fallback pattern-based matching when AI is unavailable
 */
function analyzeWithPatterns(ticketData, cmdbItems) {
  const fullText = `${ticketData.title} ${ticketData.description || ''} ${(ticketData.messages || []).join(' ')}`.toLowerCase();
  const ticketKeywords = extractKeywords(fullText);
  const customerName = (ticketData.company_name || ticketData.requester_name || '').toLowerCase();

  const matches = [];

  for (const item of cmdbItems) {
    let confidence = 0;
    const reasons = [];

    // Build searchable text from CMDB item
    const cmdbSearchText = [
      item.asset_name,
      item.asset_category,
      item.brand_name,
      item.model_name,
      item.comment,
      item.asset_location,
      item.sample_cis
    ].filter(Boolean).join(' ').toLowerCase();

    const cmdbKeywords = extractKeywords(cmdbSearchText);

    // Customer name match (strong signal)
    const itemCustomer = (item.customer_name || '').toLowerCase();
    if (itemCustomer && customerName && (
      itemCustomer.includes(customerName) || customerName.includes(itemCustomer)
    )) {
      confidence += 0.30;
      reasons.push('Customer match');
    }

    // Exact asset name mentioned in ticket
    const assetName = (item.asset_name || '').toLowerCase();
    if (assetName && assetName.length > 3 && fullText.includes(assetName)) {
      confidence += 0.45;
      reasons.push('Asset name in ticket');
    }

    // Keyword matching - check if ticket keywords appear in CMDB item
    const matchedKeywords = [];
    for (const keyword of ticketKeywords) {
      if (keyword.length >= 4) {  // Only match meaningful keywords
        // Check if keyword is in CMDB text
        if (cmdbSearchText.includes(keyword)) {
          matchedKeywords.push(keyword);
        }
        // Also check if CMDB keywords contain ticket keyword (partial match)
        for (const cmdbKeyword of cmdbKeywords) {
          if (cmdbKeyword.includes(keyword) || keyword.includes(cmdbKeyword)) {
            if (!matchedKeywords.includes(keyword) && !matchedKeywords.includes(cmdbKeyword)) {
              matchedKeywords.push(keyword);
            }
          }
        }
      }
    }

    if (matchedKeywords.length > 0) {
      // More matched keywords = higher confidence
      const keywordScore = Math.min(matchedKeywords.length * 0.12, 0.45);
      confidence += keywordScore;
      reasons.push(`Keywords: ${matchedKeywords.slice(0, 3).join(', ')}`);
    }

    // Category keyword matching (expanded)
    const category = (item.asset_category || '').toLowerCase();
    if (category) {
      if ((category.includes('server') || category.includes('web')) &&
          /(server|webserver|web server|host|vm|instance|machine|apache|nginx|iis)/i.test(fullText)) {
        confidence += 0.18;
        reasons.push('Server/Web category match');
      }
      if (category.includes('database') && /(database|mysql|sql|postgres|oracle|db|mongo|redis)/i.test(fullText)) {
        confidence += 0.20;
        reasons.push('Database category match');
      }
      if (category.includes('network') && /(network|vpn|firewall|router|switch|dns|load.?balancer|proxy)/i.test(fullText)) {
        confidence += 0.18;
        reasons.push('Network category match');
      }
      if ((category.includes('application') || category.includes('app')) &&
          /(application|app|service|api|portal|software|system)/i.test(fullText)) {
        confidence += 0.15;
        reasons.push('Application category match');
      }
      if (category.includes('storage') && /(storage|nas|san|disk|backup|archive)/i.test(fullText)) {
        confidence += 0.18;
        reasons.push('Storage category match');
      }
    }

    // Brand/Model name matching
    const brandModel = `${item.brand_name || ''} ${item.model_name || ''}`.toLowerCase();
    if (brandModel.length > 3) {
      for (const keyword of ticketKeywords) {
        if (keyword.length >= 3 && brandModel.includes(keyword)) {
          confidence += 0.15;
          reasons.push('Brand/Model match');
          break;
        }
      }
    }

    // Location match
    const location = (item.asset_location || '').toLowerCase();
    if (location && location.length > 3 && fullText.includes(location)) {
      confidence += 0.12;
      reasons.push('Location match');
    }

    // IP address or hostname in CIs
    if (item.sample_cis) {
      const ciText = item.sample_cis.toLowerCase();
      // Check for IP addresses
      const ipMatch = ciText.match(/(\d+\.\d+\.\d+\.\d+)/);
      if (ipMatch && fullText.includes(ipMatch[1])) {
        confidence += 0.50;
        reasons.push('IP address match');
      }
      // Check for hostnames
      const hostnames = ciText.match(/([a-z][a-z0-9-]+\.[a-z]{2,})/g);
      if (hostnames) {
        for (const hostname of hostnames) {
          if (fullText.includes(hostname)) {
            confidence += 0.40;
            reasons.push('Hostname match');
            break;
          }
        }
      }
    }

    // Lower threshold for suggestions - 50% instead of 60%
    if (confidence >= 0.50) {
      matches.push({
        ci_id: item.id,
        cmdb_item: item,
        link_type: 'affected',
        confidence: Math.min(confidence, 0.95),
        reason: reasons.join('; ')
      });
    }
  }

  // Sort by confidence and take top 5
  return matches
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5);
}

/**
 * Process matches and store in database
 */
async function processMatches(connection, ticketId, matches, existingLinks, options) {
  const { dryRun, userId } = options;
  const results = { autoLinked: 0, aiSuggested: 0, skipped: 0 };

  // Get IDs of existing links to avoid duplicates
  const existingCMDBIds = new Set(existingLinks.allCMDB.map(l => l.cmdb_item_id));

  for (const match of matches) {
    // Skip if already linked
    if (existingCMDBIds.has(match.ci_id)) {
      console.log(`   ⏭️ Skipping ${match.cmdb_item.asset_name} - already linked`);
      results.skipped++;
      continue;
    }

    // Determine link type based on confidence
    let matchedBy;
    if (match.confidence >= AUTO_APPLY_THRESHOLD) {
      matchedBy = 'auto';
      results.autoLinked++;
    } else if (match.confidence >= MIN_CONFIDENCE_FOR_AUTO_LINK && existingLinks.manualCMDB.length === 0) {
      matchedBy = 'auto';
      results.autoLinked++;
    } else {
      matchedBy = 'ai';
      results.aiSuggested++;
    }

    const confidencePercent = Math.round(match.confidence * 100);
    console.log(`   ${matchedBy === 'auto' ? '✅' : '💡'} ${match.cmdb_item.asset_name} (${confidencePercent}% - ${matchedBy})`);
    console.log(`      └─ ${match.reason}`);

    if (!dryRun) {
      try {
        await connection.query(`
          INSERT INTO ticket_cmdb_items
            (ticket_id, cmdb_item_id, relationship_type, confidence_score, matched_by, match_reason, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            confidence_score = VALUES(confidence_score),
            match_reason = VALUES(match_reason),
            matched_by = VALUES(matched_by)
        `, [
          ticketId,
          match.ci_id,
          match.link_type,
          Math.round(match.confidence * 100), // Store as percentage
          matchedBy,
          match.reason,
          userId
        ]);
      } catch (err) {
        console.log(`   ⚠️ Error storing link: ${err.message}`);
      }
    }
  }

  return results;
}

/**
 * Log the analysis attempt
 */
async function logAnalysis(connection, ticketId, matches, processingTime) {
  try {
    await connection.query(`
      INSERT INTO ai_cmdb_match_log
        (ticket_id, matched_cmdb_ids, matched_ci_ids, ai_model, match_criteria, processing_time_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      ticketId,
      JSON.stringify(matches.map(m => m.ci_id)),
      JSON.stringify([]), // CI IDs if we add CI matching later
      'claude-3-haiku-20240307',
      'auto-link-cmdb script',
      processingTime
    ]);
  } catch (err) {
    // Ignore logging errors
    console.log(`   ⚠️ Could not log analysis: ${err.message}`);
  }
}

/**
 * Trigger auto-linking for a ticket (fire-and-forget)
 * Used as a hook from ticket routes
 */
function triggerAutoLink(tenantCode, ticketId, userId = null) {
  // Fire and forget - don't await
  setImmediate(async () => {
    try {
      await autoLinkCMDB(tenantCode, ticketId, { userId });
    } catch (error) {
      console.error(`Auto-link background task failed for ticket ${ticketId}:`, error.message);
    }
  });
}

/**
 * Get pending AI suggestions for review
 */
async function getPendingSuggestions(tenantCode, options = {}) {
  const { limit = 50 } = options;
  const connection = await getTenantConnection(tenantCode);

  try {
    const [suggestions] = await connection.query(`
      SELECT
        tcm.id,
        tcm.ticket_id,
        tcm.cmdb_item_id,
        tcm.relationship_type,
        tcm.confidence_score,
        tcm.match_reason,
        tcm.created_at,
        t.title as ticket_title,
        t.status as ticket_status,
        ci.asset_name,
        ci.asset_category,
        ci.customer_name
      FROM ticket_cmdb_items tcm
      JOIN tickets t ON tcm.ticket_id = t.id
      JOIN cmdb_items ci ON tcm.cmdb_item_id = ci.id
      WHERE tcm.matched_by = 'ai'
      ORDER BY tcm.created_at DESC
      LIMIT ?
    `, [limit]);

    return suggestions;
  } finally {
    connection.release();
  }
}

/**
 * Approve an AI suggestion (convert to manual)
 */
async function approveSuggestion(tenantCode, suggestionId, userId) {
  const connection = await getTenantConnection(tenantCode);

  try {
    await connection.query(`
      UPDATE ticket_cmdb_items
      SET matched_by = 'manual', created_by = ?
      WHERE id = ? AND matched_by = 'ai'
    `, [userId, suggestionId]);

    return { success: true };
  } finally {
    connection.release();
  }
}

/**
 * Reject an AI suggestion (delete it)
 */
async function rejectSuggestion(tenantCode, suggestionId) {
  const connection = await getTenantConnection(tenantCode);

  try {
    await connection.query(`
      DELETE FROM ticket_cmdb_items
      WHERE id = ? AND matched_by = 'ai'
    `, [suggestionId]);

    return { success: true };
  } finally {
    connection.release();
  }
}

// CLI execution
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log('Usage: node scripts/auto-link-cmdb.js <tenant_code> <ticket_id> [--dry-run] [--force]');
    console.log('');
    console.log('Examples:');
    console.log('  node scripts/auto-link-cmdb.js apoyar 123');
    console.log('  node scripts/auto-link-cmdb.js apoyar 123 --dry-run');
    console.log('  node scripts/auto-link-cmdb.js apoyar 123 --force');
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

  autoLinkCMDB(tenantCode, ticketId, { dryRun, forceReanalyze: force })
    .then(result => {
      if (result.success) {
        console.log('\n✨ Auto-linking completed successfully');
        process.exit(0);
      } else {
        console.error(`\n❌ Auto-linking failed: ${result.error}`);
        process.exit(1);
      }
    })
    .catch(error => {
      console.error('\n❌ Unexpected error:', error);
      process.exit(1);
    });
}

module.exports = {
  autoLinkCMDB,
  triggerAutoLink,
  getPendingSuggestions,
  approveSuggestion,
  rejectSuggestion
};
