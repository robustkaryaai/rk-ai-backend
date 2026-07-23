import express from "express";
import ytSearch from "yt-search";
import { search as ddgSearch } from "duck-duck-scrape";
import { logInfo, logError } from "../../RK_AI_HOME/utils/logger.js";
import { callGemini } from "../../RK_AI_HOME/services/gemini.js";
import { ensureLimitFile, checkAndConsume } from "../../RK_AI_HOME/limitManager.js";

const router = express.Router();

// Web Search using DuckDuckGo
router.post("/web", async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) {
      return res.status(400).json({ ok: false, error: "Query required" });
    }

    logInfo(`Desktop Web Search: "${query}"`);

    const searchResults = await ddgSearch(query, {
      safeSearch: 0, // 0 = off, 1 = moderate, 2 = strict
      locale: "en-us"
    });

    const formattedResults = searchResults.results.slice(0, 10).map(result => ({
      title: result.title,
      url: result.url,
      snippet: result.description
    }));

    return res.json({ ok: true, results: formattedResults });
  } catch (err) {
    logError("Desktop Web Search Error:", err);
    return res.status(500).json({ ok: false, error: "Web search failed" });
  }
});

// YouTube/Media Search
router.post("/media", async (req, res) => {
  try {
    const { query, platform = "youtube" } = req.body;
    if (!query) {
      return res.status(400).json({ ok: false, error: "Query required" });
    }

    if (platform.toLowerCase() !== "youtube") {
      return res.status(400).json({ ok: false, error: "Only YouTube is supported right now" });
    }

    logInfo(`Desktop YouTube Search: "${query}"`);

    const searchResults = await ytSearch(query);

    const formattedResults = searchResults.videos.slice(0, 10).map(video => ({
      title: video.title,
      url: video.url,
      thumbnail: video.thumbnail,
      duration: video.duration.timestamp,
      views: video.views.toString(),
      author: video.author.name
    }));

    return res.json({ ok: true, platform, results: formattedResults });
  } catch (err) {
    logError("Desktop Media Search Error:", err);
    return res.status(500).json({ ok: false, error: "Media search failed" });
  }
});

// Cloud Deep Research (Agentic Loop)
router.post("/deep-research", async (req, res) => {
  try {
    const rawTopic = req.body.topic || req.body.prompt || req.body.query;
    const topic = typeof rawTopic === "string" ? rawTopic.trim() : null;
    const deviceSlug = req.headers["x-device-slug"];

    if (!topic || !deviceSlug) {
      return res.status(400).json({ ok: false, error: "Topic and device slug required" });
    }

    // Deep Research is a heavy operation, deduct tokens
    const cost = 25000; 
    const limits = await ensureLimitFile(deviceSlug);
    if (!checkAndConsume(limits, "tokens", cost)) {
      return res.status(402).json({ ok: false, error: "Insufficient AI tokens for Deep Research" });
    }

    logInfo(`[Deep Research] Starting cloud deep research for: "${topic}"`);

    // Basic agentic flow for now: Multi-query extraction
    const plannerPrompt = `The user wants deep research on: "${topic}". Generate 3 distinct search queries to gather comprehensive information on this topic. Return only the queries, one per line.`;
    const plannerRes = await callGemini(plannerPrompt, "gemini-2.5-pro");
    const queries = plannerRes.text.split("\\n").map(q => q.trim()).filter(q => q.length > 0);
    
    let allFindings = "";
    for (const query of queries) {
      const searchResults = await ddgSearch(query, { safeSearch: 1 });
      const topResults = searchResults.results.slice(0, 3).map(r => `Title: ${r.title}\\nSnippet: ${r.description}\\nURL: ${r.url}`).join("\\n\\n");
      allFindings += `### Search: ${query}\\n${topResults}\\n\\n`;
    }

    const synthesisPrompt = `You are a research analyst. Synthesize the following search findings into a comprehensive, deeply detailed Markdown report about "${topic}".\\n\\nFindings:\\n${allFindings}\\n\\nEnsure you cite URLs where appropriate.`;
    const finalReport = await callGemini(synthesisPrompt, "gemini-2.5-pro");

    return res.json({
      ok: true,
      report: finalReport.text,
      tokensConsumed: cost
    });

  } catch (err) {
    logError("[Deep Research] Error:", err);
    return res.status(500).json({ ok: false, error: "Cloud Deep Research failed" });
  }
});

export default router;
