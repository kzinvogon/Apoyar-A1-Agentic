const { getTenantConnection } = require('../config/database');

/**
 * AI Email Analysis Service
 * Analyzes emails and tickets using AI to extract insights, categorize, and detect trends
 */

class AIAnalysisService {
  constructor(tenantCode, options = {}) {
    this.tenantCode = tenantCode;
    this.aiProvider = options.aiProvider || process.env.AI_PROVIDER || 'pattern'; // 'openai', 'anthropic', or 'pattern'
    this.apiKey = options.apiKey || process.env.AI_API_KEY;
    this.model = options.model || this.getDefaultModel();
  }

  getDefaultModel() {
    switch (this.aiProvider) {
      case 'openai':
        return 'gpt-4o-mini';
      case 'anthropic':
        return 'claude-3-haiku-20240307';
      default:
        return 'pattern-matching';
    }
  }

  /**
   * Analyze an email/ticket and store results
   */
  async analyzeTicket(ticketId, emailData) {
    const startTime = Date.now();

    try {
      console.log(`🤖 Analyzing ticket #${ticketId} with ${this.aiProvider}...`);

      let analysis;

      if (this.aiProvider === 'openai' && this.apiKey) {
        analysis = await this.analyzeWithOpenAI(emailData);
      } else if (this.aiProvider === 'anthropic' && this.apiKey) {
        analysis = await this.analyzeWithAnthropic(emailData);
      } else {
        // Fallback to pattern matching
        analysis = await this.analyzeWithPatterns(emailData);
      }

      const processingTime = Date.now() - startTime;

      // Store analysis in database
      const connection = await getTenantConnection(this.tenantCode);
      try {
        await connection.query(`
          INSERT INTO ai_email_analysis (
            ticket_id, sentiment, confidence_score, ai_category, root_cause_type, impact_level,
            key_phrases, technical_terms, suggested_assignee, estimated_resolution_time,
            similar_ticket_ids, analysis_timestamp, ai_model_version, processing_time_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)
        `, [
          ticketId,
          analysis.sentiment,
          analysis.confidence,
          analysis.category,
          analysis.rootCause,
          analysis.impactLevel,
          JSON.stringify(analysis.keyPhrases),
          JSON.stringify(analysis.technicalTerms),
          analysis.suggestedAssignee,
          analysis.estimatedResolutionTime,
          JSON.stringify(analysis.similarTicketIds),
          this.model,
          processingTime
        ]);

        // Mark ticket as analyzed
        await connection.query(`
          UPDATE tickets SET ai_analyzed = TRUE WHERE id = ?
        `, [ticketId]);

        console.log(`✅ Analysis completed for ticket #${ticketId} (${processingTime}ms)`);

      } finally {
        connection.release();
      }

      return analysis;

    } catch (error) {
      console.error(`❌ Error analyzing ticket #${ticketId}:`, error.message);
      throw error;
    }
  }

  /**
   * Analyze with OpenAI
   */
  async analyzeWithOpenAI(emailData) {
    // This would require the OpenAI SDK: npm install openai
    // For now, returning a structured response format
    throw new Error('OpenAI integration requires installing the openai package');

    /* Example implementation:
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: this.apiKey });

    const response = await openai.chat.completions.create({
      model: this.model,
      messages: [{
        role: 'system',
        content: 'You are an IT support ticket analyzer. Analyze emails and extract structured information.'
      }, {
        role: 'user',
        content: `Analyze this support email:\n\nSubject: ${emailData.subject}\n\nBody: ${emailData.body}`
      }],
      response_format: { type: 'json_object' }
    });

    return JSON.parse(response.choices[0].message.content);
    */
  }

  /**
   * Analyze with Anthropic Claude
   */
  async analyzeWithAnthropic(emailData) {
    // This would require the Anthropic SDK: npm install @anthropic-ai/sdk
    // For now, returning a structured response format
    throw new Error('Anthropic integration requires installing the @anthropic-ai/sdk package');

    /* Example implementation:
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: this.apiKey });

    const response = await anthropic.messages.create({
      model: this.model,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `Analyze this IT support email and provide structured JSON...`
      }]
    });

    return JSON.parse(response.content[0].text);
    */
  }

