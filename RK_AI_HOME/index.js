import ytdl from '@distube/ytdl-core';
import express from "express";
import { HfInference } from "@huggingface/inference";
import { GoogleGenAI } from "@google/genai";
import { logInfo, logError } from "./utils/logger.js";
import { getUserPlanBySlug, checkDeviceBySlug, ensureDeviceBySlug, db, users, getSubscriptionStatus, updateSubscription, getDatabaseUserByEmail, createDatabaseUser, upgradeDatabaseUser } from "./services/appwriteClient.js";
import { Query, ID } from "node-appwrite";
import { loadChat, appendChat, appendUser, updateLastAI, deleteChatEntry } from "./memory.js";
import { ensureLimitFile, getLimitsForTier } from "./limitManager.js";
import { callGemini, callGeminiVision, listGeminiModels } from "./services/gemini.js";
import { handleIntents } from "./taskHandler.js";
import { getTaskStatusContext, getRecentTasks } from "./services/taskQueue.js";
import { cleanupSupabaseFiles, migrateToGoogleDrive, listFilesFromSlug, downloadFileFromSlug, deleteFileFromSlug } from "./services/supabaseClient.js";
import ytSearch from "yt-search";

const homeRouter = express.Router();
const hf = new HfInference(process.env.HF_TOKEN);
const FRONTEND_URL = process.env.FRONTEND_URL || "https://rexycore.vercel.app";

// Helper to normalize slug to 9-digit string
const normalizeSlug = (slug) => {
  if (!slug) return "";
  const s = String(slug);
  return s.padStart(9, '0');
};

const deviceCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

async function validateDevice(req, res, next) {
  if (
    req.path.startsWith("/auth/google") ||
    req.path.startsWith("/auth/spotify") ||
    req.path.startsWith("/web/") ||
    req.path === "/rk-ai-desktop/health" ||
    req.path === "/rk-ai-desktop/billing/upgrade"
  ) {
    return next();
  }
  // NOTE: req.params.slug is undefined at router.use() level because route matching
  // hasn't happened yet. We extract the slug directly from the URL path instead.
  const pathSlugMatch = req.path.match(/\/(?:device|audio|text|voice|chat|limits)\/([\d]{6,12})/);
  const slug = (pathSlugMatch && pathSlugMatch[1]) || req.params.slug || req.headers["x-device-slug"];
  if (!slug || slug === "undefined" || slug === "null" || slug.trim() === "") {
    return res.status(401).json({ error: "Device slug required and must be valid (via URL param or X-Device-Slug header)" });
  }
  const normalizedSlug = normalizeSlug(slug);
  const cachedEntry = deviceCache.get(normalizedSlug);
  if (cachedEntry && Date.now() - cachedEntry.timestamp < CACHE_TTL) {
    if (cachedEntry.valid) return next();
    else return res.status(404).json({ error: "Invalid or unregistered device" });
  }
  try {
    const exists = await checkDeviceBySlug(normalizedSlug);
    deviceCache.set(normalizedSlug, { valid: exists, timestamp: Date.now() });
    if (!exists) return res.status(404).json({ error: "Invalid or unregistered device" });
    next();
  } catch (err) {
    logError("Device validation error:", err);
    return res.status(500).json({ error: "Server error during device validation" });
  }
}


// ---------------- APPLY DEVICE VALIDATION TO ALL SUBSEQUENT ROUTES ----------------
homeRouter.use(validateDevice);

// ---------------- RPM RATE LIMITER ----------------
const rpmTracker = new Map();
const rpdTracker = new Map();

async function rateLimitMiddleware(req, res, next) {
  // Only limit actual AI action routes, ignore simple status checks
  if (req.path.endsWith("/status") || req.method === "GET") {
    return next();
  }

  const slug = req.params.slug || req.headers["x-device-slug"];
  if (!slug) return next();
  
  const normalizedSlug = normalizeSlug(slug);
  const now = Date.now();
  
  if (!rpmTracker.has(normalizedSlug)) rpmTracker.set(normalizedSlug, []);
  if (!rpdTracker.has(normalizedSlug)) rpdTracker.set(normalizedSlug, []);
  
  let requestsMin = rpmTracker.get(normalizedSlug).filter(ts => now - ts < 60000);
  let requestsDay = rpdTracker.get(normalizedSlug).filter(ts => now - ts < 86400000);
  
  try {
    const sub = await getSubscriptionStatus(normalizedSlug);
    const limits = getLimitsForTier(sub.tier);
    
    const maxRpm = limits?.rpm || 15;
    const maxRpd = limits?.rpd || 999999;
    
    if (requestsMin.length >= maxRpm) {
      console.log(`[RPM Limiter] ${normalizedSlug} hit limit of ${maxRpm} RPM`);
      return res.status(429).json({ 
        error: "too_many_requests", 
        message: `RPM Limit reached! Your plan allows ${maxRpm} requests per minute.`,
        shoom: true
      });
    }

    if (requestsDay.length >= maxRpd) {
      console.log(`[RPD Limiter] ${normalizedSlug} hit limit of ${maxRpd} RPD`);
      return res.status(429).json({ 
        error: "too_many_requests", 
        message: `Daily Limit reached! Your plan allows ${maxRpd} requests per day.`,
        shoom: true
      });
    }
    
    requestsMin.push(now);
    requestsDay.push(now);
    rpmTracker.set(normalizedSlug, requestsMin);
    rpdTracker.set(normalizedSlug, requestsDay);
    next();
  } catch (err) {
    next();
  }
}

homeRouter.use(rateLimitMiddleware);

// ---------------- AUDIO TRANSCRIPTION & HEALTH ----------------
// GET: Quick status check and metadata
homeRouter.get("/audio/:slug", async (req, res) => {
  const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }

  const lastSeen = deviceLastSeen.get(slug);
  const now = Date.now();
  const isOnline = lastSeen && (now - lastSeen < 180000);

  return res.json({
    ok: true,
    slug,
    status: isOnline ? "online" : "offline",
    lastSeen: lastSeen ? new Date(lastSeen).toISOString() : null,
    provider: "HuggingFace-Whisper-V3-Turbo",
    privacy: "Base64-Encrypted-Buffer",
    shoom: "Active 🚀"
  });
});

homeRouter.post("/audio/:slug", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }

    const { audio_b64 } = req.body;

    // Shoom Update: Mark device as seen immediately
    deviceLastSeen.set(slug, Date.now());

    if (!slug || !audio_b64) {
      return res.status(400).json({ error: "bad_request", message: "slug and audio_b64 required" });
    }

    const device = await getUserPlanBySlug(slug);
    if (!device) return res.status(404).json({ error: "invalid_slug" });

    // Decode audio (Privacy "Decoding" step)
    const audioBuffer = Buffer.from(audio_b64, "base64");

    // Transcribe using Hugging Face (Ultra-fast Whisper V3 Turbo)
    console.time(`[Shoom-STT] ${slug}`);
    const transcription = await hf.automaticSpeechRecognition({
      model: "openai/whisper-large-v3-turbo",
      data: audioBuffer,
    });
    console.timeEnd(`[Shoom-STT] ${slug}`);

    const text = transcription.text || "";
    console.log(`[Audio-STT] Decoded for ${slug}: "${text}"`);

    if (!text.trim()) {
      return res.json({
        reply: "I couldn't hear you clearly. Could you repeat that?",
        text: "",
        shoom: true
      });
    }

    // Process text with Gemini & Intent logic
    deviceBusyState.set(slug, "thinking"); // 🚀 Mark as thinking
    const result = await handleTextRequest(req, res, slug, text, device);
    deviceBusyState.set(slug, "idle"); // 🚀 Clear to idle
    return result;

  } catch (err) {
    logError("AUDIO STT ERROR:", err);
    return res.status(500).json({ error: "server_error", message: String(err), shoom: false });
  }
});

// ---------------- SYSTEM PROMPT ----------------
const SYSTEM_PROMPT = `You are RK AI (Robust Karya AI Assistant), created and powered by RexyCore. You act as both the smart intent classifier and immediate response generator for **RK AI Home**.

Your job is to understand the user's message, classify every requested action into the correct intent, generate the direct conversational or confirmation "reply" immediately, and return a single valid JSON array.

## Available intents

- \`image\` — Generate images, pictures, posters, artwork, or thumbnails.
- \`video\` — Generate videos, clips, animations, or shorts.
- \`docx\` — Create Word documents, essays, reports, or detailed notes as \`.docx\` files.
- \`ppt\` — Create presentations or slide decks.
- \`note\` — Provide short notes or explanations.
- \`planner\` — Create study plans, daily routines, or checklists.
- \`timetable\` — Create or manage school or coaching timetables.
- \`task\` — Manage reminders and to-do tasks.
- \`alarm\` — Set a time-based alarm.
- \`announcement\` — Broadcast messages or notify people.
- \`assignment\` — Create or help complete student assignments.
- \`exam_paper\` — Create question papers or examination papers.
- \`lesson_plan\` — Create teacher lesson plans.
- \`grading_sheet\` — Create grading sheets or marksheets.
- \`class_planner\` — Organize teachers' class schedules.
- \`teacher_note\` — Create explanatory notes for teachers.
- \`period_bell\` — Manage school period timings and bell schedules.
- \`weather\` — Answer weather queries. Default location: Delhi, India.
- \`news\` — Retrieve news. Default country: India.
- \`music\` — Play, pause, resume, or stop music.
- \`shutdown\` — Shut down the system or exit an application.
- \`stop_alarm\` — Stop, silence, or cancel an alarm.
- \`emergency_alarm\` — Trigger an explicitly requested emergency alert.
- \`chat\` — Handle general conversations, questions, greetings, explanations, facts, viva, and oral questions.
- \`general\` — Handle unclear or unsupported requests.

## Response & Reply rules

1. EVERY intent object MUST include a \`reply\` field with a natural, friendly, and spoken response.
2. For \`chat\` and \`general\`: The \`reply\` must be the COMPLETE and DIRECT conversational answer (1-3 sentences max). Answer the user's question directly and concisely without extra filler. Never say you are an intent router or assistant model; you are RK AI. If the user asks about the progress, status, or completion of previously queued tasks or files (e.g., "what's the status of my video?", "did my tasks finish?", "what happened with my docx?"), refer to the Recent Background Tasks & Status provided in the context, and give an accurate, friendly real-time status update.
3. For generative intents (\`image\`, \`video\`, \`docx\`, \`ppt\`, etc.): The \`reply\` must be a pleasant immediate confirmation (e.g. "Generating an image of a tree house for you now.", "Creating your presentation on photosynthesis now."). When multiple tasks are detected in a single prompt, produce a natural merged queue confirmation (e.g. "I'm queuing those 4 tasks for you. Please give me a moment while I prepare them.").
4. For \`alarm\`, \`task\`, \`weather\`, \`news\`: Provide the clear natural acknowledgement in \`reply\`.
5. Return multiple intent objects when the user requests multiple distinct actions. Preserve their original order.
6. For alarms, extract the requested time into \`time\`, formatted as \`h:mm AM/PM\` or \`HH:mm\`. Resolve relative times using the current time provided in context. Never invent a time.
7. Output strictly valid JSON. No Markdown formatting, no code fences, no explanations outside JSON.

## Output format

Return exactly one JSON array:

[
  {
    "intent": "intent_name",
    "reply": "Immediate spoken reply or answer to user",
    "parameters": {
      "prompt": "Clear description of the requested action"
    }
  }
]

## Examples

User: "What is the capital of France?"
Output:
[
  {
    "intent": "chat",
    "reply": "The capital of France is Paris.",
    "parameters": {
      "prompt": "What is the capital of France?"
    }
  }
]

User: "Generate a sunset video and make a wallpaper of the same scene."
Output:
[
  {
    "intent": "video",
    "reply": "Creating a video of the sunset for you now.",
    "parameters": {
      "prompt": "Generate a video of a sunset."
    }
  },
  {
    "intent": "image",
    "reply": "Generating a sunset wallpaper to match.",
    "parameters": {
      "prompt": "Create a wallpaper depicting the same sunset scene."
    }
  }
]

User: "rk mane ab image of a tree house"
Output:
[
  {
    "intent": "image",
    "reply": "Generating an image of a tree house for you.",
    "parameters": {
      "prompt": "A tree house"
    }
  }
]

User: "Hi!"
Output:
[
  {
    "intent": "chat",
    "reply": "Radhe Radhe! How can I help you today?",
    "parameters": {
      "prompt": "Respond naturally to the greeting."
    }
  }
]

Now classify the user's latest message and return only the JSON array.`;

