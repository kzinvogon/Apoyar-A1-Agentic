/**
 * Knowledge Base API Routes
 * CRUD operations, search, suggestions, and merge functionality
 */

const express = require('express');
const router = express.Router();
const { getTenantConnection } = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');
const { KnowledgeBaseService } = require('../services/knowledge-base-service');

// Apply authentication to all routes
router.use(verifyToken);

// ============================================================================
// ARTICLE CRUD ROUTES
// ============================================================================

// Get all KB articles (with pagination and filters)
router.get('/:tenantCode/articles', async (req, res) => {
  try {
    const { tenantCode } = req.params;
    const { page = 1, limit = 20, category, status, search, sort = 'created_at', order = 'DESC' } = req.query;

    if (req.user.tenantCode !== tenantCode && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const connection = await getTenantConnection(tenantCode);

    try {
      const offset = (parseInt(page) - 1) * parseInt(limit);
      let sql = `
        SELECT
          ka.id, ka.article_id, ka.title, ka.summary, ka.category, ka.tags,
          ka.status, ka.visibility, ka.view_count, ka.helpful_count, ka.not_helpful_count,
          ka.source_type, ka.created_at, ka.updated_at, ka.published_at,
          u.full_name as created_by_name
        FROM kb_articles ka
        LEFT JOIN users u ON ka.created_by = u.id
        WHERE 1=1
      `;
      const params = [];

      // Filter by category
      if (category) {
        sql += ' AND ka.category = ?';
        params.push(category);
      }

      // Filter by status (experts see all, customers only published)
      if (status) {
        sql += ' AND ka.status = ?';
        params.push(status);
      } else if (req.user.role === 'customer') {
        sql += " AND ka.status = 'published' AND ka.visibility IN ('public', 'internal')";
      }

      // Full-text search
      if (search) {
        sql += ' AND MATCH(ka.title, ka.content) AGAINST(? IN NATURAL LANGUAGE MODE)';
        params.push(search);
      }

      // Sorting
      const validSorts = ['created_at', 'updated_at', 'title', 'view_count', 'helpful_count'];
      const sortCol = validSorts.includes(sort) ? sort : 'created_at';
      const sortOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
      sql += ` ORDER BY ka.${sortCol} ${sortOrder}`;

      // Pagination
      sql += ' LIMIT ? OFFSET ?';
      params.push(parseInt(limit), offset);

      const [articles] = await connection.query(sql, params);

      // Get total count
      let countSql = 'SELECT COUNT(*) as total FROM kb_articles WHERE 1=1';
      const countParams = [];
      if (category) {
        countSql += ' AND category = ?';
        countParams.push(category);
      }
      if (status) {
        countSql += ' AND status = ?';
        countParams.push(status);
      }

      const [countResult] = await connection.query(countSql, countParams);

      res.json({
        success: true,
        articles: articles.map(a => {
          let tags = a.tags || [];
          // Handle various tag formats: JSON array, already-parsed array, or comma-separated string
          if (typeof tags === 'string') {
            try {
              tags = JSON.parse(tags);
            } catch (e) {
              // Not valid JSON - treat as comma-separated string
              tags = tags.split(',').map(t => t.trim()).filter(t => t.length > 0);
            }
          }
          return { ...a, tags };
        }),
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: countResult[0].total,
          pages: Math.ceil(countResult[0].total / parseInt(limit))
        }
      });

    } finally {
      connection.release();
    }

  } catch (error) {
    console.error('Error fetching KB articles:', error);
    res.status(500).json({ error: 'Failed to fetch articles', message: error.message });
  }
});

