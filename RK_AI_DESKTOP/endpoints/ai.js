
import express from "express";
import { callGemini, listGeminiModels } from "../../RK_AI_HOME/services/gemini.js";
import { logInfo, logError } from "../../RK_AI_HOME/utils/logger.js";

const router = express.Router();

// List available AI models
router.get("/models", async (req, res) => {
  try {
    const models = await listGeminiModels();
    return res.json({ ok: true, models });
  } catch (err) {
    logError("Desktop AI Models Error:", err);
    return res.status(500).json({ ok: false, error: "Failed to fetch models" });
  }
});

// Generate AI response (streaming or JSON)
router.post("/generate", async (req, res) => {
  try {
    const { prompt, model, stream = false } = req.body;
    if (!prompt) {
      return res.status(400).json({ ok: false, error: "Prompt required" });
    }

    logInfo(`Desktop AI Generate: Using model ${model || "default"}`);

    if (stream) {
      // Set headers for streaming
      res.writeHead(200, {
        "Content-Type": "text/plain",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      });

      // Call our existing Gemini service
      const result = await callGemini(prompt);
      res.write(result);
      res.end();
    } else {
      const result = await callGemini(prompt);
      return res.json({ ok: true, response: result });
    }
  } catch (err) {
    logError("Desktop AI Generate Error:", err);
    return res.status(500).json({ ok: false, error: "AI generation failed" });
  }
});

export default router;