  /**
   * Analyze with pattern matching (fallback, no API needed)
   */
  async analyzeWithPatterns(emailData) {
    const text = `${emailData.subject} ${emailData.body}`.toLowerCase();

    // Sentiment analysis
    const urgentKeywords = ['urgent', 'critical', 'emergency', 'asap', 'down', 'outage', 'failing', 'broken'];
    const positiveKeywords = ['thank', 'resolved', 'working', 'fixed', 'recovery', 'ok'];

    let sentiment = 'neutral';
    let confidence = 70;

    if (urgentKeywords.some(kw => text.includes(kw))) {
      sentiment = 'urgent';
      confidence = 85;
    } else if (positiveKeywords.some(kw => text.includes(kw))) {
      sentiment = 'positive';
      confidence = 75;
    } else if (/(problem|issue|error|fail)/.test(text)) {
      sentiment = 'negative';
      confidence = 70;
    }

    // Category detection
    let category = 'General';
    let rootCause = 'unknown';

    if (/(server|service|host|nagios|monitoring)/.test(text)) {
      category = 'Infrastructure Monitoring';
      rootCause = 'system';
    } else if (/(database|mysql|mariadb|sql|query)/.test(text)) {
      category = 'Database';
      rootCause = 'database';
    } else if (/(disk|volume|storage|space|freenas)/.test(text)) {
      category = 'Storage';
      rootCause = 'hardware';
    } else if (/(network|connection|vpn|dns)/.test(text)) {
      category = 'Network';
      rootCause = 'network';
    } else if (/(cpu|memory|load|processor|performance)/.test(text)) {
      category = 'Performance';
      rootCause = 'resource';
    }

    // Impact level
    let impactLevel = 'medium';
    if (/critical/.test(text)) {
      impactLevel = 'critical';
    } else if (/warning/.test(text)) {
      impactLevel = 'low';
    } else if (/(problem|down|outage)/.test(text)) {
      impactLevel = 'high';
    }

    // Extract key phrases
    const keyPhrases = [];
    const lines = emailData.body.split('\n').filter(l => l.trim());
    lines.forEach(line => {
      if (/(critical|warning|error|problem|issue|alert)/i.test(line)) {
        keyPhrases.push(line.trim().substring(0, 100));
      }
    });

    // Extract technical terms
    const technicalTerms = [];
    const technicalPatterns = [
      /\b[A-Z][a-zA-Z0-9]+(?:Server|DB|API|VM|Service|Host)\b/g,
      /\b(?:CPU|RAM|Disk|Network|Volume|Partition|Process)\b/gi,
      /\b\d+%\b/g, // percentages
      /\b\d+GB\b/gi // storage sizes
    ];

    technicalPatterns.forEach(pattern => {
      const matches = emailData.body.match(pattern);
      if (matches) {
        technicalTerms.push(...matches.slice(0, 5));
      }
    });

    // Extract host/service name
    let suggestedAssignee = null;
    const hostMatch = emailData.subject.match(/Host:\s*([A-Za-z0-9\-_]+)/i);
    if (hostMatch) {
      // In a real system, this would map to an assignee based on host ownership
      suggestedAssignee = `${category}-team`;
    }

    // Estimate resolution time (in minutes)
    let estimatedResolutionTime = 60; // default 1 hour
    if (impactLevel === 'critical') {
      estimatedResolutionTime = 30;
    } else if (impactLevel === 'low') {
      estimatedResolutionTime = 120;
    }

    // Find similar tickets (simplified - would need vector similarity in production)
    const connection = await getTenantConnection(this.tenantCode);
    try {
      const [similarTickets] = await connection.query(`
        SELECT id FROM tickets
        WHERE category = ? AND id != ?
        AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
        ORDER BY created_at DESC
        LIMIT 3
      `, [category, emailData.ticketId || 0]);

      const similarTicketIds = similarTickets.map(t => t.id);

      return {
        sentiment,
        confidence,
        category,
        rootCause,
        impactLevel,
        keyPhrases: keyPhrases.slice(0, 5),
        technicalTerms: [...new Set(technicalTerms)].slice(0, 10),
        suggestedAssignee,
        estimatedResolutionTime,
        similarTicketIds
      };

    } finally {
      connection.release();
    }
  }

