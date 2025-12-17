/**
 * Embedding Service
 * Provides vector embeddings for KB articles and tickets using Claude/Voyage AI
 * Supports semantic search and similarity matching
 */

require('dotenv').config();
const crypto = require('crypto');

class EmbeddingService {
  constructor(options = {}) {
    this.provider = options.provider || process.env.EMBEDDING_PROVIDER || 'anthropic';
    this.apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY || process.env.VOYAGE_API_KEY;
    this.model = options.model || this.getDefaultModel();
    this.maxChunkSize = options.maxChunkSize || 2000; // characters per chunk
    this.chunkOverlap = options.chunkOverlap || 200;
  }

  getDefaultModel() {
    switch (this.provider) {
      case 'voyage':
        return 'voyage-2';
      case 'openai':
        return 'text-embedding-3-small';
      case 'anthropic':
      default:
        return 'claude-3-haiku-20240307'; // Use Claude for embeddings via message API
    }
  }

  /**
   * Generate embedding for text
   * @param {string} text - Text to embed
   * @returns {Promise<number[]>} - Embedding vector
   */
  async generateEmbedding(text) {
    if (!text || text.trim().length === 0) {
      throw new Error('Text is required for embedding generation');
    }

    // Clean and normalize text
    const cleanText = this.normalizeText(text);

    if (this.provider === 'voyage' && this.apiKey) {
      return await this.generateVoyageEmbedding(cleanText);
    } else if (this.provider === 'openai' && this.apiKey) {
      return await this.generateOpenAIEmbedding(cleanText);
    } else {
      // Fallback to simple hash-based pseudo-embedding for testing
      // In production, you'd want a real embedding model
      return this.generateSimpleEmbedding(cleanText);
    }
  }

  /**
   * Generate embeddings using Voyage AI (recommended for production)
   */
  async generateVoyageEmbedding(text) {
    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
        input_type: 'document'
      })
    });

    if (!response.ok) {
      throw new Error(`Voyage API error: ${response.status}`);
    }

    const data = await response.json();
    return data.data[0].embedding;
  }

  /**
   * Generate embeddings using OpenAI
   */
  async generateOpenAIEmbedding(text) {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        input: text
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    return data.data[0].embedding;
  }

  /**
   * Simple embedding fallback using text features
   * This creates a deterministic embedding based on text characteristics
   * Good for testing but not as accurate as real embeddings
   */
  generateSimpleEmbedding(text) {
    const dimensions = 256; // Smaller dimension for simple embedding
    const embedding = new Array(dimensions).fill(0);

    // Normalize text
    const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const uniqueWords = [...new Set(words)];

    // Generate features
    for (let i = 0; i < uniqueWords.length; i++) {
      const word = uniqueWords[i];
      const hash = this.hashString(word);

      // Distribute word influence across multiple dimensions
      for (let j = 0; j < 4; j++) {
        const idx = Math.abs(hash + j * 17) % dimensions;
        const value = ((hash >> (j * 8)) & 0xFF) / 255.0;
        embedding[idx] += value * (1 / (i + 1)); // Decay by position
      }
    }

    // Add text statistics
    embedding[0] = Math.min(words.length / 500, 1); // Word count normalized
    embedding[1] = Math.min(uniqueWords.length / 200, 1); // Vocabulary richness
    embedding[2] = text.split(/[.!?]/).length / 50; // Sentence count normalized
    embedding[3] = (text.match(/\b(error|issue|problem|fail|broken)\b/gi) || []).length / 10;
    embedding[4] = (text.match(/\b(how|what|why|when|where)\b/gi) || []).length / 10;

    // Normalize to unit vector
    const magnitude = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    if (magnitude > 0) {
      for (let i = 0; i < dimensions; i++) {
        embedding[i] /= magnitude;
      }
    }

    return embedding;
  }

  /**
   * Simple string hash function
   */
  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  /**
   * Normalize text for embedding
   */
  normalizeText(text) {
    return text
      .replace(/\s+/g, ' ')
      .replace(/[^\w\s.,!?-]/g, '')
      .trim()
      .substring(0, 8000); // Limit text length
  }

  /**
   * Calculate cosine similarity between two embeddings
   * @param {number[]} embedding1
   * @param {number[]} embedding2
   * @returns {number} - Similarity score between 0 and 1
   */
  cosineSimilarity(embedding1, embedding2) {
    if (embedding1.length !== embedding2.length) {
      throw new Error('Embeddings must have the same dimension');
    }

    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < embedding1.length; i++) {
      dotProduct += embedding1[i] * embedding2[i];
      norm1 += embedding1[i] * embedding1[i];
      norm2 += embedding2[i] * embedding2[i];
    }

    const magnitude = Math.sqrt(norm1) * Math.sqrt(norm2);
    if (magnitude === 0) return 0;

    return dotProduct / magnitude;
  }

  /**
   * Split text into chunks for embedding
   * Useful for long documents
   */
  chunkText(text) {
    const chunks = [];
    const sentences = text.split(/(?<=[.!?])\s+/);
    let currentChunk = '';

    for (const sentence of sentences) {
      if ((currentChunk + sentence).length > this.maxChunkSize) {
        if (currentChunk) {
          chunks.push(currentChunk.trim());
        }
        currentChunk = sentence;
      } else {
        currentChunk += (currentChunk ? ' ' : '') + sentence;
      }
    }

    if (currentChunk) {
      chunks.push(currentChunk.trim());
    }

    return chunks.length > 0 ? chunks : [text];
  }

  /**
   * Generate a hash of the embedding for change detection
   */
  generateEmbeddingHash(embedding) {
    const str = embedding.slice(0, 20).map(v => v.toFixed(6)).join(',');
    return crypto.createHash('md5').update(str).digest('hex');
  }

  /**
   * Find most similar items from a list
   * @param {number[]} queryEmbedding - The embedding to compare against
   * @param {Array<{id: number, embedding: number[]}>} items - Items to search
   * @param {number} topK - Number of results to return
   * @returns {Array<{id: number, score: number}>}
   */
  findSimilar(queryEmbedding, items, topK = 5) {
    const scores = items.map(item => ({
      id: item.id,
      score: this.cosineSimilarity(queryEmbedding, item.embedding)
    }));

    return scores
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

module.exports = { EmbeddingService };
