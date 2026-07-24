import express from "express";
import ytSearch from "yt-search";
import axios from "axios";
// Removed unstable duck-duck-scrape import

async function robustSearch(query) {
  // 1. Try LangSearch API (Primary)
  const langSearchKey = process.env.LANGSEARCH_API_KEY || "sk-d2dd78018749414e917eee25412d27cf";
  if (langSearchKey) {
    try {
      const res = await axios.post("https://api.langsearch.com/v1/web-search", 
        { query: query, freshness: "noLimit", summary: true, count: 10 },
        {
          headers: {
            "Authorization": `Bearer ${langSearchKey}`,
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "X-Forwarded-For": "68.21.43.12",
            "Referer": "https://www.google.com/"
          }
        }
      );
      if (res.status === 200 && res.data?.data?.webPages?.value) {
          return { results: res.data.data.webPages.value.map(r => ({ title: r.name, url: r.url, description: r.summary || r.snippet })) };
      }
    } catch (e) {
      console.error("LangSearch error:", e.response ? e.response.status : e.message);
    }
  }

  // 2. Try Brave Search API
  if (process.env.BRAVE_API_KEY) {
    try {
      const res = await fetch("https://api.search.brave.com/res/v1/web/search?q=" + encodeURIComponent(query), {
        headers: { "X-Subscription-Token": process.env.BRAVE_API_KEY }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.web && data.web.results) {
          return { results: data.web.results.map(r => ({ title: r.title, url: r.url, description: r.description })) };
        }
      }
    } catch (e) {
      console.error("Brave Search failed:", e.message);
    }
  }

  // 3. Try Tavily API
  if (process.env.TAVILY_API_KEY) {
    try {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.results) {
          return { results: data.results.map(r => ({ title: r.title, url: r.url, description: r.content })) };
        }
      }
    } catch (e) {
      console.error("Tavily Search failed:", e.message);
    }
  }

  // 4. Try Wikipedia API (Ultimate Free Fallback, No Key Required, No 403s)
  console.log("Falling back to Wikipedia API...");
  try {
      const res = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&utf8=&format=json`);
      if (res.ok) {
          const data = await res.json();
          if (data.query && data.query.search) {
              return { 
                  results: data.query.search.map(r => ({ 
                      title: r.title, 
                      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`, 
                      description: r.snippet.replace(/<[^>]*>?/gm, '') 
                  })) 
              };
          }
      }
  } catch (e) {
      console.error("Wikipedia Search failed:", e.message);
  }

  return { results: [] };
}
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

    const searchResults = await robustSearch(query);

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

