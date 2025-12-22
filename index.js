import express from "express";
import dotenv from "dotenv";

import { logInfo, logError } from "./utils/logger.js";
import { getUserPlanBySlug, checkDeviceBySlug, ensureDeviceBySlug } from "./services/appwriteClient.js";
import { db } from "./services/appwriteClient.js";
import { loadChat, appendChat, appendUser, updateLastAI } from "./memory.js";
import { ensureLimitFile } from "./limitManager.js";
import { callGemini } from "./services/gemini.js";
import { handleIntents } from "./taskHandler.js";
// voice transcription removed — text-only processing

dotenv.config();

const app = express();

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

// voice upload removed — text-only processing

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
1) If the user uses generative verbs (generate/make/create/render/build) with a media noun:
   - Mentions video nouns (video/clip/short/episode/animation): intent = "video".
   - Mentions image nouns (image/picture/photo/thumbnail/poster/art): intent = "image".
   - Mentions slides/ppt/presentation: intent = "ppt".
   - Mentions document/report/essay/study notes: intent = "docx".
   Never default to "chat" if a generative intent is implied.
2) If the user says play/start music/song/background sound → intent = "music" (NOT video).
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

// ---------------- TEXT ROUTE ----------------
app.post("/text/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug);
    const text = String(req.body?.text || "").trim();

    if (!slug || !text) {
      return res.status(400).json({ error: "bad_request" });
    }

    const device = await getUserPlanBySlug(slug);
    if (!device) {
      return res.status(404).json({ error: "invalid_slug" });
    }

    await ensureLimitFile(slug);

    let rawIntents = await callGemini(
      SYSTEM_PROMPT,
      [],
      text
    );

    let intents;
    try {
      intents = JSON.parse(rawIntents);
      if (!Array.isArray(intents)) throw new Error("Bad JSON");
    } catch {
      intents = [{ intent: "chat", parameters: { prompt: text } }];
    }

    const appended = await appendUser(slug, `User: ${text}`);
    const results = await handleIntents(slug, intents, { device });

    let finalReply = "";
    let song_url = null;
    const isMusic = intents.some(i => i?.intent === "music");

    for (let i = 0; i < intents.length; i++) {
      const intentName = intents[i]?.intent;
      const r = results[i];
      if (!r) continue;
      if (intentName === "music") {
        finalReply = typeof r === "string" ? r : r?.reply || "";
        song_url = r?.song_url || null;
        break;
      }
    }

    if (!finalReply) {
      for (let i = 0; i < intents.length; i++) {
        const intentName = intents[i]?.intent;
        const r = results[i];
        if (!r) continue;
        if (intentName === "chat" || intentName === "general") {
          finalReply = typeof r === "string" ? r : r?.reply || "";
          break;
        }
      }
    }

    if (!finalReply) {
      const fileIntents = ["note", "planner", "timetable", "task", "docx", "ppt", "image", "video", "lesson_plan", "exam_paper", "grading_sheet", "class_planner", "teacher_note"];
      for (let i = 0; i < intents.length; i++) {
        const intentName = intents[i]?.intent;
        const r = results[i];
        if (!r) continue;
        if (fileIntents.includes(intentName)) {
          finalReply = typeof r === "string" ? r : r?.reply || "";
          if (finalReply) break;
        }
      }
    }

    if (!finalReply) {
      for (const r of results) {
        if (typeof r === "string" && r.trim()) {
          finalReply = r;
          break;
        }
        if (r && typeof r === "object" && typeof r.reply === "string" && r.reply.trim()) {
          finalReply = r.reply;
          break;
        }
      }
    }

    if (finalReply) {
      const idx = appended?.index ?? null;
      await updateLastAI(slug, finalReply, idx);
    }

    const responseObj = { reply: finalReply };
    if (song_url) {
      responseObj.song_url = song_url;
      if (isMusic) responseObj.link = song_url;
    }
    return res.json(responseObj);

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
    const slug = String(req.params.slug);

    const device = await getUserPlanBySlug(slug);
    if (!device) return res.status(404).json({ error: "invalid_slug" });

    const chat = await loadChat(slug);
    return res.json({ chat });
  } catch (err) {
    logError("CHAT ERROR:", err);
    return res.status(500).json({ error: "server_error" });
  }
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

app.get("/device/check/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug);

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
    const slug = String(req.params.slug);

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


// ---------------- START SERVER ----------------
const PORT = process.env.PORT;
app.listen(PORT, () => {
  logInfo(`🔥 RK AI Backend Running on ${PORT}`);
});