// ---------------- DEVICE PRESENCE TRACKING ----------------
const deviceLastSeen = new Map();
const deviceBusyState = new Map(); // 🚀 Track explicit processing state (now stores strings like "thinking", "playing", "speaking")
const deviceDownloadProgress = new Map(); // 🚀 TRACK MUSIC DOWNLOADS
const deviceSTTLogs = new Map(); // 🚀 TRACK STT LOGS FOR FRONEND APP (slug -> [{timestamp, text}])

// Lightweight device ping endpoint for 30s heartbeat
homeRouter.post("/device/:slug/ping", (req, res) => {
  const slug = normalizeSlug(req.params.slug);
  deviceLastSeen.set(slug, Date.now());
  return res.json({ ok: true, timestamp: Date.now() });
});

// Helper to normalize slug to 9-digit string
homeRouter.get("/ai/models", async (req, res) => {
  const models = await listGeminiModels();
  return res.json({ models });
});

async function resolveNextMusicLink(seedText = "") {
  const seed = String(seedText || "").trim();
  if (!seed) return null;

  let suggestion = "";
  try {
    suggestion = await callGemini(
      "You suggest one related song title only. Return only the song title and artist, no prose.",
      [],
      `The user is listening to: "${seed}". Suggest one related next song.`
    );
    suggestion = String(suggestion || "").trim().replace(/^["'`]+|["'`]+$/g, "");
  } catch (err) {
    console.log(`[Music-Resolve] Gemini suggestion failed, falling back to direct search: ${err?.message || err}`);
  }

  const query = suggestion || seed;
  const search = await ytSearch(query);
  const video = search?.videos?.[0];
  if (!video) return null;

  return {
    title: video.title,
    vid_id: video.videoId,
    link: video.url,
    query,
  };
}

homeRouter.get("/device/:slug/status", async (req, res) => {
  const rawSlug = req.params.slug;
  const slug = normalizeSlug(rawSlug);
  const lastSeen = deviceLastSeen.get(slug);
  const busyState = deviceBusyState.get(slug) || "idle";
  const downloadProgress = deviceDownloadProgress.get(slug) || null;
  const now = Date.now();
  const isOnline = lastSeen && (now - lastSeen < 180000);

  // Fetch storage info
  let storageMB = 0;
  try {
    const device = await getUserPlanBySlug(slug);
    if (device) {
      const tierNum = device.subscription === "true" ? (isNaN(device["subscription-tier"]) ? String(device["subscription-tier"]).toLowerCase() : Number(device["subscription-tier"])) : 0;

      // Check trial expiry (downgrade automatically ONLY if currently on a trial or student trial tier AND not manually on an active paid/subscribed plan)
      const trialEnd = device.trialEnd || device.trial_end;
      const isExplicitSubscription = device.subscription_expires_at && new Date() < new Date(device.subscription_expires_at);
      const isTrialSubscription = !isExplicitSubscription && device.subscription === "true" && Number(device["subscription-tier"] || 0) === 1 && device.trialUsed === "true";
      if (isTrialSubscription && trialEnd && new Date() > new Date(trialEnd)) {
        console.log(`[Trial Expiry] 7-Day Trial expired for ${slug}. Auto-downgrading to Free Tier 0.`);
        await db.updateDocument(process.env.APPWRITE_DB_ID, process.env.APPWRITE_DEVICES_COLLECTION, device.$id, {
          subscription: "false",
          "subscription-tier": 0,
          trialUsed: "true"
        }).catch(console.error);
        device.subscription = "false";
        device["subscription-tier"] = 0;
      }

      const tierMap = { 0: "free", 1: "student", 2: "creator", 3: "pro", 4: "studio", "infinity": "infinity", "Infinity": "infinity" };
      const tierName = tierMap[tierNum] || "free";
      storageMB = await cleanupSupabaseFiles(slug, tierName);
    }
  } catch (err) {
    console.error("[Status] Storage check failed:", err);
  }

  const responsePayload = {
    slug,
    status: isOnline ? "online" : "offline",
    lastSeen: lastSeen ? new Date(lastSeen).toISOString() : null,
    diffSeconds: lastSeen ? Math.floor((now - lastSeen) / 1000) : null,
    busyState,
    isBusy: busyState !== "idle",
    downloadProgress, // 🚀 Include download info
    storageMB: storageMB || 0,
    shoom: true
  };

  // Status-Check log silenced to prevent console spam

  return res.json(responsePayload);
});

// 🚀 NEW: Explicit state reporting from hardware
homeRouter.post("/device/:slug/state", async (req, res) => {
  const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }

  const { state } = req.body; // e.g. "thinking", "speaking", "playing", "idle"

  if (!state) return res.status(400).json({ error: "state required" });

  deviceBusyState.set(slug, state);
  deviceLastSeen.set(slug, Date.now()); // State update also acts as heartbeat

  console.log(`[Device-State] ${slug} -> ${state.toUpperCase()}`);
  return res.json({ ok: true });
});

// ---------------- STT LOG STREAM ----------------
homeRouter.post("/device/:slug/stt-log", async (req, res) => {
  const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }

  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "text required" });

  if (!deviceSTTLogs.has(slug)) deviceSTTLogs.set(slug, []);

  const logs = deviceSTTLogs.get(slug);
  logs.push({ timestamp: new Date().toISOString(), text });

  // Keep only last 50 logs in memory to avoid leaking
  if (logs.length > 50) logs.shift();

  deviceLastSeen.set(slug, Date.now()); // Acts as heartbeat
  return res.json({ ok: true });
});

homeRouter.get("/device/:slug/stt-log", async (req, res) => {
  const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }

  const logs = deviceSTTLogs.get(slug) || [];
  return res.json({ ok: true, logs });
});

