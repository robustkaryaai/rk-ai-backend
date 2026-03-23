import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";

import { logInfo, logError } from "./utils/logger.js";
import { getUserPlanBySlug, checkDeviceBySlug, ensureDeviceBySlug, db, users } from "./services/appwriteClient.js";
import { Query, ID } from "node-appwrite";
import { loadChat, appendChat, appendUser, updateLastAI, deleteChatEntry } from "./memory.js";
import { ensureLimitFile, getLimitsForTier } from "./limitManager.js";
import { callGemini, listGeminiModels } from "./services/gemini.js";
import { handleIntents } from "./taskHandler.js";
import { cleanupSupabaseFiles, migrateToGoogleDrive, listFilesFromSlug, downloadFileFromSlug, deleteFileFromSlug } from "./services/supabaseClient.js";
import {
  getSmartHomeState,
  normalizeSmartHomeConfig,
  persistSmartHomeState,
  mergeSmartDevices,
  syncTuyaDevicesForDevice,
  controlCloudSmartDevice,
} from "./services/smartHomeService.js";
import { getWaitlistStatus, listWaitlistEntries, upsertWaitlistEntry } from "./services/waitlistService.js";
import { isAuthorizedDesktopRelayRequest, openDesktopRelayConnection, relayDesktopCommand } from "./services/desktopRelayService.js";
import { HfInference } from "@huggingface/inference";

dotenv.config();

const FRONTEND_URL = process.env.FRONTEND_URL || "https://rexycore.vercel.app";
const hf = new HfInference(process.env.HF_TOKEN);
const app = express();

