
import express from "express";
import { callGemini, listGeminiModels } from "../../RK_AI_HOME/services/gemini.js";
import { logInfo, logError } from "../../RK_AI_HOME/utils/logger.js";
import { generateImage } from "../../RK_AI_HOME/modules/imageGenerator.js";
import { generateVideo } from "../../RK_AI_HOME/modules/videoGenerator.js";
import { createDocx } from "../../RK_AI_HOME/modules/docxGenerator.js";
import { createPPT } from "../../RK_AI_HOME/modules/pptGenerator.js";
import { generateAndZipCode } from "../../RK_AI_HOME/modules/codeGenerator.js";
import { getUserPlanBySlug } from "../../RK_AI_HOME/services/appwriteClient.js";
import { ensureLimitFile, getLimitsForTier, checkAndConsume } from "../../RK_AI_HOME/limitManager.js";
import { cleanupSupabaseFiles, supabase } from "../../RK_AI_HOME/services/supabaseClient.js";
import { callGeminiVision } from "../../RK_AI_HOME/services/gemini.js";
import multer from "multer";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// Helper to get tier and limits for a slug
async function getTierAndLimits(slug) {
  const device = await getUserPlanBySlug(slug);
  const tier = Number(device["subscription-tier"] || 0);
  const limits = await ensureLimitFile(slug);
  const storageMB = await cleanupSupabaseFiles(slug, getLimitsForTier(tier).storage);
  return { tier, limits, storageMB };
}

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

// Generate AI text response (streaming or JSON)
router.post("/generate", async (req, res) => {
  try {
    const { prompt, model, stream = false } = req.body;
    if (!prompt) {
      return res.status(400).json({ ok: false, error: "Prompt required" });
    }

    logInfo(`Desktop AI Generate: Using model ${model || "default"}`);
    
    const slug = req.headers["x-device-slug"] || null;

    if (stream) {
      // Set headers for streaming
      res.writeHead(200, {
        "Content-Type": "text/plain",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      });

      // Call our existing Gemini service
      const result = await callGemini(prompt, [], "", 2, null, null, slug);
      res.write(result);
      res.end();
    } else {
      const result = await callGemini(prompt, [], "", 2, null, null, slug);
      return res.json({ ok: true, response: result });
    }
  } catch (err) {
    logError("Desktop AI Generate Error:", err);
    return res.status(500).json({ ok: false, error: "AI generation failed" });
  }
});

// Vision endpoint for Gemini
router.post("/vision", upload.single("image"), async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt || !req.file) {
      return res.status(400).json({ ok: false, error: "Prompt and image required" });
    }

    logInfo(`Desktop AI Vision: Processing image for prompt: "${prompt.substring(0, 50)}..."`);
    
    const slug = req.headers["x-device-slug"] || null;
    const result = await callGeminiVision(prompt, req.file.buffer, req.file.mimetype, null, null, slug);

    return res.json({ ok: true, response: result });
  } catch (err) {
    logError("Desktop Vision Error:", err);
    return res.status(500).json({ ok: false, error: "AI vision failed" });
  }
});

// Generate Image
router.post("/generate/image", async (req, res) => {
  try {
    const { prompt, slug } = req.body;
    if (!prompt || !slug) {
      return res.status(400).json({ ok: false, error: "Prompt and slug required" });
    }

    logInfo(`Desktop Image Generate: "${prompt}"`);
    const { tier, limits, storageMB } = await getTierAndLimits(slug);
    const result = await generateImage(prompt, slug, tier, storageMB);
    
    if (result.image) {
      const { data } = supabase.storage.from(process.env.SUPABASE_BUCKET || "user-files").getPublicUrl(`${slug}/${result.image}`);
      if (data && data.publicUrl) result.url = data.publicUrl;
    }
    
    return res.json({ ok: true, ...result });
  } catch (err) {
    logError("Desktop Image Generate Error:", err);
    return res.status(500).json({ ok: false, error: "Image generation failed" });
  }
});

// Generate Video
router.post("/generate/video", async (req, res) => {
  try {
    const { prompt, slug } = req.body;
    if (!prompt || !slug) {
      return res.status(400).json({ ok: false, error: "Prompt and slug required" });
    }

    logInfo(`Desktop Video Generate: "${prompt}"`);
    const { tier, limits, storageMB } = await getTierAndLimits(slug);
    const result = await generateVideo(prompt, slug, tier, storageMB, req.body);
    
    if (result.video) {
      const { data } = supabase.storage.from(process.env.SUPABASE_BUCKET || "user-files").getPublicUrl(`${slug}/${result.video}`);
      if (data && data.publicUrl) result.url = data.publicUrl;
    }
    
    return res.json({ ok: true, ...result });
  } catch (err) {
    logError("Desktop Video Generate Error:", err);
    return res.status(500).json({ ok: false, error: "Video generation failed" });
  }
});