// Cloud Deep Research (Native Gemini Search Grounding)
router.post("/deep-research", async (req, res) => {
  try {
    const rawTopic = req.body.topic || req.body.prompt || req.body.query;
    const topic = typeof rawTopic === "string" ? rawTopic.trim() : null;
    const deviceSlug = req.headers["x-device-slug"];

    if (!topic || !deviceSlug) {
      return res.status(400).json({ ok: false, error: "Topic and device slug required" });
    }

    // 1. Verify user has enough quota buffer (e.g. 5,000 tokens) to safely start
    const minRequired = 5000;
    const { getSubscriptionStatus } = await import("../../RK_AI_HOME/services/appwriteClient.js");
    const subStatus = await getSubscriptionStatus(deviceSlug, req.headers["x-user-email"]);
    
    // checkAndConsume just verifies quota for "tokens", it doesn't deduct yet.
    const consumeRes = await checkAndConsume(deviceSlug, subStatus.tier, "tokens", minRequired);
    if (!consumeRes.ok) {
      return res.status(402).json({ ok: false, error: "Insufficient AI tokens for Deep Research" });
    }

    const interaction_id = "research_" + Date.now();
    global.activeJobs = global.activeJobs || {};
    global.activeJobs[interaction_id] = { status: "RUNNING", progress: 0 };

    // Fire and forget
    (async () => {
      try {
        logInfo(`[Deep Research] Starting Google Search Grounding for: "${topic}"`);
        global.activeJobs[interaction_id].progress = 50;

        const prompt = `You are an elite Autonomous Deep Research AI.
Your objective is to thoroughly research and write a highly detailed Markdown report about: "${topic}".
Use your native Google Search tools to gather real-time data, academic research, and industry reports.
Do not hallucinate. Provide factual, up-to-date information.`;

        // Pass useWebSearch=true and returnMetadata=true
        let result = await callGemini(
            prompt, 
            [], 
            "", 
            2, 
            null, 
            "gemini-3.1-flash-lite-preview", 
            deviceSlug, // Pass slug for exact token deduction in callGemini
            true,       // useWebSearch = true
            true        // returnMetadata = true
        );

        let finalReport = typeof result === "object" ? result.text : result;
        let metadata = typeof result === "object" ? result.metadata : null;

        if (metadata) {
            // Calculate remaining quota based on the upfront check
            const allowed = consumeRes.allowed;
            const newUsed = consumeRes.used + metadata.total_tokens;
            metadata.remaining_quota = Math.max(0, allowed - newUsed);
        }

        global.activeJobs[interaction_id] = { 
            status: "COMPLETED", 
            artifact: { report: finalReport }, 
            progress: 100,
            metadata: metadata 
        };
      } catch (err) {
        logError("Background Deep Research Error:", err);
        global.activeJobs[interaction_id] = { status: "FAILED", error: err.message };
      }
    })();

    return res.json({ ok: true, interaction_id, message: "Deep research started using Native Gemini Grounding" });

  } catch (err) {
    logError("Deep Research API Error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Basic in-memory cache to save costs for repeated searches
const searchCache = new Map();

// Universal Search Microservice (For Desktop Qwen & Others)
router.post("/search-tool", async (req, res) => {
  try {
    const { query, mode } = req.body;
    const deviceSlug = req.headers["x-device-slug"];

    if (!query || !deviceSlug) {
      return res.status(400).json({ ok: false, error: "Query and device slug required" });
    }

    // Append search modes to force Native Gemini to target specific domains
    let finalQuery = query;
    if (mode === "github") finalQuery += " site:github.com";
    else if (mode === "reddit") finalQuery += " site:reddit.com";
    else if (mode === "academic") finalQuery += " site:arxiv.org OR site:nature.com OR site:sciencedirect.com";
    else if (mode === "dev") finalQuery += " site:stackoverflow.com OR site:dev.to OR site:medium.com";

    // Check cache
    const cacheKey = finalQuery.toLowerCase().trim();
    if (searchCache.has(cacheKey)) {
      logInfo(`[Search Tool] Cache hit for "${finalQuery}"`);
      return res.json({ 
          ok: true, 
          source: "cache", 
          response: searchCache.get(cacheKey),
          metadata: { total_tokens: 0, input_tokens: 0, output_tokens: 0 }
      });
    }

    logInfo(`[Search Tool] Live search for "${finalQuery}"`);
    
    // Verify user has buffer quota (500 tokens is enough for a basic search)
    const { getSubscriptionStatus } = await import("../../RK_AI_HOME/services/appwriteClient.js");
    const subStatus = await getSubscriptionStatus(deviceSlug, req.headers["x-user-email"]);
    const consumeRes = await checkAndConsume(deviceSlug, subStatus.tier, "tokens", 500);
    
    if (!consumeRes.ok) {
      return res.status(402).json({ ok: false, error: "Insufficient AI tokens for Search Tool" });
    }

    // Force gemini-3.1-flash-lite-preview because it is the cheapest model with Search Grounding
    // We use returnMetadata=true for exact billing
    const prompt = `Provide a concise, factual answer to the following query. 
Use your Google Search grounding tool to find the most accurate real-time information.
Query: "${finalQuery}"`;

    const result = await callGemini(
      prompt, 
      [], 
      "", 
      1, 
      null, 
      "gemini-3.1-flash-lite-preview", 
      deviceSlug, // Pass slug for exact billing inside callGemini
      true,       // useWebSearch = true
      true        // returnMetadata = true
    );

    const textOutput = typeof result === "object" ? result.text : result;
    const metadata = typeof result === "object" ? result.metadata : null;

    if (metadata) {
       metadata.remaining_quota = Math.max(0, consumeRes.allowed - (consumeRes.used + metadata.total_tokens));
    }

    const payload = {
        ok: true,
        source: "live",
        response: textOutput,
        metadata: metadata
    };

    // Cache the result for 1 hour to save tokens across similar desktop requests
    searchCache.set(cacheKey, textOutput);
    setTimeout(() => searchCache.delete(cacheKey), 3600000);

    return res.json(payload);

  } catch (err) {
    logError("Search Tool API Error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