// Get single article by ID
router.get('/:tenantCode/articles/:articleId', async (req, res) => {
  try {
    const { tenantCode, articleId } = req.params;
    const { increment_view = 'true' } = req.query;

    if (req.user.tenantCode !== tenantCode && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const connection = await getTenantConnection(tenantCode);

    try {
      const [articles] = await connection.query(`
        SELECT
          ka.*,
          u1.full_name as created_by_name,
          u2.full_name as updated_by_name
        FROM kb_articles ka
        LEFT JOIN users u1 ON ka.created_by = u1.id
        LEFT JOIN users u2 ON ka.updated_by = u2.id
        WHERE ka.id = ? OR ka.article_id = ?
      `, [articleId, articleId]);

      if (articles.length === 0) {
        return res.status(404).json({ error: 'Article not found' });
      }

      const article = articles[0];
      // Handle tags which may be JSON array, pre-parsed array, or comma-separated string
      let tags = article.tags || [];
      if (typeof tags === 'string') {
        try {
          tags = JSON.parse(tags);
        } catch (e) {
          tags = tags.split(',').map(t => t.trim()).filter(t => t.length > 0);
        }
      }
      article.tags = tags;
      // Handle merged_from JSON
      const rawMerged = article.merged_from;
      article.merged_from = typeof rawMerged === 'string' ? JSON.parse(rawMerged || '[]') : (rawMerged || []);

      // Increment view count
      if (increment_view === 'true') {
        await connection.query('UPDATE kb_articles SET view_count = view_count + 1 WHERE id = ?', [article.id]);
        article.view_count++;
      }

      // Get versions
      const [versions] = await connection.query(`
        SELECT v.*, u.full_name as created_by_name
        FROM kb_article_versions v
        LEFT JOIN users u ON v.created_by = u.id
        WHERE v.article_id = ?
        ORDER BY v.version_number DESC
      `, [article.id]);

      article.versions = versions;

      // Get related tickets
      const [linkedTickets] = await connection.query(`
        SELECT tka.*, t.title as ticket_title, t.status as ticket_status
        FROM ticket_kb_articles tka
        JOIN tickets t ON tka.ticket_id = t.id
        WHERE tka.article_id = ?
        ORDER BY tka.created_at DESC
        LIMIT 10
      `, [article.id]);

      article.linked_tickets = linkedTickets;

      res.json({ success: true, article });

    } finally {
      connection.release();
    }

  } catch (error) {
    console.error('Error fetching KB article:', error);
    res.status(500).json({ error: 'Failed to fetch article', message: error.message });
  }
});

// Create new article
router.post('/:tenantCode/articles', requireRole(['admin', 'expert']), async (req, res) => {
  try {
    const { tenantCode } = req.params;
    const { title, content, summary, category, tags, status, visibility } = req.body;

    if (req.user.tenantCode !== tenantCode && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!title || !content) {
      return res.status(400).json({ error: 'Title and content are required' });
    }

    const kbService = new KnowledgeBaseService(tenantCode);
    const result = await kbService.createArticle({
      title, content, summary, category, tags, status, visibility
    }, req.user.userId);

    res.json({
      success: true,
      message: 'Article created successfully',
      article: result
    });

  } catch (error) {
    console.error('Error creating KB article:', error);
    res.status(500).json({ error: 'Failed to create article', message: error.message });
  }
});

// Update article
router.put('/:tenantCode/articles/:articleId', requireRole(['admin', 'expert']), async (req, res) => {
  try {
    const { tenantCode, articleId } = req.params;
    const { title, content, summary, category, tags, status, visibility, change_reason } = req.body;

    if (req.user.tenantCode !== tenantCode && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const kbService = new KnowledgeBaseService(tenantCode);
    const result = await kbService.updateArticle(parseInt(articleId), {
      title, content, summary, category, tags, status, visibility
    }, req.user.userId, change_reason || 'Updated');

    res.json({
      success: true,
      message: 'Article updated successfully',
      ...result
    });

  } catch (error) {
    console.error('Error updating KB article:', error);
    res.status(500).json({ error: 'Failed to update article', message: error.message });
  }
});

// Delete article (archive)
router.delete('/:tenantCode/articles/:articleId', requireRole(['admin']), async (req, res) => {
  try {
    const { tenantCode, articleId } = req.params;

    if (req.user.tenantCode !== tenantCode && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const connection = await getTenantConnection(tenantCode);

    try {
      await connection.query(
        'UPDATE kb_articles SET status = ? WHERE id = ?',
        ['archived', articleId]
      );

      res.json({ success: true, message: 'Article archived successfully' });

    } finally {
      connection.release();
    }

  } catch (error) {
    console.error('Error deleting KB article:', error);
    res.status(500).json({ error: 'Failed to delete article', message: error.message });
  }
});

// ============================================================================
// SEARCH ROUTES
// ============================================================================

// Semantic search
router.get('/:tenantCode/search', async (req, res) => {
  try {
    const { tenantCode } = req.params;
    const { q, category, limit = 10 } = req.query;

    if (req.user.tenantCode !== tenantCode && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!q) {
      return res.status(400).json({ error: 'Search query (q) is required' });
    }

    const kbService = new KnowledgeBaseService(tenantCode);
    const results = await kbService.searchArticles(q, {
      limit: parseInt(limit),
      category,
      status: 'published',
      minScore: 0.4
    });

    res.json({
      success: true,
      query: q,
      results
    });

  } catch (error) {
    console.error('Error searching KB:', error);
    res.status(500).json({ error: 'Search failed', message: error.message });
  }
});

// ============================================================================
// SUGGESTION ROUTES
// ============================================================================

// Get article suggestions for a ticket
router.get('/:tenantCode/tickets/:ticketId/suggestions', requireRole(['admin', 'expert']), async (req, res) => {
  try {
    const { tenantCode, ticketId } = req.params;

    if (req.user.tenantCode !== tenantCode && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const kbService = new KnowledgeBaseService(tenantCode);
    const result = await kbService.suggestArticlesForTicket(parseInt(ticketId));

    res.json(result);

  } catch (error) {
    console.error('Error getting KB suggestions:', error);
    res.status(500).json({ error: 'Failed to get suggestions', message: error.message });
  }
});

// Create article from resolved ticket
router.post('/:tenantCode/tickets/:ticketId/create-article', requireRole(['admin', 'expert']), async (req, res) => {
  try {
    const { tenantCode, ticketId } = req.params;
    const { title, category, publish } = req.body;

    if (req.user.tenantCode !== tenantCode && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const kbService = new KnowledgeBaseService(tenantCode);
    const result = await kbService.createArticleFromTicket(
      parseInt(ticketId),
      req.user.userId,
      { title, category, publish }
    );

    res.json(result);

  } catch (error) {
    console.error('Error creating article from ticket:', error);
    res.status(500).json({ error: 'Failed to create article', message: error.message });
  }
});

// ============================================================================
// MERGE ROUTES
// ============================================================================

// Get pending merge suggestions
router.get('/:tenantCode/merge-suggestions', requireRole(['admin', 'expert']), async (req, res) => {
  try {
    const { tenantCode } = req.params;
    const { limit = 20 } = req.query;

    if (req.user.tenantCode !== tenantCode && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const kbService = new KnowledgeBaseService(tenantCode);
    const suggestions = await kbService.getPendingMergeSuggestions(parseInt(limit));

    res.json({
      success: true,
      count: suggestions.length,
      suggestions
    });

  } catch (error) {
    console.error('Error getting merge suggestions:', error);
    res.status(500).json({ error: 'Failed to get merge suggestions', message: error.message });
  }
});

// Merge two articles
router.post('/:tenantCode/merge', requireRole(['admin']), async (req, res) => {
  try {
    const { tenantCode } = req.params;
    const { source_article_id, target_article_id, append_content } = req.body;

    if (req.user.tenantCode !== tenantCode && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!source_article_id || !target_article_id) {
      return res.status(400).json({ error: 'source_article_id and target_article_id are required' });
    }

    const kbService = new KnowledgeBaseService(tenantCode);
    const result = await kbService.mergeArticles(
      parseInt(source_article_id),
      parseInt(target_article_id),
      req.user.userId,
      { appendContent: append_content !== false }
    );

    res.json(result);

  } catch (error) {
    console.error('Error merging articles:', error);
    res.status(500).json({ error: 'Failed to merge articles', message: error.message });
  }
});

// Dismiss merge suggestion
router.post('/:tenantCode/merge-suggestions/:suggestionId/dismiss', requireRole(['admin', 'expert']), async (req, res) => {
  try {
    const { tenantCode, suggestionId } = req.params;

    if (req.user.tenantCode !== tenantCode && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const connection = await getTenantConnection(tenantCode);

    try {
      await connection.query(`
        UPDATE kb_article_similarities
        SET status = 'dismissed', reviewed_by = ?, reviewed_at = NOW()
        WHERE id = ?
      `, [req.user.userId, suggestionId]);

      res.json({ success: true, message: 'Merge suggestion dismissed' });

    } finally {
      connection.release();
    }

  } catch (error) {
    console.error('Error dismissing merge suggestion:', error);
    res.status(500).json({ error: 'Failed to dismiss suggestion', message: error.message });
  }
});

// ============================================================================
// FEEDBACK ROUTES
// ============================================================================

// Record article feedback
router.post('/:tenantCode/articles/:articleId/feedback', async (req, res) => {
  try {
    const { tenantCode, articleId } = req.params;
    const { helpful, feedback_text, ticket_id } = req.body;

    if (req.user.tenantCode !== tenantCode && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (helpful === undefined) {
      return res.status(400).json({ error: 'helpful (true/false) is required' });
    }

    const kbService = new KnowledgeBaseService(tenantCode);
    await kbService.recordFeedback(
      parseInt(articleId),
      req.user.userId,
      helpful,
      feedback_text,
      ticket_id
    );

    res.json({ success: true, message: 'Feedback recorded' });

  } catch (error) {
    console.error('Error recording feedback:', error);
    res.status(500).json({ error: 'Failed to record feedback', message: error.message });
  }
});

// ============================================================================
// CATEGORY ROUTES
// ============================================================================

// Get all categories
router.get('/:tenantCode/categories', async (req, res) => {
  try {
    const { tenantCode } = req.params;

    if (req.user.tenantCode !== tenantCode && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const connection = await getTenantConnection(tenantCode);

    try {
      const [categories] = await connection.query(`
        SELECT * FROM kb_categories ORDER BY sort_order, name
      `);

      res.json({ success: true, categories });

    } finally {
      connection.release();
    }

  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: 'Failed to fetch categories', message: error.message });
  }
});

// ============================================================================
// STATS ROUTES
// ============================================================================

// Get KB statistics
router.get('/:tenantCode/stats', requireRole(['admin', 'expert']), async (req, res) => {
  try {
    const { tenantCode } = req.params;

    if (req.user.tenantCode !== tenantCode && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const connection = await getTenantConnection(tenantCode);

    try {
      // Article counts by status
      const [statusCounts] = await connection.query(`
        SELECT status, COUNT(*) as count FROM kb_articles GROUP BY status
      `);

      // Total views
      const [viewStats] = await connection.query(`
        SELECT SUM(view_count) as total_views, SUM(helpful_count) as total_helpful, SUM(not_helpful_count) as total_not_helpful
        FROM kb_articles
      `);

      // Pending merge suggestions
      const [mergeCounts] = await connection.query(`
        SELECT COUNT(*) as pending FROM kb_article_similarities WHERE status = 'pending'
      `);

      // Articles by category
      const [categoryCounts] = await connection.query(`
        SELECT category, COUNT(*) as count FROM kb_articles WHERE status = 'published' GROUP BY category ORDER BY count DESC
      `);

      // Recent articles
      const [recentArticles] = await connection.query(`
        SELECT id, article_id, title, created_at FROM kb_articles ORDER BY created_at DESC LIMIT 5
      `);

      res.json({
        success: true,
        stats: {
          byStatus: statusCounts.reduce((acc, row) => ({ ...acc, [row.status]: row.count }), {}),
          totalViews: viewStats[0].total_views || 0,
          totalHelpful: viewStats[0].total_helpful || 0,
          totalNotHelpful: viewStats[0].total_not_helpful || 0,
          pendingMerges: mergeCounts[0].pending,
          byCategory: categoryCounts,
          recentArticles
        }
      });

    } finally {
      connection.release();
    }

  } catch (error) {
    console.error('Error fetching KB stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats', message: error.message });
  }
});

// ============================================================================
// TICKET SUGGESTION ROUTES
// ============================================================================

// Get KB article suggestions for a ticket
router.get('/:tenantCode/suggest-for-ticket/:ticketId', async (req, res) => {
  try {
    const { tenantCode, ticketId } = req.params;

    if (req.user.tenantCode !== tenantCode && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const kbService = new KnowledgeBaseService(tenantCode);
    const result = await kbService.suggestArticlesForTicket(parseInt(ticketId));

    res.json({
      success: result.success,
      ticket_id: ticketId,
      suggestions: result.suggestions || []
    });

  } catch (error) {
    console.error('Error fetching KB suggestions for ticket:', error);
    res.status(500).json({ error: 'Failed to fetch suggestions', message: error.message });
  }
});

module.exports = router;