// 🚀 ENHANCED CORS (With Credentials Support for Vercel)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowedOrigins = ["https://rexycore.vercel.app", "http://localhost:3000"];
  
  if (allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Credentials", "true");
  } else {
    res.header("Access-Control-Allow-Origin", "*");
  }
  
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Appwrite-Project, X-Appwrite-Key, x-user-id");
  
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// ---------------- AUDIO TRANSCRIPTION & HEALTH ----------------
// GET: Quick status check and metadata
app.get("/audio/:slug", (req, res) => {
  const slug = normalizeSlug(req.params.slug);
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

app.post("/audio/:slug", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
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
const SYSTEM_PROMPT = `
You are RexyCore's intent classifier. Your job is to convert a user message into strict tool instructions.
Output must be a pure JSON array of one or more intent objects (no prose, no markdown).

INTENTS
- image: generate images, pictures, posters, thumbnails, art.
- video: generate videos, clips, shorts, episodes, edits, animations.
- docx: write essays, reports, study notes as a .docx.
- ppt: create slide decks or presentations.
- note: short notes or explanations.
- planner: study schedule, daily routine, checklist.
- timetable: school/coaching timetable.
- task: alarms, reminders, todos (use alarm intent for time-based alarms).
- alarm: set alarms with specific times (extract time from prompt).
- announcement: make announcements, broadcast messages, notify.
- period_bell, lesson_plan, exam_paper, grading_sheet, class_planner, teacher_note, weather, news, chat, general, shutdown/exit, music.
- lumina_coding: user is starting a coding session on Lumina OS / Lumina — wants smart lights + PC workspace (IDE, project folder) prepared. Examples: "I'm coming to code on Lumina", "prepare my Lumina workspace", "set up for coding on Lumina OS".

STRICT CLASSIFICATION RULES
1) Generative intents (docx, ppt, note, planner, timetable, lesson_plan, exam_paper, grading_sheet, class_planner, teacher_note) MUST ONLY be triggered if the user EXPLICITLY uses a verb like "make", "generate", "create", "build", "write", "render", or "prepare". 
   - If the user just mentions the topic (e.g., "tell me about photosynthesis"), use "chat" or "general".
2) Image & Video intents (image, video) SHOULD be triggered if the user uses creation verbs OR explicitly mentions "video", "image", "poster", "art", "clip" in a way that implies they want to see/have one.
   - User: "penguin dancing video" -> intent: "video".
   - User: "cool wallpaper image" -> intent: "image".
3) If the user says play/start music/song/background sound → intent = "music".
3) If the user says "announce", "announcement", "broadcast", "notify everyone" → intent = "announcement".
4) If the user says "set alarm", "wake me up at", "alarm for [time]" → intent = "alarm" and extract time.
5) If the user mixes multiple requests, return multiple intents in a single array.
6) If the message is truly unclear, use "general".
7) For alarms: extract "time" parameter in format like "8:00 AM", "20:00", etc.
8) For announcements: put the announcement message in the "prompt" parameter.
9) For weather/news, default location to Delhi, India unless user gives a real place; for news, only India.
10) Stop/silence/cancel alarms → intent = "stop_alarm".
11) "emergency", "fire", "evacuate", "alert" → "emergency_alarm" or "fire_alarm".
12) Viva/interview/yourself/oral questions → "chat".
13) Output must be pure JSON; do not wrap in markdown; no commentary.
14) If the user wants Lumina OS / Lumina coding environment with desk and PC → intent = "lumina_coding". Optional parameters: "folder" (absolute path if they name a project), "ide" (e.g. "Visual Studio Code", "Cursor").


OUTPUT SCHEMA
[
  {
    "intent": "image" | "video" | "docx" | "ppt" | "note" | "planner" | "timetable" | "task" | "alarm" | "announcement" | "status" | "period_bell" | "assignment" | "exam_paper" | "grading_sheet" | "class_planner" | "teacher_note" | "weather" | "news" | "chat" | "general" | "shutdown/exit" | "music" | "lumina_coding",
    "parameters": {
      "prompt": "description or command",
      "location": "use Delhi, India if not provided for weather/news",
      "note_type": "if notes or summary",
      "time": "if scheduling/alarm (e.g., '8:00 AM', '20:00')",
      "extra": "any additional context"
    }
  }
]

EXAMPLES
User: "generate a video of a dancing pizza"
[
  { "intent": "video", "parameters": { "prompt": "dancing pizza video" } }
]
User: "make a poster for school science fair"
[
  { "intent": "image", "parameters": { "prompt": "school science fair poster" } }
]
User: "create slides on photosynthesis"
[
  { "intent": "ppt", "parameters": { "prompt": "photosynthesis slides" } }
]
User: "write a report on AI ethics"
[
  { "intent": "docx", "parameters": { "prompt": "AI ethics report" } }
]
User: "play lo-fi music"
[
  { "intent": "music", "parameters": { "prompt": "play lo-fi music" } }
]
User: "announce that dinner is ready"
[
  { "intent": "announcement", "parameters": { "prompt": "dinner is ready" } }
]
User: "set alarm for 8 AM"
[
  { "intent": "alarm", "parameters": { "prompt": "wake up", "time": "8:00 AM" } }
]
User: "I'm coming to code on Lumina, get everything ready"
[
  { "intent": "lumina_coding", "parameters": { "prompt": "prepare Lumina coding workspace" } }
]

Now only output JSON following the schema and rules.`;

// ---------------- DEVICE PRESENCE TRACKING ----------------
const deviceLastSeen = new Map();
const deviceBusyState = new Map(); // 🚀 Track explicit processing state (now stores strings like "thinking", "playing", "speaking")
const deviceNightModeState = new Map(); // Track live night protocol runtime state separately from settings
const deviceDownloadProgress = new Map(); // 🚀 TRACK MUSIC DOWNLOADS
const deviceSTTLogs = new Map(); // 🚀 TRACK STT LOGS FOR FRONEND APP (slug -> [{timestamp, text}])
const deviceBusyStateAt = new Map();
const deviceDownloadProgressAt = new Map();
const deviceLastActiveBusyState = new Map();
const deviceLastActiveBusyStateAt = new Map();
const deviceLastDownloadProgress = new Map();
const deviceLastDownloadProgressAt = new Map();
const STATUS_STICKY_MS = 8000;

// Helper to normalize slug to 9-digit string
app.get("/ai/models", async (req, res) => {
  const models = await listGeminiModels();
  return res.json({ models });
});

const normalizeSlug = (slug) => {
  if (!slug) return "";
  const s = String(slug);
  return s.padStart(9, '0');
};

function parseJsonSafe(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function sanitizeSttLogs(logs) {
  if (!Array.isArray(logs)) return [];
  return logs
    .filter((item) => item && typeof item.text === "string" && item.text.trim())
    .map((item) => ({
      timestamp: item.timestamp || new Date().toISOString(),
      text: String(item.text).trim(),
    }))
    .slice(-50);
}

async function readPersistedSttLogs(slug) {
  try {
    const device = await getUserPlanBySlug(slug);
    const systemStatus = parseJsonSafe(device.systemStatus, {});
    return sanitizeSttLogs(systemStatus.sttLogs || []);
  } catch (err) {
    console.warn(`[STT-Logs] Failed to read persisted logs for ${slug}:`, err.message || err);
    return [];
  }
}

async function writePersistedSttLogs(slug, logs) {
  const nextLogs = sanitizeSttLogs(logs);
  const device = await getUserPlanBySlug(slug);
  const systemStatus = parseJsonSafe(device.systemStatus, {});
  systemStatus.sttLogs = nextLogs;
  await db.updateDocument(
    process.env.APPWRITE_DB_ID,
    process.env.APPWRITE_DEVICES_COLLECTION,
    device.$id,
    { systemStatus: JSON.stringify(systemStatus) }
  );
  return nextLogs;
}

app.get("/device/:slug/status", async (req, res) => {
  const rawSlug = req.params.slug;
  const slug = normalizeSlug(rawSlug);
  const lastSeen = deviceLastSeen.get(slug);
  const rawBusyState = deviceBusyState.get(slug) || "idle";
  const rawBusyStateAt = deviceBusyStateAt.get(slug) || 0;
  const lastActiveBusyState = deviceLastActiveBusyState.get(slug) || "idle";
  const lastActiveBusyStateAt = deviceLastActiveBusyStateAt.get(slug) || 0;
  const nightModeActive = deviceNightModeState.get(slug) || false;
  const rawDownloadProgress = deviceDownloadProgress.get(slug) || null;
  const rawDownloadProgressAt = deviceDownloadProgressAt.get(slug) || 0;
  const lastDownloadProgress = deviceLastDownloadProgress.get(slug) || null;
  const lastDownloadProgressAt = deviceLastDownloadProgressAt.get(slug) || 0;
  const now = Date.now();
  const isOnline = lastSeen && (now - lastSeen < 180000);
  const busyState =
    rawBusyState !== "idle"
      ? rawBusyState
      : ((now - lastActiveBusyStateAt) <= STATUS_STICKY_MS ? lastActiveBusyState : rawBusyState);
  const downloadProgress =
    rawDownloadProgress !== null
      ? rawDownloadProgress
      : ((now - lastDownloadProgressAt) <= STATUS_STICKY_MS ? lastDownloadProgress : null);

  // Fetch storage info
  let storageMB = 0;
  try {
    const device = await getUserPlanBySlug(slug);
    if (device) {
      const tierNum = device.subscription === "true" ? (isNaN(device["subscription-tier"]) ? String(device["subscription-tier"]).toLowerCase() : Number(device["subscription-tier"])) : 0;
      
      // Check trial expiry
      if (tierNum === 1 && device.trialEnd) {
        if (new Date() > new Date(device.trialEnd)) {
          console.log(`[Trial Expiry] Revoking expired trial for ${slug}`);
          db.updateDocument(process.env.APPWRITE_DB_ID, process.env.APPWRITE_DEVICES_COLLECTION, device.$id, {
            subscription: "false",
            "subscription-tier": 0
          }).catch(console.error);
          return res.json({ slug, status: isOnline ? "online" : "offline", isBusy: busyState !== "idle", nightModeActive, storageMB: 0, shoom: true });
        }
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
    nightModeActive,
    downloadProgress, // 🚀 Include download info
    storageMB: storageMB || 0,
    shoom: true
  };

  console.log(`[Status-Check] RAW_OUT: ${JSON.stringify(responsePayload)}`);

  return res.json(responsePayload);
});

// 🚀 NEW: Explicit state reporting from hardware
app.post("/device/:slug/state", (req, res) => {
  const slug = normalizeSlug(req.params.slug);
  const { state } = req.body; // e.g. "thinking", "speaking", "playing", "idle"
  
  if (!state) return res.status(400).json({ error: "state required" });
  
  deviceBusyState.set(slug, state);
  deviceBusyStateAt.set(slug, Date.now());
  if (state !== "idle") {
    deviceLastActiveBusyState.set(slug, state);
    deviceLastActiveBusyStateAt.set(slug, Date.now());
  }
  deviceLastSeen.set(slug, Date.now()); // State update also acts as heartbeat
  
  console.log(`[Device-State] ${slug} -> ${state.toUpperCase()}`);
  return res.json({ ok: true });
});

app.post("/device/:slug/night-mode", (req, res) => {
  const slug = normalizeSlug(req.params.slug);
  const { active } = req.body;
  if (typeof active !== "boolean") {
    return res.status(400).json({ error: "active boolean required" });
  }

  deviceNightModeState.set(slug, active);
  deviceLastSeen.set(slug, Date.now());
  console.log(`[Night-Mode] ${slug} -> ${active ? "ACTIVE" : "INACTIVE"}`);
  return res.json({ ok: true });
});

// ---------------- STT LOG STREAM ----------------
app.post("/device/:slug/stt-log", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "text required" });

    const inMemoryLogs = deviceSTTLogs.get(slug) || [];
    const nextLogs = sanitizeSttLogs([
      ...inMemoryLogs,
      { timestamp: new Date().toISOString(), text },
    ]);

    deviceSTTLogs.set(slug, nextLogs);
    deviceLastSeen.set(slug, Date.now());

    try {
      await writePersistedSttLogs(slug, nextLogs);
    } catch (err) {
      console.error(`[STT-Logs] Persist failed for ${slug}:`, err.message || err);
    }

    return res.json({ ok: true, logs: nextLogs });
  } catch (err) {
    console.error("[STT-Logs] POST failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

app.get("/device/:slug/stt-log", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    let logs = sanitizeSttLogs(deviceSTTLogs.get(slug) || []);

    if (!logs.length) {
      logs = await readPersistedSttLogs(slug);
      if (logs.length) {
        deviceSTTLogs.set(slug, logs);
      }
    }

    return res.json({ ok: true, logs });
  } catch (err) {
    console.error("[STT-Logs] GET failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------- DESKTOP AUTH PROXY ----------------
app.post("/desktop/login", async (req, res) => {
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

    return res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/desktop/signup", async (req, res) => {
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

    // 1. Parallelize Gemini and Presence
    const [rawIntents] = await Promise.all([
      callGemini(
        SYSTEM_PROMPT, 
        [], 
        text, 
        2, 
        device.geminiApiKey || null, 
        device.geminiModel || null
      ),
      appendUser(normSlug, `User: ${text}`)
    ]);
    
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

    // Strategy: Priority-based selection
    const priorityIntents = ["music", "lumina_coding", "announcement", "chat", "general", "weather", "news"];
    
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

    // 5. Finalize Memory & Response
    if (finalReply) {
      await updateLastAI(normSlug, finalReply);
    }

    const responseObj = { 
      reply: finalReply || "I processed that for you.", 
      text, 
      shoom: true,
      timestamp: Date.now()
    };
    
    if (song_url) {
      responseObj.song_url = song_url;
      if (isMusic) responseObj.link = song_url;
    }

    return res.json(responseObj);
  } catch (err) {
    logError(`[Shoom-Error] ${slug}:`, err);
    return res.status(500).json({ error: "shoom_crash", message: String(err) });
  }
}

// ---------------- TEXT ROUTE ----------------
app.post("/text/:slug", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
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
app.get("/chat/:slug", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);

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
app.delete("/chat/:slug/:index", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
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
app.get("/limits/:slug", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    const device = await getUserPlanBySlug(slug);
    if (!device) return res.status(404).json({ error: "invalid_slug" });

    const tier = Number(device["subscription-tier"] || 0);
    const limits = await ensureLimitFile(slug);
    const t = new Date().toISOString().split("T")[0];
    const todayLimits = limits[t] || { image: 0, video: 0, ppt: 0 };
    const tierLimits = getLimitsForTier(tier);

    // 🚀 NEW: Matrix Subscription Data
    const isPro = device.subscription === "true";
    const trialUsed = device.trialUsed === "true" || device.trialUsed === true;
    const trialEnd = device.trialEnd || null;
    const now = new Date();
    const trialEndDate = trialEnd ? new Date(trialEnd) : null;
    const trialActive =
      isPro &&
      trialUsed &&
      trialEndDate &&
      trialEndDate > now;

    let sys = {};
    try {
      sys = JSON.parse(device.systemStatus || "{}");
    } catch (e) {}
    const trialSecretPresent = !!sys.trialSecret;

    // UI shows "infinity" while trial is active (device still uses numeric tier for quotas)
    const displayTier = trialActive ? "infinity" : tier;

    return res.json({
      used: todayLimits,
      allowed: tierLimits,
      tier,
      displayTier,
      isPro,
      trialUsed,
      trialEnd,
      trialActive: !!trialActive,
      trialSecretPresent
    });
  } catch (err) {
    logError("LIMITS ERROR:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

// ---------------- NO-OP GET ----------------
// Accepts any query params but intentionally does nothing with them.
app.get("/noop", (req, res) => {
  return res.json({ ok: true });
});

// ---------------- GOOGLE OAUTH START ----------------
app.get("/auth/google/start/:slug", async (req, res) => {
  try {
    // 🚀 Fixed: Use raw params to avoid double-encoding issues with slug|native
    const slug = req.params.slug;
    const state = slug; // Keep it as is

    // 🚀 CHECK SUBSCRIPTION TIER: Only paid users can link Google Drive
    const cleanSlug = normalizeSlug(slug.split('|')[0]);
    const device = await getUserPlanBySlug(cleanSlug);
    
    if (!device || device.subscription !== "true") {
      console.log(`[Google OAuth] Refusing flow for ${slug} - Subscription not active.`);
      const isNative = state.includes('|native');
      const baseRedirectUrl = isNative ? 'com.rexycore.rkai://settings' : `${FRONTEND_URL}/settings`;
      return res.redirect(`${baseRedirectUrl}?google_error=subscription_required`);
    }

    // 🚀 FORCE PRODUCTION URL IF ON RENDER
    const host = req.get('host') || "";
    let redirectUri = `https://rk-ai-backend.onrender.com/auth/google/callback`;
    
    if (host.includes('localhost')) {
      redirectUri = `http://localhost:4000/auth/google/callback`;
    }

    console.log(`[Google OAuth] Starting flow for ${slug}. Host: ${host}, Redirect URI: ${redirectUri}`);

    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/drive.file email",
      access_type: "offline",
      prompt: "consent",
      state
    });

    return res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  } catch (err) {
    console.error("Google OAuth start error:", err);
    return res.status(500).send(String(err));
  }
});

// ---------------- GOOGLE OAUTH CALLBACK ----------------
app.get("/auth/google/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    // Decode state carefully
    const decodedState = decodeURIComponent(state || "");
    
    // 🚀 NEW: Detect if this is a web login flow
    const isWebFlow = decodedState.startsWith("web|");
    const webRedirect = isWebFlow ? decodedState.split('|')[1] : null;
    
    const slug = isWebFlow ? null : decodedState.split('|')[0];
    
    if (!code || (!isWebFlow && !slug)) {
      console.error("Missing code or state:", { code: !!code, slug, isWebFlow });
      return res.redirect(`${FRONTEND_URL}/settings?google_error=missing_params`);
    }

    // 🚀 FORCE PRODUCTION URL IF ON RENDER
    const host = req.get('host') || "";
    let redirectUri = `https://rk-ai-backend.onrender.com/auth/google/callback`;
    if (host.includes('localhost')) {
      redirectUri = `http://localhost:4000/auth/google/callback`;
    }

    // Exchange code for tokens
    const body = new URLSearchParams();
    body.append("code", String(code));
    body.append("client_id", process.env.GOOGLE_CLIENT_ID);
    body.append("client_secret", process.env.GOOGLE_CLIENT_SECRET);
    body.append("redirect_uri", redirectUri);
    body.append("grant_type", "authorization_code");

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });

    if (!tokenRes.ok) {
      const errorText = await tokenRes.text();
      console.error(`Token exchange failed: ${tokenRes.status}`, errorText);
      return res.redirect(`${FRONTEND_URL}/settings?google_error=token_exchange_failed`);
    }

    const tokenJson = await tokenRes.json();
    const access_token = tokenJson.access_token;
    const refresh_token = tokenJson.refresh_token;

    // Get user email & info
    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    if (!userInfoRes.ok) {
      console.error("Failed to fetch user info");
      return res.redirect(`${FRONTEND_URL}/settings?google_error=userinfo_failed`);
    }

    const userInfo = await userInfoRes.json();
    console.log("✅ User email:", userInfo.email);

    // ── CASE 1: WEB LOGIN FLOW ──
    if (isWebFlow) {
      // Find or create user in Appwrite
      let appwriteUser;
      try {
        const existing = await users.list([Query.equal("email", userInfo.email)]);
        if (existing.total > 0) {
          appwriteUser = existing.users[0];
        } else {
          appwriteUser = await users.create(ID.unique(), userInfo.email, undefined, undefined, userInfo.name);
        }
      } catch (err) {
        console.error("[Web Auth] Appwrite User Error:", err);
        return res.redirect(`${FRONTEND_URL}/login?error=auth_failed`);
      }

      // Redirect to frontend with token and userId
      return res.redirect(`${FRONTEND_URL}/auth/web-callback?token=${appwriteUser.$id}&userId=${appwriteUser.$id}&redirect=${encodeURIComponent(webRedirect)}`);
    }

    // ── CASE 2: DEVICE LINKING FLOW (Existing Logic) ──
    // ✅ Check if refresh_token exists
    if (!refresh_token) {
      console.error("❌ No refresh_token received! User may have already authorized.");
      console.log("💡 User needs to revoke access and re-authorize, or we use existing token");
      return res.redirect(`${FRONTEND_URL}/settings?google_error=no_refresh_token`);
    }

    // Check for existing folder or create new one (search by name)
    const searchRes = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=name='RK AI Files' and mimeType='application/vnd.google-apps.folder' and trashed=false&fields=files(id,name)`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    const searchResult = await searchRes.json();

    let folderId;
    if (searchResult.files && searchResult.files.length > 0) {
      folderId = searchResult.files[0].id;
      console.log('✅ Reusing existing folder:', folderId);
    } else {
      const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: 'RK AI Files',
          mimeType: 'application/vnd.google-apps.folder'
        })
      });
      const newFolder = await createRes.json();
      folderId = newFolder.id;
      console.log('✅ Created new folder:', folderId);
    }

    // Update Appwrite with all required fields
    const device = await getUserPlanBySlug(slug);
    console.log("📝 Updating Appwrite for device:", device.$id);
    await db.updateDocument(
      process.env.APPWRITE_DB_ID,
      process.env.APPWRITE_DEVICES_COLLECTION,
      device.$id,
      {
        storageUsing: 'google',
        googleAccessToken: access_token,
        googleRefreshToken: refresh_token,
        googleFolderId: folderId,
        email: userInfo.email
      }
    );

    // 🚀 AUTOMATIC MIGRATION: Copy existing files from Supabase to Drive (except limit.txt)
    // We run this asynchronously so the user doesn't wait for the migration to finish
    migrateToGoogleDrive(slug).catch(err => {
      console.error(`[Migration] Async migration failed for ${slug}:`, err);
    });

    // 🚀 Robust Deep Link Redirect
    const isNative = decodedState.includes('|native');
    const baseRedirectUrl = isNative ? 'com.rexycore.rkai://settings' : `${FRONTEND_URL}/settings`;
    
    console.log(`✅ Appwrite updated! Native: ${isNative}, Redirecting to: ${baseRedirectUrl}`);
    return res.redirect(`${baseRedirectUrl}?google_connected=true`);
  } catch (err) {
    console.error("OAuth callback error:", err);
    const decodedStateErr = decodeURIComponent(req.query.state || "");
    const isWebFlow = decodedStateErr.startsWith("web|");
    const baseRedirectUrl = isWebFlow ? `${FRONTEND_URL}/login` : (decodedStateErr.includes('|native') ? 'com.rexycore.rkai://settings' : `${FRONTEND_URL}/settings`);
    return res.redirect(`${baseRedirectUrl}?google_error=callback_failed`);
  }
});

// ---------------- SPOTIFY OAUTH START ----------------
app.get("/auth/spotify/start/:slug", async (req, res) => {
  try {
    const slug = req.params.slug;
    const state = slug;

    // 🚀 USE DYNAMIC REDIRECT URI
    const host = req.get('host') || "";
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const redirectUri = `${protocol}://${host}/auth/spotify/callback`;
    
    console.log(`[Spotify OAuth] Using Redirect URI: ${redirectUri}`);

    if (!process.env.SPOTIFY_CLIENT_ID) {
      console.error("SPOTIFY_CLIENT_ID is not defined in .env");
      return res.status(500).send("Spotify Client ID is missing on the server.");
    }

    const params = new URLSearchParams({
      client_id: process.env.SPOTIFY_CLIENT_ID,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: "user-read-private user-read-email user-modify-playback-state user-read-playback-state streaming",
      show_dialog: "true", // 🚀 FORCE LOGIN DIALOG AS REQUESTED
      state
    });
    return res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
  } catch (err) {
    return res.status(500).send(String(err));
  }
});

// ---------------- SPOTIFY OAUTH CALLBACK ----------------
app.get("/auth/spotify/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    const decodedState = decodeURIComponent(state || "");
    const slug = decodedState.split('|')[0];

    if (!code || !slug) {
      console.error("Missing code or state:", { code: !!code, slug });
      return res.redirect(`${FRONTEND_URL}/settings?spotify_error=missing_params`);
    }

    // 🚀 FORCE PRODUCTION URL IF ON RENDER
    const host = req.get('host') || "";
    let redirectUri = `https://rk-ai-backend.onrender.com/auth/spotify/callback`;
    if (host.includes('localhost')) {
      redirectUri = `http://localhost:4000/auth/spotify/callback`;
    }

    const body = new URLSearchParams();
    body.append("code", String(code));
    body.append("grant_type", "authorization_code");
    body.append("redirect_uri", redirectUri);

    const authHeader = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString("base64");

    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { 
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": `Basic ${authHeader}`
      },
      body: body.toString()
    });

    if (!tokenRes.ok) {
      return res.redirect(`${FRONTEND_URL}/settings?spotify_error=token_exchange_failed`);
    }

    const tokenJson = await tokenRes.json();
    
    // Update Appwrite device doc with Spotify tokens
    try {
      const device = await getUserPlanBySlug(slug);
      console.log(`[Spotify OAuth] Updating device doc ${device.$id} for ${slug}...`);
      
      await db.updateDocument(
        process.env.APPWRITE_DB_ID,
        process.env.APPWRITE_DEVICES_COLLECTION,
        device.$id,
        {
          spotifyAccessToken: tokenJson.access_token,
          spotifyRefreshToken: tokenJson.refresh_token,
          spotifyConnected: "true"
        }
      );
      console.log(`[Spotify OAuth] ✅ Appwrite updated successfully for ${slug}.`);
    } catch (appwriteErr) {
      console.error(`[Spotify OAuth] ❌ Appwrite update failed (Check if attributes exist):`, appwriteErr.message || appwriteErr);
      // We don't want to crash the whole flow if only Appwrite update failed (tokens are already in memory/logs if needed)
      // but the user needs to add these attributes to Appwrite.
    }

    const isNative = decodedState.includes('|native');
    const baseRedirectUrl = isNative ? 'com.rexycore.rkai://settings' : `${FRONTEND_URL}/settings`;

    return res.redirect(`${baseRedirectUrl}?spotify_connected=true`);
  } catch (err) {
    console.error("Spotify OAuth error:", err);
    const decodedStateErr = decodeURIComponent(req.query.state || "");
    const isNative = decodedStateErr.includes('|native');
    const baseRedirectUrl = isNative ? 'com.rexycore.rkai://settings' : `${FRONTEND_URL}/settings`;
    return res.redirect(`${baseRedirectUrl}?spotify_error=callback_failed`);
  }
});


// ---------------- DEVICE SETTINGS ----------------
app.post("/device/:slug/settings", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    const settings = req.body;
    
    console.log(`[Settings] Updating settings for ${slug}:`, settings);

    const device = await getUserPlanBySlug(slug);
    if (!device) return res.status(404).json({ error: "device_not_found" });

    const updateData = { ...settings };

    // Safely pack unmapped UI configs into systemStatus so Appwrite doesn't crash on missing schema attributes
    let currentConfig = {};
    try { currentConfig = JSON.parse(device.systemStatus || "{}"); } catch(e) {}
    
    let configUpdated = false;
    if (settings.nightProtocolEnabled !== undefined) {
      currentConfig.nightProtocolEnabled = settings.nightProtocolEnabled;
      delete updateData.nightProtocolEnabled; // Remove so Appwrite doesn't throw Attribute Error
      configUpdated = true;
    }
    if (settings.smartHomeConfig !== undefined) {
      currentConfig.smartHomeConfig = normalizeSmartHomeConfig(settings.smartHomeConfig || {});
      delete updateData.smartHomeConfig;
      configUpdated = true;
    }
    if (settings.ttsConfig !== undefined) {
      currentConfig.ttsConfig = settings.ttsConfig || {};
      delete updateData.ttsConfig;
      configUpdated = true;
    }
    if (configUpdated) {
      updateData.systemStatus = JSON.stringify(currentConfig);
    }

    // 🚀 If assistantName is updated, use Gemini to generate wake word variations
    if (settings.assistantName && settings.assistantName !== device.assistantName) {
      console.log(`[Settings] Assistant name changed to ${settings.assistantName}. Generating wake words...`);
      try {
        const prompt = `The user wants to name their AI assistant "${settings.assistantName}". 
        Generate a list of 8-10 variations of this name that a speech-to-text engine might transcribe it as, 
        including common misspellings or similar-sounding words. 
        Return ONLY a JSON array of strings. Example for "Jarvis": ["Jarvis", "Jarvis", "Java", "Travis", "Jarvis AI"].`;
        
        const aiResponse = await callGemini(prompt);
        // Clean the response to ensure it's valid JSON
        const cleanedResponse = aiResponse.replace(/```json|```/g, '').trim();
        const variations = JSON.parse(cleanedResponse);
        
        // Ensure the original name is included
        if (!variations.includes(settings.assistantName)) {
          variations.unshift(settings.assistantName);
        }
        
        updateData.wakeWords = JSON.stringify(variations);
        console.log(`[Settings] Generated wake words:`, variations);
      } catch (err) {
        console.error(`[Settings] Failed to generate wake words:`, err);
        // Fallback to just the name
        updateData.wakeWords = JSON.stringify([settings.assistantName]);
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
      smartHomeConfig: currentConfig.smartHomeConfig || null,
    });
  } catch (err) {
    console.error(`[Settings] Error updating settings:`, err);
    res.status(500).json({ error: String(err) });
  }
});

