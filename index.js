import express from "express";
import dotenv from "dotenv";

import { logInfo, logError } from "./utils/logger.js";
import { getUserPlanBySlug, checkDeviceBySlug, ensureDeviceBySlug } from "./services/appwriteClient.js";
import { db } from "./services/appwriteClient.js";
import { Query, ID } from "node-appwrite";
import { loadChat, appendChat, appendUser, updateLastAI } from "./memory.js";
import { checkAndConsume, ensureLimitFile } from "./limitManager.js";
import { callGemini } from "./services/gemini.js";
import { handleIntents } from "./taskHandler.js";
import { cleanupSupabaseFiles } from "./services/supabaseClient.js";
import { HfInference } from "@huggingface/inference";

dotenv.config();

const hf = new HfInference(process.env.HF_TOKEN);
const app = express();

// 🚀 ENHANCED CORS (Manual implementation to avoid extra dependency)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Appwrite-Project, X-Appwrite-Key");
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
    return handleTextRequest(req, res, slug, text, device);

  } catch (err) {
    logError("AUDIO STT ERROR:", err);
    return res.status(500).json({ error: "server_error", message: String(err), shoom: false });
  }
});

// ---------------- SYSTEM PROMPT ----------------
const SYSTEM_PROMPT = `
You are RK AI's intent classifier. Your job is to convert a user message into strict tool instructions.
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
1) Generative intents (image, video, docx, ppt, note, planner, timetable, lesson_plan, exam_paper, grading_sheet, class_planner, teacher_note) MUST ONLY be triggered if the user EXPLICITLY uses a verb like "make", "generate", "create", "build", "write", "render", or "prepare". 
   - If the user just mentions the topic (e.g., "tell me about photosynthesis" or "photosynthesis essay"), use "chat" or "general".
   - If the user says "make a report on photosynthesis", then use "docx".
2) If the user says play/start music/song/background sound → intent = "music".
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

// Helper to normalize slug to 9-digit string
const normalizeSlug = (slug) => {
  if (!slug) return "";
  const s = String(slug);
  return s.padStart(9, '0');
};

app.get("/device/:slug/status", (req, res) => {
  const rawSlug = req.params.slug;
  const slug = normalizeSlug(rawSlug);
  const lastSeen = deviceLastSeen.get(slug);
  const now = Date.now();
  const isOnline = lastSeen && (now - lastSeen < 180000);

  console.log(`[Status-Check] Slug: ${slug} (Raw: ${rawSlug}), Online: ${isOnline}, LastSeen: ${lastSeen ? (now - lastSeen) / 1000 : 'Never'}s ago`);

  return res.json({
    slug,
    status: isOnline ? "online" : "offline",
    lastSeen: lastSeen ? new Date(lastSeen).toISOString() : null,
    diffSeconds: lastSeen ? Math.floor((now - lastSeen) / 1000) : null,
    shoom: true
  });
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

// ---------------- NO-OP GET ----------------
// Accepts any query params but intentionally does nothing with them.
app.get("/noop", (req, res) => {
  return res.json({ ok: true });
});

// ---------------- GOOGLE OAUTH START ----------------
app.get("/auth/google/start/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug);
    const state = encodeURIComponent(slug);
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI,
      response_type: "code",
      // include email scope so we can verify account and store user email
      scope: "https://www.googleapis.com/auth/drive.file email",
      access_type: "offline",
      prompt: "consent",
      state
    });

    return res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  } catch (err) {
    return res.status(500).send(String(err));
  }
});

// ---------------- GOOGLE OAUTH CALLBACK ----------------
app.get("/auth/google/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    const slug = String(state || "");
    if (!code || !slug) {
      console.error("Missing code or state");
      return res.redirect(`${process.env.FRONTEND_URL}/settings?google_error=missing_params`);
    }

    // Exchange code for tokens
    const body = new URLSearchParams();
    body.append("code", String(code));
    body.append("client_id", process.env.GOOGLE_CLIENT_ID);
    body.append("client_secret", process.env.GOOGLE_CLIENT_SECRET);
    body.append("redirect_uri", process.env.GOOGLE_OAUTH_REDIRECT_URI);
    body.append("grant_type", "authorization_code");

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });

    if (!tokenRes.ok) {
      const errorText = await tokenRes.text();
      console.error(`Token exchange failed: ${tokenRes.status}`, errorText);
      return res.redirect(`${process.env.FRONTEND_URL}/settings?google_error=token_exchange_failed`);
    }

    const tokenJson = await tokenRes.json();
    const access_token = tokenJson.access_token;
    const refresh_token = tokenJson.refresh_token;

    // ✅ Check if refresh_token exists
    if (!refresh_token) {
      console.error("❌ No refresh_token received! User may have already authorized.");
      console.log("💡 User needs to revoke access and re-authorize, or we use existing token");
      return res.redirect(`${process.env.FRONTEND_URL}/settings?google_error=no_refresh_token`);
    }

    console.log("✅ Got access_token:", access_token ? "YES" : "NO");
    console.log("✅ Got refresh_token:", refresh_token ? "YES" : "NO");

    // Get user email
    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    if (!userInfoRes.ok) {
      console.error("Failed to fetch user info");
      return res.redirect(`${process.env.FRONTEND_URL}/settings?google_error=userinfo_failed`);
    }

    const userInfo = await userInfoRes.json();
    console.log("✅ User email:", userInfo.email);

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
    const user = await getUserPlanBySlug(slug);
    console.log("📝 Updating Appwrite for device:", user.$id);
    await db.updateDocument(
      process.env.APPWRITE_DB_ID,
      process.env.APPWRITE_DEVICES_COLLECTION,
      user.$id,
      {
        storageUsing: 'google',
        googleAccessToken: access_token,
        googleRefreshToken: refresh_token,
        googleFolderId: folderId,
        googleEmail: userInfo.email
      }
    );

    console.log("✅ Appwrite updated successfully!");

    // Redirect to settings
    return res.redirect(`${process.env.FRONTEND_URL}/settings?google_connected=true`);
  } catch (err) {
    console.error("OAuth callback error:", err);
    return res.redirect(`${process.env.FRONTEND_URL}/settings?google_error=callback_failed`);
  }
});

// ---------------- SPOTIFY OAUTH START ----------------
app.get("/auth/spotify/start/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug);
    const state = encodeURIComponent(slug);
    const params = new URLSearchParams({
      client_id: process.env.SPOTIFY_CLIENT_ID,
      response_type: "code",
      redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
      scope: "user-read-private user-read-email user-modify-playback-state user-read-playback-state streaming",
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
    const slug = String(state || "");
    if (!code || !slug) {
      return res.redirect(`${process.env.FRONTEND_URL}/settings?spotify_error=missing_params`);
    }

    const body = new URLSearchParams();
    body.append("code", String(code));
    body.append("grant_type", "authorization_code");
    body.append("redirect_uri", process.env.SPOTIFY_REDIRECT_URI);

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
      return res.redirect(`${process.env.FRONTEND_URL}/settings?spotify_error=token_exchange_failed`);
    }

    const tokenJson = await tokenRes.json();
    
    // Update Appwrite device doc with Spotify tokens
    const device = await getUserPlanBySlug(slug);
    await db.updateDocument(
      process.env.APPWRITE_DB_ID,
      process.env.APPWRITE_DEVICES_COLLECTION,
      device.$id,
      {
        spotifyAccessToken: tokenJson.access_token,
        spotifyRefreshToken: tokenJson.refresh_token,
        spotifyConnected: true
      }
    );

    return res.redirect(`${process.env.FRONTEND_URL}/settings?spotify_connected=true`);
  } catch (err) {
    console.error("Spotify OAuth error:", err);
    return res.redirect(`${process.env.FRONTEND_URL}/settings?spotify_error=callback_failed`);
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
      { is_muted: muted }
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
      { memory_enabled: enabled }
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

    if (!/^\d{9}$/.test(slug)) {
      return res.status(400).json({ error: "Invalid slug format" });
    }

    if (!command_type) {
      return res.status(400).json({ error: "command_type required" });
    }

    // Validate device exists
    const deviceDoc = await db.listDocuments(
      process.env.APPWRITE_DB_ID,
      process.env.APPWRITE_DEVICES_COLLECTION,
      [Query.equal("slug", Number(slug))]
    );

    if (deviceDoc.documents.length === 0) {
      return res.status(404).json({ error: "Device not found" });
    }

    // Create command in Appwrite commands collection
    const command = await db.createDocument(
      process.env.APPWRITE_DB_ID,
      process.env.APPWRITE_COMMANDS_COLLECTION || "commands",
      ID.unique(),
      {
        slug: Number(slug),
        command_type,
        payload: JSON.stringify(payload || {}),
        status: "pending",
        created_at: new Date().toISOString(),
        executed_at: null,
        result: null
      }
    );

    logInfo(`Command queued for device ${slug}: ${command_type}`);

    return res.json({
      ok: true,
      command_id: command.$id,
      queued_at: command.created_at
    });

  } catch (err) {
    logError("COMMAND QUEUE ERROR:", err);
    return res.status(500).json({ error: "Server error" });
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
        executed_at: new Date().toISOString(),
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
  return res.send("<h1>🚀 RK AI Backend v3.0.0</h1><p>Shoom mode active.</p>");
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

// ---------------- START SERVER ----------------
const PORT = process.env.PORT;
app.listen(PORT, () => {
  logInfo(`🔥 RK AI Backend Running on ${PORT}`);
});
