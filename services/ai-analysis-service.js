const { getTenantConnection } = require('../config/database');
const { buildSLAFacts } = require('./sla-calculator');
const { logTicketActivity } = require('./activityLogger');

/**
 * AI Email Analysis Service
 * Analyzes emails and tickets using AI to extract insights, categorize, and detect trends
 *
 * Supports task-based routing with model selection per task type:
 * - triage tasks: fast, cost-effective (Haiku)
 * - reasoning tasks: balanced (Sonnet)
 * - premium tasks: highest quality (Opus)
 */

// =============================================================================
// CONFIGURATION: Environment Variables with Defaults
// =============================================================================

const CONFIG = {
  // Provider configuration (backwards compatible)
  AI_PROVIDER_PRIMARY: process.env.AI_PROVIDER_PRIMARY || process.env.AI_PROVIDER || 'pattern',
  AI_PROVIDER_SECONDARY: process.env.AI_PROVIDER_SECONDARY || 'pattern',

  // Model selection per task tier
  AI_MODEL_TRIAGE: process.env.AI_MODEL_TRIAGE || 'claude-3-haiku-20240307',
  AI_MODEL_REASONING: process.env.AI_MODEL_REASONING || 'claude-3-5-sonnet-latest',
  AI_MODEL_PREMIUM: process.env.AI_MODEL_PREMIUM || 'claude-3-opus-latest',

  // OpenAI models (placeholders for future implementation)
  OPENAI_MODEL_TRIAGE: process.env.OPENAI_MODEL_TRIAGE || 'gpt-4o-mini',
  OPENAI_MODEL_REASONING: process.env.OPENAI_MODEL_REASONING || 'gpt-4o',
  OPENAI_MODEL_PREMIUM: process.env.OPENAI_MODEL_PREMIUM || 'gpt-4o',

  // Retry configuration
  AI_MAX_RETRIES: parseInt(process.env.AI_MAX_RETRIES || '2', 10),
  AI_RETRY_DELAY_MS: parseInt(process.env.AI_RETRY_DELAY_MS || '800', 10),

  // JSON enforcement
  AI_JSON_ONLY: process.env.AI_JSON_ONLY !== 'false' // default true
};

// =============================================================================
// TASK TAXONOMY: Maps task names to model tiers
// =============================================================================

const TASK_TAXONOMY = {
  // Triage tasks - fast, low cost
  ticket_classify: 'triage',
  cmdb_autolink: 'triage',
  pool_ranking: 'triage',  // Fast ranking for ticket pool prioritization
  ticket_work_classify: 'triage',  // Work type + execution mode classification

  // Reasoning tasks - balanced
  preview_summary: 'reasoning',
  next_best_action: 'reasoning',
  draft_customer_reply: 'reasoning',
  kb_generate: 'reasoning',
  rule_interpret: 'reasoning',

  // Premium tasks - highest quality
  premium_customer_reply: 'premium'
};

// Default task for backwards compatibility
const DEFAULT_TASK = 'ticket_classify';

// =============================================================================
// ERROR CODES
// =============================================================================

const AI_ERROR_CODES = {
  AI_BAD_JSON: 'AI_BAD_JSON',
  AI_PROVIDER_NOT_IMPLEMENTED: 'AI_PROVIDER_NOT_IMPLEMENTED',
  AI_NO_VALID_PROVIDER: 'AI_NO_VALID_PROVIDER'
};

// Transient error codes that should trigger retry
const TRANSIENT_ERROR_CODES = [
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ECONNREFUSED',
  'PROTOCOL_CONNECTION_LOST'
];

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Safe JSON parsing with fallback extraction
 * @param {string} text - Raw text to parse
 * @returns {object} Parsed JSON object
 * @throws {Error} With code AI_BAD_JSON if parsing fails
 */
function safeParseJson(text) {
  if (!text || typeof text !== 'string') {
    const error = new Error('Empty or invalid response text');
    error.code = AI_ERROR_CODES.AI_BAD_JSON;
    throw error;
  }

  // First, try direct parse
  try {
    return JSON.parse(text);
  } catch (e) {
    // Continue to fallback strategies
  }

  // Remove markdown code blocks if present
  let cleanText = text;
  if (text.includes('```')) {
    cleanText = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    try {
      return JSON.parse(cleanText);
    } catch (e) {
      // Continue to next strategy
    }
  }

  // Try to extract first JSON object { ... }
  const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      // Continue to error
    }
  }

  // All strategies failed
  const error = new Error(`Failed to parse JSON response: ${text.substring(0, 200)}...`);
  error.code = AI_ERROR_CODES.AI_BAD_JSON;
  throw error;
}

/**
 * Retry wrapper with exponential backoff and jitter
 * @param {Function} fn - Async function to retry
 * @param {string} providerName - Provider name for logging
 * @param {number} maxRetries - Maximum retry attempts (default from CONFIG)
 * @param {number} baseDelay - Base delay in ms (default from CONFIG)
 * @returns {Promise<any>} Result from fn
 */
