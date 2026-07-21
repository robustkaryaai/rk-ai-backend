import { logInfo, logError } from "../../utils/logger.js";
import { supabase } from "../supabaseClient.js";

// Abstract interface for Vector Store
export class VectorStore {
  /**
   * Save chunks with metadata to the DB
   * @param {Array<{id: string, slug: string, text: string, metadata: object, embedding: number[]}>} records 
   */
  async upsert(records) {
    throw new Error("Not implemented");
  }

  /**
   * Search for top K most similar vectors
   * @param {number[]} embedding 
   * @param {string} slug 
   * @param {number} topK 
   * @returns {Promise<Array<{text: string, metadata: object, similarity: number}>>}
   */
  async search(embedding, slug, topK = 5) {
    throw new Error("Not implemented");
  }

  /**
   * Check if a document is already indexed
   * @param {string} fileHash 
   * @param {string} slug 
   * @returns {Promise<boolean>}
   */
  async documentExists(fileHash, slug) {
    throw new Error("Not implemented");
  }
}

// Supabase pgvector implementation
export class SupabaseVectorStore extends VectorStore {
  async upsert(records) {
    // Requires a 'documents' table: id, slug, text, metadata, embedding (vector)
    try {
      const { error } = await supabase
        .from('documents')
        .upsert(records);
      
      if (error) throw error;
      logInfo(`[VectorStore] Inserted ${records.length} chunks into Supabase.`);
    } catch (err) {
      logError(`[VectorStore] Supabase upsert error:`, err);
      // Let it fail gracefully or fallback in real app
    }
  }

  async search(embedding, slug, topK = 5) {
    try {
      // Requires an RPC function named 'match_documents'
      const { data, error } = await supabase.rpc('match_documents', {
        query_embedding: embedding,
        match_slug: slug,
        match_threshold: 0.3,
        match_count: topK
      });

      if (error) {
        // If RPC doesn't exist, this will throw
        throw error;
      }
      return data || [];
    } catch (err) {
      logError(`[VectorStore] Supabase search error:`, err);
      return [];
    }
  }

  async documentExists(fileHash, slug) {
    try {
      const { count, error } = await supabase
        .from('documents')
        .select('*', { count: 'exact', head: true })
        .eq('slug', slug)
        .eq('metadata->>fileHash', fileHash);

      if (error) throw error;
      return count > 0;
    } catch (err) {
      logError(`[VectorStore] documentExists error:`, err);
      return false; // Safely return false so it re-indexes on error
    }
  }
}

// Temporary Local Memory Store (Fallback if pgvector is not setup yet)
export class LocalMemoryVectorStore extends VectorStore {
  constructor() {
    super();
    // In production, this would be SQLite/FAISS. For now, a simple array.
    this.memory = [];
  }

  // Simple cosine similarity
  _cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  async upsert(records) {
    this.memory.push(...records);
    logInfo(`[LocalVectorStore] Saved ${records.length} chunks to local memory. Total: ${this.memory.length}`);
  }

  async search(embedding, slug, topK = 5) {
    const userDocs = this.memory.filter(doc => doc.slug === slug);
    const results = userDocs.map(doc => {
      const sim = this._cosineSimilarity(embedding, doc.embedding);
      return { ...doc, similarity: sim };
    });

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
  }
}