// ---------------- DESKTOP AUTH PROXY ----------------
homeRouter.post("/desktop/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    // Call Appwrite REST API dirctly to bypass Desktop CORS/Platform limits
    const response = await fetch(`${process.env.APPWRITE_ENDPOINT}/account/sessions/email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Appwrite-Project": process.env.APPWRITE_PROJECT_ID,
      },
      body: JSON.stringify({ email, password })
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data.message });
    }

    // Link Web Auth Session to Custom Users Database Collection
    let dbUser = await getDatabaseUserByEmail(email);
    if (!dbUser) {
        dbUser = await createDatabaseUser(email, data.name || email.split("@")[0]);
    }
    
    // Override device_slug and plan for the Desktop App to use
    data.slug = dbUser.slug;
    data.plan = dbUser.plan;

    return res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

homeRouter.post("/desktop/signup", async (req, res) => {
  try {
    const { email, password } = req.body;

    const response = await fetch(`${process.env.APPWRITE_ENDPOINT}/account`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Appwrite-Project": process.env.APPWRITE_PROJECT_ID,
      },
      body: JSON.stringify({ userId: "unique()", email, password })
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data.message });
    }

    return res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

homeRouter.get("/desktop/profile/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    const subscriptionsReq = await db.listDocuments(
      process.env.APPWRITE_DB_ID,
      "subscriptions",
      [Query.equal("userId", userId), Query.orderDesc("$createdAt"), Query.limit(1)]
    ).catch(() => ({ documents: [] }));

    let plan = "free";
    let expires = null;
    
    if (subscriptionsReq.documents.length > 0) {
      const sub = subscriptionsReq.documents[0];
      if (sub.status === "active") {
        plan = sub.planId || sub.plan || "free";
        expires = sub.currentPeriodEnd || sub.expiresOn || sub.expiresAt || null;
      }
    }
    
    // Fallback for legacy upgrades (users collection)
    if (plan === "free") {
      try {
        const userDoc = await getDatabaseUserByEmail(userId);
        if (userDoc && userDoc.plan && userDoc.plan !== "free") {
          plan = userDoc.plan;
          expires = userDoc.subscription_expires_at || null;
        }
      } catch (e) {}
    }
    
    // Fallback for legacy upgrades (devices collection)
    if (plan === "free") {
      try {
        const deviceDoc = await getUserPlanBySlug(userId);
        if (deviceDoc && deviceDoc.subscription === "true") {
          const tiers = { 0: "free", 1: "pro", 2: "elite", 3: "quantum", 4: "infinity" };
          plan = tiers[deviceDoc["subscription-tier"]] || "free";
          expires = deviceDoc.subscription_expires_at || null;
        }
      } catch (e2) {}
    }
    
    return res.json({ plan, expires });
  } catch (err) {
    console.error("[Desktop Profile Error] failed to check:", err);
    return res.status(500).json({ error: String(err) });
  }
});

// Helper to process text (refactored for Shoom 3.0 speed)
async function handleTextRequest(req, res, slug, text, device) {
  try {
    const normSlug = normalizeSlug(slug);
    await ensureLimitFile(normSlug);

    // 0. Handle LOCAL_INTENT_SYNC from Assistant (to store in Supabase without classifying again)
    if (text.startsWith("LOCAL_INTENT_SYNC:")) {
      console.log(`[Sync] Received local sync from assistant: ${text}`);
      const parts = text.replace("LOCAL_INTENT_SYNC:", "").split("| AI:");
      const userMsg = parts[0]?.trim() || "User command";
      const aiReply = parts[1]?.trim() || "Processed locally";

      await appendChat(normSlug, userMsg, aiReply);
      return res.json({ ok: true, synced: true });
    }

    // 1. Generate intents with Gemini (presence updated synchronously in memory)
    // Load last 10 messages of chat history so Gemini has full context
    // (e.g. user asked for video gen earlier, now asks "what happened with that?")
    const chatHistory = await loadChat(normSlug);
    const recentHistory = chatHistory.slice(-10).map(entry =>
      `User: ${entry.user || entry.prompt || ""}\nAssistant: ${entry.ai || entry.reply || ""}`
    );

    // Prepend current IST time and recent task status so Gemini can resolve relative times and task queries
    const nowIST = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true, weekday: "long", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const taskContext = getTaskStatusContext(normSlug);
    const textWithContext = `[Current time: ${nowIST} IST]${taskContext}\nUser Request: ${text}`;

    const rawIntents = await callGemini(
      SYSTEM_PROMPT,
      recentHistory,
      textWithContext,
      2,
      device.geminiApiKey || null,
      device.geminiModel || null
    );

    // Mark seen on text request too
    deviceLastSeen.set(normSlug, Date.now());

    // 2. Parse Intents with robust fallback
    let intents;
    try {
      intents = JSON.parse(rawIntents.replace(/```json|```/g, ""));
      if (!Array.isArray(intents)) throw new Error("Not an array");
    } catch {
      intents = [{ intent: "chat", parameters: { prompt: text } }];
    }

    // 3. Process Intents
    const results = await handleIntents(normSlug, intents, { device });

    // 4. Shoom Reply Logic: Find the most relevant response
    let finalReply = "";
    let song_url = null;
    const isMusic = intents.some(i => i?.intent === "music");

    // If multiple intents were returned, prefer Gemini's organic queue reply if provided, else use natural queue reply
    if (intents.length > 1) {
      const geminiQueueReply = intents[0]?.reply;
      // Check if Gemini already produced a consolidated queue confirmation
      if (geminiQueueReply && (geminiQueueReply.toLowerCase().includes("queue") || geminiQueueReply.toLowerCase().includes("tasks") || geminiQueueReply.toLowerCase().includes("creating") || geminiQueueReply.toLowerCase().includes("working on"))) {
        finalReply = geminiQueueReply;
      } else {
        finalReply = `I'm queuing ${intents.length} tasks for you. Please wait a moment while I create them.`;
      }
    } else {
      // Strategy: Priority-based selection
      const priorityIntents = ["music", "announcement", "chat", "general", "weather", "news"];

      // Find first matching high-priority intent result
      for (const pIntent of priorityIntents) {
        const idx = intents.findIndex(i => i?.intent === pIntent);
        if (idx !== -1 && results[idx]) {
          const r = results[idx];
          finalReply = typeof r === "string" ? r : (r?.reply || r?.text || "");
          if (pIntent === "music") song_url = r?.song_url || null;
          if (finalReply) break;
        }
      }

      // Fallback: Just pick the first non-empty result
      if (!finalReply) {
        for (const r of results) {
          finalReply = typeof r === "string" ? r : (r?.reply || r?.text || "");
          if (finalReply) break;
        }
      }
    }

    // Derive the primary intent for the Pi to act on locally
    const primaryIntent = intents[0]?.intent || "general";
    const primaryParams = intents[0]?.parameters || {};
    const primaryReply = intents[0]?.reply || "";
    const cleanSpokenReply = finalReply || primaryReply || "I processed that for you.";

    const responseObj = {
      reply: cleanSpokenReply,
      intent: primaryIntent,
      intents: intents.map((obj, i) => ({
        intent: obj.intent,
        reply: obj.reply || (i === 0 ? cleanSpokenReply : "") || "",
        parameters: obj.parameters || {}
      })),
      text,
      shoom: true,
      timestamp: Date.now()
    };

    if (song_url) {
      responseObj.song_url = song_url;
      if (isMusic) responseObj.link = song_url;
      // Inject song_url into the music intent parameters so Pi can play directly
      const musicIntentObj = responseObj.intents.find(i => i.intent === "music");
      if (musicIntentObj) musicIntentObj.parameters.song_url = song_url;
    }

    // 5. Send HTTP 200 response immediately to the client (Do NOT await storage sync!)
    res.json(responseObj);

    // 6. Asynchronous Background Storage Sync for chat.txt
    setImmediate(async () => {
      try {
        await appendChat(normSlug, text, cleanSpokenReply);
        logInfo(`[Background-Sync] chat.txt updated for ${normSlug}`);
      } catch (syncErr) {
        logError(`[Background-Sync-Error] Failed to sync chat.txt for ${normSlug}:`, syncErr);
      }
    });

    return;
  } catch (err) {
    logError(`[Shoom-Error] ${slug}:`, err);
    return res.status(500).json({ error: "shoom_crash", message: String(err) });
  }
}

// ---------------- TEXT ROUTE ----------------
homeRouter.post("/text/:slug", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }

    const text = String(req.body?.text || "").trim();

    if (!slug || !text) {
      return res.status(400).json({ error: "bad_request" });
    }

    const device = await getUserPlanBySlug(slug);
    if (!device) {
      return res.status(404).json({ error: "invalid_slug" });
    }

    return handleTextRequest(req, res, slug, text, device);

  } catch (err) {
    logError("TEXT ERROR:", err);
    return res.status(500).json({
      error: "server_error",
      message: String(err)
    });
  }
});