app.get("/device/:slug/smart-home/state", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    const device = await getUserPlanBySlug(slug);
    const { smartHomeConfig, smartDevices } = getSmartHomeState(device);
    return res.json({
      ok: true,
      smartHomeConfig,
      smart_devices: smartDevices,
    });
  } catch (err) {
    console.error("[smart-home/state] error:", err);
    return res.status(500).json({ error: String(err) });
  }
});

app.post("/device/:slug/smart-home/providers/:provider/config", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    const provider = String(req.params.provider || "").toLowerCase();
    const device = await getUserPlanBySlug(slug);
    const { smartHomeConfig } = getSmartHomeState(device);
    const nextConfig = normalizeSmartHomeConfig({
      ...smartHomeConfig,
      providers: {
        ...smartHomeConfig.providers,
        [provider]: {
          ...(smartHomeConfig.providers?.[provider] || {}),
          ...(req.body || {}),
        },
      },
    });

    await persistSmartHomeState(device, { smartHomeConfig: nextConfig });

    return res.json({
      ok: true,
      provider,
      config: nextConfig.providers?.[provider] || null,
    });
  } catch (err) {
    console.error("[smart-home/provider-config] error:", err);
    return res.status(500).json({ error: String(err) });
  }
});

app.post("/device/:slug/smart-home/providers/:provider/sync", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    const provider = String(req.params.provider || "").toLowerCase();
    const device = await getUserPlanBySlug(slug);

    if (provider !== "tuya") {
      return res.status(400).json({ error: `Unsupported provider: ${provider}` });
    }

    const result = await syncTuyaDevicesForDevice(device);
    return res.json({
      ok: true,
      ...result,
    });
  } catch (err) {
    console.error("[smart-home/provider-sync] error:", err);

    try {
      const slug = normalizeSlug(req.params.slug);
      const device = await getUserPlanBySlug(slug);
      const { smartHomeConfig } = getSmartHomeState(device);
      const provider = String(req.params.provider || "").toLowerCase();
      const nextConfig = normalizeSmartHomeConfig({
        ...smartHomeConfig,
        providers: {
          ...smartHomeConfig.providers,
          [provider]: {
            ...(smartHomeConfig.providers?.[provider] || {}),
            lastError: String(err.message || err),
          },
        },
      });
      await persistSmartHomeState(device, { smartHomeConfig: nextConfig });
    } catch {}

    return res.status(500).json({ error: String(err.message || err) });
  }
});

