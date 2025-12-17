/**
 * Knowledge Base Service
 * Manages KB articles, embeddings, similarity detection, and auto-merge suggestions
 */

const { getTenantConnection } = require('../config/database');
const { EmbeddingService } = require('./embedding-service');

class KnowledgeBaseService {
  constructor(tenantCode, options = {}) {
    this.tenantCode = tenantCode;
    this.embeddingService = new EmbeddingService(options);
    this.similarityThreshold = options.similarityThreshold || 0.85; // 85% similarity for merge suggestion
    this.suggestThreshold = options.suggestThreshold || 0.65; // 65% for article suggestions
  }

  /**
   * Create a new KB article
   */
  async createArticle(articleData, userId) {
    const connection = await getTenantConnection(this.tenantCode);

    try {
      const articleId = `KB-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // Normalize tags: convert comma-separated string to array if needed
      let tags = articleData.tags || [];
      if (typeof tags === 'string') {
        tags = tags.split(',').map(t => t.trim()).filter(t => t.length > 0);
      }

      // Insert article
      const [result] = await connection.query(`
        INSERT INTO kb_articles (
          article_id, title, content, summary, category, tags, status, visibility,
          source_type, source_ticket_id, created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        articleId,
        articleData.title,
        articleData.content,
        articleData.summary || this.generateSummary(articleData.content),
        articleData.category || 'General',
        JSON.stringify(tags),
        articleData.status || 'draft',
        articleData.visibility || 'internal',
        articleData.source_type || 'manual',
        articleData.source_ticket_id || null,
        userId,
        userId
      ]);

      const newArticleId = result.insertId;

      // Create initial version
      await connection.query(`
        INSERT INTO kb_article_versions (article_id, version_number, title, content, summary, change_reason, created_by)
        VALUES (?, 1, ?, ?, ?, 'Initial creation', ?)
      `, [newArticleId, articleData.title, articleData.content, articleData.summary || '', userId]);

      // Generate and store embedding
      await this.updateArticleEmbedding(newArticleId);

      // Check for similar articles
      await this.detectSimilarArticles(newArticleId);

      // Update category count
      await this.updateCategoryCount(articleData.category || 'General');

      console.log(`📚 Created KB article: ${articleId}`);

      return { id: newArticleId, article_id: articleId };

    } finally {
      connection.release();
    }
  }

  /**
   * Update an existing article
   */
  async updateArticle(articleId, articleData, userId, changeReason = 'Updated') {
    const connection = await getTenantConnection(this.tenantCode);

    try {
      // Get current version number
      const [versions] = await connection.query(
        'SELECT MAX(version_number) as max_version FROM kb_article_versions WHERE article_id = ?',
        [articleId]
      );
      const newVersion = (versions[0].max_version || 0) + 1;

      // Update article
      await connection.query(`
        UPDATE kb_articles SET
          title = COALESCE(?, title),
          content = COALESCE(?, content),
          summary = COALESCE(?, summary),
          category = COALESCE(?, category),
          tags = COALESCE(?, tags),
          status = COALESCE(?, status),
          visibility = COALESCE(?, visibility),
          updated_by = ?,
          published_at = CASE WHEN ? = 'published' AND published_at IS NULL THEN NOW() ELSE published_at END
        WHERE id = ?
      `, [
        articleData.title,
        articleData.content,
        articleData.summary,
        articleData.category,
        articleData.tags ? JSON.stringify(articleData.tags) : null,
        articleData.status,
        articleData.visibility,
        userId,
        articleData.status,
        articleId
      ]);

      // Create new version if content changed
      if (articleData.content || articleData.title) {
        const [article] = await connection.query('SELECT title, content, summary FROM kb_articles WHERE id = ?', [articleId]);
        if (article.length > 0) {
          await connection.query(`
            INSERT INTO kb_article_versions (article_id, version_number, title, content, summary, change_reason, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `, [articleId, newVersion, article[0].title, article[0].content, article[0].summary, changeReason, userId]);
        }
      }

      // Re-generate embedding if content changed
      if (articleData.content) {
        await this.updateArticleEmbedding(articleId);
        await this.detectSimilarArticles(articleId);
      }

      console.log(`📝 Updated KB article #${articleId}`);

      return { success: true, version: newVersion };

    } finally {
      connection.release();
    }
  }

  /**
   * Generate and store embedding for an article
   */
  async updateArticleEmbedding(articleId) {
    const connection = await getTenantConnection(this.tenantCode);

    try {
      // Get article content
      const [articles] = await connection.query(
        'SELECT title, content, summary FROM kb_articles WHERE id = ?',
        [articleId]
      );

      if (articles.length === 0) return;

      const article = articles[0];
      const textToEmbed = `${article.title}\n\n${article.summary || ''}\n\n${article.content}`;

      // Chunk if needed
      const chunks = this.embeddingService.chunkText(textToEmbed);

      // Delete old embeddings
      await connection.query('DELETE FROM kb_article_embeddings WHERE article_id = ?', [articleId]);

      // Generate and store embeddings for each chunk
      for (let i = 0; i < chunks.length; i++) {
        const embedding = await this.embeddingService.generateEmbedding(chunks[i]);
        const embeddingHash = this.embeddingService.generateEmbeddingHash(embedding);

        await connection.query(`
          INSERT INTO kb_article_embeddings (article_id, embedding_model, embedding_vector, embedding_hash, chunk_index, chunk_text)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [
          articleId,
          this.embeddingService.model,
          JSON.stringify(embedding), // MySQL JSON column will store this correctly
          embeddingHash,
          i,
          chunks[i].substring(0, 500) // Store preview of chunk
        ]);
      }

      console.log(`🧮 Generated ${chunks.length} embedding(s) for article #${articleId}`);

    } finally {
      connection.release();
    }
  }

  /**
   * Detect and store similar articles for merge suggestions
   */
  async detectSimilarArticles(articleId) {
    const connection = await getTenantConnection(this.tenantCode);

    try {
      // Get this article's embedding
      const [embeddings] = await connection.query(
        'SELECT embedding_vector FROM kb_article_embeddings WHERE article_id = ? AND chunk_index = 0',
        [articleId]
      );

      if (embeddings.length === 0) return [];

      // MySQL JSON columns return parsed objects, but stringified values need parsing
      const rawVector = embeddings[0].embedding_vector;
      const targetEmbedding = typeof rawVector === 'string' ? JSON.parse(rawVector) : rawVector;

      // Get all other article embeddings
      const [otherEmbeddings] = await connection.query(`
        SELECT kae.article_id, kae.embedding_vector, ka.title
        FROM kb_article_embeddings kae
        JOIN kb_articles ka ON kae.article_id = ka.id
        WHERE kae.article_id != ? AND kae.chunk_index = 0 AND ka.status != 'archived'
      `, [articleId]);

      const similarArticles = [];

      for (const other of otherEmbeddings) {
        const rawOther = other.embedding_vector;
        const otherEmbedding = typeof rawOther === 'string' ? JSON.parse(rawOther) : rawOther;
        const similarity = this.embeddingService.cosineSimilarity(targetEmbedding, otherEmbedding);

        if (similarity >= this.similarityThreshold) {
          // Check if pair already exists
          const [existing] = await connection.query(`
            SELECT id FROM kb_article_similarities
            WHERE (article_id_1 = ? AND article_id_2 = ?) OR (article_id_1 = ? AND article_id_2 = ?)
          `, [articleId, other.article_id, other.article_id, articleId]);

          if (existing.length === 0) {
            // Store similarity (always store smaller ID first for consistency)
            const id1 = Math.min(articleId, other.article_id);
            const id2 = Math.max(articleId, other.article_id);

            await connection.query(`
              INSERT INTO kb_article_similarities (article_id_1, article_id_2, similarity_score, similarity_type)
              VALUES (?, ?, ?, 'combined')
            `, [id1, id2, similarity]);

            similarArticles.push({
              article_id: other.article_id,
              title: other.title,
              similarity: similarity
            });

            console.log(`🔗 Found similar articles: #${articleId} ↔ #${other.article_id} (${(similarity * 100).toFixed(1)}%)`);
          }
        }
      }

      return similarArticles;

    } finally {
      connection.release();
    }
  }

  /**
   * Search KB articles using semantic similarity
   */
  async searchArticles(query, options = {}) {
    const { limit = 10, category = null, status = 'published', minScore = 0.5 } = options;
    const connection = await getTenantConnection(this.tenantCode);

    try {
      // Generate query embedding
      const queryEmbedding = await this.embeddingService.generateEmbedding(query);

      // Get all article embeddings
      let sql = `
        SELECT kae.article_id, kae.embedding_vector, kae.chunk_text,
               ka.article_id as kb_id, ka.title, ka.summary, ka.category, ka.status,
               ka.view_count, ka.helpful_count
        FROM kb_article_embeddings kae
        JOIN kb_articles ka ON kae.article_id = ka.id
        WHERE kae.chunk_index = 0
      `;
      const params = [];

      if (status) {
        sql += ' AND ka.status = ?';
        params.push(status);
      }

      if (category) {
        sql += ' AND ka.category = ?';
        params.push(category);
      }

      const [embeddings] = await connection.query(sql, params);

      // Calculate similarities
      const results = embeddings.map(row => {
        const rawVector = row.embedding_vector;
        const embedding = typeof rawVector === 'string' ? JSON.parse(rawVector) : rawVector;
        const score = this.embeddingService.cosineSimilarity(queryEmbedding, embedding);
        return {
          id: row.article_id,
          article_id: row.kb_id,
          title: row.title,
          summary: row.summary,
          category: row.category,
          score: score,
          view_count: row.view_count,
          helpful_count: row.helpful_count
        };
      });

      // Filter by minimum score and sort
      return results
        .filter(r => r.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

    } finally {
      connection.release();
    }
  }

  /**
   * Suggest KB articles for a ticket
   */
  async suggestArticlesForTicket(ticketId) {
    const connection = await getTenantConnection(this.tenantCode);

    try {
      // Get ticket details
      const [tickets] = await connection.query(
        'SELECT title, description, category FROM tickets WHERE id = ?',
        [ticketId]
      );

      if (tickets.length === 0) {
        return { success: false, error: 'Ticket not found' };
      }

      const ticket = tickets[0];
      const searchText = `${ticket.title} ${ticket.description || ''}`;

      // Search for relevant articles
      const suggestions = await this.searchArticles(searchText, {
        limit: 5,
        status: 'published',
        minScore: this.suggestThreshold
      });

      // Store suggestions
      for (const suggestion of suggestions) {
        await connection.query(`
          INSERT IGNORE INTO ticket_kb_articles (ticket_id, article_id, relevance_score, link_type, suggested_by)
          VALUES (?, ?, ?, 'suggested', 'ai')
        `, [ticketId, suggestion.id, suggestion.score]);
      }

      console.log(`💡 Suggested ${suggestions.length} KB articles for ticket #${ticketId}`);

      return {
        success: true,
        ticketId,
        suggestions: suggestions.map(s => ({
          id: s.id,
          article_id: s.article_id,
          title: s.title,
          summary: s.summary,
          category: s.category,
          score: s.score,
          view_count: s.view_count,
          helpful_count: s.helpful_count
        }))
      };

    } finally {
      connection.release();
    }
  }

  /**
   * Merge two similar articles
   */
  async mergeArticles(sourceArticleId, targetArticleId, userId, options = {}) {
    const connection = await getTenantConnection(this.tenantCode);

    try {
      // Get both articles
      const [articles] = await connection.query(
        'SELECT id, title, content, tags, merged_from FROM kb_articles WHERE id IN (?, ?)',
        [sourceArticleId, targetArticleId]
      );

      if (articles.length !== 2) {
        return { success: false, error: 'One or both articles not found' };
      }

      const source = articles.find(a => a.id === sourceArticleId);
      const target = articles.find(a => a.id === targetArticleId);

      // Merge content (append source to target or use AI to merge)
      let mergedContent = target.content;
      if (options.appendContent !== false) {
        mergedContent += `\n\n---\n\n## Additional Information\n\n${source.content}`;
      }

      // Merge tags - handle various formats (JSON array, pre-parsed, comma-separated string)
      const parseTags = (tags) => {
        if (!tags) return [];
        if (Array.isArray(tags)) return tags;
        if (typeof tags === 'string') {
          try { return JSON.parse(tags); }
          catch (e) { return tags.split(',').map(t => t.trim()).filter(t => t.length > 0); }
        }
        return [];
      };
      const targetTags = parseTags(target.tags);
      const sourceTags = parseTags(source.tags);
      const mergedTags = [...new Set([...targetTags, ...sourceTags])];

      // Track merge history - handle MySQL JSON columns
      const rawMergedFrom = target.merged_from;
      const mergedFrom = typeof rawMergedFrom === 'string' ? JSON.parse(rawMergedFrom || '[]') : (rawMergedFrom || []);
      mergedFrom.push({
        article_id: sourceArticleId,
        title: source.title,
        merged_at: new Date().toISOString(),
        merged_by: userId
      });

      // Update target article
      await connection.query(`
        UPDATE kb_articles SET
          content = ?,
          tags = ?,
          merged_from = ?,
          updated_by = ?
        WHERE id = ?
      `, [mergedContent, JSON.stringify(mergedTags), JSON.stringify(mergedFrom), userId, targetArticleId]);

      // Archive source article
      await connection.query(
        'UPDATE kb_articles SET status = ? WHERE id = ?',
        ['archived', sourceArticleId]
      );

      // Update similarity record
      await connection.query(`
        UPDATE kb_article_similarities SET status = 'merged', reviewed_by = ?, reviewed_at = NOW()
        WHERE (article_id_1 = ? AND article_id_2 = ?) OR (article_id_1 = ? AND article_id_2 = ?)
      `, [userId, sourceArticleId, targetArticleId, targetArticleId, sourceArticleId]);

      // Re-generate embedding for merged article
      await this.updateArticleEmbedding(targetArticleId);

      console.log(`🔀 Merged article #${sourceArticleId} into #${targetArticleId}`);

      return {
        success: true,
        mergedArticleId: targetArticleId,
        archivedArticleId: sourceArticleId
      };

    } finally {
      connection.release();
    }
  }

  /**
   * Get pending merge suggestions
   */
  async getPendingMergeSuggestions(limit = 20) {
    const connection = await getTenantConnection(this.tenantCode);

    try {
      const [suggestions] = await connection.query(`
        SELECT
          kas.id,
          kas.article_id_1,
          kas.article_id_2,
          kas.similarity_score,
          kas.created_at,
          a1.title as title_1,
          a1.article_id as kb_id_1,
          a2.title as title_2,
          a2.article_id as kb_id_2
        FROM kb_article_similarities kas
        JOIN kb_articles a1 ON kas.article_id_1 = a1.id
        JOIN kb_articles a2 ON kas.article_id_2 = a2.id
        WHERE kas.status = 'pending'
          AND a1.status != 'archived'
          AND a2.status != 'archived'
        ORDER BY kas.similarity_score DESC
        LIMIT ?
      `, [limit]);

      return suggestions.map(s => ({
        id: s.id,
        article1: { id: s.article_id_1, kb_id: s.kb_id_1, title: s.title_1 },
        article2: { id: s.article_id_2, kb_id: s.kb_id_2, title: s.title_2 },
        similarity: Math.round(s.similarity_score * 100),
        detected_at: s.created_at
      }));

    } finally {
      connection.release();
    }
  }

  /**
   * Create article from resolved ticket
   */
  async createArticleFromTicket(ticketId, userId, options = {}) {
    const connection = await getTenantConnection(this.tenantCode);

    try {
      // Get ticket with resolution
      const [tickets] = await connection.query(`
        SELECT t.*, u.full_name as requester_name,
               (SELECT description FROM ticket_activity
                WHERE ticket_id = t.id AND activity_type = 'resolution'
                ORDER BY created_at DESC LIMIT 1) as resolution
        FROM tickets t
        LEFT JOIN users u ON t.requester_id = u.id
        WHERE t.id = ?
      `, [ticketId]);

      if (tickets.length === 0) {
        return { success: false, error: 'Ticket not found' };
      }

      const ticket = tickets[0];

      if (!ticket.resolution && ticket.status !== 'Resolved' && ticket.status !== 'Closed') {
        return { success: false, error: 'Ticket is not resolved' };
      }

      // Generate article content
      const title = options.title || `How to: ${ticket.title}`;
      const content = `## Problem\n\n${ticket.description || ticket.title}\n\n## Solution\n\n${ticket.resolution || 'See ticket for resolution details.'}`;

      // Create article
      const article = await this.createArticle({
        title,
        content,
        category: options.category || ticket.category || 'Troubleshooting',
        tags: [ticket.category, ticket.priority].filter(Boolean),
        source_type: 'ticket',
        source_ticket_id: ticketId,
        status: options.publish ? 'published' : 'draft'
      }, userId);

      // Link article to ticket
      await connection.query(`
        INSERT INTO ticket_kb_articles (ticket_id, article_id, link_type, created_by)
        VALUES (?, ?, 'created_from', ?)
      `, [ticketId, article.id, userId]);

      console.log(`📄 Created KB article from ticket #${ticketId}`);

      return {
        success: true,
        article
      };

    } finally {
      connection.release();
    }
  }

  /**
   * Generate a summary from content
   */
  generateSummary(content, maxLength = 200) {
    if (!content) return '';

    // Simple extraction - first paragraph or first N characters
    const firstParagraph = content.split(/\n\n/)[0];
    if (firstParagraph.length <= maxLength) {
      return firstParagraph;
    }

    return firstParagraph.substring(0, maxLength - 3) + '...';
  }

  /**
   * Update category article count
   */
  async updateCategoryCount(categoryName) {
    const connection = await getTenantConnection(this.tenantCode);
    try {
      await connection.query(`
        UPDATE kb_categories SET article_count = (
          SELECT COUNT(*) FROM kb_articles WHERE category = ? AND status = 'published'
        ) WHERE name = ?
      `, [categoryName, categoryName]);
    } finally {
      connection.release();
    }
  }

  /**
   * Record article feedback
   */
  async recordFeedback(articleId, userId, helpful, feedbackText = null, ticketId = null) {
    const connection = await getTenantConnection(this.tenantCode);

    try {
      await connection.query(`
        INSERT INTO kb_article_feedback (article_id, user_id, ticket_id, helpful, feedback_text)
        VALUES (?, ?, ?, ?, ?)
      `, [articleId, userId, ticketId, helpful, feedbackText]);

      // Update article counts
      if (helpful) {
        await connection.query('UPDATE kb_articles SET helpful_count = helpful_count + 1 WHERE id = ?', [articleId]);
      } else {
        await connection.query('UPDATE kb_articles SET not_helpful_count = not_helpful_count + 1 WHERE id = ?', [articleId]);
      }

      return { success: true };
    } finally {
      connection.release();
    }
  }
}

module.exports = { KnowledgeBaseService };
