/**
 * Migration: Add Knowledge Base tables with embedding support
 * Creates tables for KB articles, versions, embeddings, and feedback
 */

const { getTenantConnection } = require('../config/database');

async function runMigration(tenantCode) {
  const connection = await getTenantConnection(tenantCode);

  try {
    console.log(`  Running Knowledge Base migration for ${tenantCode}...`);

    // Main KB articles table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS kb_articles (
        id INT PRIMARY KEY AUTO_INCREMENT,
        article_id VARCHAR(50) UNIQUE NOT NULL,
        title VARCHAR(500) NOT NULL,
        content LONGTEXT NOT NULL,
        summary TEXT,
        category VARCHAR(100) DEFAULT 'General',
        tags JSON,
        status ENUM('draft', 'published', 'archived') DEFAULT 'draft',
        visibility ENUM('public', 'internal', 'restricted') DEFAULT 'internal',
        view_count INT DEFAULT 0,
        helpful_count INT DEFAULT 0,
        not_helpful_count INT DEFAULT 0,
        source_type ENUM('manual', 'ticket', 'ai_generated', 'imported') DEFAULT 'manual',
        source_ticket_id INT NULL,
        merged_from JSON,
        created_by INT,
        updated_by INT,
        published_at DATETIME,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id),
        FOREIGN KEY (updated_by) REFERENCES users(id),
        FOREIGN KEY (source_ticket_id) REFERENCES tickets(id) ON DELETE SET NULL,
        INDEX idx_status (status),
        INDEX idx_category (category),
        INDEX idx_visibility (visibility),
        INDEX idx_created (created_at),
        FULLTEXT INDEX ft_title_content (title, content)
      )
    `);
    console.log('    ✓ Created kb_articles table');

    // Article version history for tracking changes
    await connection.query(`
      CREATE TABLE IF NOT EXISTS kb_article_versions (
        id INT PRIMARY KEY AUTO_INCREMENT,
        article_id INT NOT NULL,
        version_number INT NOT NULL,
        title VARCHAR(500) NOT NULL,
        content LONGTEXT NOT NULL,
        summary TEXT,
        change_reason TEXT,
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (article_id) REFERENCES kb_articles(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id),
        UNIQUE KEY unique_article_version (article_id, version_number),
        INDEX idx_article (article_id)
      )
    `);
    console.log('    ✓ Created kb_article_versions table');

    // Vector embeddings for semantic search
    await connection.query(`
      CREATE TABLE IF NOT EXISTS kb_article_embeddings (
        id INT PRIMARY KEY AUTO_INCREMENT,
        article_id INT NOT NULL,
        embedding_model VARCHAR(100) NOT NULL,
        embedding_vector JSON NOT NULL,
        embedding_hash VARCHAR(64),
        chunk_index INT DEFAULT 0,
        chunk_text TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (article_id) REFERENCES kb_articles(id) ON DELETE CASCADE,
        UNIQUE KEY unique_article_chunk (article_id, chunk_index),
        INDEX idx_article (article_id),
        INDEX idx_model (embedding_model)
      )
    `);
    console.log('    ✓ Created kb_article_embeddings table');

    // User feedback on articles
    await connection.query(`
      CREATE TABLE IF NOT EXISTS kb_article_feedback (
        id INT PRIMARY KEY AUTO_INCREMENT,
        article_id INT NOT NULL,
        user_id INT,
        ticket_id INT,
        helpful BOOLEAN NOT NULL,
        feedback_text TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (article_id) REFERENCES kb_articles(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE SET NULL,
        INDEX idx_article (article_id),
        INDEX idx_user (user_id)
      )
    `);
    console.log('    ✓ Created kb_article_feedback table');

    // Link KB articles to tickets (for suggestions)
    await connection.query(`
      CREATE TABLE IF NOT EXISTS ticket_kb_articles (
        id INT PRIMARY KEY AUTO_INCREMENT,
        ticket_id INT NOT NULL,
        article_id INT NOT NULL,
        relevance_score DECIMAL(5,4),
        link_type ENUM('suggested', 'resolved_with', 'referenced', 'created_from') DEFAULT 'suggested',
        suggested_by ENUM('ai', 'manual', 'auto') DEFAULT 'ai',
        viewed_by_agent BOOLEAN DEFAULT FALSE,
        sent_to_customer BOOLEAN DEFAULT FALSE,
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
        FOREIGN KEY (article_id) REFERENCES kb_articles(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id),
        UNIQUE KEY unique_ticket_article (ticket_id, article_id),
        INDEX idx_ticket (ticket_id),
        INDEX idx_article (article_id),
        INDEX idx_relevance (relevance_score)
      )
    `);
    console.log('    ✓ Created ticket_kb_articles table');

    // Similar/duplicate article tracking for merge suggestions
    await connection.query(`
      CREATE TABLE IF NOT EXISTS kb_article_similarities (
        id INT PRIMARY KEY AUTO_INCREMENT,
        article_id_1 INT NOT NULL,
        article_id_2 INT NOT NULL,
        similarity_score DECIMAL(5,4) NOT NULL,
        similarity_type ENUM('content', 'title', 'combined') DEFAULT 'combined',
        status ENUM('pending', 'merged', 'dismissed', 'reviewed') DEFAULT 'pending',
        reviewed_by INT,
        reviewed_at DATETIME,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (article_id_1) REFERENCES kb_articles(id) ON DELETE CASCADE,
        FOREIGN KEY (article_id_2) REFERENCES kb_articles(id) ON DELETE CASCADE,
        FOREIGN KEY (reviewed_by) REFERENCES users(id),
        UNIQUE KEY unique_pair (article_id_1, article_id_2),
        INDEX idx_score (similarity_score),
        INDEX idx_status (status)
      )
    `);
    console.log('    ✓ Created kb_article_similarities table');

    // Categories for organizing KB
    await connection.query(`
      CREATE TABLE IF NOT EXISTS kb_categories (
        id INT PRIMARY KEY AUTO_INCREMENT,
        name VARCHAR(100) NOT NULL,
        slug VARCHAR(100) NOT NULL,
        description TEXT,
        parent_id INT,
        icon VARCHAR(50),
        sort_order INT DEFAULT 0,
        article_count INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (parent_id) REFERENCES kb_categories(id) ON DELETE SET NULL,
        UNIQUE KEY unique_slug (slug),
        INDEX idx_parent (parent_id)
      )
    `);
    console.log('    ✓ Created kb_categories table');

    // Insert default categories
    await connection.query(`
      INSERT IGNORE INTO kb_categories (name, slug, description, icon, sort_order) VALUES
      ('General', 'general', 'General knowledge articles', '📄', 1),
      ('Troubleshooting', 'troubleshooting', 'Common issues and solutions', '🔧', 2),
      ('How-To Guides', 'how-to', 'Step-by-step instructions', '📋', 3),
      ('FAQs', 'faqs', 'Frequently asked questions', '❓', 4),
      ('Best Practices', 'best-practices', 'Recommended approaches', '✨', 5),
      ('Technical Documentation', 'technical', 'Technical reference materials', '📚', 6)
    `);
    console.log('    ✓ Inserted default KB categories');

    console.log(`  ✓ Knowledge Base migration completed for ${tenantCode}`);

  } catch (error) {
    if (error.code === 'ER_TABLE_EXISTS_ERROR') {
      console.log('    Tables already exist, skipping...');
    } else {
      console.error(`  ✗ Migration error: ${error.message}`);
      throw error;
    }
  } finally {
    connection.release();
  }
}

module.exports = { runMigration };
