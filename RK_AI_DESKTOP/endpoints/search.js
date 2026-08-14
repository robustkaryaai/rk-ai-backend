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

    // Make it synchronous to avoid complex frontend polling state
    try {
      logInfo(`[Deep Research] Starting Google Search Grounding for: "${topic}"`);

      const prompt = `Autonomous research analyst. Write a comprehensive, factual Markdown report using Google Search grounding.

Report structure:
## Executive Summary
## Key Findings
## Supporting Data & Statistics
## Sources

Rules:
1. Never hallucinate. Ground every claim in search results.
2. Include specific statistics, dates, and named sources.
3. Conclude with 3 actionable insights or open questions.

Topic: "${topic}"`;

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
      
      // Force token deduction fallback for Deep Research if callGemini missed it
      if (!metadata || metadata.total_tokens === 0) {
          const { incrementAppwriteUsage } = await import("../../RK_AI_HOME/services/appwriteClient.js");
          await incrementAppwriteUsage(deviceSlug, "tokens", 8000);
          if (metadata) metadata.total_tokens = 8000;
      }

      return res.json({ 
          ok: true, 
          report: finalReport,
          tokensConsumed: metadata ? metadata.total_tokens : 0,
          metadata: metadata 
      });

    } catch (err) {
      logError("Background Deep Research Error:", err);
      return res.status(500).json({ ok: false, error: err.message });
    }
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
    const prompt = `Return a direct, factual answer using Google Search. 2-3 sentences max. Cite the source inline.

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


// Deep Research Cloud Orchestrator (Backend Loop)
router.post("/deep-research/relay", async (req, res) => {
  try {
    const { topic, sessionId: inSessionId, history: inHistory, stepResults: inStepResults } = req.body;
    const deviceSlug = req.headers["x-device-slug"];

    if (!topic || !deviceSlug) {
      return res.status(400).json({ ok: false, error: "Topic and device slug required" });
    }

    const { getSubscriptionStatus } = await import("../../RK_AI_HOME/services/appwriteClient.js");
    const subStatus = await getSubscriptionStatus(deviceSlug, req.headers["x-user-email"]);
    // consume more tokens since this runs a loop
    const consumeRes = await checkAndConsume(deviceSlug, subStatus.tier, "tokens", 3000);
    if (!consumeRes.ok) {
      return res.status(402).json({ ok: false, error: "Insufficient AI tokens" });
    }

    const fs = await import("fs");
    const path = await import("path");
    const os = await import("os");
    
    // Session and workspace management
    const sessionId = inSessionId || Math.random().toString(36).substring(7);
    const workspaceDir = path.join(os.tmpdir(), `rk_deep_research_${sessionId}`);
    
    // Always ensure the directory exists, even if we are resuming a session
    // This prevents ENOENT crashes if the temp directory was cleaned up
    if (!fs.existsSync(workspaceDir)) {
        fs.mkdirSync(workspaceDir, { recursive: true });
    }

    const systemPrompt = `You are an autonomous Deep Research agent running on the cloud.
Your goal is to research: "${topic}".
You have a temporary workspace.
You must output ONLY valid JSON. 
Your JSON must contain a "scratchpad" string (to store your notes, findings, and next steps), a "reasoning" string (explaining your thought process), and a "tools" array. You can run multiple tools at once.
Example: {"scratchpad": "Found X, need to search Y next.", "reasoning": "I need to search for Y.", "tools": [{"tool": "web_search", "arguments": {"query": "Y"}}]}

Available tools:
1. {"tool": "write_file", "arguments": {"filename": "task.md", "content": "..."}} - Create or overwrite files. MUST use this first to create task.md (your plan). Store context in report.md.
2. {"tool": "web_search", "arguments": {"query": "..."}} - Search the web.
3. {"tool": "task_done", "arguments": {"task": "what was done", "summary": "short summary to remember"}} - Marks a task done and saves a brief summary to your context.
4. {"tool": "get_all_context", "arguments": {}} - Reads and returns the contents of all files in your temporary workspace.
5. {"tool": "complete", "arguments": {"report": "Full comprehensive markdown report"}} - Ends research and returns the final report.

