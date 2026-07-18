import { logError, logInfo } from "../../utils/logger.js";

// Abstract interface for Embedding Providers
export class EmbeddingProvider {
  /**
   * Initialize the provider (download models if needed)
   */
  async init() {
    throw new Error("Not implemented");
  }

  /**
   * Embed an array of texts.
   * @param {string[]} texts
   * @returns {Promise<number[][]>} Array of vectors
   */
  async embed(texts) {
    throw new Error("Not implemented");
  }
}

// FastEmbed Implementation
export class FastEmbedProvider extends EmbeddingProvider {
  constructor(modelName = "Xenova/bge-small-en-v1.5") {
    super();
    this.modelName = modelName;
    this.model = null;
  }

  async init() {
    if (this.model) return;
    try {
      // Dynamic import
      const { FlagEmbedding } = await import("fastembed");
      logInfo(`[FastEmbed] Initializing model: ${this.modelName}...`);
      this.model = await FlagEmbedding.init({ model: this.modelName });
      logInfo(`[FastEmbed] Model ready.`);
    } catch (err) {
      logError(`[FastEmbed] Failed to initialize:`, err);
      throw err;
    }
  }

  async embed(texts) {
    await this.init();
    try {
      // FastEmbed generates an AsyncGenerator
      const embeddingsGenerator = this.model.queryEmbed(texts);
      const results = [];
      for await (const batch of embeddingsGenerator) {
        // fastembed yields Float32Arrays. Convert to standard arrays.
        results.push(Array.from(batch));
      }
      return results;
    } catch (err) {
      logError(`[FastEmbed] Embedding failed:`, err);
      return [];
    }
  }
}
