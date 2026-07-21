import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import { logInfo, logError } from "../../utils/logger.js";
import { Parser } from "./parser.js";
import { Chunker } from "./chunker.js";
import { FastEmbedProvider } from "./embedding_provider.js";
import { Retriever } from "./retriever.js";

const embedder = new FastEmbedProvider();
const chunker = new Chunker(1000, 200);

/**
 * Main orchestration for RAG insertion and retrieval.
 */
export class KnowledgeEngine {
  
  /**
   * Process a document in the background: Parse -> Chunk -> Embed -> Store
   * @param {Buffer} buffer 
   * @param {string} filename 
   * @param {string} slug 
   */
  static async processDocumentForRAG(buffer, filename, slug) {
    try {
      logInfo(`[KnowledgeEngine] Starting background indexing for ${filename} (${slug})`);
      
      const fileHash = crypto.createHash("md5").update(buffer).digest("hex");
      const vectorStore = Retriever.getVectorStore();
      
      if (vectorStore.documentExists) {
        const exists = await vectorStore.documentExists(fileHash, slug);
        if (exists) {
          logInfo(`[KnowledgeEngine] Document ${filename} (hash: ${fileHash}) is already cached. Skipping OCR/Gemini.`);
          return;
        }
      }
      
      // 1. Parse
      const text = await Parser.parse(buffer, filename);
      if (!text || text.trim().length === 0) {
        logInfo(`[KnowledgeEngine] Skipped empty/unparseable document: ${filename}`);
        return;
      }
      
      // 2. Chunk
      const chunks = chunker.chunkText(text);
      if (chunks.length === 0) return;
      logInfo(`[KnowledgeEngine] Document parsed into ${chunks.length} chunks.`);

      // 3. Embed (Process in batches to avoid RAM spikes)
      const batchSize = 50;
      const docId = uuidv4();
      
      for (let i = 0; i < chunks.length; i += batchSize) {
        const chunkBatch = chunks.slice(i, i + batchSize);
        const embeddings = await embedder.embed(chunkBatch);
        
        // 4. Form records
        const records = chunkBatch.map((chunkText, idx) => ({
          id: uuidv4(),
          slug: slug,
          text: chunkText,
          metadata: {
            documentId: docId,
            filename: filename,
            fileHash: fileHash,
            chunkIndex: i + idx,
            hash: crypto.createHash("md5").update(chunkText).digest("hex"),
            timestamp: new Date().toISOString()
          },
          embedding: embeddings[idx]
        }));
        
        // 5. Store
        try {
          if (Retriever.getUseSupabase()) {
            await Retriever.getSupabaseStore().upsert(records);
          } else {
            await Retriever.getFallbackStore().upsert(records);
          }
        } catch (dbErr) {
          if (Retriever.getUseSupabase() && dbErr.message && (dbErr.message.includes('relation "documents" does not exist') || dbErr.message.includes('match_documents'))) {
            logInfo(`[KnowledgeEngine] pgvector not detected on Supabase. Falling back to local memory store.`);
            Retriever.setUseSupabase(false);
            await Retriever.getFallbackStore().upsert(records);
          } else {
            throw dbErr;
          }
        }
      }
      
      logInfo(`[KnowledgeEngine] Successfully indexed ${filename}.`);
      
    } catch (err) {
      logError(`[KnowledgeEngine] Failed to process document ${filename}:`, err);
    }
  }

  /**
   * Semantic search across all indexed chunks for a specific user slug.
   * Delegates to Retriever module.
   */
  static async search(query, slug, topK = 5) {
    return await Retriever.search(query, slug, topK);
  }
}
