import express from "express";
import multer from "multer";
import { saveFileToSlug, listFilesFromSlug } from "../../RK_AI_HOME/services/supabaseClient.js";
import { logInfo, logError } from "../../RK_AI_HOME/utils/logger.js";
import { KnowledgeEngine } from "../../RK_AI_HOME/services/knowledge_engine/knowledge_engine.js";

const router = express.Router();

// Configure multer for file uploads (memory storage)
const upload = multer({ storage: multer.memoryStorage() });

// Upload file to knowledge base
router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const { slug } = req.body;
    const deviceSlug = req.headers["x-device-slug"] || slug;
    if (!req.file || !deviceSlug) {
      return res.status(400).json({ ok: false, error: "File and slug required" });
    }

    logInfo(`[Knowledge Endpoint] Upload: "${req.file.originalname}"`);
    const filename = `${Date.now()}_${req.file.originalname}`;
    
    // 1. Save file to storage
    await saveFileToSlug(deviceSlug, filename, req.file.buffer);
    
    // 2. Return immediately as per Pro architecture
    res.json({
      ok: true,
      message: "File uploaded successfully. Background indexing started.",
      file: {
        name: filename,
        originalName: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype
      }
    });

    // 3. Spawn background indexing task
    setImmediate(() => {
      KnowledgeEngine.processDocumentForRAG(req.file.buffer, filename, deviceSlug)
        .catch(err => logError(`[Knowledge Endpoint] Background indexing error for ${filename}:`, err));
    });

  } catch (err) {
    logError("[Knowledge Endpoint] Upload Error:", err);
    // Don't double-respond if we already did, but here we haven't responded yet if it crashes early
    if (!res.headersSent) {
      return res.status(500).json({ ok: false, error: "File upload failed" });
    }
  }
});

// Query knowledge base
router.post("/query", async (req, res) => {
  try {
    const { query, slug, topK = 5 } = req.body;
    const deviceSlug = req.headers["x-device-slug"] || slug;
    if (!query || !deviceSlug) {
      return res.status(400).json({ ok: false, error: "Query and slug required" });
    }

    logInfo(`[Knowledge Endpoint] Retrieval Query: "${query}"`);
    
    // 1. Retrieve most relevant chunks from the Knowledge Engine
    const chunks = await KnowledgeEngine.search(query, deviceSlug, topK);
    
    // 2. We also provide the raw list of files just in case the desktop wants to display them
    const files = await listFilesFromSlug(deviceSlug);
    
    // 3. DO NOT CALL GEMINI. Return the chunks directly to Desktop/Qwen.
    return res.json({
      ok: true,
      chunks: chunks.map(c => ({
        text: c.text,
        metadata: c.metadata,
        similarity: c.similarity
      })),
      availableFiles: files,
      message: chunks.length > 0 ? "Chunks retrieved successfully" : "No relevant context found."
    });

  } catch (err) {
    logError("[Knowledge Endpoint] Query Error:", err);
    return res.status(500).json({ ok: false, error: "Knowledge retrieval failed" });
  }
});

// Hybrid RAG Cloud Escalation: Reason over locally provided chunks
router.post("/generate-rag", async (req, res) => {
  try {
    const { query, chunks, slug } = req.body;
    const deviceSlug = req.headers["x-device-slug"] || slug;

    if (!query || !deviceSlug || !chunks || !Array.isArray(chunks)) {
      return res.status(400).json({ ok: false, error: "Query, deviceSlug, and chunks array required" });
    }

    logInfo(`[Knowledge Endpoint] Cloud RAG Generation for "${query}" with ${chunks.length} chunks`);

    const { getSubscriptionStatus } = await import("../../RK_AI_HOME/services/appwriteClient.js");
    const { checkAndConsume } = await import("../../RK_AI_HOME/limitManager.js");
    
    // Exact Billing Buffer Check
    const subStatus = await getSubscriptionStatus(deviceSlug, req.headers["x-user-email"]);
    const consumeRes = await checkAndConsume(deviceSlug, subStatus.tier, "tokens", 1000);
    if (!consumeRes.ok) {
      return res.status(402).json({ ok: false, error: "Insufficient AI tokens for RAG generation" });
    }

    // Prepare context
    const contextStr = chunks.map((c, i) => `--- Chunk ${i+1} ---\n${c}`).join("\n\n");
    const systemPrompt = `You are an expert Document Analysis AI. Answer the user's query strictly using the provided context chunks.
Do not hallucinate facts outside the context.
If the context does not contain the answer, say "I cannot find the answer in the provided document chunks."

CRITICAL CITATION RULES:
1. Every factual claim MUST be followed by an exact inline citation referencing the chunk (e.g., [Chunk 1]).
2. When quoting directly from the text, use markdown blockquotes (>) and append the chunk number.
Example:
> "The revenue increased by 20% in Q3." [Chunk 2]
`;

    const finalPrompt = `Context:\n${contextStr}\n\nQuery: ${query}`;

    const { callGemini } = await import("../../RK_AI_HOME/services/gemini.js");

    // Strictly enforce Gemma model for RAG reasoning as requested
    const result = await callGemini(
      systemPrompt, 
      [], 
      finalPrompt, 
      2, 
      null, 
      "gemma-4-26b-a4b-it", 
      deviceSlug, 
      false, 
      true // returnMetadata = true
    );

    const textOutput = typeof result === "object" ? result.text : result;
    const metadata = typeof result === "object" ? result.metadata : null;

    if (metadata) {
       metadata.remaining_quota = Math.max(0, consumeRes.allowed - (consumeRes.used + metadata.total_tokens));
    }

    return res.json({
        ok: true,
        answer: textOutput,
        metadata: metadata
    });

  } catch (err) {
    logError("[Knowledge Endpoint] RAG Generate Error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
