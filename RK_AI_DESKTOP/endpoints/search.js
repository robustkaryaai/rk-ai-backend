import express from "express";
import ytSearch from "yt-search";
// Removed unstable duck-duck-scrape import
async function robustSearch(query) {
  if (!process.env.LANGSEARCH_API_KEY) {
    console.error("LANGSEARCH_API_KEY is missing from environment variables.");
    return { results: [] };
  }

  try {
    const res = await fetch("https://api.langsearch.com/v1/web-search", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.LANGSEARCH_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: query,
        freshness: "noLimit",
        summary: true,
        count: 10
      })
    });

    if (res.ok) {
      const data = await res.json();
      if (data.data && data.data.webPages && data.data.webPages.value) {
        return { 
          results: data.data.webPages.value.map(r => ({ 
            title: r.name, 
            url: r.url, 
            description: r.summary || r.snippet 
          })) 
        };
      }
    } else {
      console.error(`LangSearch API failed with status: ${res.status}`);
    }
  } catch (e) {
    console.error("LangSearch failed:", e.message);
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
    const { getSubscriptionStatus } = await import("../../RK_AI_HOME/services/appwriteClient.js");
    const subStatus = await getSubscriptionStatus(deviceSlug, req.headers["x-user-email"]);
    
    const consumeRes = await checkAndConsume(deviceSlug, subStatus.tier, "tokens", cost);
    if (!consumeRes.ok) {
      return res.status(402).json({ ok: false, error: "Insufficient AI tokens for Deep Research" });
    }

    const interaction_id = "research_" + Date.now();
    global.activeJobs = global.activeJobs || {};
    global.activeJobs[interaction_id] = { status: "RUNNING", progress: 0 };

    // Fire and forget
    (async () => {
      try {
        logInfo(`[Deep Research] Starting cloud deep research for: "${topic}"`);

        // Autonomous ReAct Loop
        let knownFacts = "";
        let isCompleted = false;
        let finalReport = "No report generated.";
        
        for (let step = 0; step < 5; step++) {
          const prompt = `You are an elite Autonomous Deep Research AI.
Your objective is to thoroughly research: "${topic}".

STRICT RULES:
1. On your very first step, you MUST formulate a strict research plan before taking any action.
2. You must execute your plan step-by-step.
3. NEVER fake facts.

Known Facts so far:
${knownFacts}

You MUST output EXACTLY one valid JSON object and nothing else. Do not use Markdown wrappers like \`\`\`json.
{
  "reasoning": "Explain your logic for this step. Did you make a plan yet? What are you doing next?",
  "tool": "web_search" | "analyze_text" | "terminal" | "completed",
  "tool_input": "search query (for web_search) OR text to summarize (for analyze_text) OR bash command (for terminal) OR final Markdown report (for completed)"
}`;
          
          let resText = await callGemini(prompt, [], "", 2, null, "gemma-4-26b-a4b-it");
          let agentAction;
          
          try {
            // Strip any markdown code blocks
            resText = resText.replace(/```json/g, "").replace(/```/g, "").trim();
            const jsonMatch = resText.match(/\{[\s\S]*\}/);
            agentAction = JSON.parse(jsonMatch ? jsonMatch[0] : resText);
          } catch (e) {
            logError("JSON parsing failed during loop:", e);
            // Break out of loop cleanly on formatting failure
            break; 
          }
          
          if (agentAction.tool === "completed") {
            finalReport = agentAction.tool_input;
            isCompleted = true;
            break;
          }
          
          // ADD MEMORY OF ACTIONS SO IT REMEMBERS WHAT IT DID
          knownFacts += `\n### Step ${step+1} AI Action\nReasoning: ${agentAction.reasoning}\nTool Used: ${agentAction.tool}\nInput: ${agentAction.tool_input}\n`;

          if (agentAction.tool === "terminal") {
            const command = agentAction.tool_input;
            logInfo(`[Deep Research] Agent executing terminal command: "${command}"`);
            try {
               const { exec } = await import("child_process");
               const util = await import("util");
               const execAsync = util.promisify(exec);
               const { stdout, stderr } = await execAsync(command, { timeout: 30000 });
               knownFacts += `\n### Terminal Output for "${command}"\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}\n`;
            } catch (err) {
               knownFacts += `\n### Terminal Error for "${command}"\n${err.message}\n`;
            }
          } else if (agentAction.tool === "analyze_text") {
            const textToAnalyze = agentAction.tool_input;
            logInfo(`[Deep Research] Agent analyzing text snippet.`);
            try {
               const analysis = await callGemini(`Summarize the key facts from this text:\n\n${textToAnalyze}`, [], "", 1, null, "gemini-3.5-flash-lite");
               knownFacts += `\n### Text Analysis\n${analysis}\n`;
            } catch (err) {
               knownFacts += `\n### Text Analysis Failed\n`;
            }
          } else if (agentAction.tool === "web_search") {
            const query = agentAction.tool_input;
            global.activeJobs[interaction_id].progress = (step + 1) * 20;
            logInfo(`[Deep Research] Agent searching: "${query}"`);
            try {
              const searchResults = await robustSearch(query);
              const topResults = searchResults.results.slice(0, 4).map(r => `Title: ${r.title}\nSnippet: ${r.description}\nURL: ${r.url}`).join("\n\n");
              knownFacts += `\n### Web Search Result for "${query}"\n${topResults}\n`;
            } catch (err) {
              knownFacts += `\n### Web Search Result for "${query}"\nSearch failed or no results.\n`;
            }
          }
        }
        
        if (!isCompleted) {
          logInfo("[Deep Research] Loop limit reached. Forcing synthesis.");
          const synthesisPrompt = `Synthesize the following facts into a deeply detailed, final Markdown report about "${topic}":\n\n${knownFacts}`;
          finalReport = await callGemini(synthesisPrompt, [], "", 2, null, "gemma-4-26b-a4b-it");
          // If returned as object, extract text
          if (typeof finalReport === "object") finalReport = finalReport.text || "Synthesis failed.";
        }

        global.activeJobs[interaction_id] = { status: "COMPLETED", artifact: { report: finalReport } };
      } catch (err) {
        logError("Background Deep Research Error:", err);
        global.activeJobs[interaction_id] = { status: "FAILED", error: err.message };
      }
    })();

    return res.json({
      ok: true,
      interaction_id,
      status: "RUNNING",
      message: "Deep research started in the background."
    });

  } catch (err) {
    logError("[Deep Research] Error:", err);
    return res.status(500).json({ ok: false, error: "Cloud Deep Research failed" });
  }
});

export default router;