  /**
   * Detect trends and generate insights
   */
  async detectTrends(timeRangeHours = 24) {
    console.log(`🔍 Detecting trends for last ${timeRangeHours} hours...`);

    const connection = await getTenantConnection(this.tenantCode);
    try {
      const insights = [];

      // Trend 1: Spike in tickets
      const [ticketCounts] = await connection.query(`
        SELECT
          DATE_FORMAT(created_at, '%Y-%m-%d %H:00:00') as hour,
          COUNT(*) as count
        FROM tickets
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
        GROUP BY hour
        ORDER BY hour DESC
      `, [timeRangeHours]);

      if (ticketCounts.length > 0) {
        const avgCount = ticketCounts.reduce((sum, row) => sum + row.count, 0) / ticketCounts.length;
        const maxCount = Math.max(...ticketCounts.map(r => r.count));

        if (maxCount > avgCount * 2) {
          insights.push({
            type: 'trend',
            title: 'Ticket Volume Spike Detected',
            description: `Ticket volume is ${Math.round((maxCount / avgCount - 1) * 100)}% above average. Current rate: ${maxCount} tickets/hour vs average ${Math.round(avgCount)} tickets/hour.`,
            severity: 'warning',
            metrics: { avgCount, maxCount, threshold: avgCount * 2 }
          });
        }
      }

      // Trend 2: Recurring issues (same category)
      const [categoryTrends] = await connection.query(`
        SELECT
          ai.ai_category,
          COUNT(*) as count,
          GROUP_CONCAT(t.id) as ticket_ids
        FROM tickets t
        JOIN ai_email_analysis ai ON t.id = ai.ticket_id
        WHERE t.created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
        GROUP BY ai.ai_category
        HAVING count >= 3
        ORDER BY count DESC
      `, [timeRangeHours]);

      categoryTrends.forEach(trend => {
        const ticketIds = trend.ticket_ids ? trend.ticket_ids.split(',').map(id => parseInt(id)) : [];
        insights.push({
          type: 'trend',
          title: `Recurring Issue: ${trend.ai_category}`,
          description: `${trend.count} tickets related to "${trend.ai_category}" in the last ${timeRangeHours} hours. This may indicate a systemic problem.`,
          severity: trend.count >= 5 ? 'critical' : 'warning',
          affected_tickets: ticketIds,
          metrics: { count: trend.count, category: trend.ai_category }
        });
      });

      // Trend 3: SLA breach risk
      const [slaRisk] = await connection.query(`
        SELECT
          COUNT(*) as at_risk_count,
          GROUP_CONCAT(id) as ticket_ids
        FROM tickets
        WHERE status NOT IN ('resolved', 'closed')
        AND sla_deadline IS NOT NULL
        AND sla_deadline BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 2 HOUR)
      `);

      if (slaRisk[0].at_risk_count > 0) {
        const ticketIds = slaRisk[0].ticket_ids ? slaRisk[0].ticket_ids.split(',').map(id => parseInt(id)) : [];
        insights.push({
          type: 'alert',
          title: 'SLA Breach Risk',
          description: `${slaRisk[0].at_risk_count} ticket(s) will breach SLA within 2 hours if not resolved.`,
          severity: 'critical',
          affected_tickets: ticketIds,
          metrics: { at_risk_count: slaRisk[0].at_risk_count }
        });
      }

      // Trend 4: High sentiment negative tickets
      const [negativeSentiment] = await connection.query(`
        SELECT
          COUNT(*) as count,
          GROUP_CONCAT(t.id) as ticket_ids
        FROM tickets t
        JOIN ai_email_analysis ai ON t.id = ai.ticket_id
        WHERE t.created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
        AND ai.sentiment IN ('urgent', 'negative')
        AND t.status = 'open'
      `, [timeRangeHours]);

      if (negativeSentiment[0].count >= 3) {
        const ticketIds = negativeSentiment[0].ticket_ids ? negativeSentiment[0].ticket_ids.split(',').map(id => parseInt(id)) : [];
        insights.push({
          type: 'recommendation',
          title: 'High Priority Tickets Need Attention',
          description: `${negativeSentiment[0].count} high-urgency tickets are still open. Consider prioritizing these for assignment.`,
          severity: 'warning',
          affected_tickets: ticketIds,
          metrics: { count: negativeSentiment[0].count }
        });
      }

      // Store insights in database
      for (const insight of insights) {
        await connection.query(`
          INSERT INTO ai_insights (
            insight_type, title, description, severity, affected_tickets, metrics,
            time_range_start, time_range_end
          ) VALUES (?, ?, ?, ?, ?, ?, DATE_SUB(NOW(), INTERVAL ? HOUR), NOW())
        `, [
          insight.type,
          insight.title,
          insight.description,
          insight.severity,
          JSON.stringify(insight.affected_tickets || []),
          JSON.stringify(insight.metrics || {}),
          timeRangeHours
        ]);
      }

      console.log(`✅ Detected ${insights.length} insights`);
      return insights;

    } finally {
      connection.release();
    }
  }