async function withRetry(fn, providerName, maxRetries = CONFIG.AI_MAX_RETRIES, baseDelay = CONFIG.AI_RETRY_DELAY_MS) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if error is retryable
      const isTransient = TRANSIENT_ERROR_CODES.includes(error.code) ||
                          TRANSIENT_ERROR_CODES.some(code => error.message?.includes(code));
      const isBadJson = error.code === AI_ERROR_CODES.AI_BAD_JSON;

      const shouldRetry = (isTransient || isBadJson) && attempt < maxRetries;

      if (shouldRetry) {
        // Exponential backoff with jitter
        const delay = baseDelay * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
        console.warn(`⚠️ [${providerName}] Retry ${attempt + 1}/${maxRetries} after ${delay}ms - Error: ${error.code || error.message}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        // Non-retryable error or max retries exceeded
        throw error;
      }
    }
  }

  throw lastError;
}

/**
 * Pick the appropriate model for a given provider and task
 * @param {string} provider - 'anthropic', 'openai', or 'pattern'
 * @param {string} taskName - Task name from TASK_TAXONOMY
 * @returns {string|null} Model name or null for pattern provider
 */
function pickModelFor(provider, taskName) {
  const tier = TASK_TAXONOMY[taskName] || 'triage';

  if (provider === 'anthropic') {
    switch (tier) {
      case 'premium': return CONFIG.AI_MODEL_PREMIUM;
      case 'reasoning': return CONFIG.AI_MODEL_REASONING;
      case 'triage':
      default: return CONFIG.AI_MODEL_TRIAGE;
    }
  }

  if (provider === 'openai') {
    switch (tier) {
      case 'premium': return CONFIG.OPENAI_MODEL_PREMIUM;
      case 'reasoning': return CONFIG.OPENAI_MODEL_REASONING;
      case 'triage':
      default: return CONFIG.OPENAI_MODEL_TRIAGE;
    }
  }

  // Pattern matching has no model
  return null;
}

/**
 * Get ordered list of providers to try
 * @returns {string[]} Array of provider names in priority order
 */
function getProviderOrder() {
  const providers = [];

  if (CONFIG.AI_PROVIDER_PRIMARY && CONFIG.AI_PROVIDER_PRIMARY !== 'pattern') {
    providers.push(CONFIG.AI_PROVIDER_PRIMARY);
  }

  if (CONFIG.AI_PROVIDER_SECONDARY &&
      CONFIG.AI_PROVIDER_SECONDARY !== 'pattern' &&
      CONFIG.AI_PROVIDER_SECONDARY !== CONFIG.AI_PROVIDER_PRIMARY) {
    providers.push(CONFIG.AI_PROVIDER_SECONDARY);
  }

  // Pattern is always the final fallback
  providers.push('pattern');

  return providers;
}

// =============================================================================
// MAIN CLASS
// =============================================================================

class AIAnalysisService {
  constructor(tenantCode, options = {}) {
    this.tenantCode = tenantCode;

    // Backwards compatible: aiProvider option or AI_PROVIDER env var
    this.aiProvider = options.aiProvider || process.env.AI_PROVIDER || 'pattern';
    this.apiKey = options.apiKey || process.env.AI_API_KEY;

    // Task-based routing (new feature, default to ticket_classify for backwards compat)
    this.task = options.task || DEFAULT_TASK;

    // Model selection: explicit option > task-based > legacy default
    if (options.model) {
      this.model = options.model;
    } else {
      this.model = pickModelFor(this.aiProvider, this.task) || this.getDefaultModel();
    }
  }

  /**
   * Get default model (backwards compatible)
   */
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
   * Set task and update model accordingly
   * @param {string} taskName - Task name from TASK_TAXONOMY
   */
  setTask(taskName) {
    if (!TASK_TAXONOMY[taskName]) {
      console.warn(`⚠️ Unknown task "${taskName}", defaulting to ${DEFAULT_TASK}`);
      taskName = DEFAULT_TASK;
    }
    this.task = taskName;
    this.model = pickModelFor(this.aiProvider, taskName) || this.model;
  }

  /**
   * Check if we have a valid API key for the given provider
   * @param {string} provider - Provider name
   * @returns {boolean}
   */
  hasValidApiKey(provider) {
    if (!this.apiKey) return false;
    if (this.apiKey === 'your_anthropic_api_key_here') return false;

    // Anthropic keys start with sk-ant-
    if (provider === 'anthropic' && this.apiKey.startsWith('sk-ant-')) return true;
    // Also accept generic sk- keys for anthropic
    if (provider === 'anthropic' && this.apiKey.startsWith('sk-')) return true;

    // OpenAI keys start with sk-
    if (provider === 'openai' && this.apiKey.startsWith('sk-')) return true;

    return false;
  }

  // ===========================================================================
  // TASK-AWARE ANALYSIS (NEW)
  // ===========================================================================

  /**
   * Analyze email/ticket data with task-based routing and provider fallback
   * @param {object} emailData - Email/ticket data to analyze
   * @param {object} options - Options including { task }
   * @returns {Promise<object>} Analysis result
   */
  async analyze(emailData, options = {}) {
    // Update task if provided
    if (options.task) {
      this.setTask(options.task);
    }

    const providers = getProviderOrder();
    let lastError;

    for (const provider of providers) {
      try {
        // Skip provider if it requires API key and we don't have one
        if (provider !== 'pattern' && !this.hasValidApiKey(provider)) {
          console.log(`⏭️ Skipping ${provider} - no valid API key`);
          continue;
        }

        // Select model for this provider and task
        const model = pickModelFor(provider, this.task);

        console.log(`🤖 Analyzing with ${provider}/${model || 'pattern'} for task: ${this.task}`);

        if (provider === 'anthropic') {
          return await withRetry(
            () => this.analyzeWithAnthropicTaskAware(emailData, model),
            'anthropic'
          );
        } else if (provider === 'openai') {
          // OpenAI is still stubbed - throw specific error to trigger fallback
          const error = new Error('OpenAI integration not yet implemented');
          error.code = AI_ERROR_CODES.AI_PROVIDER_NOT_IMPLEMENTED;
          throw error;
        } else {
          // Pattern matching fallback
          return await this.analyzeWithPatterns(emailData);
        }
      } catch (error) {
        lastError = error;

        // If it's a "not implemented" error, try next provider
        if (error.code === AI_ERROR_CODES.AI_PROVIDER_NOT_IMPLEMENTED) {
          console.log(`⏭️ ${provider} not implemented, trying next provider`);
          continue;
        }

        // Log and try next provider for other errors
        console.warn(`⚠️ ${provider} failed: ${error.message}, trying next provider`);
      }
    }

    // All providers failed - final fallback to pattern matching
    console.warn('⚠️ All AI providers failed, using pattern matching fallback');
    try {
      return await this.analyzeWithPatterns(emailData);
    } catch (patternError) {
      // If even pattern matching fails, throw the last meaningful error
      throw lastError || patternError;
    }
  }

  /**
   * Task-aware Anthropic analysis with JSON enforcement
   * @param {object} emailData - Email/ticket data
   * @param {string} modelOverride - Model to use (from task router)
   * @returns {Promise<object>} Parsed JSON analysis result
   */
  async analyzeWithAnthropicTaskAware(emailData, modelOverride) {
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: this.apiKey });

    const model = modelOverride || this.model || CONFIG.AI_MODEL_TRIAGE;
    const prompt = this.buildPromptForTask(emailData);
    const systemPrompt = this.buildSystemPromptForTask();

    const response = await anthropic.messages.create({
      model: model,
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: prompt
      }],
      system: systemPrompt
    });

    // Extract all text blocks and join
    const responseText = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    // Parse with safe JSON parser (throws AI_BAD_JSON on failure)
    return safeParseJson(responseText);
  }

  /**
   * Build system prompt for the current task
   * @returns {string} System prompt
   */
  buildSystemPromptForTask() {
    const jsonEnforcement = CONFIG.AI_JSON_ONLY
      ? '\n\nCRITICAL: Return JSON only. No markdown. No extra text. No code blocks.'
      : '';

    const basePrompt = `You are an expert IT support assistant specializing in ITSM ticket analysis.${jsonEnforcement}`;

    const taskPrompts = {
      ticket_classify: `${basePrompt}

Classify the support ticket and extract key information.

Required JSON output:
{
  "category": "Infrastructure|Database|Network|Storage|Performance|Security|Application|General",
  "sentiment": "urgent|negative|neutral|positive",
  "urgency": "critical|high|medium|low",
  "summary": "1-2 sentence summary",
  "extracted_entities": ["entity1", "entity2"]
}`,

      preview_summary: `${basePrompt}

Analyze the ticket and provide a comprehensive preview summary for the support agent.

Required JSON output:
{
  "summary": "Concise summary of the issue",
  "key_facts": ["fact1", "fact2", "fact3"],
  "missing_info": ["what additional info would help"],
  "risk_flags": ["potential risks or concerns"],
  "recommended_intent": "accept_and_own|request_more_info|suggest_escalation|decline",
  "rationale": "Why this recommendation",
  "suggested_questions": ["question to ask customer"]
}`,

      next_best_action: `${basePrompt}

Determine the next best actions for handling this ticket.

Required JSON output:
{
  "risk_flags": ["identified risks"],
  "next_actions": [
    {
      "action": "Action to take",
      "why": "Reason for this action",
      "effort_estimate": "low|medium|high"
    }
  ],
  "suggested_customer_update": "Message to send to customer",
  "internal_notes": "Notes for internal team"
}`,

      draft_customer_reply: `${basePrompt}

Draft a professional customer reply (max 160 words). Do not speculate or make promises you cannot keep.

Required JSON output:
{
  "subject": "Reply subject line",
  "body": "Professional reply body (max 160 words)"
}`,

      kb_generate: `${basePrompt}

Generate a knowledge base article from this resolved ticket.

Required JSON output:
{
  "title": "KB article title",
  "problem": "Description of the problem",
  "environment": "Affected environment/systems",
  "resolution_steps": ["step1", "step2", "step3"],
  "prevention": "How to prevent this in the future",
  "references": ["related KB articles or documentation"]
}`,

      cmdb_autolink: `${basePrompt}

Identify configuration items (CIs) mentioned in or related to this ticket.

Required JSON output:
{
  "candidate_cis": [
    {
      "ci_name": "Name of the CI",
      "confidence_0_100": 85,
      "reason": "Why this CI is relevant"
    }
  ]
}`,

      pool_ranking: `${basePrompt}

Rank this ticket for expert pool prioritization. Consider urgency, SLA proximity, customer tier, and technical complexity.

Required JSON output:
{
  "pool_score": 75,
  "urgency_factors": ["factor1", "factor2"],
  "recommended_skills": ["skill1", "skill2"],
  "complexity_estimate": "low|medium|high",
  "reasoning": "Brief explanation of the ranking"
}

Scoring guidelines:
- 90-100: Critical system down, P1 customer, SLA breach imminent
- 70-89: High impact, important customer, SLA at risk
- 50-69: Standard priority, normal business impact
- 30-49: Low priority, minor issue, ample SLA time
- 0-29: Informational, no urgency`,

      ticket_work_classify: `${basePrompt}

Classify the IT support ticket into work type and execution mode.

Work Types:
- request: Service request for new access, setup, provisioning, or something that doesn't exist yet
- incident: Something is broken, not working, or degraded from normal operation
- problem: Root cause investigation for recurring incidents or patterns
- change_request: Request to modify, update, or change existing system/configuration
- operational_action: Scheduled maintenance, routine task, backup verification, patching
- question: General inquiry, how-to question, seeking information
- feedback: Complaint, compliment, suggestion, or general feedback
- unknown: Cannot confidently classify - ambiguous or insufficient information

Execution Modes:
- automated: Can be handled entirely by automation or scripts
- human_review: Needs human review before taking action, but straightforward
- expert_required: Needs specialist knowledge or elevated privileges
- escalation_required: Needs escalation to vendor, management, or security team
- mixed: Multiple paths needed (e.g., some automated + some expert)

System Tags: Add 1-3 relevant tags from: database, network, security, compliance, urgent, vip, hardware, software, access, backup, monitoring, performance, outage, maintenance, training, billing, integration

Required JSON output:
{
  "work_type": "incident",
  "execution_mode": "expert_required",
  "system_tags": ["database", "urgent"],
  "confidence": 0.85,
  "reason": "Database connection errors indicate an incident requiring DBA expertise"
}`,

      premium_customer_reply: `${basePrompt}

Draft a premium, highly polished customer reply. Be empathetic, thorough, and professional.
Consider the customer's frustration level and business impact.

Required JSON output:
{
  "subject": "Reply subject line",
  "body": "Premium quality reply (appropriate length for the situation)"
}`,

      rule_interpret: `${basePrompt}

You are interpreting a natural language instruction into a structured automated action rule for an ITSM ticket system.

The rule engine matches incoming tickets by searching for text in the ticket title, body, or both, then fires an action.

Available action types:
- "delete" — Delete the ticket (no params needed)
- "assign_to_expert" — Assign to an expert. Params: { "expert_id": <number> }
- "create_for_customer" — Create ticket for a customer. Params: { "customer_id": <number> }
- "set_priority" — Set priority. Params: { "priority": "low"|"medium"|"high"|"critical" }
- "set_status" — Set status. Params: { "status": "Open"|"In Progress"|"Resolved"|"Closed" }
- "add_tag" — Add a tag. Params: { "tag": "<string>" }
- "add_to_monitoring" — Mark as system monitoring ticket (no params needed)
- "set_sla_definition" — Apply an SLA. Params: { "sla_definition_id": <number> }

Search options:
- "search_in": "both" (title and body), "title" (title only), "body" (body only)
- "search_text": the keyword or phrase to match
- "case_sensitive": true or false

Interpret the user's instruction and produce the best structured rule. If the instruction references a person by name, match them from the provided context lists. If ambiguous, set lower confidence and add a warning.

Required JSON output:
{
  "rule_name": "Short descriptive name for the rule",
  "description": "What this rule does",
  "search_in": "both|title|body",
  "search_text": "keyword or phrase to match",
  "case_sensitive": false,
  "action_type": "one of the action types above",
  "action_params": {},
  "confidence": 0.0 to 1.0,
  "reasoning": "How you interpreted the instruction",
  "warnings": ["Any ambiguities or concerns"]
}`
    };

    return taskPrompts[this.task] || taskPrompts.ticket_classify;
  }

  /**
   * Build user prompt for the current task
   * @param {object} emailData - Email/ticket data
   * @returns {string} User prompt
   */
  buildPromptForTask(emailData) {
    const baseInfo = `
TICKET INFORMATION:
Subject: ${emailData.subject || 'N/A'}
Description: ${emailData.body || 'N/A'}
Customer: ${emailData.customerName || 'Unknown'}
Company: ${emailData.companyName || 'Unknown'}
Created: ${emailData.createdAt || 'Unknown'}
Status: ${emailData.currentStatus || 'Unknown'}
Priority: ${emailData.currentPriority || 'Unknown'}
Assignee: ${emailData.currentAssignee || 'Unassigned'}`;

    const slaInfo = emailData.slaFacts ? `

SLA STATUS:
- SLA Name: ${emailData.slaFacts.sla_name || 'None'}
- Phase: ${emailData.slaFacts.phase}
- Response: ${emailData.slaFacts.response?.state || 'N/A'}
- Resolve: ${emailData.slaFacts.resolve?.state || 'N/A'}` : '';

    const activityInfo = emailData.activityHistory?.length > 0 ? `

RECENT ACTIVITY:
${emailData.activityHistory.slice(0, 5).map(a =>
  `- [${a.type}] ${a.user}: ${(a.description || '').substring(0, 100)}`
).join('\n')}` : '';

    const taskInstructions = {
      ticket_classify: 'Classify this ticket and extract key entities.',
      preview_summary: 'Provide a preview summary to help the agent understand this ticket quickly.',
      next_best_action: 'Determine the best next actions for this ticket.',
      draft_customer_reply: 'Draft a professional reply to the customer (max 160 words).',
      kb_generate: 'Generate a knowledge base article from this ticket.',
      cmdb_autolink: 'Identify any configuration items or infrastructure mentioned.',
      premium_customer_reply: 'Draft a premium, empathetic customer reply.'
    };

    return `${taskInstructions[this.task] || 'Analyze this ticket.'}
${baseInfo}${slaInfo}${activityInfo}

Respond with JSON only.`;
  }

  // ===========================================================================
  // LEGACY METHODS (Preserved for backwards compatibility)
  // ===========================================================================

  /**
   * Analyze an email/ticket and store results (LEGACY - preserved for backwards compat)
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
   * Analyze with OpenAI (LEGACY - still stubbed)
   */
  async analyzeWithOpenAI(emailData) {
    // This would require the OpenAI SDK: npm install openai
    // For now, returning a structured response format
    const error = new Error('OpenAI integration requires installing the openai package');
    error.code = AI_ERROR_CODES.AI_PROVIDER_NOT_IMPLEMENTED;
    throw error;

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
   * Analyze with Anthropic Claude (LEGACY - preserved for backwards compat)
   */
  async analyzeWithAnthropic(emailData) {
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: this.apiKey });

    let systemPrompt = `You are an expert IT support ticket analyzer. Analyze support tickets and provide structured recommendations.

Your response must be valid JSON with this exact structure:
{
  "sentiment": "urgent|negative|neutral|positive",
  "confidence": 0-100,
  "category": "Infrastructure|Database|Network|Storage|Performance|Security|Application|General",
  "rootCause": "system|database|hardware|network|resource|configuration|user_error|unknown",
  "impactLevel": "critical|high|medium|low",
  "keyPhrases": ["phrase1", "phrase2"],
  "technicalTerms": ["term1", "term2"],
  "suggestedAssignee": "team-name or null",
  "estimatedResolutionTime": minutes as number,
  "similarTicketIds": [],
  "suggestedPriority": "critical|high|medium|low",
  "suggestedActions": [
    {
      "action": "action_type",
      "label": "Button label",
      "description": "What this action does",
      "params": {}
    }
  ],
  "draftResponse": "Suggested initial response to the customer",
  "nextSteps": ["Step 1", "Step 2", "Step 3"],
  "reasoning": "Brief explanation of the analysis"
}

Available action types: assign_expert, set_priority, set_category, add_response, escalate, link_cmdb, close_ticket`;

    // Add JSON enforcement if enabled
    if (CONFIG.AI_JSON_ONLY) {
      systemPrompt += '\n\nReturn JSON only. No markdown. No extra text.';
    }

    const response = await anthropic.messages.create({
      model: this.model || 'claude-3-haiku-20240307',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: `Analyze this IT support ticket and provide recommendations:

Subject: ${emailData.subject}

Description:
${emailData.body}

Customer: ${emailData.customerName || 'Unknown'}
Company: ${emailData.companyName || 'Unknown'}
Created: ${emailData.createdAt || 'Unknown'}

Respond with valid JSON only, no markdown formatting.`
      }],
      system: systemPrompt
    });

    // Extract text and parse with safe parser
    const responseText = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    return safeParseJson(responseText);
  }

  /**
   * Get AI-powered suggestions for a specific ticket (one-click actions)
   */
  async getTicketSuggestions(ticketId) {
    const connection = await getTenantConnection(this.tenantCode);
    try {
      // Get ticket details with SLA definition
      const [tickets] = await connection.query(`
        SELECT t.*,
               u.full_name as requester_name,
               u.email as requester_email,
               c.company_name,
               a.full_name as assignee_name,
               s.name as sla_name,
               s.response_target_minutes, s.resolve_after_response_minutes,
               s.resolve_target_minutes, s.near_breach_percent,
               s.business_hours_profile_id,
               b.timezone, b.days_of_week, b.start_time, b.end_time, b.is_24x7
        FROM tickets t
        LEFT JOIN users u ON t.requester_id = u.id
        LEFT JOIN customers c ON u.id = c.user_id
        LEFT JOIN users a ON t.assignee_id = a.id
        LEFT JOIN sla_definitions s ON t.sla_definition_id = s.id
        LEFT JOIN business_hours_profiles b ON s.business_hours_profile_id = b.id
        WHERE t.id = ?
      `, [ticketId]);

      if (tickets.length === 0) {
        throw new Error('Ticket not found');
      }

      const ticket = tickets[0];

      // Build SLA facts for AI context
      const slaFacts = buildSLAFacts(ticket, ticket.sla_definition_id ? ticket : null);

      // Get ticket activity/comments
      const [activities] = await connection.query(`
        SELECT ta.*, u.full_name as user_name
        FROM ticket_activity ta
        LEFT JOIN users u ON ta.user_id = u.id
        WHERE ta.ticket_id = ?
        ORDER BY ta.created_at DESC
        LIMIT 10
      `, [ticketId]);

      // Get available experts (users with expert or admin role)
      const [experts] = await connection.query(`
        SELECT u.id, u.full_name, u.email,
               COALESCE(e.skills, '') as skills,
               COALESCE(e.availability_status, 'available') as availability_status,
               COALESCE(e.max_concurrent_tickets, 10) as max_concurrent_tickets,
               (SELECT COUNT(*) FROM tickets WHERE assignee_id = u.id AND status NOT IN ('Resolved', 'Closed')) as current_tickets
        FROM users u
        LEFT JOIN experts e ON u.id = e.user_id
        WHERE u.role IN ('expert', 'admin') AND u.is_active = TRUE
        ORDER BY e.availability_status = 'available' DESC, current_tickets ASC
      `);

      // Check for existing AI analysis
      const [existingAnalysis] = await connection.query(`
        SELECT * FROM ai_email_analysis WHERE ticket_id = ? ORDER BY analysis_timestamp DESC LIMIT 1
      `, [ticketId]);

      // Load active automated actions for AI context
      let automatedActions = [];
      try {
        const [rules] = await connection.query(`
          SELECT rule_name, instruction_text, search_in, search_text, action_type, action_params
          FROM ticket_processing_rules
          WHERE tenant_code = ? AND enabled = 1
        `, [this.tenantCode]);
        automatedActions = rules;
      } catch (e) {
        // Non-critical: proceed without rules context
        console.warn('Could not load automated actions for AI context:', e.message);
      }

      // Build context for AI
      const emailData = {
        subject: ticket.title,
        body: ticket.description,
        customerName: ticket.requester_name,
        companyName: ticket.company_name,
        createdAt: ticket.created_at,
        ticketId: ticketId,
        currentStatus: ticket.status,
        currentPriority: ticket.priority,
        currentAssignee: ticket.assignee_name,
        slaFacts: slaFacts,
        activityHistory: activities.map(a => ({
          type: a.activity_type,
          description: a.description,
          user: a.user_name,
          timestamp: a.created_at
        }))
      };

      let analysis;

      // Only use Claude if we have a valid API key (not placeholder)
      if (this.aiProvider === 'anthropic' && this.hasValidApiKey('anthropic')) {
        try {
          analysis = await this.getClaudeSuggestions(emailData, experts, automatedActions);
        } catch (error) {
          console.warn('Claude API failed, falling back to pattern matching:', error.message);
          analysis = await this.getPatternSuggestions(emailData, experts);
        }
      } else {
        // Fallback to pattern-based suggestions
        analysis = await this.getPatternSuggestions(emailData, experts);
      }

      // Add expert recommendations
      analysis.availableExperts = experts.map(e => ({
        id: e.id,
        name: e.full_name,
        skills: e.skills,
        status: e.availability_status,
        currentLoad: `${e.current_tickets}/${e.max_concurrent_tickets}`
      }));

      return analysis;

    } finally {
      connection.release();
    }
  }

  /**
   * Get Claude-powered suggestions with one-click actions
   */
  async getClaudeSuggestions(emailData, experts, automatedActions = []) {
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: this.apiKey });

    const expertList = experts.map(e =>
      `- ${e.full_name} (ID: ${e.id}): ${e.skills || 'General'}, Status: ${e.availability_status}, Load: ${e.current_tickets}/${e.max_concurrent_tickets}`
    ).join('\n');

    const activitySummary = emailData.activityHistory?.map(a =>
      `[${a.type}] ${a.user}: ${a.description?.substring(0, 100) || 'N/A'}`
    ).join('\n') || 'No activity yet';

    // Format SLA facts for prompt
    const slaFacts = emailData.slaFacts;
    const slaContext = slaFacts ? `
SLA Status:
- SLA: ${slaFacts.sla_name || 'None'} (source: ${slaFacts.sla_source})
- Phase: ${slaFacts.phase}
- Timezone: ${slaFacts.timezone}
- Outside business hours: ${slaFacts.outside_business_hours ? 'Yes' : 'No'}
- Response: ${slaFacts.response.state} (${slaFacts.response.percent_used}% used${slaFacts.response.remaining_minutes !== null ? ', ' + slaFacts.response.remaining_minutes + ' mins remaining' : ''})
- Resolve: ${slaFacts.resolve.state} (${slaFacts.resolve.percent_used}% used${slaFacts.resolve.remaining_minutes !== null ? ', ' + slaFacts.resolve.remaining_minutes + ' mins remaining' : ''})
` : 'SLA Status: No SLA assigned';

    let systemPrompt = `You are an expert IT support assistant helping agents triage and resolve tickets efficiently.

## SLA Rules (MUST follow these strictly):
1. NEVER recommend changing the SLA. SLA is auto-computed by the system and locked.
2. When reporting SLA status, use ONLY the sla_facts provided. Never infer or guess.
3. For time remaining, report in business hours (e.g., "2 hours of business time remaining").
4. If outside_business_hours is true, note that "SLA timers are paused until business hours resume."
5. SLA phase meanings:
   - "awaiting_response": Ticket needs first response
   - "in_progress": Responded, working toward resolution
   - "resolved": Ticket is resolved
6. SLA states:
   - "on_track": Within SLA targets
   - "near_breach": Approaching deadline (urgent attention needed)
   - "breached": Deadline exceeded (escalation may be needed)
   - "met": Target was met successfully
   - "pending": Not yet applicable (e.g., resolve clock before response)

Provide actionable suggestions in valid JSON format:
{
  "analysis": {
    "summary": "Brief 1-2 sentence summary of the issue",
    "urgency": "critical|high|medium|low",
    "complexity": "simple|moderate|complex",
    "estimatedTime": "Time estimate to resolve",
    "slaStatus": "Brief SLA status from sla_facts"
  },
  "suggestedActions": [
    {
      "id": "unique_id",
      "type": "assign|priority|category|respond|escalate|close",
      "label": "Button text (short)",
      "description": "What this does",
      "confidence": 0-100,
      "params": {
        "assignee_id": number or null,
        "priority": "string or null",
        "category": "string or null",
        "response": "string or null",
        "status": "string or null"
      }
    }
  ],
  "draftResponse": "Suggested response to send to customer",
  "nextSteps": ["Recommended step 1", "Recommended step 2"],
  "knowledgeHints": ["Relevant KB article suggestion 1"],
  "warnings": ["Any concerns or things to watch out for, including SLA warnings"]
}

Provide 3-5 actionable suggestions ordered by confidence/relevance.
For assign actions, include assignee_id from the expert list.
For respond actions, include a professional draft response.
If SLA is near_breach or breached, include a warning and prioritize actions that help meet SLA.

## Automated Actions
Factor in the active automated actions listed below. Do NOT suggest actions that duplicate what these rules already handle automatically. If a rule already applies to this ticket, mention it in your analysis.`;

    // Add JSON enforcement if enabled
    if (CONFIG.AI_JSON_ONLY) {
      systemPrompt += '\n\nReturn JSON only. No markdown. No extra text.';
    }

    // Build automated actions context for user prompt
    let automatedActionsContext = '';
    if (automatedActions && automatedActions.length > 0) {
      const actionDescriptions = automatedActions.map(r => {
        const params = typeof r.action_params === 'string' ? JSON.parse(r.action_params) : (r.action_params || {});
        if (r.instruction_text) {
          return `- "${r.rule_name}": ${r.instruction_text}`;
        }
        return `- "${r.rule_name}": When ${r.search_in} contains "${r.search_text}" → ${r.action_type}${params.priority ? ' (' + params.priority + ')' : ''}${params.tag ? ' (' + params.tag + ')' : ''}`;
      }).join('\n');
      automatedActionsContext = `\n\nACTIVE AUTOMATED ACTIONS (fire automatically on matching tickets):\n${actionDescriptions}`;
    }

    const response = await anthropic.messages.create({
      model: this.model || 'claude-3-haiku-20240307',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: `Analyze this ticket and suggest one-click actions:

TICKET #${emailData.ticketId}
Title: ${emailData.subject}
Status: ${emailData.currentStatus}
Priority: ${emailData.currentPriority}
Assignee: ${emailData.currentAssignee || 'Unassigned'}
Customer: ${emailData.customerName} (${emailData.companyName})
${slaContext}
Description:
${emailData.body}

Activity History:
${activitySummary}

Available Experts:
${expertList}
${automatedActionsContext}

Provide JSON suggestions for efficient ticket handling.`
      }],
      system: systemPrompt
    });

    const responseText = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    return safeParseJson(responseText);
  }

  /**
   * Interpret a natural language instruction into a structured automated action rule.
   * @param {string} instructionText - Free-text instruction from the user
   * @param {object} context - Available experts, customers, SLA definitions
   * @returns {object} Structured rule interpretation
   */
  async interpretRuleInstruction(instructionText, context = {}) {
    if (!this.hasValidApiKey('anthropic')) {
      throw new Error('AI provider not configured. Please set up an Anthropic API key to use AI interpretation.');
    }

    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: this.apiKey });

    // Build context strings for the AI
    const expertList = (context.experts || []).map(e =>
      `- ${e.full_name} (ID: ${e.id})${e.skills ? ': ' + e.skills : ''}`
    ).join('\n') || 'No experts available';

    const customerList = (context.customers || []).map(c =>
      `- ${c.company_name || c.full_name} (Customer ID: ${c.id})`
    ).join('\n') || 'No customers available';

    const slaList = (context.slaDefinitions || []).map(s =>
      `- ${s.name} (ID: ${s.id}): Response ${s.response_target_minutes}min, Resolve ${s.resolve_target_minutes}min`
    ).join('\n') || 'No SLA definitions available';

    // Build system prompt for rule interpretation
    const savedTask = this.task;
    this.task = 'rule_interpret';
    const systemPrompt = this.buildSystemPromptForTask();
    this.task = savedTask; // restore

    const response = await anthropic.messages.create({
      model: CONFIG.AI_MODEL_TRIAGE,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: `Interpret this instruction into a structured rule:

INSTRUCTION: "${instructionText}"

AVAILABLE CONTEXT:

Experts:
${expertList}

Customers:
${customerList}

SLA Definitions:
${slaList}

Return the structured rule as JSON.`
      }]
    });

    const responseText = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    return safeParseJson(responseText);
  }

  /**
   * Pattern-based suggestions fallback
   */
  async getPatternSuggestions(emailData, experts) {
    const text = `${emailData.subject} ${emailData.body}`.toLowerCase();

    const suggestions = [];
    const warnings = [];

    // Check SLA status and add warnings
    const slaFacts = emailData.slaFacts;
    let slaStatus = 'No SLA';
    if (slaFacts) {
      if (slaFacts.response.state === 'breached') {
        warnings.push('Response SLA BREACHED - immediate escalation recommended');
        slaStatus = 'Response SLA breached';
      } else if (slaFacts.response.state === 'near_breach') {
        warnings.push(`Response SLA at risk - ${slaFacts.response.remaining_minutes} business minutes remaining`);
        slaStatus = 'Response SLA at risk';
      } else if (slaFacts.resolve.state === 'breached') {
        warnings.push('Resolution SLA BREACHED - escalation needed');
        slaStatus = 'Resolution SLA breached';
      } else if (slaFacts.resolve.state === 'near_breach') {
        warnings.push(`Resolution SLA at risk - ${slaFacts.resolve.remaining_minutes} business minutes remaining`);
        slaStatus = 'Resolution SLA at risk';
      } else if (slaFacts.outside_business_hours) {
        slaStatus = `${slaFacts.sla_name} - SLA timers paused (outside business hours)`;
      } else {
        slaStatus = `${slaFacts.sla_name} - ${slaFacts.response.state}`;
      }
    }

    // Suggest priority based on keywords
    if (/(critical|emergency|down|outage|urgent)/i.test(text)) {
      suggestions.push({
        id: 'set_critical',
        type: 'priority',
        label: 'Set Critical Priority',
        description: 'Detected urgent keywords in ticket',
        confidence: 85,
        params: { priority: 'critical' }
      });
    }

    // Suggest category
    let suggestedCategory = 'General';
    if (/(server|host|monitoring|nagios)/i.test(text)) {
      suggestedCategory = 'Infrastructure';
    } else if (/(database|mysql|sql|query)/i.test(text)) {
      suggestedCategory = 'Database';
    } else if (/(network|vpn|dns|firewall)/i.test(text)) {
      suggestedCategory = 'Network';
    }

    suggestions.push({
      id: 'set_category',
      type: 'category',
      label: `Categorize: ${suggestedCategory}`,
      description: `Based on ticket content analysis`,
      confidence: 70,
      params: { category: suggestedCategory }
    });

    // Suggest best available expert
    const availableExpert = experts.find(e => e.availability_status === 'available');
    if (availableExpert) {
      suggestions.push({
        id: 'assign_expert',
        type: 'assign',
        label: `Assign to ${availableExpert.full_name}`,
        description: `Available expert with lowest workload`,
        confidence: 75,
        params: { assignee_id: availableExpert.id }
      });
    }

    // Suggest initial response
    suggestions.push({
      id: 'send_ack',
      type: 'respond',
      label: 'Send Acknowledgment',
      description: 'Send standard acknowledgment to customer',
      confidence: 90,
      params: {
        response: `Thank you for contacting support. We have received your ticket regarding "${emailData.subject}" and a team member will be reviewing it shortly. We'll keep you updated on our progress.`
      }
    });

    return {
      analysis: {
        summary: `Ticket about ${suggestedCategory.toLowerCase()} issue`,
        urgency: /(critical|emergency|down)/i.test(text) ? 'high' : 'medium',
        complexity: 'moderate',
        estimatedTime: '1-2 hours',
        slaStatus: slaStatus
      },
      suggestedActions: suggestions,
      draftResponse: `Thank you for reaching out. We understand you're experiencing an issue with ${suggestedCategory.toLowerCase()}. Our team is reviewing your request and will respond shortly.`,
      nextSteps: [
        'Review ticket details',
        'Assign to appropriate expert',
        'Send acknowledgment to customer'
      ],
      knowledgeHints: [],
      warnings: warnings
    };
  }

  /**
   * Execute a suggested action
   */
  async executeSuggestion(ticketId, action, userId) {
    const connection = await getTenantConnection(this.tenantCode);
    try {
      const results = [];

      switch (action.type) {
        case 'assign':
          if (action.params.assignee_id) {
            await connection.query(
              'UPDATE tickets SET assignee_id = ?, status = ? WHERE id = ?',
              [action.params.assignee_id, 'In Progress', ticketId]
            );
            await logTicketActivity(connection, {
              ticketId, userId, activityType: 'assigned',
              description: 'AI suggested assignment accepted',
              source: 'system', eventKey: 'ticket.assigned',
              meta: { assigneeId: action.params.assignee_id, triggeredBy: 'ai_suggestion' }
            });
            results.push({ success: true, action: 'assign', message: 'Ticket assigned' });
          }
          break;

        case 'priority':
          if (action.params.priority) {
            await connection.query(
              'UPDATE tickets SET priority = ? WHERE id = ?',
              [action.params.priority, ticketId]
            );
            await logTicketActivity(connection, {
              ticketId, userId, activityType: 'updated',
              description: `Priority set to ${action.params.priority} (AI suggestion)`,
              source: 'system', eventKey: 'ticket.priority.changed',
              meta: { field: 'priority', to: action.params.priority, triggeredBy: 'ai_suggestion' }
            });
            results.push({ success: true, action: 'priority', message: `Priority set to ${action.params.priority}` });
          }
          break;

        case 'category':
          if (action.params.category) {
            await connection.query(
              'UPDATE tickets SET category = ? WHERE id = ?',
              [action.params.category, ticketId]
            );
            results.push({ success: true, action: 'category', message: `Category set to ${action.params.category}` });
          }
          break;

        case 'respond':
          if (action.params.response) {
            await logTicketActivity(connection, {
              ticketId, userId, activityType: 'comment',
              description: action.params.response,
              source: 'system', eventKey: 'ticket.comment.added',
              meta: { triggeredBy: 'ai_suggestion' }
            });
            results.push({ success: true, action: 'respond', message: 'Response added to ticket' });
          }
          break;

        case 'close':
          await connection.query(
            'UPDATE tickets SET status = ? WHERE id = ?',
            ['Closed', ticketId]
          );
          await logTicketActivity(connection, {
            ticketId, userId, activityType: 'closed',
            description: 'Ticket closed via AI suggestion',
            source: 'system', eventKey: 'ticket.status.changed',
            meta: { field: 'status', to: 'Closed', triggeredBy: 'ai_suggestion' }
          });
          results.push({ success: true, action: 'close', message: 'Ticket closed' });
          break;
      }

      // Log AI action execution
      await connection.query(`
        INSERT INTO ai_action_log (ticket_id, user_id, action_type, action_params, executed_at)
        VALUES (?, ?, ?, ?, NOW())
      `, [ticketId, userId, action.type, JSON.stringify(action.params)]);

      return results;

    } finally {
      connection.release();
    }
  }

  /**
   * Analyze with pattern matching (fallback, no API needed)
   */
  async analyzeWithPatterns(emailData) {
    const text = `${emailData.subject || ''} ${emailData.body || ''}`.toLowerCase();

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
    const body = emailData.body || '';
    const lines = body.split('\n').filter(l => l.trim());
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
      const matches = body.match(pattern);
      if (matches) {
        technicalTerms.push(...matches.slice(0, 5));
      }
    });

    // Extract host/service name
    let suggestedAssignee = null;
    const subject = emailData.subject || '';
    const hostMatch = subject.match(/Host:\s*([A-Za-z0-9\-_]+)/i);
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

      // Return format depends on task
      // For new task-based routing, return task-appropriate format
      if (this.task === 'ticket_classify') {
        return {
          category,
          sentiment,
          urgency: impactLevel,
          summary: `${category} issue detected with ${sentiment} sentiment`,
          extracted_entities: technicalTerms.slice(0, 5)
        };
      }

      // Legacy format for backwards compatibility
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
        const ticketIds = trend.ticket_ids ? trend.ticket_ids.split(',').map(id => parseInt(id)).filter(id => !isNaN(id) && id !== null) : [];
        insights.push({
          type: 'trend',
          title: `Recurring Issue: ${trend.ai_category}`,
          description: `${trend.count} tickets related to "${trend.ai_category}" in the last ${timeRangeHours} hours. This may indicate a systemic problem.`,
          severity: trend.count >= 5 ? 'critical' : 'warning',
          affected_tickets: ticketIds,
          metrics: { count: trend.count, category: trend.ai_category }
        });
      });

      // Trend 3: SLA status (two-phase: response and resolve)
      // 3a. Already breached response SLA (past deadline, no response yet)
      const [responseBreached] = await connection.query(`
        SELECT
          COUNT(*) as count,
          GROUP_CONCAT(id) as ticket_ids
        FROM tickets
        WHERE status NOT IN ('resolved', 'closed')
        AND sla_definition_id IS NOT NULL
        AND first_responded_at IS NULL
        AND response_due_at IS NOT NULL
        AND response_due_at < NOW()
      `);

      if (responseBreached[0].count > 0) {
        const ticketIds = responseBreached[0].ticket_ids ? responseBreached[0].ticket_ids.split(',').map(id => parseInt(id)).filter(id => !isNaN(id) && id !== null) : [];
        insights.push({
          type: 'alert',
          title: 'Response SLA Breached',
          description: `${responseBreached[0].count} ticket(s) have missed their response SLA deadline and still need first response.`,
          severity: 'critical',
          affected_tickets: ticketIds,
          metrics: { count: responseBreached[0].count, phase: 'response', state: 'breached' }
        });
      }

      // 3b. Response SLA at risk (within 2 hours of deadline)
      const [responseRisk] = await connection.query(`
        SELECT
          COUNT(*) as count,
          GROUP_CONCAT(id) as ticket_ids
        FROM tickets
        WHERE status NOT IN ('resolved', 'closed')
        AND sla_definition_id IS NOT NULL
        AND first_responded_at IS NULL
        AND response_due_at IS NOT NULL
        AND response_due_at BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 2 HOUR)
      `);

      if (responseRisk[0].count > 0) {
        const ticketIds = responseRisk[0].ticket_ids ? responseRisk[0].ticket_ids.split(',').map(id => parseInt(id)).filter(id => !isNaN(id) && id !== null) : [];
        insights.push({
          type: 'alert',
          title: 'Response SLA At Risk',
          description: `${responseRisk[0].count} ticket(s) need first response within 2 hours to avoid SLA breach.`,
          severity: 'warning',
          affected_tickets: ticketIds,
          metrics: { count: responseRisk[0].count, phase: 'response', state: 'at_risk' }
        });
      }

      // 3c. Already breached resolution SLA (past deadline, not resolved)
      const [resolveBreached] = await connection.query(`
        SELECT
          COUNT(*) as count,
          GROUP_CONCAT(id) as ticket_ids
        FROM tickets
        WHERE status NOT IN ('resolved', 'closed')
        AND sla_definition_id IS NOT NULL
        AND first_responded_at IS NOT NULL
        AND resolve_due_at IS NOT NULL
        AND resolve_due_at < NOW()
      `);

      if (resolveBreached[0].count > 0) {
        const ticketIds = resolveBreached[0].ticket_ids ? resolveBreached[0].ticket_ids.split(',').map(id => parseInt(id)).filter(id => !isNaN(id) && id !== null) : [];
        insights.push({
          type: 'alert',
          title: 'Resolution SLA Breached',
          description: `${resolveBreached[0].count} ticket(s) have missed their resolution SLA deadline and still need to be resolved.`,
          severity: 'critical',
          affected_tickets: ticketIds,
          metrics: { count: resolveBreached[0].count, phase: 'resolve', state: 'breached' }
        });
      }

      // 3d. Resolution SLA at risk (within 2 hours of deadline)
      const [resolveRisk] = await connection.query(`
        SELECT
          COUNT(*) as count,
          GROUP_CONCAT(id) as ticket_ids
        FROM tickets
        WHERE status NOT IN ('resolved', 'closed')
        AND sla_definition_id IS NOT NULL
        AND first_responded_at IS NOT NULL
        AND resolve_due_at IS NOT NULL
        AND resolve_due_at BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 2 HOUR)
      `);

      if (resolveRisk[0].count > 0) {
        const ticketIds = resolveRisk[0].ticket_ids ? resolveRisk[0].ticket_ids.split(',').map(id => parseInt(id)).filter(id => !isNaN(id) && id !== null) : [];
        insights.push({
          type: 'alert',
          title: 'Resolution SLA At Risk',
          description: `${resolveRisk[0].count} ticket(s) need resolution within 2 hours to avoid SLA breach.`,
          severity: 'warning',
          affected_tickets: ticketIds,
          metrics: { count: resolveRisk[0].count, phase: 'resolve', state: 'at_risk' }
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
        const ticketIds = negativeSentiment[0].ticket_ids ? negativeSentiment[0].ticket_ids.split(',').map(id => parseInt(id)).filter(id => !isNaN(id) && id !== null) : [];
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
      // Get stored insights
      const [insights] = await connection.query(`
        SELECT * FROM ai_insights
        WHERE status = 'active'
        AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        ORDER BY severity DESC, created_at DESC
        LIMIT 10
      `, [period]);

      // Increase GROUP_CONCAT limit for large ticket ID lists (default 1024 is too small)
      await connection.query('SET SESSION group_concat_max_len = 1000000');

      // Live SLA breach queries — filtered by period to match other stats
      const [responseBreached] = await connection.query(`
        SELECT COUNT(*) as count, GROUP_CONCAT(id) as ticket_ids
        FROM tickets
        WHERE status NOT IN ('resolved', 'closed')
        AND sla_definition_id IS NOT NULL
        AND first_responded_at IS NULL
        AND response_due_at IS NOT NULL
        AND response_due_at < NOW()
        AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      `, [period]);

      const [resolveBreached] = await connection.query(`
        SELECT COUNT(*) as count, GROUP_CONCAT(id) as ticket_ids
        FROM tickets
        WHERE status NOT IN ('resolved', 'closed')
        AND sla_definition_id IS NOT NULL
        AND first_responded_at IS NOT NULL
        AND resolve_due_at IS NOT NULL
        AND resolve_due_at < NOW()
        AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      `, [period]);

      const [responseRisk] = await connection.query(`
        SELECT COUNT(*) as count, GROUP_CONCAT(id) as ticket_ids
        FROM tickets
        WHERE status NOT IN ('resolved', 'closed')
        AND sla_definition_id IS NOT NULL
        AND first_responded_at IS NULL
        AND response_due_at IS NOT NULL
        AND response_due_at BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 2 HOUR)
        AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      `, [period]);

      const [resolveRisk] = await connection.query(`
        SELECT COUNT(*) as count, GROUP_CONCAT(id) as ticket_ids
        FROM tickets
        WHERE status NOT IN ('resolved', 'closed')
        AND sla_definition_id IS NOT NULL
        AND first_responded_at IS NOT NULL
        AND resolve_due_at IS NOT NULL
        AND resolve_due_at BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 2 HOUR)
        AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      `, [period]);

      // Build live SLA insights
      const liveInsights = [];
      const parseIds = (str) => str ? str.split(',').map(id => parseInt(id)).filter(id => !isNaN(id)) : [];

      if (responseBreached[0].count > 0) {
        liveInsights.push({
          id: 'live-response-breached', type: 'alert', severity: 'critical',
          title: 'Response SLA Breached',
          description: `${responseBreached[0].count} ticket(s) have missed their response SLA deadline and still need first response.`,
          affected_tickets: parseIds(responseBreached[0].ticket_ids),
          metrics: { count: responseBreached[0].count, phase: 'response', state: 'breached' }
        });
      }

      if (resolveBreached[0].count > 0) {
        liveInsights.push({
          id: 'live-resolve-breached', type: 'alert', severity: 'critical',
          title: 'Resolution SLA Breached',
          description: `${resolveBreached[0].count} ticket(s) have missed their resolution SLA deadline and still need to be resolved.`,
          affected_tickets: parseIds(resolveBreached[0].ticket_ids),
          metrics: { count: resolveBreached[0].count, phase: 'resolve', state: 'breached' }
        });
      }

      if (responseRisk[0].count > 0) {
        liveInsights.push({
          id: 'live-response-risk', type: 'alert', severity: 'warning',
          title: 'Response SLA At Risk',
          description: `${responseRisk[0].count} ticket(s) need first response within 2 hours to avoid SLA breach.`,
          affected_tickets: parseIds(responseRisk[0].ticket_ids),
          metrics: { count: responseRisk[0].count, phase: 'response', state: 'at_risk' }
        });
      }

      if (resolveRisk[0].count > 0) {
        liveInsights.push({
          id: 'live-resolve-risk', type: 'alert', severity: 'warning',
          title: 'Resolution SLA At Risk',
          description: `${resolveRisk[0].count} ticket(s) need resolution within 2 hours to avoid SLA breach.`,
          affected_tickets: parseIds(resolveRisk[0].ticket_ids),
          metrics: { count: resolveRisk[0].count, phase: 'resolve', state: 'at_risk' }
        });
      }

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

      // Get AI performance metrics (filter outliers: processing_time > 60s is clearly erroneous)
      const [performance] = await connection.query(`
        SELECT
          AVG(confidence_score) as avg_confidence,
          AVG(CASE WHEN processing_time_ms <= 60000 THEN processing_time_ms ELSE NULL END) as avg_processing_time,
          COUNT(*) as total_analyzed
        FROM ai_email_analysis ai
        JOIN tickets t ON ai.ticket_id = t.id
        WHERE t.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      `, [period]);

      // Get total tickets in period for ticketStats
      const [ticketCount] = await connection.query(`
        SELECT COUNT(*) as total FROM tickets
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      `, [period]);

      return {
        ticketStats: {
          total: ticketCount[0]?.total || 0,
          analyzed: performance[0]?.total_analyzed || 0
        },
        insights: [
          // Live SLA insights first (always current)
          ...liveInsights,
          // Then stored insights (from detectTrends)
          ...insights.map(i => {
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
          })
        ],
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

  /**
   * Match ticket to CMDB items and CIs using AI
   * Analyzes ticket content and finds related infrastructure items
   */
  async matchTicketToCMDB(ticketId) {
    const startTime = Date.now();
    const connection = await getTenantConnection(this.tenantCode);

    try {
      console.log(`🔍 AI matching CMDB items for ticket #${ticketId}...`);

      // Get ticket details
      const [tickets] = await connection.query(`
        SELECT t.*, u.full_name as customer_name, c.company_name
        FROM tickets t
        LEFT JOIN users u ON t.requester_id = u.id
        LEFT JOIN customers c ON u.id = c.user_id
        WHERE t.id = ?
      `, [ticketId]);

      if (tickets.length === 0) {
        throw new Error('Ticket not found');
      }

      const ticket = tickets[0];

      // Get all CMDB items with their CIs
      const [cmdbItems] = await connection.query(`
        SELECT
          ci.id, ci.cmdb_id, ci.asset_name, ci.asset_category,
          ci.brand_name, ci.model_name, ci.customer_name,
          ci.asset_location, ci.comment,
          (SELECT COUNT(*) FROM configuration_items WHERE cmdb_item_id = ci.id) as ci_count
        FROM cmdb_items ci
        ORDER BY ci.asset_name
      `);

      // Get all CIs with their parent CMDB item info
      const [configItems] = await connection.query(`
        SELECT
          cfg.id, cfg.ci_id, cfg.ci_name, cfg.category_field_value,
          cfg.cmdb_item_id, cmdb.asset_name as parent_asset_name,
          cmdb.customer_name as parent_customer_name
        FROM configuration_items cfg
        LEFT JOIN cmdb_items cmdb ON cfg.cmdb_item_id = cmdb.id
      `);

      let matches;

      // Use Claude if available, otherwise pattern matching
      if (this.aiProvider === 'anthropic' && this.hasValidApiKey('anthropic')) {
        try {
          matches = await this.matchWithClaude(ticket, cmdbItems, configItems);
        } catch (error) {
          console.warn('Claude API failed, falling back to pattern matching:', error.message);
          matches = await this.matchWithPatterns(ticket, cmdbItems, configItems);
        }
      } else {
        matches = await this.matchWithPatterns(ticket, cmdbItems, configItems);
      }

      const processingTime = Date.now() - startTime;

      // Store match results
      await connection.query(`
        INSERT INTO ai_cmdb_match_log (ticket_id, matched_cmdb_ids, matched_ci_ids, ai_model, match_criteria, processing_time_ms)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        ticketId,
        JSON.stringify(matches.cmdbItems.map(m => m.id)),
        JSON.stringify(matches.configItems.map(m => m.id)),
        this.model,
        matches.reasoning,
        processingTime
      ]);

      console.log(`✅ Found ${matches.cmdbItems.length} CMDB items and ${matches.configItems.length} CIs for ticket #${ticketId} (${processingTime}ms)`);

      return {
        success: true,
        ticketId,
        cmdbItems: matches.cmdbItems,
        configItems: matches.configItems,
        reasoning: matches.reasoning,
        processingTime
      };

    } finally {
      connection.release();
    }
  }

  /**
   * Match using Claude AI
   */
  async matchWithClaude(ticket, cmdbItems, configItems) {
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: this.apiKey });

    // Build CMDB context
    const cmdbContext = cmdbItems.map(item =>
      `ID:${item.id} | ${item.asset_name} | Category: ${item.asset_category || 'N/A'} | Customer: ${item.customer_name || 'N/A'} | Location: ${item.asset_location || 'N/A'} | CIs: ${item.ci_count}`
    ).join('\n');

    const ciContext = configItems.slice(0, 100).map(ci =>
      `ID:${ci.id} | ${ci.ci_name}: ${ci.category_field_value || 'N/A'} | Parent: ${ci.parent_asset_name || 'N/A'}`
    ).join('\n');

    let systemPrompt = `You are an IT infrastructure expert that matches support tickets to Configuration Management Database (CMDB) items.

Analyze the ticket and identify which CMDB items (servers, services, applications) and Configuration Items (CIs like IP addresses, credentials, settings) are relevant.

Respond with valid JSON:
{
  "cmdb_matches": [
    {
      "id": number,
      "confidence": 0-100,
      "relationship": "affected|caused_by|related",
      "reason": "Why this item matches"
    }
  ],
  "ci_matches": [
    {
      "id": number,
      "confidence": 0-100,
      "relationship": "affected|caused_by|related",
      "reason": "Why this CI matches"
    }
  ],
  "reasoning": "Overall explanation of the matches"
}

Only include items with confidence >= 60. Order by confidence descending.`;

    // Add JSON enforcement if enabled
    if (CONFIG.AI_JSON_ONLY) {
      systemPrompt += '\n\nReturn JSON only. No markdown. No extra text.';
    }

    const response = await anthropic.messages.create({
      model: this.model || 'claude-3-haiku-20240307',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: `Match this support ticket to relevant CMDB items and CIs:

TICKET #${ticket.id}
Title: ${ticket.title}
Description: ${ticket.description}
Customer: ${ticket.customer_name || 'Unknown'} (${ticket.company_name || 'Unknown'})
Priority: ${ticket.priority}

AVAILABLE CMDB ITEMS:
${cmdbContext}

AVAILABLE CONFIGURATION ITEMS (sample):
${ciContext}

Find all relevant infrastructure items. Respond with JSON only.`
      }],
      system: systemPrompt
    });

    const responseText = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    const result = safeParseJson(responseText);

    // Map results to full item data
    const cmdbMatches = (result.cmdb_matches || []).map(match => {
      const item = cmdbItems.find(i => i.id === match.id);
      return item ? {
        ...item,
        confidence: match.confidence,
        relationship: match.relationship,
        reason: match.reason
      } : null;
    }).filter(Boolean);

    const ciMatches = (result.ci_matches || []).map(match => {
      const item = configItems.find(i => i.id === match.id);
      return item ? {
        ...item,
        confidence: match.confidence,
        relationship: match.relationship,
        reason: match.reason
      } : null;
    }).filter(Boolean);

    return {
      cmdbItems: cmdbMatches,
      configItems: ciMatches,
      reasoning: result.reasoning || 'AI-powered matching'
    };
  }

  /**
   * Match using pattern matching (fallback)
   */
  async matchWithPatterns(ticket, cmdbItems, configItems) {
    const text = `${ticket.title} ${ticket.description}`.toLowerCase();
    const customerName = (ticket.customer_name || ticket.company_name || '').toLowerCase();

    const cmdbMatches = [];
    const ciMatches = [];

    // Match CMDB items
    for (const item of cmdbItems) {
      let confidence = 0;
      let reasons = [];

      // Check if asset name is mentioned in ticket
      const assetName = (item.asset_name || '').toLowerCase();
      if (assetName && text.includes(assetName)) {
        confidence += 50;
        reasons.push('Asset name mentioned in ticket');
      }

      // Check if customer matches
      const itemCustomer = (item.customer_name || '').toLowerCase();
      if (itemCustomer && customerName && itemCustomer.includes(customerName)) {
        confidence += 30;
        reasons.push('Customer match');
      }

      // Check for category keywords
      const category = (item.asset_category || '').toLowerCase();
      if (category) {
        if (category.includes('server') && /(server|host|vm|instance)/i.test(text)) {
          confidence += 20;
          reasons.push('Server category matches server keywords');
        }
        if (category.includes('database') && /(database|mysql|sql|db)/i.test(text)) {
          confidence += 20;
          reasons.push('Database category matches database keywords');
        }
        if (category.includes('network') && /(network|vpn|firewall|router)/i.test(text)) {
          confidence += 20;
          reasons.push('Network category matches network keywords');
        }
        if (category.includes('application') && /(app|application|software|service)/i.test(text)) {
          confidence += 20;
          reasons.push('Application category matches app keywords');
        }
      }

      // Check location keywords
      const location = (item.asset_location || '').toLowerCase();
      if (location && text.includes(location)) {
        confidence += 15;
        reasons.push('Location mentioned in ticket');
      }

      if (confidence >= 40) {
        cmdbMatches.push({
          ...item,
          confidence: Math.min(confidence, 95),
          relationship: 'affected',
          reason: reasons.join('; ')
        });
      }
    }

    // Match Configuration Items
    for (const ci of configItems) {
      let confidence = 0;
      let reasons = [];

      // Check if CI name is mentioned
      const ciName = (ci.ci_name || '').toLowerCase();
      if (ciName && text.includes(ciName)) {
        confidence += 40;
        reasons.push('CI name mentioned in ticket');
      }

      // Check if CI value is mentioned (IP addresses, hostnames, etc.)
      const ciValue = (ci.category_field_value || '').toLowerCase();
      if (ciValue && ciValue.length > 3) {
        // Check for IP address pattern
        if (/\d+\.\d+\.\d+\.\d+/.test(ciValue) && text.includes(ciValue)) {
          confidence += 60;
          reasons.push('IP address mentioned in ticket');
        }
        // Check for hostname/URL
        else if (text.includes(ciValue)) {
          confidence += 50;
          reasons.push('CI value found in ticket');
        }
      }

      // Check if parent asset matches
      const parentAsset = (ci.parent_asset_name || '').toLowerCase();
      if (parentAsset && text.includes(parentAsset)) {
        confidence += 30;
        reasons.push('Parent asset mentioned');
      }

      if (confidence >= 40) {
        ciMatches.push({
          ...ci,
          confidence: Math.min(confidence, 95),
          relationship: 'affected',
          reason: reasons.join('; ')
        });
      }
    }

    // Sort by confidence
    cmdbMatches.sort((a, b) => b.confidence - a.confidence);
    ciMatches.sort((a, b) => b.confidence - a.confidence);

    return {
      cmdbItems: cmdbMatches.slice(0, 10),
      configItems: ciMatches.slice(0, 20),
      reasoning: 'Pattern-based matching using keyword analysis'
    };
  }

  /**
   * Link a ticket to CMDB items (save the relationship)
   */
  async linkTicketToCMDB(ticketId, cmdbItemIds, ciIds, userId, matchedBy = 'manual') {
    const connection = await getTenantConnection(this.tenantCode);

    try {
      const results = { cmdbLinked: 0, ciLinked: 0 };

      // Link CMDB items
      for (const itemId of cmdbItemIds) {
        try {
          await connection.query(`
            INSERT INTO ticket_cmdb_items (ticket_id, cmdb_item_id, matched_by, created_by)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE matched_by = VALUES(matched_by)
          `, [ticketId, itemId, matchedBy, userId]);
          results.cmdbLinked++;
        } catch (err) {
          console.warn(`Could not link CMDB item ${itemId}:`, err.message);
        }
      }

      // Link CIs
      for (const ciId of ciIds) {
        try {
          await connection.query(`
            INSERT INTO ticket_configuration_items (ticket_id, ci_id, matched_by, created_by)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE matched_by = VALUES(matched_by)
          `, [ticketId, ciId, matchedBy, userId]);
          results.ciLinked++;
        } catch (err) {
          console.warn(`Could not link CI ${ciId}:`, err.message);
        }
      }

      // Log activity
      await logTicketActivity(connection, {
        ticketId, userId, activityType: 'comment',
        description: `CMDB Linked: ${results.cmdbLinked} CMDB items and ${results.ciLinked} CIs (${matchedBy})`,
        source: 'system', eventKey: 'ticket.cmdb.linked',
        meta: { cmdbLinked: results.cmdbLinked, ciLinked: results.ciLinked, matchedBy }
      });

      return results;

    } finally {
      connection.release();
    }
  }

  /**
   * Get linked CMDB items for a ticket
   */
  async getTicketCMDBItems(ticketId) {
    const connection = await getTenantConnection(this.tenantCode);

    try {
      // Get linked CMDB items
      const [cmdbItems] = await connection.query(`
        SELECT
          tcm.*,
          cm.cmdb_id, cm.asset_name, cm.asset_category, cm.customer_name,
          cm.brand_name, cm.model_name, cm.asset_location,
          u.full_name as linked_by_name
        FROM ticket_cmdb_items tcm
        JOIN cmdb_items cm ON tcm.cmdb_item_id = cm.id
        LEFT JOIN users u ON tcm.created_by = u.id
        WHERE tcm.ticket_id = ?
        ORDER BY tcm.created_at DESC
      `, [ticketId]);

      // Get linked CIs
      const [configItems] = await connection.query(`
        SELECT
          tci.*,
          ci.ci_id, ci.ci_name, ci.category_field_value,
          cm.asset_name as parent_asset_name, cm.cmdb_id as parent_cmdb_id,
          u.full_name as linked_by_name
        FROM ticket_configuration_items tci
        JOIN configuration_items ci ON tci.ci_id = ci.id
        LEFT JOIN cmdb_items cm ON ci.cmdb_item_id = cm.id
        LEFT JOIN users u ON tci.created_by = u.id
        WHERE tci.ticket_id = ?
        ORDER BY tci.created_at DESC
      `, [ticketId]);

      return {
        cmdbItems,
        configItems
      };

    } finally {
      connection.release();
    }
  }

  /**
   * Remove CMDB link from ticket
   */
  async unlinkCMDBItem(ticketId, cmdbItemId, userId) {
    const connection = await getTenantConnection(this.tenantCode);

    try {
      await connection.query(`
        DELETE FROM ticket_cmdb_items WHERE ticket_id = ? AND cmdb_item_id = ?
      `, [ticketId, cmdbItemId]);

      await logTicketActivity(connection, {
        ticketId, userId, activityType: 'comment',
        description: 'CMDB Unlinked: Removed CMDB item link',
        source: 'system', eventKey: 'ticket.cmdb.unlinked',
        meta: { cmdbItemId }
      });

      return { success: true };

    } finally {
      connection.release();
    }
  }

  /**
   * Remove CI link from ticket
   */
  async unlinkCI(ticketId, ciId, userId) {
    const connection = await getTenantConnection(this.tenantCode);

    try {
      await connection.query(`
        DELETE FROM ticket_configuration_items WHERE ticket_id = ? AND ci_id = ?
      `, [ticketId, ciId]);

      await logTicketActivity(connection, {
        ticketId, userId, activityType: 'comment',
        description: 'CMDB Unlinked: Removed CI link',
        source: 'system', eventKey: 'ticket.cmdb.unlinked',
        meta: { ciId }
      });

      return { success: true };

    } finally {
      connection.release();
    }
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  AIAnalysisService,
  // Export utilities for testing
  safeParseJson,
  withRetry,
  pickModelFor,
  getProviderOrder,
  CONFIG,
  TASK_TAXONOMY,
  AI_ERROR_CODES
};
