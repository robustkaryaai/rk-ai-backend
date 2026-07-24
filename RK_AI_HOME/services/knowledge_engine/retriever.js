import { logInfo, logError } from "../../utils/logger.js";
import { FastEmbedProvider } from "./embedding_provider.js";
import { SupabaseVectorStore, LocalMemoryVectorStore } from "./vector_store.js";

// Keep static instances of stores and embedder
const embedder = new FastEmbedProvider();
const supabaseStore = new SupabaseVectorStore();
const fallbackStore = new LocalMemoryVectorStore();
let useSupabase = true;

/**
 * Handles all semantic retrieval logic.
 */
export class Retriever {
  
  static getFallbackStore() {
    return fallbackStore;
  }

  static getSupabaseStore() {
    return supabaseStore;
  }
  
  static getUseSupabase() {
    return useSupabase;
  }
  
  static getVectorStore() {
    return useSupabase ? supabaseStore : fallbackStore;
  }
  
  static setUseSupabase(val) {
    useSupabase = val;
  }

  /**
   * Search vector store for relevant chunks
   * @param {string} query 
   * @param {string} slug 
   * @param {number} topK 
   * @returns {Promise<Array>} Array of chunk objects
   */
  static async search(query, slug, topK = 5) {
    try {
      logInfo(`[Retriever] Semantic search for: "${query}"`);
      
      const embeddings = await embedder.embed([query]);
      if (!embeddings || embeddings.length === 0) return [];
      
      const queryVector = embeddings[0];
      
      let results = [];
      if (useSupabase) {
        try {
          results = await supabaseStore.search(queryVector, slug, topK);
        } catch (err) {
          // If RPC is missing, fallback to local
          useSupabase = false;
          results = await fallbackStore.search(queryVector, slug, topK);
        }
      } else {
        results = await fallbackStore.search(queryVector, slug, topK);
      }
      
      logInfo(`[Retriever] Search found ${results.length} relevant chunks.`);
      return results;
    } catch (err) {
      logError(`[Retriever] Search failed:`, err);
      return [];
    }
  }
}