  /**
   * Get AI-powered dashboard data
   */
  async getDashboardData(period = 7) {
    const connection = await getTenantConnection(this.tenantCode);
    try {
      // Get active insights
      const [insights] = await connection.query(`
        SELECT * FROM ai_insights
        WHERE status = 'active'
        AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        ORDER BY severity DESC, created_at DESC
        LIMIT 10
      `, [period]);

      // Get sentiment distribution
      const [sentimentStats] = await connection.query(`
        SELECT
          ai.sentiment,
          COUNT(*) as count
        FROM ai_email_analysis ai
        JOIN tickets t ON ai.ticket_id = t.id
        WHERE t.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        GROUP BY ai.sentiment
      `, [period]);

      // Get top categories by AI
      const [aiCategories] = await connection.query(`
        SELECT
          ai.ai_category,
          COUNT(*) as count,
          AVG(ai.confidence_score) as avg_confidence
        FROM ai_email_analysis ai
        JOIN tickets t ON ai.ticket_id = t.id
        WHERE t.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        GROUP BY ai.ai_category
        ORDER BY count DESC
        LIMIT 10
      `, [period]);

      // Get root cause distribution
      const [rootCauses] = await connection.query(`
        SELECT
          root_cause_type,
          COUNT(*) as count
        FROM ai_email_analysis ai
        JOIN tickets t ON ai.ticket_id = t.id
        WHERE t.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        GROUP BY root_cause_type
        ORDER BY count DESC
      `, [period]);

      // Get AI performance metrics
      const [performance] = await connection.query(`
        SELECT
          AVG(confidence_score) as avg_confidence,
          AVG(processing_time_ms) as avg_processing_time,
          COUNT(*) as total_analyzed
        FROM ai_email_analysis ai
        JOIN tickets t ON ai.ticket_id = t.id
        WHERE t.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      `, [period]);

      return {
        insights: insights.map(i => {
          let affectedTickets = [];
          let metrics = {};

          // Handle affected_tickets - might be string, JSON, or already parsed
          try {
            if (typeof i.affected_tickets === 'string') {
              affectedTickets = JSON.parse(i.affected_tickets);
            } else if (Array.isArray(i.affected_tickets)) {
              affectedTickets = i.affected_tickets;
            }
          } catch (e) {
            console.warn('Failed to parse affected_tickets:', e.message);
          }

          // Handle metrics - might be string, JSON, or already parsed
          try {
            if (typeof i.metrics === 'string') {
              metrics = JSON.parse(i.metrics);
            } else if (typeof i.metrics === 'object') {
              metrics = i.metrics;
            }
          } catch (e) {
            console.warn('Failed to parse metrics:', e.message);
          }

          return {
            ...i,
            affected_tickets: affectedTickets,
            metrics
          };
        }),
        sentiment: {
          distribution: sentimentStats.reduce((acc, row) => {
            acc[row.sentiment || 'unknown'] = row.count;
            return acc;
          }, {})
        },
        categories: aiCategories,
        rootCauses: rootCauses,
        performance: performance[0]
      };

    } finally {
      connection.release();
    }
  }
}

module.exports = { AIAnalysisService };