Rules:
1. Start by creating a task.md file ONLY IF it doesn't already exist.
2. DO NOT repeat the exact same tool call (e.g. writing the exact same task.md over and over). Move on to web_search!
3. Search iteratively. Use task_done to keep context focused.
4. Use get_all_context if you need to read back what you wrote in report.md or task.md.
5. When finished, use the 'complete' tool.`;

    let history = inHistory || [];
    if (inStepResults && inStepResults.length > 0) {
        history.push({role: "user", parts: [{text: `Tool Execution Results:\\n${inStepResults.join("\\n\\n")}`}]});
    }
    
    let finalReport = "Cloud Deep Research failed to produce a final report.";
    let loopCount = 0;
    let isComplete = false;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    
    while(loopCount < 15) {
      loopCount++;
      
      // Delay to respect Gemini RPM rate limits (wait 2 minutes per user request)
      if (loopCount > 1) {
          await sleep(120000); 
      }
      
      // Inject current files so the model knows what it has already done
      let currentFiles = fs.readdirSync(workspaceDir);
      
      // Inject the direct results of the previous client action so the model doesn't ignore history
      let stepText = "";
      // Only inject once per API call
      if (loopCount === 1 && inStepResults && inStepResults.length > 0) {
          stepText = `[CRITICAL UPDATE FROM LAST ACTION]:\n${inStepResults.join("\n\n")}\n\n`;
      }
      
      let nextStepPrompt = `${stepText}Current workspace files: [${currentFiles.join(", ") || "None"}]. \nWhat is your next step? Reply in JSON only.`;
      
      let result = await callGemini(
        systemPrompt,
        history,
        nextStepPrompt,
        1,
        null,
        "gemini-3.5-flash-lite",
        deviceSlug,
        false, 
        true
      );
      
      let rawText = typeof result === "object" ? result.text : result;
      rawText = rawText.replace(/```json/g, "").replace(/```/g, "").trim();
      let startIdx = rawText.indexOf('{');
      let endIdx = rawText.lastIndexOf('}');
      if (startIdx !== -1 && endIdx !== -1) {
          rawText = rawText.substring(startIdx, endIdx + 1);
      }
      
      let parsed;
      try {
          parsed = JSON.parse(rawText);
      } catch(e) {
          history.push({role: "model", parts: [{text: rawText}]});
          history.push({role: "user", parts: [{text: "JSON Parse error. Output valid JSON only."}]});
          continue;
      }
      
      let tools = parsed.tools || [];
      if (!Array.isArray(tools)) tools = [parsed];
      
      history.push({role: "model", parts: [{text: rawText}]});
      let stepResults = [];
      
      for (let t of tools) {
         let tName = t.tool || t.action;
         let args = t.arguments || t || {};
         
         if (tName === "write_file") {
            let filename = args.filename || args.path || "unnamed.md";
            fs.writeFileSync(path.join(workspaceDir, path.basename(filename)), args.content || "");
            stepResults.push(`[write_file] Successfully wrote to ${filename}`);
         } else if (tName === "web_search" || tName === "search") {
            // We DO NOT execute this on the backend anymore.
            // The client will handle it. We just collect it here.
         } else if (tName === "task_done") {
            stepResults.push(`[task_done] Marked '${args.task}' complete. Summary saved: ${args.summary}`);
         } else if (tName === "get_all_context") {
            let files = fs.readdirSync(workspaceDir);
            let ctx = "Workspace files:\\n";
            for (let f of files) {
               ctx += `\\n--- ${f} ---\\n${fs.readFileSync(path.join(workspaceDir, f), 'utf-8')}\\n`;
            }
            stepResults.push(`[get_all_context]\\n${ctx}`);
         } else if (tName === "complete" || tName === "final") {
            finalReport = args.report || "Done";
            isComplete = true;
            break;
         } else {
            stepResults.push(`[${tName}] Unknown tool.`);
         }
      }
      
      let toolsToRunOnClient = tools.filter(t => (t.tool || t.action) === "web_search" || (t.tool || t.action) === "search");
      if (toolsToRunOnClient.length > 0) {
          // Send back to client to execute web_search
          return res.json({
              ok: true,
              need_client_tool: "web_search",
              client_tools: toolsToRunOnClient,
              stepResults,
              sessionId,
              history,
              scratchpad: parsed.scratchpad || "",
              reasoning: parsed.reasoning || ""
          });
      }
      
      if (isComplete) break;
      history.push({role: "user", parts: [{text: `Tool Execution Results:\\n${stepResults.join("\\n\\n")}`}]});
    }
    
    if (!isComplete && fs.existsSync(workspaceDir)) {
      let files = fs.readdirSync(workspaceDir);
      let ctx = "Cloud Deep Research timed out. Gathered context:\\n";
      for (let f of files) {
         ctx += `\\n--- ${f} ---\\n${fs.readFileSync(path.join(workspaceDir, f), 'utf-8')}\\n`;
      }
      finalReport = ctx;
    }
    
    // Cleanup temporary cloud workspace
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    
    return res.json({ ok: true, step: { action: "final", report: finalReport } });
  } catch(err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});
export default router;