app.post("/device/:slug/smart-home/control", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    const { id, action = "toggle", payload = {} } = req.body || {};
    if (!id) {
      return res.status(400).json({ error: "Missing smart device id." });
    }

    const device = await getUserPlanBySlug(slug);
    const result = await controlCloudSmartDevice(device, id, String(action).toLowerCase(), payload);
    return res.json({
      ok: true,
      ...result,
    });
  } catch (err) {
    console.error("[smart-home/control] error:", err);
    return res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/device/check/:slug", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);

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

// ---------------- ALARMS ----------------
app.get("/device/:slug/alarms", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
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
app.get("/device/:slug/schedules", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
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
app.post("/device/:slug/sync_alarms", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    const { alarms } = req.body;
    const device = await getUserPlanBySlug(slug);
    if (!device) return res.status(404).json({ error: "device_not_found" });

    // Wipe old alarms
    try {
      const old = await db.listDocuments(process.env.APPWRITE_DB_ID, "alarms", [Query.equal("id", device.$id)]);
      for (const doc of old.documents) {
        await db.deleteDocument(process.env.APPWRITE_DB_ID, "alarms", doc.$id);
      }
    } catch(e) {}

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

app.post("/device/:slug/sync_schedules", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    const { schedules } = req.body;
    const device = await getUserPlanBySlug(slug);
    if (!device) return res.status(404).json({ error: "device_not_found" });

    // Wipe old schedules
    try {
      const old = await db.listDocuments(process.env.APPWRITE_DB_ID, "schedules", [Query.equal("id", device.$id)]);
      for (const doc of old.documents) {
        await db.deleteDocument(process.env.APPWRITE_DB_ID, "schedules", doc.$id);
      }
    } catch(e) {}

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
app.get("/device/:slug/files", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
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

app.get("/device/:slug/file/:filename", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    const filename = req.params.filename;
    const buffer = await downloadFileFromSlug(slug, filename);

    if (!buffer) return res.status(404).send("File not found");

    let mimeType = 'application/octet-stream';
    const lowerName = filename.toLowerCase();
    if (lowerName.endsWith('.png')) mimeType = 'image/png';
    else if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) mimeType = 'image/jpeg';
    else if (lowerName.endsWith('.mp4')) mimeType = 'video/mp4';
    else if (lowerName.endsWith('.mp3')) mimeType = 'audio/mpeg';

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(buffer);
  } catch (err) {
    return res.status(500).send(String(err));
  }
});

app.delete("/device/:slug/file/:filename", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    const filename = req.params.filename;
    const success = await deleteFileFromSlug(slug, filename);

    if (success) return res.json({ ok: true });
    else return res.status(500).json({ error: "Failed to delete file" });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------- DEVICE UPDATE STATUS (BUSY/DOWNLOAD + SMART DEVICES FROM HUB) ----------------
app.post("/device/:slug/update-status", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    const { busyState, downloadProgress, smart_devices } = req.body;

    if (busyState) {
      deviceBusyState.set(slug, busyState);
      deviceBusyStateAt.set(slug, Date.now());
      if (busyState !== "idle") {
        deviceLastActiveBusyState.set(slug, busyState);
        deviceLastActiveBusyStateAt.set(slug, Date.now());
      }
    }
    if (downloadProgress !== undefined) {
      deviceDownloadProgress.set(slug, downloadProgress);
      deviceDownloadProgressAt.set(slug, Date.now());
      if (downloadProgress !== null) {
        deviceLastDownloadProgress.set(slug, downloadProgress);
        deviceLastDownloadProgressAt.set(slug, Date.now());
      }
    }

    // Pi network scan posts discovered bulbs so the mobile app can see them (same field as /settings).
    if (smart_devices !== undefined && Array.isArray(smart_devices)) {
      try {
        const device = await getUserPlanBySlug(slug);
        if (device) {
          await db.updateDocument(
            process.env.APPWRITE_DB_ID,
            process.env.APPWRITE_DEVICES_COLLECTION,
            device.$id,
            { smart_devices: JSON.stringify(smart_devices) }
          );
        }
      } catch (dbErr) {
        console.error("[update-status] smart_devices persist failed:", dbErr);
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.post("/device/ensure/:slug", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);

    if (!/^\d{9}$/.test(slug)) {
      return res.status(400).json({ error: "invalid_slug_format" });
    }

    const result = await ensureDeviceBySlug(slug);

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
app.get("/device/:slug/maintenance", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
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
app.post("/device/:slug/verify", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
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
app.post("/device/:slug/mute", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
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
app.post("/device/:slug/memory", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
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
app.post("/device/:slug/command", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
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
        } catch(e) {}
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
        } catch(e) {}
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
app.get("/device/:slug/commands/pending", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);

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
app.post("/device/:slug/commands/:command_id/complete", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
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
app.get("/health", (req, res) => {
  return res.json({ status: "healthy", timestamp: new Date().toISOString(), version: "3.0.0", shoom: true });
});

app.get("/", (req, res) => {
  return res.send("<h1>🚀 RexyCore Backend v3.0.0</h1><p>Shoom mode active.</p>");
});

// Shoom Debug: See all registered devices
app.get("/shoom/debug/devices", (req, res) => {
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

app.get("/web/auth/google/start", (req, res) => {
  const redirect = req.query.redirect || "/";
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: `https://rk-ai-backend.onrender.com/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state: `web|${redirect}`
  });
  return res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

// Remove the separate /web/auth/google/callback as we'll unify it
// (I will remove it in the next step when I edit the unified handler)

app.get("/web/auth/me", async (req, res) => {
  const userId = req.headers["x-user-id"];
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const user = await users.get(userId);
    return res.json({ user });
  } catch (err) {
    return res.status(401).json({ error: "Session invalid" });
  }
});

app.get("/web/profile/:userId", async (req, res) => {
  const { userId } = req.params;
  const email = String(req.query.email || "").trim();
  try {
    const [waitlistRows, ordersReq, preordersReq, subscriptionsReq, devicesTrialReq] = await Promise.all([
      listWaitlistEntries({ userId, email }).catch(() => []),
      db.listDocuments(process.env.APPWRITE_DB_ID, "order", [Query.equal("userId", userId), Query.orderDesc("$createdAt"), Query.limit(25)]).catch(() => ({ documents: [] })),
      db.listDocuments(process.env.APPWRITE_DB_ID, "preorder", [Query.equal("userId", userId), Query.orderDesc("$createdAt"), Query.limit(25)]).catch(() => ({ documents: [] })),
      db.listDocuments(process.env.APPWRITE_DB_ID, "subscriptions", [Query.equal("userId", userId), Query.orderDesc("$createdAt"), Query.limit(1)]).catch(() => ({ documents: [] })),
      db
        .listDocuments(process.env.APPWRITE_DB_ID, process.env.APPWRITE_DEVICES_COLLECTION, [Query.limit(250)])
        .catch(() => ({ documents: [] }))
    ]);

    const trials = (devicesTrialReq.documents || [])
      .map((d) => {
        let sys = {};
        try {
          sys = JSON.parse(d.systemStatus || "{}");
        } catch (e) {}
        if (sys.trialLinkedUserId !== userId) return null;
        return {
          deviceSlug: d.slug,
          trialEnd: d.trialEnd || null,
          trialUsed: d.trialUsed,
          linkedAt: sys.trialLinkedAt || null
        };
      })
      .filter(Boolean);

    return res.json({
      waitlist: waitlistRows,
      orders: ordersReq.documents,
      preorders: preordersReq.documents,
      subscriptions: subscriptionsReq.documents,
      trials
    });
  } catch (err) {
    console.error("PROFILE ERROR:", err);
    return res.status(500).json({ error: String(err) });
  }
});

app.post("/web/auth/logout", (req, res) => {
  return res.json({ ok: true });
});

app.post("/web/waitlist", async (req, res) => {
  try {
    const result = await upsertWaitlistEntry(req.body || {});
    return res.json(result);
  } catch (err) {
    console.error("WAITLIST ERROR:", err);
    return res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/web/waitlist/status", async (req, res) => {
  try {
    const result = await getWaitlistStatus({
      userId: req.query.userId || "",
      email: req.query.email || "",
      productKey: req.query.productKey || "",
    });
    return res.json(result);
  } catch (err) {
    console.error("WAITLIST STATUS ERROR:", err);
    return res.status(500).json({ error: String(err.message || err) });
  }
});

app.post("/web/contact", async (req, res) => {
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

app.post("/web/preorder", async (req, res) => {
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

app.post("/waitlist", (req, res) => {
  // Simple redirect/alias to the web version for compatibility
  return app._router.handle(req, res, () => {});
});

/** Fixed early-access caps (price lock). Trial = device activations; others = waitlist rows by productKey. */
const PRICE_LOCK_CAPS = {
  trial: 100,
  student: 100,
  creator: 50,
  pro: 25,
  studio: 5
};

app.get("/web/waitlist/stats", async (req, res) => {
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

/** Remaining slots per tier for price-lock UI */
app.get("/web/waitlist/slots", async (req, res) => {
  try {
    const caps = { ...PRICE_LOCK_CAPS };

    const countWaitlistByKey = async (productKey) => {
      try {
        const r = await db.listDocuments(
          process.env.APPWRITE_DB_ID,
          "waitlist",
          [Query.equal("productKey", productKey), Query.limit(1)]
        );
        return r.total;
      } catch (e) {
        console.warn("[waitlist/slots] count for", productKey, e.message);
        return 0;
      }
    };

    let trialUsedDevices = 0;
    try {
      const devList = await db.listDocuments(
        process.env.APPWRITE_DB_ID,
        process.env.APPWRITE_DEVICES_COLLECTION,
        [Query.equal("trialUsed", "true"), Query.limit(1)]
      );
      trialUsedDevices = devList.total;
    } catch (e) {
      console.warn("[waitlist/slots] device trial count:", e.message);
    }

    const used = {
      trial: trialUsedDevices,
      student: await countWaitlistByKey("student"),
      creator: await countWaitlistByKey("creator"),
      pro: await countWaitlistByKey("pro"),
      studio: await countWaitlistByKey("studio")
    };

    const remaining = {};
    for (const k of Object.keys(caps)) {
      remaining[k] = Math.max(0, caps[k] - (used[k] || 0));
    }

    return res.json({
      caps,
      used,
      remaining,
      totalSignups: Object.values(used).reduce((a, b) => a + b, 0)
    });
  } catch (err) {
    console.error("WAITLIST SLOTS ERROR:", err);
    return res.status(500).json({ error: String(err) });
  }
});

app.get("/waitlist/stats", (req, res) => {
  return app._router.handle(req, res, () => {});
});

// 🚀 START TRIAL (Device-based tracking + hardware-bound secret in systemStatus)
app.post("/device/:slug/trial", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    const device = await getUserPlanBySlug(slug);

    let trialDevicesTotal = 0;
    try {
      const tr = await db.listDocuments(
        process.env.APPWRITE_DB_ID,
        process.env.APPWRITE_DEVICES_COLLECTION,
        [Query.equal("trialUsed", "true"), Query.limit(1)]
      );
      trialDevicesTotal = tr.total;
    } catch (e) {
      console.warn("[trial] count devices:", e.message);
    }
    if (
      trialDevicesTotal >= PRICE_LOCK_CAPS.trial &&
      device.trialUsed !== "true" &&
      device.trialUsed !== true
    ) {
      return res.status(400).json({
        error: "trial_slots_full",
        message: "All trial price-lock slots are claimed. Join a paid tier waitlist."
      });
    }

    const now = new Date();
    const prevEnd = device.trialEnd ? new Date(device.trialEnd) : null;

    if (prevEnd && prevEnd > now) {
      return res.status(400).json({
        error: "trial_already_active",
        message: "Trial is already active on this device.",
        trialEnd: device.trialEnd
      });
    }

    const canRestartTrial =
      !prevEnd || now - prevEnd > 30 * 24 * 60 * 60 * 1000;

    if (device.trialUsed === "true" && !canRestartTrial) {
      return res.status(400).json({
        error: "trial_cooldown",
        message: "Trial already used on this device. Wait 30 days after expiry or join the waitlist."
      });
    }

    let sys = {};
    try {
      sys = JSON.parse(device.systemStatus || "{}");
    } catch (e) {}
    if (!sys.trialSecret) {
      sys.trialSecret = crypto.randomBytes(32).toString("hex");
    }
    sys.trialStartedAt = now.toISOString();
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const linkUserId =
      typeof body.userId === "string" && body.userId.length > 0
        ? body.userId
        : typeof body.appwriteUserId === "string"
          ? body.appwriteUserId
          : null;
    if (linkUserId) {
      sys.trialLinkedUserId = linkUserId;
      sys.trialLinkedAt = now.toISOString();
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
        "subscription-tier": 1,
        trialUsed: "true",
        trialEnd: newTrialEnd.toISOString(),
        systemStatus: JSON.stringify(sys)
      }
    );

    return res.json({
      ok: true,
      message: `7-Day Free Trial Started! Ends on ${newTrialEnd.toDateString()}`,
      trialEnd: newTrialEnd.toISOString()
    });
  } catch (err) {
    console.error("TRIAL START ERROR:", err);
    return res.status(500).json({ error: String(err) });
  }
});

app.get("/device/:slug/desktop-relay", (req, res) => {
  const slug = normalizeSlug(req.params.slug);
  openDesktopRelayConnection(slug, req, res);
});

app.post("/device/:slug/to-desktop", async (req, res) => {
  const slug = normalizeSlug(req.params.slug);
  if (!isAuthorizedDesktopRelayRequest(req)) {
    return res.status(403).json({ error: "Unauthorized desktop relay request" });
  }

  const result = relayDesktopCommand(slug, req.body || {});
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }

  return res.json({ ok: true, message: result.message });
});

// ---------------- START SERVER ----------------
const PORT = process.env.PORT;
app.listen(PORT, () => {
  logInfo(`🔥 RexyCore Backend Running on ${PORT}`);
});
