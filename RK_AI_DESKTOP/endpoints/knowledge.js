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

export default router;