// ---------------- CHAT HISTORY ----------------
homeRouter.get("/chat/:slug", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }


    const device = await getUserPlanBySlug(slug);
    if (!device) return res.status(404).json({ error: "invalid_slug" });

    const chat = await loadChat(slug);
    return res.json({ chat });
  } catch (err) {
    logError("CHAT ERROR:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

// ✅ DELETE SPECIFIC CHAT ENTRY
homeRouter.delete("/chat/:slug/:index", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }

    const index = parseInt(req.params.index, 10);

    if (isNaN(index)) return res.status(400).json({ error: "invalid_index" });

    const device = await getUserPlanBySlug(slug);
    if (!device) return res.status(404).json({ error: "invalid_slug" });

    const chat = await deleteChatEntry(slug, index);
    return res.json({ ok: true, chat });
  } catch (err) {
    logError("DELETE CHAT ERROR:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

// ---------------- LIMITS CHECK ----------------
homeRouter.get("/limits/:slug", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }

    const device = await getUserPlanBySlug(slug);
    if (!device) return res.status(404).json({ error: "invalid_slug" });

    const tier = Number(device["subscription-tier"] || 0);
    const limits = await ensureLimitFile(slug);
    const tierLimits = getLimitsForTier(tier);

    // 🚀 NEW: Matrix Subscription Data
    const isPro = device.subscription === "true";
    const trialUsed = device.trialUsed === "true" || device.trialUsed === true;
    const trialEnd = device.trialEnd || null;

    return res.json({
      used: limits,
      allowed: tierLimits,
      tier,
      isPro,
      trialUsed,
      trialEnd
    });
  } catch (err) {
    logError("LIMITS ERROR:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

// ---------------- NO-OP GET ----------------
// Accepts any query params but intentionally does nothing with them.
homeRouter.get("/noop", (req, res) => {
  return res.json({ ok: true });
});

function parseJsonSafely(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseWakeWordsDocument(rawValue) {
  const parsed = parseJsonSafely(rawValue, null);
  if (Array.isArray(parsed)) {
    return { words: parsed, meta: {} };
  }
  if (parsed && typeof parsed === "object") {
    return {
      words: Array.isArray(parsed.words)
        ? parsed.words
        : (Array.isArray(parsed.wakeWords) ? parsed.wakeWords : []),
      meta: parsed.meta && typeof parsed.meta === "object" ? parsed.meta : {},
    };
  }
  return { words: [], meta: {} };
}


// GET: Pi polls this to fetch its own settings (isMuted, nightProtocol, musicDownload, wakeWords, TTS etc.)
homeRouter.get("/device/:slug/settings", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    const device = await getUserPlanBySlug(slug);
    if (!device) return res.status(404).json({ ok: false, error: "device_not_found" });

    const wakeWordsBlob = parseWakeWordsDocument(device.wakeWords);
    const meta = wakeWordsBlob.meta || {};

    const settingsDoc = {
      isMuted: device.isMuted ?? false,
      memoryEnabled: device.memoryEnabled ?? true,
      assistantName: device.assistantName || "RK",
      greetingPhrase: device.greetingPhrase || "Radhe Radhe",
      wakeWords: device.wakeWords || null,
      ttsConfig: meta.ttsConfig || device.ttsConfig || null,
      voiceVolume: meta.voiceVolume !== undefined ? meta.voiceVolume : (device.vol !== undefined ? Number(device.vol) : (device.voiceVolume !== undefined ? Number(device.voiceVolume) : 70)),
      vol: device.vol !== undefined ? Number(device.vol) : (meta.voiceVolume !== undefined ? meta.voiceVolume : (device.voiceVolume !== undefined ? Number(device.voiceVolume) : 70)),
      nightProtocolEnabled: meta.nightProtocolEnabled ?? true,
      musicDownloadEnabled: device.musicDownloadEnabled ?? device.music_download_enabled ?? device.downloadMusic ?? false,
      smart_devices: device.smart_devices || device.smartDevices || [],
      subscription: device.subscription,
    };

    // Return in the format settings_sync.py expects: { documents: [doc] }
    return res.json({ ok: true, documents: [settingsDoc] });
  } catch (err) {
    console.error("[GET Settings] Error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// POST: Disconnect Google Drive storage (reverts device back to Supabase)
homeRouter.post("/device/:slug/storage/disconnect-google", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    const device = await getUserPlanBySlug(slug);
    if (!device) return res.status(404).json({ error: "Device not found" });

    await db.updateDocument(
      process.env.APPWRITE_DB_ID,
      process.env.APPWRITE_DEVICES_COLLECTION,
      device.$id,
      {
        storageUsing: "supabase",
        googleAccessToken: null,
        googleRefreshToken: null,
        googleFolderId: null
      }
    );

    logInfo(`[Storage] Disconnected Google Drive for device ${slug}. Storage set back to Supabase.`);
    return res.json({ ok: true, storageUsing: "supabase", message: "Google Drive disconnected successfully." });
  } catch (err) {
    logError("DISCONNECT GOOGLE DRIVE ERROR:", err);
    return res.status(500).json({ error: "Server error", message: String(err) });
  }
});

// POST: Disconnect Spotify account
homeRouter.post("/device/:slug/spotify/disconnect", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    const device = await getUserPlanBySlug(slug);
    if (!device) return res.status(404).json({ error: "Device not found" });

    await db.updateDocument(
      process.env.APPWRITE_DB_ID,
      process.env.APPWRITE_DEVICES_COLLECTION,
      device.$id,
      {
        spotifyConnected: "false",
        spotifyAccessToken: null,
        spotifyRefreshToken: null
      }
    );

    logInfo(`[Spotify] Disconnected Spotify account for device ${slug}.`);
    return res.json({ ok: true, spotifyConnected: false, message: "Spotify account disconnected successfully." });
  } catch (err) {
    logError("DISCONNECT SPOTIFY ERROR:", err);
    return res.status(500).json({ error: "Server error", message: String(err) });
  }
});

// POST: Update / Upgrade / Downgrade Device Tier
homeRouter.post("/device/:slug/plan", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    const { tier, plan } = req.body;
    const device = await getUserPlanBySlug(slug);
    if (!device) return res.status(404).json({ error: "Device not found" });

    const tierMap = {
      0: "free",
      1: "student",
      2: "creator",
      3: "pro",
      4: "studio",
      "free": 0,
      "trial": 1,
      "student": 1,
      "creator": 2,
      "pro": 3,
      "studio": 4,
      "elite": 2,
      "quantum": 3,
      "infinity": 4
    };

    let targetTierNum = 0;
    if (typeof tier === "number") {
      targetTierNum = tier;
    } else if (tier && tierMap[tier] !== undefined) {
      targetTierNum = tierMap[tier];
    } else if (plan && tierMap[plan] !== undefined) {
      targetTierNum = tierMap[plan];
    }

    const isSubscribed = targetTierNum > 0;
    const now = new Date();
    const expiry = isSubscribed ? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString() : null;

    await db.updateDocument(
      process.env.APPWRITE_DB_ID,
      process.env.APPWRITE_DEVICES_COLLECTION,
      device.$id,
      {
        subscription: isSubscribed ? "true" : "false",
        "subscription-tier": targetTierNum,
        subscription_expires_at: expiry,
        trialEnd: targetTierNum === 0 ? null : (device.trialEnd || null)
      }
    );

    logInfo(`[Plan] Device ${slug} plan changed to tier: ${targetTierNum} (${tierMap[targetTierNum] || 'free'}).`);
    return res.json({
      ok: true,
      slug,
      tier: targetTierNum,
      tierName: tierMap[targetTierNum] || "free",
      subscription: isSubscribed,
      expiresAt: expiry
    });
  } catch (err) {
    logError("PLAN UPDATE ERROR:", err);
    return res.status(500).json({ error: "Server error", message: String(err) });
  }
});

// ---------------- DEVICE SETTINGS ----------------
homeRouter.post("/device/:slug/settings", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }

    const settings = req.body;

    console.log(`[Settings] Updating settings for ${slug}:`, settings);

    const device = await getUserPlanBySlug(slug);
    if (!device) return res.status(404).json({ error: "device_not_found" });

    const updateData = { ...settings };
    const wakeWordsBlob = parseWakeWordsDocument(device.wakeWords);
    let wakeWordsChanged = false;

    // Safely pack nested UI configs into string-backed Appwrite fields and wakeWords meta.
    let currentConfig = {};
    try { currentConfig = JSON.parse(device.systemStatus || "{}"); } catch (e) { }

    let configUpdated = false;
    if (settings.nightProtocolEnabled !== undefined) {
      currentConfig.nightProtocolEnabled = settings.nightProtocolEnabled;
      wakeWordsBlob.meta.nightProtocolEnabled = settings.nightProtocolEnabled;
      delete updateData.nightProtocolEnabled; // Remove so Appwrite doesn't throw Attribute Error
      configUpdated = true;
      wakeWordsChanged = true;
    }

    // Handle musicDownloadEnabled toggle (pack inside wakeWords metadata to prevent Appwrite schema error)
    if (settings.musicDownloadEnabled !== undefined || settings.downloadMusic !== undefined) {
      const isEnabled = Boolean(settings.musicDownloadEnabled !== undefined ? settings.musicDownloadEnabled : settings.downloadMusic);
      currentConfig.musicDownloadEnabled = isEnabled;
      wakeWordsBlob.meta.musicDownloadEnabled = isEnabled;
      delete updateData.musicDownloadEnabled;
      delete updateData.downloadMusic;
      configUpdated = true;
      wakeWordsChanged = true;
    }

    const targetVolume = settings.vol !== undefined ? settings.vol : settings.voiceVolume;
    if (targetVolume !== undefined) {
      const volNum = Math.max(0, Math.min(100, Number(targetVolume)));
      wakeWordsBlob.meta.voiceVolume = volNum;
      wakeWordsChanged = true;
      updateData.vol = volNum;
    }

    if (settings.ttsConfig !== undefined) {
      const normalizedTtsConfig = parseJsonSafely(settings.ttsConfig, null);
      if (normalizedTtsConfig && typeof normalizedTtsConfig === "object" && !Array.isArray(normalizedTtsConfig)) {
        wakeWordsBlob.meta.ttsConfig = normalizedTtsConfig;
        updateData.ttsConfig = JSON.stringify(normalizedTtsConfig);
        wakeWordsChanged = true;
      } else {
        delete updateData.ttsConfig;
      }
    }
    // systemStatus is not an Appwrite attribute - kept in wakeWordsBlob.meta
    if (wakeWordsChanged) {
      updateData.wakeWords = JSON.stringify(wakeWordsBlob);
    }

    // 🚀 If assistantName is updated, use Gemini to generate wake word variations
    if (settings.assistantName && settings.assistantName !== device.assistantName) {
      console.log(`[Settings] Assistant name changed to ${settings.assistantName}. Generating wake words...`);
      try {
        const prompt = `Generate 8-10 speech-to-text transcription variants for the assistant name "${settings.assistantName}" — include phonetic matches, common mishearings, and misspellings.
Return ONLY a JSON array of strings.`;

        const aiResponse = await callGemini(prompt);
        // Clean the response to ensure it's valid JSON
        const cleanedResponse = aiResponse.replace(/```json|```/g, '').trim();
        const variations = JSON.parse(cleanedResponse);

        // Ensure the original name is included
        if (!variations.includes(settings.assistantName)) {
          variations.unshift(settings.assistantName);
        }

        wakeWordsBlob.words = variations;
        updateData.wakeWords = JSON.stringify(wakeWordsBlob);
        console.log(`[Settings] Generated wake words:`, variations);
      } catch (err) {
        console.error(`[Settings] Failed to generate wake words:`, err);
        // Fallback to just the name
        wakeWordsBlob.words = [settings.assistantName];
        updateData.wakeWords = JSON.stringify(wakeWordsBlob);
      }
    }

    await db.updateDocument(
      process.env.APPWRITE_DB_ID,
      process.env.APPWRITE_DEVICES_COLLECTION,
      device.$id,
      updateData
    );

    return res.json({
      success: true,
      wakeWords: updateData.wakeWords ? JSON.parse(updateData.wakeWords) : null,
      systemStatus: currentConfig,
      ttsConfig: updateData.ttsConfig ? JSON.parse(updateData.ttsConfig) : null
    });
  } catch (err) {
    console.error(`[Settings] Error updating settings:`, err);
    res.status(500).json({ error: String(err) });
  }
});

homeRouter.get("/device/check/:slug", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }


    if (!/^\d{9}$/.test(slug)) {
      return res.status(400).json({ error: "invalid_slug_format" });
    }

    const exists = await checkDeviceBySlug(slug);
    return res.json({ exists });

  } catch (err) {
    logError("DEVICE CHECK ERROR:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

homeRouter.get("/device/:slug/profile", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }

    const device = await getUserPlanBySlug(slug);
    if (!device) return res.status(404).json({ error: "Device not found" });
    return res.json({ email: device.email || "", username: device.name || "" });
  } catch (err) {
    return res.status(500).json({ error: "server_error" });
  }
});

// ---------------- ALARMS ----------------
homeRouter.get("/device/:slug/alarms", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }

    console.log(`[Alarms Fetch] Fetching alarms for device slug: ${slug}`);

    const device = await getUserPlanBySlug(slug);
    if (!device) {
      console.warn(`[Alarms Fetch] Device not found for slug: ${slug}`);
      return res.status(404).json({ error: "device_not_found" });
    }

    console.log(`[Alarms Fetch] Device ID: ${device.$id}. Querying Appwrite collection 'alarms' where 'id' == ${device.$id}...`);

    const result = await db.listDocuments(
      process.env.APPWRITE_DB_ID,
      "alarms",
      [Query.equal("id", device.$id), Query.limit(100)]
    );

    console.log(`[Alarms Fetch] Success! Found ${result.documents.length} alarms.`);

    const alarms = result.documents.map(d => ({
      ...d,
      id: d.$id,
      label: d.for || d.label || "Alarm",
      days: typeof d.days === 'string' ? JSON.parse(d.days || "[]") : (d.days || [])
    }));
    return res.json(alarms);
  } catch (err) {
    console.error(`[Alarms Fetch Error]`, err);
    if (err.code === 404) {
      console.error(`[Alarms Fetch Error] Collection 'alarms' not found! Check your Appwrite Collection ID settings.`);
      return res.json([]);
    }
    // Return the specific error message to help the user debug "Application Error"
    res.status(500).json({
      error: "server_error",
      message: err.message,
      code: err.code
    });
  }
});

