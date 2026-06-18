import express from "express";
import ytSearch from "yt-search";
import { search as ddgSearch } from "duck-duck-scrape";
import { logInfo, logError } from "../../RK_AI_HOME/utils/logger.js";

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

export default router;
