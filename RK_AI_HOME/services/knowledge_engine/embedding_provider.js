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

// Transformers.js Implementation (Reliable HuggingFace fallback)
export class FastEmbedProvider extends EmbeddingProvider {
  constructor(modelName = "Xenova/bge-small-en-v1.5") {
    super();
    this.modelName = modelName;
    this.model = null;
    this.mockFallback = false;
  }

  async init() {
    if (this.model || this.mockFallback) return;
    try {
      const { pipeline } = await import("@xenova/transformers");
      logInfo(`[Transformers] Initializing model: ${this.modelName}...`);
      this.model = await pipeline("feature-extraction", this.modelName);
      logInfo(`[Transformers] Model ready.`);
    } catch (err) {
      logError(`[Transformers] Failed to initialize, falling back to mock embeddings:`, err.message);
      this.mockFallback = true;
    }
  }

  async embed(texts) {
    await this.init();
    try {
      const results = [];
      for (let i = 0; i < texts.length; i++) {
        if (this.mockFallback) {
          // 384 dimensions for bge-small-en
          const dummy = new Array(384).fill(0).map((_, idx) => Math.sin(i + idx));
          results.push(dummy);
        } else {
          const output = await this.model(texts[i], { pooling: "mean", normalize: true });
          results.push(Array.from(output.data));
        }
      }
      return results;
    } catch (err) {
      logError(`[Transformers] Embedding failed:`, err);
      return [];
    }
  }
}