// ---------------- SCHEDULES ----------------
homeRouter.get("/device/:slug/schedules", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }

    const device = await getUserPlanBySlug(slug);
    if (!device) return res.status(404).json({ error: "device_not_found" });

    const result = await db.listDocuments(
      process.env.APPWRITE_DB_ID,
      "schedules",
      [Query.equal("id", device.$id), Query.limit(100)]
    );

    const schedules = result.documents.map(d => ({
      ...d,
      id: d.$id,
      task: d.task || d.taskId || "Task"
    }));
    return res.json(schedules);
  } catch (err) {
    if (err.code === 404) return res.json([]);
    res.status(500).json({ error: String(err) });
  }
});

// ---------------- ALARMS & SCHEDULES SYNC FROM PI ----------------
homeRouter.post("/device/:slug/sync_alarms", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }

    const { alarms } = req.body;
    const device = await getUserPlanBySlug(slug);
    if (!device) return res.status(404).json({ error: "device_not_found" });

    // Wipe old alarms
    try {
      const old = await db.listDocuments(process.env.APPWRITE_DB_ID, "alarms", [Query.equal("id", device.$id)]);
      for (const doc of old.documents) {
        await db.deleteDocument(process.env.APPWRITE_DB_ID, "alarms", doc.$id);
      }
    } catch (e) { }

    // Insert new alarms
    if (Array.isArray(alarms)) {
      for (const alarm of alarms) {
        await db.createDocument(process.env.APPWRITE_DB_ID, "alarms", ID.unique(), {
          id: device.$id,
          time: String(alarm.time || ""),
          date: String(alarm.date || ""),
          days: typeof alarm.days === 'string' ? alarm.days : JSON.stringify(alarm.days || []),
          sound: String(alarm.sound || "default"),
          for: String(alarm.label || alarm.for || "Alarm")
        });
      }
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error(`[Sync] Alarms error:`, err);
    res.status(500).json({ error: String(err) });
  }
});

homeRouter.post("/device/:slug/sync_schedules", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }

    const { schedules } = req.body;
    const device = await getUserPlanBySlug(slug);
    if (!device) return res.status(404).json({ error: "device_not_found" });

    // Wipe old schedules
    try {
      const old = await db.listDocuments(process.env.APPWRITE_DB_ID, "schedules", [Query.equal("id", device.$id)]);
      for (const doc of old.documents) {
        await db.deleteDocument(process.env.APPWRITE_DB_ID, "schedules", doc.$id);
      }
    } catch (e) { }

    // Insert new schedules
    if (Array.isArray(schedules)) {
      for (const sched of schedules) {
        await db.createDocument(process.env.APPWRITE_DB_ID, "schedules", ID.unique(), {
          id: device.$id,
          time: String(sched.time || ""),
          date: String(sched.date || ""),
          days: "[]",
          sound: "none",
          for: String(sched.task || sched.label || "Schedule")
        });
      }
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error(`[Sync] Schedules error:`, err);
    res.status(500).json({ error: String(err) });
  }
});

// ---------------- FILES (List & Download) ----------------
homeRouter.get("/device/:slug/files", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }

    const files = await listFilesFromSlug(slug);
    const filtered = files.filter(f => !['chat.txt', 'limit.txt', 'welcome.txt'].includes(f.name.toLowerCase()));

    // Add dynamic streaming URL for the frontend
    const mapped = filtered.map(f => ({
      ...f,
      url: `/device/${slug}/file/${f.name}` // Next.js proxy will route this
    }));

    return res.json({ slug, folderExists: true, files: mapped });
  } catch (err) {
    return res.status(500).json({ slug: req.params.slug, folderExists: false, files: [] });
  }
});

homeRouter.get("/device/:slug/file/:filename", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }

    const filename = req.params.filename;
    const buffer = await downloadFileFromSlug(slug, filename);

    if (!buffer) return res.status(404).send("File not found");

    let mimeType = 'application/octet-stream';
    const lowerName = filename.toLowerCase();
    if (lowerName.endsWith('.png')) mimeType = 'image/png';
    else if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) mimeType = 'image/jpeg';
    else if (lowerName.endsWith('.mp4')) mimeType = 'video/mp4';
    else if (lowerName.endsWith('.mp3')) mimeType = 'audio/mpeg';
    else if (lowerName.endsWith('.pdf')) mimeType = 'application/pdf';
    else if (lowerName.endsWith('.docx')) mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    else if (lowerName.endsWith('.pptx')) mimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    else if (lowerName.endsWith('.xlsx')) mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    else if (lowerName.endsWith('.txt')) mimeType = 'text/plain; charset=utf-8';
    else if (lowerName.endsWith('.json')) mimeType = 'application/json';

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(buffer);
  } catch (err) {
    return res.status(500).send(String(err));
  }
});

homeRouter.delete("/device/:slug/file/:filename", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }

    const filename = req.params.filename;
    const success = await deleteFileFromSlug(slug, filename);

    if (success) return res.json({ ok: true });
    else return res.status(500).json({ error: "Failed to delete file" });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------- DEVICE UPDATE STATUS (BUSY/DOWNLOAD) ----------------
homeRouter.post("/device/:slug/update-status", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }

    const { busyState, downloadProgress } = req.body;

    if (busyState) deviceBusyState.set(slug, busyState);
    if (downloadProgress !== undefined) deviceDownloadProgress.set(slug, downloadProgress);

    return res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});


