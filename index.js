import express from "express";
import dotenv from "dotenv";

import { logInfo, logError } from "./utils/logger.js";
import { getUserPlanBySlug, checkDeviceBySlug, ensureDeviceBySlug, db, users } from "./services/appwriteClient.js";
import { Query, ID } from "node-appwrite";
import { loadChat, appendChat, appendUser, updateLastAI, deleteChatEntry } from "./memory.js";
import { ensureLimitFile, getLimitsForTier } from "./limitManager.js";
import { callGemini, listGeminiModels } from "./services/gemini.js";
import { handleIntents } from "./taskHandler.js";
import { cleanupSupabaseFiles, migrateToGoogleDrive, listFilesFromSlug, downloadFileFromSlug, deleteFileFromSlug } from "./services/supabaseClient.js";
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


OUTPUT SCHEMA
[
  {
    "intent": "image" | "video" | "docx" | "ppt" | "note" | "planner" | "timetable" | "task" | "alarm" | "announcement" | "status" | "period_bell" | "assignment" | "exam_paper" | "grading_sheet" | "class_planner" | "teacher_note" | "weather" | "news" | "chat" | "general" | "shutdown/exit" | "music",
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

Now only output JSON following the schema and rules.`;

// ---------------- DEVICE PRESENCE TRACKING ----------------
const deviceLastSeen = new Map();
const deviceBusyState = new Map(); // 🚀 Track explicit processing state (now stores strings like "thinking", "playing", "speaking")
const deviceDownloadProgress = new Map(); // 🚀 TRACK MUSIC DOWNLOADS

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

app.get("/device/:slug/status", async (req, res) => {
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
      const tierNum = device.subscription === "true" ? Number(device["subscription-tier"] || 0) : 0;
      const tierMap = { 0: "free", 1: "student", 2: "creator", 3: "pro", 4: "studio" };
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

  console.log(`[Status-Check] RAW_OUT: ${JSON.stringify(responsePayload)}`);

  return res.json(responsePayload);
});

// 🚀 NEW: Explicit state reporting from hardware
app.post("/device/:slug/state", (req, res) => {
  const slug = normalizeSlug(req.params.slug);
  const { state } = req.body; // e.g. "thinking", "speaking", "playing", "idle"
  
  if (!state) return res.status(400).json({ error: "state required" });
  
  deviceBusyState.set(slug, state);
  deviceLastSeen.set(slug, Date.now()); // State update also acts as heartbeat
  
  console.log(`[Device-State] ${slug} -> ${state.toUpperCase()}`);
  return res.json({ ok: true });
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

    return res.json({
      used: todayLimits,
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

    return res.json({ success: true, wakeWords: updateData.wakeWords ? JSON.parse(updateData.wakeWords) : null });
  } catch (err) {
    console.error(`[Settings] Error updating settings:`, err);
    res.status(500).json({ error: String(err) });
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

// ---------------- DEVICE UPDATE STATUS (BUSY/DOWNLOAD) ----------------
app.post("/device/:slug/update-status", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    const { busyState, downloadProgress } = req.body;

    if (busyState) deviceBusyState.set(slug, busyState);
    if (downloadProgress !== undefined) deviceDownloadProgress.set(slug, downloadProgress);

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
  try {
    const [waitlist, orders, preorders, subscriptions] = await Promise.all([
      db.listDocuments(process.env.APPWRITE_DB_ID, "waitlist", [Query.equal("userId", userId), Query.orderDesc("$createdAt"), Query.limit(25)]),
      db.listDocuments(process.env.APPWRITE_DB_ID, "orders", [Query.equal("userId", userId), Query.orderDesc("$createdAt"), Query.limit(25)]),
      db.listDocuments(process.env.APPWRITE_DB_ID, "preorders", [Query.equal("userId", userId), Query.orderDesc("$createdAt"), Query.limit(25)]),
      db.listDocuments(process.env.APPWRITE_DB_ID, "subscriptions", [Query.equal("userId", userId), Query.orderDesc("$createdAt"), Query.limit(1)])
    ]);

    return res.json({
      waitlist: waitlist.documents,
      orders: orders.documents,
      preorders: preorders.documents,
      subscriptions: subscriptions.documents
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

app.post("/web/preorder", async (req, res) => {
  try {
    const data = req.body;
    if (!data.email || !data.userId) return res.status(400).json({ error: "Email and User ID required" });

    const preorderData = {
      userId: data.userId,
      email: data.email,
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

    await db.createDocument(
      process.env.APPWRITE_DB_ID,
      "preorders",
      ID.unique(),
      preorderData
    );

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

app.get("/waitlist/stats", (req, res) => {
  return app._router.handle(req, res, () => {});
});

// 🚀 START TRIAL (Device-based tracking)
app.post("/device/:slug/trial", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
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

app.get("/device/:slug/desktop-relay", (req, res) => {
  const slug = normalizeSlug(req.params.slug);
  
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

app.post("/device/:slug/to-desktop", async (req, res) => {
  const slug = normalizeSlug(req.params.slug);
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

// ---------------- START SERVER ----------------
const PORT = process.env.PORT;
app.listen(PORT, () => {
  logInfo(`🔥 RexyCore Backend Running on ${PORT}`);
});