// Generate Word Document (.docx)
router.post("/generate/docx", async (req, res) => {
  try {
    const { prompt, slug } = req.body;
    if (!prompt || !slug) {
      return res.status(400).json({ ok: false, error: "Prompt and slug required" });
    }

    logInfo(`Desktop DOCX Generate: "${prompt}"`);
    const result = await createDocx(prompt, slug);
    return res.json({ ok: true, ...result });
  } catch (err) {
    logError("Desktop DOCX Generate Error:", err);
    return res.status(500).json({ ok: false, error: "DOCX generation failed" });
  }
});

// Generate PowerPoint Presentation (.pptx)
router.post("/generate/ppt", async (req, res) => {
  try {
    const { prompt, slug } = req.body;
    if (!prompt || !slug) {
      return res.status(400).json({ ok: false, error: "Prompt and slug required" });
    }

    logInfo(`Desktop PPT Generate: "${prompt}"`);
    const result = await createPPT(prompt, slug);
    return res.json({ ok: true, ...result });
  } catch (err) {
    logError("Desktop PPT Generate Error:", err);
    return res.status(500).json({ ok: false, error: "PPT generation failed" });
  }
});

// In-memory job store (in production, use Redis/DB)
global.activeJobs = global.activeJobs || {};

// Generate Code Project (.zip) - ASYNC
router.post("/generate/code", async (req, res) => {
  try {
    const { prompt, slug } = req.body;
    if (!prompt || !slug) {
      return res.status(400).json({ ok: false, error: "Prompt and slug required" });
    }

    logInfo(`Desktop Code Generate: "${prompt}"`);
    const { tier, limits, storageMB } = await getTierAndLimits(slug);
    
    // NO MERCY QUOTA ENFORCEMENT
    // Full-stack code generation is extremely expensive. Charge 100,000 tokens flat upfront.
    const quotaCheck = await checkAndConsume(slug, tier, "tokens", 100000);
    if (!quotaCheck.ok) {
        logError(`❌ QUOTA EXCEEDED for ${slug}: Tried to use 100000 tokens but only ${quotaCheck.allowed - quotaCheck.used} left.`);
        return res.status(403).json({ 
            ok: false, 
            error: "RK AI Quota Exceeded. You do not have enough tokens remaining to build a full-stack project. Upgrade your plan or wait for the reset." 
        });
    }

    const interaction_id = "interaction_" + Date.now();
    global.activeJobs[interaction_id] = { status: "RUNNING", progress: 0 };

    // Fire and forget
    generateAndZipCode(prompt, slug, interaction_id, tier).then(result => {
       if (result.token_limit) {
           global.activeJobs[interaction_id] = { status: "TOKEN_LIMIT", reason: result.reason, zip_url: result.url, completed_files: result.completed_files, remaining_files: result.remaining_files };
       } else {
           global.activeJobs[interaction_id] = { status: "COMPLETED", artifact: result };
       }
    }).catch(err => {
       logError("Background Job Error:", err);
       global.activeJobs[interaction_id] = { status: "FAILED", error: err.message };
    });

    return res.json({ 
       ok: true, 
       interaction_id, 
       estimated_time: 120, 
       status: "RUNNING",
       message: "I'm building your project in the background. You can continue chatting while I work."
    });
  } catch (err) {
    logError("Desktop Code Generate Error:", err);
    return res.status(500).json({ ok: false, error: "Code generation failed: " + err.message });
  }
});

router.get("/generate/status/:interaction_id", async (req, res) => {
   const job = global.activeJobs[req.params.interaction_id];
   if (!job) return res.status(404).json({ ok: false, error: "Job not found" });
   
   if (job.status === "RUNNING") {
       return res.json({ status: "RUNNING", recommended_next_check_seconds: 15 });
   } else if (job.status === "COMPLETED") {
       return res.json({ status: "COMPLETED", artifact: job.artifact });
   } else if (job.status === "TOKEN_LIMIT") {
       return res.json({ status: "TOKEN_LIMIT", reason: job.reason, zip_url: job.zip_url, completed_files: job.completed_files, remaining_files: job.remaining_files });
   } else {
       return res.json({ status: job.status, error: job.error });
   }
});
// Think tool (Escalated Reasoning)
router.post("/think", async (req, res) => {
  try {
    const { prompt, slug } = req.body;
    if (!prompt || !slug) {
      return res.status(400).json({ ok: false, error: "Prompt and slug required" });
    }

    logInfo(`Desktop Think Request from slug ${slug}`);
    
    // We reuse the callGemini function from our existing services
    const result = await callGemini(
      `You are the "Think" module for a local AI agent. Provide a detailed, step-by-step reasoning or architectural plan for the following request. Return ONLY the plan, no extra conversational filler.\n\nRequest: ${prompt}`
    );
    
    return res.json({ ok: true, response: result });
  } catch (err) {
    logError("Desktop Think Error:", err);
    return res.status(500).json({ ok: false, error: "Think module failed to generate reasoning" });
  }
});

export default router;