// ⚡ High-speed server-side YouTube music stream resolution for Pi Zero W:
// Uses server's high-speed datacenter connection & yt-search + @distube/ytdl-core to resolve direct audio URL in ~1s
homeRouter.post("/device/:slug/music/resolve", async (req, res) => {
  const t0 = Date.now();
  try {
    const slug = normalizeSlug(req.params.slug);
    const query = String(req.body?.query || req.body?.prompt || "").trim();
    if (!query) return res.status(400).json({ error: "query required" });

    deviceLastSeen.set(slug, Date.now());
    console.log(`[Music-Resolve-Fast] Searching for: "${query}" for device ${slug}...`);

    // 1. Ultra-fast ytSearch on server
    const search = await ytSearch(query);
    const video = search?.videos?.[0];
    if (!video) {
      return res.status(404).json({ error: "No video found" });
    }

    // 2. Instant stream extraction with pre-imported ytdl
    let streamUrl = null;
    try {
      const info = await ytdl.getInfo(video.url);
      const audioFormats = ytdl.filterFormats(info.formats, "audioonly");
      if (audioFormats && audioFormats.length > 0) {
        streamUrl = audioFormats[0].url;
      }
    } catch (e) {
      console.log(`[Music-Resolve-Fast] ytdl stream extraction fallback: ${e.message}`);
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(`[Music-Resolve-Fast] Resolved "${video.title}" in ${elapsed}s`);

    return res.json({
      ok: true,
      title: video.title,
      vid_id: video.videoId,
      link: video.url,
      stream_url: streamUrl || video.url,
      elapsed_seconds: Number(elapsed)
    });
  } catch (err) {
    console.error("[Music-Resolve-Fast] Error:", err);
    return res.status(500).json({ error: String(err) });
  }
});

// 🟢 Server-side Spotify Resolve: Searches Spotify for official metadata/URI or plays on connected device
homeRouter.post("/device/:slug/spotify/resolve", async (req, res) => {
  const t0 = Date.now();
  try {
    const slug = normalizeSlug(req.params.slug);
    const query = String(req.body?.query || req.body?.prompt || "").trim();
    if (!query) return res.status(400).json({ error: "query required" });

    deviceLastSeen.set(slug, Date.now());

    // Check device Spotify credentials from Appwrite
    let accessToken = null;
    try {
      const device = await getUserPlanBySlug(slug);
      if (device && device.spotifyAccessToken && device.spotifyConnected === "true") {
        accessToken = device.spotifyAccessToken;
      }
    } catch (e) {
      console.log(`[Spotify-Resolve] Appwrite token lookup notice: ${e.message}`);
    }

    // 1. If user has Spotify connected, trigger Spotify Connect or return track info
    if (accessToken) {
      try {
        const spotifySearch = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=1`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        if (spotifySearch.ok) {
          const sData = await spotifySearch.json();
          const track = sData?.tracks?.items?.[0];
          if (track) {
            // Trigger Spotify Connect play if active
            const playResp = await fetch("https://api.spotify.com/v1/me/player/play", {
              method: "PUT",
              headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
              body: JSON.stringify({ uris: [track.uri] })
            });
            const connectOk = playResp.status === 204 || playResp.status === 200;
            return res.json({
              ok: true,
              type: "spotify_connect",
              connect_active: connectOk,
              title: `${track.name} - ${track.artists?.[0]?.name || ""}`,
              uri: track.uri,
              elapsed_seconds: Number(((Date.now() - t0) / 1000).toFixed(2))
            });
          }
        }
      } catch (err) {
        console.log(`[Spotify-Resolve] Direct Spotify Web API error: ${err.message}`);
      }
    }

    // 2. High-speed Bridge: If Spotify Connect is not active, resolve top audio stream seamlessly via ytSearch
    const search = await ytSearch(query);
    const video = search?.videos?.[0];
    if (!video) return res.status(404).json({ error: "No track found" });

    let streamUrl = null;
    try {
      const info = await ytdl.getInfo(video.url);
      const audioFormats = ytdl.filterFormats(info.formats, "audioonly");
      if (audioFormats && audioFormats.length > 0) {
        streamUrl = audioFormats[0].url;
      }
    } catch (e) {}

    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    return res.json({
      ok: true,
      type: "stream_bridge",
      title: video.title,
      vid_id: video.videoId,
      link: video.url,
      stream_url: streamUrl || video.url,
      elapsed_seconds: Number(elapsed)
    });
  } catch (err) {
    console.error("[Spotify-Resolve] Error:", err);
    return res.status(500).json({ error: String(err) });
  }
});

homeRouter.post("/device/:slug/music/recommend", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }

    const seedText = String(req.body?.current_title || req.body?.current_query || "").trim();

    if (!seedText) {
      return res.status(400).json({ error: "current_title required" });
    }

    deviceLastSeen.set(slug, Date.now());
    const resolved = await resolveNextMusicLink(seedText);

    if (!resolved) {
      return res.status(404).json({ error: "no_music_match" });
    }

    return res.json({
      ok: true,
      slug,
      ...resolved
    });
  } catch (err) {
    console.error("[Music-Resolve] Failed:", err);
    return res.status(500).json({ error: "music_recommend_failed", message: String(err) });
  }
});
homeRouter.post("/device/ensure/:slug", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }


    if (!/^\d{9}$/.test(slug)) {
      return res.status(400).json({ error: "invalid_slug_format" });
    }

    const result = await ensureDeviceBySlug(slug, req.body.deviceType || "home");

    return res.json({
      ok: true,
      created: result.created
    });

  } catch (err) {
    logError("DEVICE ENSURE ERROR:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

// ---------------- DEVICE AUTHENTICATION & CONTROL ----------------

// ---------------- DEVICE MAINTENANCE ----------------
// Pi polls this every 1 minute for background tasks (cleanup, etc.)
homeRouter.get("/device/:slug/maintenance", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }

    console.log(`[Maintenance] Maintenance started for device: ${slug}`);

    // 1. Update last seen timestamp
    deviceLastSeen.set(slug, Date.now());

    const device = await getUserPlanBySlug(slug);
    if (!device) {
      console.warn(`[Maintenance] Rejected: Device not found in Appwrite (${slug})`);
      return res.status(404).json({ error: "Device not found" });
    }

    const tierNum = device.subscription === "true" ? Number(device["subscription-tier"] || 0) : 0;
    const tierMap = { 0: "free", 1: "student", 2: "creator", 3: "pro", 4: "studio" };
    const tierName = tierMap[tierNum] || "free";

    // 2. Refresh Daily Limits (24h refresh check)
    await ensureLimitFile(slug);

    // 3. Check Storage Space in Supabase
    const storageUsedMB = await cleanupSupabaseFiles(slug, tierName);
    const storageInfo = {
      usedMB: storageUsedMB || 0,
      tier: tierName,
      lastSeen: new Date().toISOString()
    };

    console.log(`[Maintenance] Completed for ${slug}. Storage: ${storageInfo.usedMB.toFixed(2)}MB, Tier: ${tierName}`);

    return res.json({
      ok: true,
      message: "Maintenance complete",
      storage: storageInfo,
      shoom: "⚡"
    });

  } catch (err) {
    logError("MAINTENANCE ERROR:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Verify device password
homeRouter.post("/device/:slug/verify", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }

    const { password } = req.body;

    if (!/^\d{9}$/.test(slug)) {
      return res.status(400).json({ verified: false, message: "Invalid slug format" });
    }

    if (!password) {
      return res.status(400).json({ verified: false, message: "Password required" });
    }

    // Get device from Appwrite
    const deviceDoc = await db.listDocuments(
      process.env.APPWRITE_DB_ID,
      process.env.APPWRITE_DEVICES_COLLECTION,
      [Query.equal("slug", Number(slug))]
    );

    if (deviceDoc.documents.length === 0) {
      return res.status(404).json({ verified: false, message: "Device not found" });
    }

    const device = deviceDoc.documents[0];

    // Check password (assuming there's a 'password' field in devices collection)
    if (device.password === password) {
      return res.json({
        verified: true,
        deviceName: device.name_of_device || "RK AI",
        tier: device["subscription-tier"] || 0
      });
    } else {
      return res.status(401).json({ verified: false, message: "Incorrect password" });
    }

  } catch (err) {
    logError("PASSWORD VERIFY ERROR:", err);
    return res.status(500).json({ verified: false, message: "Server error" });
  }
});

// Toggle device mute state
homeRouter.post("/device/:slug/mute", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }

    const { muted } = req.body;

    if (!/^\d{9}$/.test(slug)) {
      return res.status(400).json({ error: "Invalid slug format" });
    }

    // Get device document
    const deviceDoc = await db.listDocuments(
      process.env.APPWRITE_DB_ID,
      process.env.APPWRITE_DEVICES_COLLECTION,
      [Query.equal("slug", Number(slug))]
    );

    if (deviceDoc.documents.length === 0) {
      return res.status(404).json({ error: "Device not found" });
    }

    const device = deviceDoc.documents[0];

    // Update mute state in Appwrite
    await db.updateDocument(
      process.env.APPWRITE_DB_ID,
      process.env.APPWRITE_DEVICES_COLLECTION,
      device.$id,
      { isMuted: muted }
    );

    // Also push an instant command to the queue so Pi reacts within seconds (not 30s poll cycle)
    try {
      const collectionId = process.env.APPWRITE_COMMANDS_COLLECTION || "commands";
      await db.createDocument(process.env.APPWRITE_DB_ID, collectionId, ID.unique(), {
        slug: Number(slug),
        commandType: muted ? "mute" : "unmute",
        payload: JSON.stringify({ mute: muted }),
        status: "pending",
        createdAt: new Date().toISOString(),
        executedAt: null,
        result: null
      });
    } catch (cmdErr) {
      console.warn("[Mute] Failed to push instant command (non-fatal):", cmdErr.message);
    }

    logInfo(`Device ${slug} mute state set to: ${muted}`);

    return res.json({
      ok: true,
      muted,
      message: muted ? "Device muted" : "Device unmuted"
    });

  } catch (err) {
    logError("MUTE TOGGLE ERROR:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Toggle device memory state
homeRouter.post("/device/:slug/memory", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }

    const { enabled } = req.body;

    if (!/^\d{9}$/.test(slug)) {
      return res.status(400).json({ error: "Invalid slug format" });
    }

    // Get device document
    const deviceDoc = await db.listDocuments(
      process.env.APPWRITE_DB_ID,
      process.env.APPWRITE_DEVICES_COLLECTION,
      [Query.equal("slug", Number(slug))]
    );

    if (deviceDoc.documents.length === 0) {
      return res.status(404).json({ error: "Device not found" });
    }

    const device = deviceDoc.documents[0];

    // Update memory state in Appwrite
    await db.updateDocument(
      process.env.APPWRITE_DB_ID,
      process.env.APPWRITE_DEVICES_COLLECTION,
      device.$id,
      { memoryEnabled: enabled }
    );

    logInfo(`Device ${slug} memory set to: ${enabled}`);

    return res.json({
      ok: true,
      enabled,
      message: enabled ? "Memory enabled" : "Memory disabled"
    });

  } catch (err) {
    logError("MEMORY TOGGLE ERROR:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ---------------- COMMAND QUEUE SYSTEM ----------------

// Queue a command for Pi to execute
homeRouter.post("/device/:slug/command", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }

    const { command_type, payload } = req.body;

    console.log(`[Command Uplink] Received ${command_type} for slug: ${slug}`);
    console.log("[Command Uplink] Body:", JSON.stringify(req.body));

    // Relaxed slug validation: must be numeric, length doesn't have to be 9
    if (!/^\d+$/.test(slug)) {
      console.error("[Command Uplink] Invalid slug format:", slug);
      return res.status(400).json({ error: "Invalid slug format (must be numeric)" });
    }

    if (!command_type) {
      console.error("[Command Uplink] Missing command_type");
      return res.status(400).json({ error: "Missing command_type" });
    }

    // Validate device exists
    console.log(`[Command Uplink] Verifying device exists. DB: ${process.env.APPWRITE_DB_ID}, Collection: ${process.env.APPWRITE_DEVICES_COLLECTION || 'devices'}, Slug: ${slug}`);

    let deviceDoc;
    try {
      deviceDoc = await db.listDocuments(
        process.env.APPWRITE_DB_ID,
        process.env.APPWRITE_DEVICES_COLLECTION || "devices", // 🚀 Added fallback
        [Query.equal("slug", Number(slug))]
      );
    } catch (listErr) {
      console.error("[Command Uplink] Appwrite listDocuments failed:", listErr.message);
      return res.status(500).json({ error: `Appwrite access failed: ${listErr.message}` });
    }

    if (!deviceDoc || deviceDoc.documents.length === 0) {
      console.error("[Command Uplink] Device not found in Appwrite registry:", slug);
      return res.status(404).json({ error: `Device ${slug} not registered` });
    }

    const device = deviceDoc.documents[0];

    // 🚀 INSTANT DB SYNC for Alarms & Schedules Collections (so the app updates instantly)
    try {
      if (command_type === "set_alarm") {
        await db.createDocument(process.env.APPWRITE_DB_ID, "alarms", ID.unique(), {
          id: device.$id,
          time: String(payload.time || ""),
          date: String(payload.date || ""),
          days: JSON.stringify(payload.days || []),
          sound: String(payload.sound || "default"),
          for: String(payload.label || "Alarm")
        });
      }
      else if (command_type === "delete_alarm") {
        // Appwrite delete requires Document ID. But payload might only have alarm_id.
        // We must query and delete.
        try {
          const docs = await db.listDocuments(process.env.APPWRITE_DB_ID, "alarms", [Query.equal("id", device.$id)]);
          for (let doc of docs.documents) {
            if (doc.$id === payload.alarm_id) {
              await db.deleteDocument(process.env.APPWRITE_DB_ID, "alarms", doc.$id);
            }
          }
        } catch (e) { }
      }
      else if (command_type === "set_schedule") {
        await db.createDocument(process.env.APPWRITE_DB_ID, "schedules", ID.unique(), {
          id: device.$id,
          time: String(payload.time || ""),
          date: String(payload.date || ""),
          days: "[]",
          sound: "none",
          for: String(payload.task || "Schedule")
        });
      }
      else if (command_type === "delete_schedule") {
        try {
          const docs = await db.listDocuments(process.env.APPWRITE_DB_ID, "schedules", [Query.equal("id", device.$id)]);
          for (let doc of docs.documents) {
            if (doc.$id === payload.schedule_id) {
              await db.deleteDocument(process.env.APPWRITE_DB_ID, "schedules", doc.$id);
            }
          }
        } catch (e) { }
      }
      else if (command_type === "volume") {
        const volVal = payload.volume !== undefined ? Number(payload.volume) : (payload.level !== undefined ? Number(payload.level) : null);
        if (volVal !== null && !isNaN(volVal)) {
          const safeVol = Math.max(0, Math.min(100, volVal));
          await db.updateDocument(
            process.env.APPWRITE_DB_ID,
            process.env.APPWRITE_DEVICES_COLLECTION || "devices",
            device.$id,
            { vol: safeVol }
          ).catch(e => console.error("[Command Uplink] Failed to update vol attribute:", e.message));
        }
      }
    } catch (syncErr) {
      console.error("[Command Uplink] Failed to auto-sync alarm/schedule to Appwrite:", syncErr);
    }

    // Create command in Appwrite commands collection
    const docData = {
      slug: Number(slug),
      commandType: command_type,
      payload: JSON.stringify(payload || {}),
      status: "pending",
      createdAt: new Date().toISOString(),
      executedAt: null,
      result: null
    };

    const collectionId = process.env.APPWRITE_COMMANDS_COLLECTION || "commands";
    console.log(`[Command Uplink] Creating document in collection: ${collectionId}`);

    let command;
    try {
      command = await db.createDocument(
        process.env.APPWRITE_DB_ID,
        collectionId,
        ID.unique(),
        docData
      );
    } catch (createErr) {
      console.error("[Command Uplink] Appwrite createDocument failed:", createErr.message);
      if (createErr.response) console.error("[Command Uplink] Full Response:", JSON.stringify(createErr.response));

      // If the error is about "commandType", maybe try a different attribute name or log it clearly
      return res.status(500).json({
        error: `Failed to create command: ${createErr.message}`,
        details: createErr.response
      });
    }

    console.log("[Command Uplink] Success! Command ID:", command.$id);

    return res.json({
      ok: true,
      command_id: command.$id,
      queued_at: command.createdAt || command.$createdAt
    });
  } catch (err) {
    console.error("[Command Uplink] FATAL ERROR:", err.message);
    if (err.response) console.error("[Command Uplink] Appwrite details:", err.response);
    return res.status(500).json({ error: err.message });
  }
});

// Pi polls for pending commands
homeRouter.get("/device/:slug/commands/pending", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }


    // Record the fact that this device natively polled the server right now
    deviceLastSeen.set(slug, Date.now());

    // Get pending commands for this device
    const commands = await db.listDocuments(
      process.env.APPWRITE_DB_ID,
      process.env.APPWRITE_COMMANDS_COLLECTION || "commands",
      [
        Query.equal("slug", Number(slug)),
        Query.equal("status", "pending"),
        Query.orderAsc("$createdAt"),
        Query.limit(10)
      ]
    );

    // Parse JSON payload for each command
    const parsedCommands = commands.documents.map(cmd => ({
      ...cmd,
      payload: JSON.parse(cmd.payload || "{}")
    }));

    return res.json({ commands: parsedCommands });

  } catch (err) {
    logError("COMMAND POLL ERROR:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Pi marks command as complete
homeRouter.post("/device/:slug/commands/:command_id/complete", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }

    const command_id = req.params.command_id;
    const { result, success } = req.body;

    if (!/^\d{9}$/.test(slug)) {
      return res.status(400).json({ error: "Invalid slug format" });
    }

    // Update command status
    await db.updateDocument(
      process.env.APPWRITE_DB_ID,
      process.env.APPWRITE_COMMANDS_COLLECTION || "commands",
      command_id,
      {
        status: success ? "completed" : "failed",
        executedAt: new Date().toISOString(), // 🚀 Fixed: Use executedAt for Appwrite schema
        result: result || "No result"
      }
    );

    logInfo(`Command ${command_id} marked as ${success ? 'completed' : 'failed'}`);

    return res.json({ ok: true });

  } catch (err) {
    logError("COMMAND COMPLETE ERROR:", err);
    return res.status(500).json({ error: "Server error" });
  }
});


// ---------------- HEALTH & ROOT ----------------
homeRouter.get("/health", (req, res) => {
  return res.json({ status: "healthy", timestamp: new Date().toISOString(), version: "3.0.0", shoom: true });
});

homeRouter.get("/", (req, res) => {
  return res.send("<h1>🚀 RexyCore Backend v3.0.0</h1><p>Shoom mode active.</p>");
});

// Shoom Debug: See all registered devices
homeRouter.get("/shoom/debug/devices", (req, res) => {
  const devices = {};
  const now = Date.now();
  for (const [slug, lastSeen] of deviceLastSeen.entries()) {
    devices[slug] = {
      lastSeen: new Date(lastSeen).toISOString(),
      diffSeconds: Math.floor((now - lastSeen) / 1000),
      online: (now - lastSeen < 180000)
    };
  }
  return res.json({
    count: deviceLastSeen.size,
    threshold: "180s",
    devices
  });
});

// ---------------- WEB AUTH & DATA (Rexycore Website) ----------------

// Remove the separate /web/auth/google/callback as we'll unify it
// (I will remove it in the next step when I edit the unified handler)

function getWebAuthUserId(req) {
  const authHeader = req.headers.authorization || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  return (
    req.headers["x-user-id"] ||
    req.headers["x-appwrite-user-id"] ||
    bearerToken ||
    req.query.userId ||
    req.query.token ||
    ""
  );
}

homeRouter.get("/web/auth/me", async (req, res) => {
  const userId = String(getWebAuthUserId(req)).trim();
  console.log("[Web Auth] /web/auth/me request", {
    hasAuthorization: Boolean(req.headers.authorization),
    hasXUserId: Boolean(req.headers["x-user-id"]),
    hasXAppwriteUserId: Boolean(req.headers["x-appwrite-user-id"]),
    resolvedUserId: userId || null,
    origin: req.headers.origin || null,
    referer: req.headers.referer || null,
  });

  if (!userId) {
    console.warn("[Web Auth] /web/auth/me missing user id", {
      hasAuthorization: Boolean(req.headers.authorization),
      hasXUserId: Boolean(req.headers["x-user-id"]),
      hasXAppwriteUserId: Boolean(req.headers["x-appwrite-user-id"]),
      queryKeys: Object.keys(req.query || {}),
    });
    return res.json({ authenticated: false, user: null, error: "Unauthorized" });
  }

  try {
    const user = await users.get(userId);
    console.log("[Web Auth] /web/auth/me authenticated", {
      userId: user.$id,
      email: user.email,
    });
    return res.json({ authenticated: true, user });
  } catch (err) {
    console.warn("[Web Auth] /web/auth/me invalid user id", {
      userId,
      code: err?.code,
      type: err?.type,
      message: err?.message,
    });
    return res.status(401).json({ authenticated: false, user: null, error: "Session invalid" });
  }
});

homeRouter.get("/web/profile/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    const [waitlistReq, ordersReq, preordersReq, subscriptionsReq] = await Promise.all([
      db.listDocuments(process.env.APPWRITE_DB_ID, "waitlist", [Query.equal("userId", userId), Query.orderDesc("$createdAt"), Query.limit(50)]).catch(() => ({ documents: [] })),
      db.listDocuments(process.env.APPWRITE_DB_ID, "order", [Query.equal("userId", userId), Query.orderDesc("$createdAt"), Query.limit(25)]).catch(() => ({ documents: [] })),
      db.listDocuments(process.env.APPWRITE_DB_ID, "preorder", [Query.equal("userId", userId), Query.orderDesc("$createdAt"), Query.limit(25)]).catch(() => ({ documents: [] })),
      db.listDocuments(process.env.APPWRITE_DB_ID, "subscriptions", [Query.equal("userId", userId), Query.orderDesc("$createdAt"), Query.limit(1)]).catch(() => ({ documents: [] }))
    ]);

    let subscriptions = subscriptionsReq.documents;
    
    // Fallback for legacy upgrades if subscriptions is empty
    if (subscriptions.length === 0) {
      let plan = "free";
      let expires = null;
      try {
        const userDoc = await getDatabaseUserByEmail(userId);
        if (userDoc && userDoc.plan && userDoc.plan !== "free") {
          plan = userDoc.plan;
          expires = userDoc.subscription_expires_at || null;
        }
      } catch (e) {}
      
      if (plan === "free") {
        try {
          const deviceDoc = await getUserPlanBySlug(userId);
          if (deviceDoc && deviceDoc.subscription === "true") {
            const tiers = { 0: "free", 1: "pro", 2: "elite", 3: "quantum", 4: "infinity" };
            plan = tiers[deviceDoc["subscription-tier"]] || "free";
            expires = deviceDoc.subscription_expires_at || null;
          }
        } catch (e2) {}
      }
      
      if (plan !== "free") {
        subscriptions = [{
          plan: plan,
          planId: plan,
          status: "active",
          currentPeriodEnd: expires
        }];
      }
    }

    const mappedSubscriptions = subscriptions.map(sub => ({
      ...sub,
      planId: sub.planId || sub.plan,
      plan: sub.plan || sub.planId
    }));

    return res.json({
      waitlist: waitlistReq.documents,
      orders: ordersReq.documents,
      preorders: preordersReq.documents,
      subscriptions: mappedSubscriptions
    });
  } catch (err) {
    console.error("PROFILE ERROR:", err);
    return res.status(500).json({ error: String(err) });
  }
});

homeRouter.post("/web/auth/logout", (req, res) => {
  console.log("[Web Auth] logout", {
    hasAuthorization: Boolean(req.headers.authorization),
    hasXUserId: Boolean(req.headers["x-user-id"]),
    origin: req.headers.origin || null,
  });
  return res.json({ ok: true });
});

homeRouter.post("/web/waitlist", async (req, res) => {
  try {
    const {
      name, email, phone, country,
      product, productKey, userId,
      paymentIntent, notes, featureDemand,
      source, slug
    } = req.body;

    if (!email) return res.status(400).json({ error: "Email required" });

    // Map featureDemand to notes if notes is missing (compat)
    const finalNotes = notes || featureDemand || "";

    // Store in Appwrite
    const waitlistData = {
      name: name || "Anonymous",
      email,
      phone: phone || "",
      country: country || "India",
      product: product || "Rexycore",
      productKey: productKey || "rexycore",
      userId: userId || "anonymous",
      paymentIntent: paymentIntent || "Maybe",
      notes: finalNotes,
      source: source || "web",
      createdAt: new Date().toISOString()
    };

    await db.createDocument(
      process.env.APPWRITE_DB_ID,
      "waitlist",
      ID.unique(),
      waitlistData
    );

    return res.json({ ok: true, message: "Welcome to the future of AI Home Control! 🚀" });
  } catch (err) {
    console.error("WAITLIST ERROR:", err);
    return res.status(500).json({ error: String(err) });
  }
});

homeRouter.post("/web/contact", async (req, res) => {
  try {
    const data = req.body;
    if (!data.email) return res.status(400).json({ error: "Email required" });

    const contactData = {
      name: data.name || "Contact Inquiry",
      email: data.email,
      subject: data.subject || "No Subject",
      message: data.message || "",
      createdAt: new Date().toISOString()
    };

    try {
      await db.createDocument(
        process.env.APPWRITE_DB_ID,
        "contact",
        ID.unique(),
        contactData
      );
    } catch (ignoreErr) {
      console.warn("APPWRITE WARNING: 'contact' collection might not exist. Skipping DB save:", contactData);
    }

    return res.json({ ok: true, message: "Your message has been sent successfully! 🚀" });
  } catch (err) {
    console.error("CONTACT ERROR:", err);
    return res.status(500).json({ error: String(err) });
  }
});
homeRouter.post("/web/feedback", async (req, res) => {
  try {
    const data = req.body;
    if (!data.message) return res.status(400).json({ error: "Feedback message required" });

    const feedbackData = {
      name: data.name || "Anonymous",
      email: data.email || "",
      category: data.category || "General Feedback",
      rating: data.rating || "",
      message: data.message,
      version: data.version || "v1.0.0 (Beta)",
      product: data.product || "neytreya",
      createdAt: new Date().toISOString()
    };

    try {
      await db.createDocument(
        process.env.APPWRITE_DB_ID,
        "feedback",
        ID.unique(),
        feedbackData
      );
    } catch (ignoreErr) {
      console.warn("APPWRITE WARNING: 'feedback' collection error:", ignoreErr.message || ignoreErr);
      console.warn("Skipping DB save for:", feedbackData);
    }

    return res.json({ ok: true, message: "Feedback received. Thank you!" });
  } catch (err) {
    console.error("FEEDBACK ERROR:", err);
    return res.status(500).json({ error: String(err) });
  }
});



homeRouter.post("/web/preorder", async (req, res) => {
  try {
    const data = req.body;
    if (!data.email || !data.userId) return res.status(400).json({ error: "Email and User ID required" });

    const preorderData = {
      userId: data.userId,
      email: data.email,
      phone: data.phone || "",
      productId: data.productId || "rkai_home",
      productName: data.productName || "RK AI Home",
      price: data.price || "₹4,999",
      shippingFullName: data.shippingFullName || "",
      shippingAddress: data.shippingAddress || "",
      shippingCity: data.shippingCity || "",
      shippingZip: data.shippingZip || "",
      shippingCountry: data.shippingCountry || "India",
      status: data.status || "submitted",
      createdAt: new Date().toISOString(),
      source: data.source || "web"
    };

    try {
      await db.createDocument(
        process.env.APPWRITE_DB_ID,
        "preorder",
        ID.unique(),
        preorderData
      );
    } catch (createErr) {
      if (createErr.message && createErr.message.includes("could not be found")) {
        try {
          await db.createDocument(
            process.env.APPWRITE_DB_ID,
            "order",
            ID.unique(),
            preorderData
          );
        } catch (fallbackErr) {
          console.warn("APPWRITE WARNING: 'preorder' and 'order' collections do not exist. Skipping DB save:", preorderData);
        }
      } else {
        throw createErr;
      }
    }

    return res.json({ ok: true, message: "Pre-order submitted! 🚀" });
  } catch (err) {
    console.error("PREORDER ERROR:", err);
    return res.status(500).json({ error: String(err) });
  }
});

homeRouter.post("/waitlist", (req, res) => {
  // Simple redirect/alias to the web version for compatibility
  return app._router.handle(req, res, () => { });
});

homeRouter.get("/web/waitlist/stats", async (req, res) => {
  try {
    const list = await db.listDocuments(
      process.env.APPWRITE_DB_ID,
      "waitlist"
    );

    const total = list.total;
    const yesCount = list.documents.filter(d => d.paymentIntent === "Yes").length;
    const paymentIntentRate = total > 0 ? (yesCount / total) * 100 : 0;

    return res.json({
      totalSignups: total,
      paymentIntentRate: paymentIntentRate.toFixed(1) + "%",
      recentFeatures: list.documents.map(d => d.featureDemand).filter(f => f).slice(-10)
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

homeRouter.get("/waitlist/stats", (req, res) => {
  return app._router.handle(req, res, () => { });
});


homeRouter.post("/device/:slug/trial", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }

    const device = await getUserPlanBySlug(slug);

    // We now allow "More Trials" - let's say up to 3 trials or if the user asks
    // For now, let's just make it easier to restart a trial if it's been more than 30 days
    const now = new Date();
    const trialEnd = device.trialEnd ? new Date(device.trialEnd) : null;
    const canRestartTrial = !trialEnd || (now - trialEnd > 30 * 24 * 60 * 60 * 1000);

    if (device.trialUsed === "true" && !canRestartTrial) {
      return res.status(400).json({ error: "Trial already used recently. Please join the waitlist or wait 30 days." });
    }

    const trialDays = 7;
    const newTrialEnd = new Date();
    newTrialEnd.setDate(newTrialEnd.getDate() + trialDays);

    await db.updateDocument(
      process.env.APPWRITE_DB_ID,
      process.env.APPWRITE_DEVICES_COLLECTION,
      device.$id,
      {
        subscription: "true",
        "subscription-tier": 1, // Student tier for trial
        trialUsed: "true",
        trialEnd: newTrialEnd.toISOString()
      }
    );

    return res.json({ ok: true, message: `7-Day Free Trial Started! Ends on ${newTrialEnd.toDateString()}` });
  } catch (err) {
    console.error("TRIAL START ERROR:", err);
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------- REAL-TIME COMMAND RELAY (HUB -> DESKTOP) ----------------
const desktopConnections = new Map(); // slug -> response object

homeRouter.get("/device/:slug/desktop-relay/status", (req, res) => { const isConnected = desktopConnections.has(normalizeSlug(req.params.slug)); return res.json({ connected: isConnected }); });

homeRouter.get("/device/:slug/desktop-relay", async (req, res) => {
  const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }


  // SSE (Server-Sent Events) setup for real-time relay
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  console.log(`[Relay] Desktop Agent connected for slug: ${slug}`);
  desktopConnections.set(slug, res);

  // Keep connection alive with heartbeats
  const keepAlive = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 30000);

  req.on("close", () => {
    clearInterval(keepAlive);
    desktopConnections.delete(slug);
    console.log(`[Relay] Desktop Agent disconnected for slug: ${slug}`);
  });
});

homeRouter.post("/device/:slug/to-desktop", async (req, res) => {
  const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }

  const command = req.body; // { intent, parameters }

  const desktopRes = desktopConnections.get(slug);
  if (desktopRes) {
    console.log(`[Relay] Sending command to desktop ${slug}:`, command);
    desktopRes.write(`data: ${JSON.stringify(command)}\n\n`);
    return res.json({ ok: true, message: "Relayed to desktop" });
  } else {
    return res.status(404).json({ error: "Desktop agent not connected for this slug" });
  }
});
// --- QUANTUM RELAY (E2E Encrypted Sync) ---
const quantumRelayStore = new Map();

homeRouter.post("/relay/sync", async (req, res) => {
  const slug = req.headers["x-device-slug"] || req.body.slug;
  if (!slug) return res.status(400).json({ error: "Device slug required" });
  
  const normalizedSlug = normalizeSlug(slug);
  const { encrypted_blob } = req.body;
  
  if (!encrypted_blob) return res.status(400).json({ error: "No encrypted payload provided" });
  
  // Store the encrypted state blob. The server CANNOT read this payload.
  quantumRelayStore.set(normalizedSlug, {
    blob: encrypted_blob,
    timestamp: Date.now()
  });
  
  console.log(`[Quantum Relay] Encrypted state synced for slug: ${normalizedSlug}`);
  res.json({ ok: true, message: "Encrypted state securely relayed" });
});

homeRouter.get("/relay/sync/:slug", async (req, res) => {
  const normalizedSlug = normalizeSlug(req.params.slug);
  const state = quantumRelayStore.get(normalizedSlug);
  
  if (state) {
    res.json({ ok: true, encrypted_blob: state.blob, timestamp: state.timestamp });
  } else {
    res.status(404).json({ error: "No relay state found for this device" });
  }
});
// --- GEMINI LIVE VISION WS ---
homeRouter.ws('/device/:slug/live-vision', async (ws, req) => {
  const { slug } = req.params;
  const { GoogleGenAI } = await import("@google/genai");
  const aiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  let session = null;
  
  try {
      session = await aiClient.models.connect({ model: "gemini-3.1-flash-live-preview" });
      
      // Handle messages from the live API and forward to desktop
      (async () => {
          try {
              for await (const msg of session) {
                  if (msg && msg.text) {
                      ws.send(JSON.stringify({ type: 'text', data: msg.text }));
                  }
                  if (msg && msg.audio) {
                      ws.send(JSON.stringify({ type: 'audio', data: msg.audio.toString('base64') }));
                  }
              }
          } catch (e) {
              console.error("[LiveVision WS] Session error:", e);
          }
      })();
  } catch (err) {
      console.error("[LiveVision WS] Setup error:", err);
      ws.close();
      return;
  }

  ws.on('message', async (msg) => {
      try {
          const data = JSON.parse(msg);
          // Data expected to have { prompt?: string, image?: string (base64) }
          
          let parts = [];
          if (data.prompt) parts.push({ text: data.prompt });
          if (data.image) {
              const base64Data = data.image.replace(/^data:image\/\w+;base64,/, "");
              parts.push({
                  inlineData: {
                      data: base64Data,
                      mimeType: "image/png"
                  }
              });
          }
          if (parts.length > 0 && session) {
              await session.send({
                  role: "user",
                  parts: parts
              });
          }
      } catch (e) {
          console.error("[LiveVision WS] Message parsing error:", e);
      }
  });

  ws.on('close', () => {
      console.log(`[LiveVision WS] Closed for ${slug}`);
  });
});

export default homeRouter;