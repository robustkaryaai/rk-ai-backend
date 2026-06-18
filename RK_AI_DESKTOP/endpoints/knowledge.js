import express from "express";
import multer from "multer";
import { callGemini } from "../../RK_AI_HOME/services/gemini.js";
import { saveFileToSlug, listFilesFromSlug } from "../../RK_AI_HOME/services/supabaseClient.js";
import { logInfo, logError } from "../../RK_AI_HOME/utils/logger.js";

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

    logInfo(`Desktop Knowledge Upload: "${req.file.originalname}"`);
    const filename = `${Date.now()}_${req.file.originalname}`;
    await saveFileToSlug(deviceSlug, filename, req.file.buffer);
    return res.json({
      ok: true,
      message: "File uploaded successfully",
      file: {
        name: filename,
        originalName: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype
      }
    });
  } catch (err) {
    logError("Desktop Knowledge Upload Error:", err);
    return res.status(500).json({ ok: false, error: "File upload failed" });
  }
});

// Query knowledge base
router.post("/query", async (req, res) => {
  try {
    const { query, slug } = req.body;
    const deviceSlug = req.headers["x-device-slug"] || slug;
    if (!query || !deviceSlug) {
      return res.status(400).json({ ok: false, error: "Query and slug required" });
    }

    logInfo(`Desktop Knowledge Query: "${query}"`);
    
    // List files in user's storage
    const files = await listFilesFromSlug(deviceSlug);
    
    // For now, we'll just tell Gemini to answer (in a real RAG system, you'd process files into vectors)
    // This is a simple implementation
    const prompt = `Answer this query using the context that we have files available (but we don't have their content yet, since this is a basic implementation). Query: ${query}`;
    const aiResponse = await callGemini("", "", prompt);
    
    return res.json({
      ok: true,
      answer: aiResponse,
      availableFiles: files,
      message: "Note: Full RAG (file content processing) will be added in a future update"
    });
  } catch (err) {
    logError("Desktop Knowledge Query Error:", err);
    return res.status(500).json({ ok: false, error: "Knowledge query failed" });
  }
});

export default router;
