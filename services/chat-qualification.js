const { getTenantConnection } = require('../config/database');

const MAX_QUESTIONS = 4;
const SKIP_PENALTY_MINUTES = 60;

/**
 * AI Qualification Engine for Live Chat
 *
 * Asks up to 4 qualifying questions to gather ticket info.
 * Each skipped question adds 60 minutes SLA penalty.
 * Suggests CMDB items and finds similar tickets.
 */
class ChatQualificationEngine {
  constructor(tenantCode) {
    this.tenantCode = tenantCode;
  }

  /**
   * Get qualification questions based on the initial problem description.
   * Returns up to MAX_QUESTIONS questions.
   */
  async getQualificationQuestions(problemDescription) {
    const connection = await getTenantConnection(this.tenantCode);
    try {
      // Get available categories from existing tickets
      const [categories] = await connection.query(
        `SELECT DISTINCT category FROM tickets WHERE category IS NOT NULL AND category != '' ORDER BY category`
      );
      const categoryList = categories.map(c => c.category);

      // Get available priorities
      const priorities = ['low', 'medium', 'high', 'critical'];

      // Get CMDB asset categories
      const [assetCategories] = await connection.query(
        `SELECT DISTINCT asset_category FROM cmdb_items WHERE asset_category IS NOT NULL ORDER BY asset_category`
      );
      const assetCategoryList = assetCategories.map(c => c.asset_category);

      const questions = [
        {
          id: 'category',
          question: 'What category best describes your issue?',
          type: 'select',
          options: categoryList.length > 0 ? categoryList : ['General', 'Hardware', 'Software', 'Network', 'Access & Authentication'],
          required: false
        },
        {
          id: 'priority',
          question: 'How urgent is this issue?',
          type: 'select',
          options: priorities,
          required: false
        },
        {
          id: 'asset',
          question: 'Is this related to a specific device or system?',
          type: 'asset_search',
          hint: 'Type to search your assets...',
          assetCategories: assetCategoryList,
          required: false
        },
        {
          id: 'details',
          question: 'Any additional details that would help us resolve this faster?',
          type: 'text',
          required: false
        }
      ];

      return { questions, maxQuestions: MAX_QUESTIONS, skipPenaltyMinutes: SKIP_PENALTY_MINUTES };
    } finally {
      connection.release();
    }
  }

  /**
   * Process qualification answers and compute ticket metadata.
   * Returns ticket data and SLA penalty.
   */
  async processAnswers(answers, problemDescription) {
    const connection = await getTenantConnection(this.tenantCode);
    try {
      let skippedCount = 0;
      const ticketData = {
        title: problemDescription.substring(0, 100) + (problemDescription.length > 100 ? '...' : ''),
        description: problemDescription,
        category: 'General',
        priority: 'medium',
        cmdb_item_id: null,
        sla_skip_penalty_minutes: 0
      };

      // Process each answer
      for (const q of ['category', 'priority', 'asset', 'details']) {
        const answer = answers[q];
        if (!answer || answer === '' || answer === 'skip') {
          skippedCount++;
          continue;
        }

        switch (q) {
          case 'category':
            ticketData.category = answer;
            break;
          case 'priority':
            ticketData.priority = answer;
            break;
          case 'asset':
            if (typeof answer === 'object' && answer.id) {
              ticketData.cmdb_item_id = answer.id;
            } else if (typeof answer === 'number' || (typeof answer === 'string' && /^\d+$/.test(answer))) {
              ticketData.cmdb_item_id = parseInt(answer);
            }
            break;
          case 'details':
            ticketData.description += '\n\nAdditional details: ' + answer;
            break;
        }
      }

      // Calculate SLA penalty
      ticketData.sla_skip_penalty_minutes = skippedCount * SKIP_PENALTY_MINUTES;

      // Find similar tickets
      const similarTickets = await this.findSimilarTickets(connection, ticketData.title, ticketData.category);

      // Find suggested CMDB items if none selected
      let suggestedAssets = [];
      if (!ticketData.cmdb_item_id) {
        suggestedAssets = await this.suggestCMDBItems(connection, problemDescription, ticketData.category);
      }

      return {
        ticketData,
        skippedCount,
        penaltyMinutes: ticketData.sla_skip_penalty_minutes,
        similarTickets,
        suggestedAssets
      };
    } finally {
      connection.release();
    }
  }

  /**
   * Search CMDB items for the asset picker question.
   */
  async searchAssets(query) {
    const connection = await getTenantConnection(this.tenantCode);
    try {
      const [items] = await connection.query(
        `SELECT cmdb_id as id, asset_name, asset_category, brand_name, model_name, status
         FROM cmdb_items
         WHERE (asset_name LIKE ? OR brand_name LIKE ? OR model_name LIKE ?)
         AND status != 'Retired'
         ORDER BY asset_name
         LIMIT 10`,
        [`%${query}%`, `%${query}%`, `%${query}%`]
      );
      return items;
    } finally {
      connection.release();
    }
  }

  /**
   * Find similar tickets based on title keywords and category.
   */
  async findSimilarTickets(connection, title, category) {
    try {
      // Extract significant words (3+ chars, skip common words)
      const stopWords = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our', 'out', 'has', 'have', 'with', 'this', 'that', 'from', 'they', 'been', 'said', 'each', 'which', 'their', 'will', 'other', 'about', 'many', 'then', 'them', 'these', 'some', 'would', 'into', 'more', 'could', 'issue', 'problem', 'help', 'need', 'please', 'working']);
      const words = title.toLowerCase().split(/\s+/).filter(w => w.length >= 3 && !stopWords.has(w));

      if (words.length === 0) return [];

      // Build LIKE conditions for each keyword
      const conditions = words.slice(0, 3).map(() => `t.title LIKE ?`);
      const params = words.slice(0, 3).map(w => `%${w}%`);

      const [tickets] = await connection.query(
        `SELECT t.id, t.title, t.status, t.priority, t.category, t.created_at,
                u.full_name as assignee_name
         FROM tickets t
         LEFT JOIN users u ON t.assigned_to = u.id
         WHERE (${conditions.join(' OR ')})
         AND t.status NOT IN ('Closed', 'Cancelled')
         ORDER BY t.created_at DESC
         LIMIT 5`,
        params
      );
      return tickets;
    } catch (err) {
      console.error('[ChatQualification] Error finding similar tickets:', err);
      return [];
    }
  }

  /**
   * Suggest CMDB items based on problem description and category.
   */
  async suggestCMDBItems(connection, description, category) {
    try {
      const words = description.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
      if (words.length === 0) return [];

      const conditions = words.slice(0, 3).map(() => `(ci.asset_name LIKE ? OR ci.asset_category LIKE ?)`);
      const params = [];
      words.slice(0, 3).forEach(w => { params.push(`%${w}%`, `%${w}%`); });

      const [items] = await connection.query(
        `SELECT ci.cmdb_id as id, ci.asset_name, ci.asset_category, ci.brand_name, ci.model_name
         FROM cmdb_items ci
         WHERE (${conditions.join(' OR ')})
         AND ci.status != 'Retired'
         ORDER BY ci.asset_name
         LIMIT 5`,
        params
      );
      return items;
    } catch (err) {
      console.error('[ChatQualification] Error suggesting CMDB items:', err);
      return [];
    }
  }
}

module.exports = { ChatQualificationEngine, MAX_QUESTIONS, SKIP_PENALTY_MINUTES };
