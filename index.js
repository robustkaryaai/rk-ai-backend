// index.js
import express from "express";
import dotenv from "dotenv";
import multer from "multer";
import fs from "fs";
import path from "path";

import { logInfo, logError } from "./utils/logger.js";
import { getUserPlanBySlug, checkDeviceBySlug, ensureDeviceBySlug } from "./services/appwriteClient.js";
import { db } from "./services/appwriteClient.js";
import { loadChat, appendChat, appendUser, updateLastAI } from "./memory.js";
import { ensureLimitFile, checkAndConsume } from "./limitManager.js";
import { callGemini } from "./services/gemini.js";
import { handleIntents } from "./taskHandler.js";
import { transcribeMP3 } from "./services/assemblyai.js";

dotenv.config();

const app = express();

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

// ✅ ENSURE voice FOLDER EXISTS
const VOICE_DIR = path.join(process.cwd(), "voice");
if (!fs.existsSync(VOICE_DIR)) {
  fs.mkdirSync(VOICE_DIR);
}

// ✅ REAL FILE STORAGE (NOT MEMORY)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, VOICE_DIR);
  },
  filename: (req, file, cb) => {
    const slug = String(req.params.slug);
    const ext = path.extname(file.originalname) || ".m4a";
    const name = `${slug}_${Date.now()}${ext}`;
    cb(null, name);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ---------------- SYSTEM PROMPT ----------------
const SYSTEM_PROMPT = `
You are **RK AI**, a multimodal assistant and automation system built by Dev (Dav THE LEGEND).
You serve as the intelligent core of the RK ecosystem — handling creation, scheduling, organization, and interaction tasks.

Your role is to understand user intent deeply and output structured JSON instructions for tools to execute.
You do not respond with explanations or plain text — only pure JSON following the schema below.

=======================
🧠 WHAT YOU CAN DO
=======================
🎨 **Creative Generation**
- "image" → generate images, posters, thumbnails, or concept art.
- "video" → generate videos, edits, story episodes, or shorts.
- "docx" → write essays, formatted study notes, or reports.
- "ppt" → create slides or class summaries.

📚 **Student and Academic Tasks**
- "note" → make short notes, summaries, or detailed explanations.
- "planner" → create study schedules, daily routines, or checklists.
- "timetable" → generate structured school or coaching timetables.
- "task" → set alarms, reminders, or to-dos.
- "period_bell" → manage automatic school period and assembly bells.
- "announcement" → make daily or school-related announcements.

👨‍🏫 **Teacher and Educational Tools**
- "lesson_plan" → create structured lesson outlines or teaching content.
- "exam_paper" → generate question papers, quizzes, or mock exams.
- "grading_sheet" → make templates for student marks or progress tracking.
- "class_planner" → organize class routines, syllabi, or assignments.
- "teacher_note" → prepare teaching notes or guides for complex topics.
- Teachers may also use "planner" and "timetable" intents for school management.

🌦️ **Info and Daily Utilities**
- "weather" → get real-time weather or temperature info for any city.
- "news" → fetch breaking news, tech updates, or local headlines.
- "chat" → handle normal conversation or small talk.

=======================
📜 OUTPUT SCHEMA
=======================
[
  {
    "intent": "image" | "video" | "docx" | "ppt" | "note" | "planner" |
               "timetable" | "task" | "status" | "period_bell" | "announcement" |
               "assignment" | "exam_paper" | "grading_sheet" | "class_planner" |
               "teacher_note" | "weather" | "news" | "chat" | "general" | "shutdown/exit",
    "parameters": {
        "prompt": "description or command",
        "location": "if weather/news related, the location in which user is is Delhi, India.",
        "note_type": "if notes or summary",
        "time": "if scheduling, alarm, or bell related.",
        "extra": "any additional context"
    }
  }
]

=======================================
⚠️ IMPORTANT RULES YOU CAN NOT BREAK
=======================================
1. Always respond in **pure JSON** — no markdown, no quotes outside the array.
2. Break down complex prompts into multiple intents if needed.
3. Never say “here’s your JSON” or add any extra commentary.
4. If unsure of intent, use "general".
5. Keep parameters precise — avoid repetition.
6. You may return multiple intents in one array if the user mixes tasks.
7. Until and unless user tells a real place name in weather or news prompt do not put any other location than Delhi, India and for news only India.
8. For an alarm default type is reminder until user tells what this alarm is for. So, if the user says like "Set an alarm for 3PM" you give prompt only alarm.
9. If the user says "emergency", "fire", "evacuate", or "alert", use intent = "emergency_alarm" or "fire_alarm" as appropriate. Do NOT classify it as "task" or "reminder".
10. If the user says anything like “cancel the alarm”, “stop the alarm”, “turn off reminder”, or “silence alert”, classify it strictly as the intent "stop_alarm" — never "task", "fire_alarm", or "emergency_alarm".
11. If user says shutdown or exit you have to give intent the same not general.
12. When handling alarms, store time separately from the prompt. 
    Example: "Set alarm for 6:45 AM named Morning Yoga" → {"prompt": "Morning Yoga", "time": "06:45 AM"}.
13. If the user says “play”, “start music”, “background sound”, or “song”, use intent = "music", not "video".
14. Do NOT wrap JSON in \`\`\`json
15. If user says stop or pause or resume this means they are talking about music not the system.
16. If you see user say only pose or paul means they meant pause so your job is to parse pause the music not generate image.
17. If the user mentions "viva", "interview", "yourself", or "oral questions", classify intent as "chat" (or "general") — not "note" or "exam_paper".

=======================
💬 EXAMPLE
=======================
User says: "Make notes on photosynthesis, create tomorrow's class plan, and generate a quiz."

Output:
[
  {
    "intent": "note",
    "parameters": {"prompt": "photosynthesis notes", "note_type": "summary"}
  },
  {
    "intent": "class_planner",
    "parameters": {"prompt": "tomorrow's class schedule for biology"}
  },
  {
    "intent": "exam_paper",
    "parameters": {"prompt": "quiz questions on photosynthesis topic"}
  }
]
User says: "What is pascal law"

Output:
[
  {
    "intent": "chat",
    "parameters": {"prompt": "explain pascal law"}
  }
]

Now only output JSON and respond to this prompt with all the rules you’ve learned.
`;

// ---------------- VOICE ROUTE ----------------
// ---------------- VOICE ROUTE ----------------
app.post("/voice/:slug", upload.single("file"), async (req, res) => {
  try {
    const slug = String(req.params.slug);

    if (!slug || !req.file) {
      return res.status(400).json({ error: "bad_request" });
    }

    // ✅ FULL PATH OF SAVED FILE
    const audioPath = req.file.path;
    logInfo("🎤 VOICE FILE SAVED:", audioPath);

    // ✅ Verify device
    const device = await getUserPlanBySlug(slug);
    if (!device) {
      return res.status(404).json({ error: "invalid_slug" });
    }

    const tier =
      device.subscription === "true"
        ? Number(device["subscription-tier"] || 0)
        : 0;

    // ✅ Ensure limit file
    await ensureLimitFile(slug);

    // ✅ ✅ ✅ TRANSCRIBE FROM REAL FILE PATH
    const transcription = await transcribeMP3(audioPath);

    // ✅ ✅ ✅ DELETE FILE AFTER TRANSCRIPTION (AUTO CLEANUP)
    fs.unlink(audioPath, (err) => {
      console.log("Done bro :) Deleted file:", audioPath);
    });

    let rawIntents = await callGemini(
      SYSTEM_PROMPT,
      [],
      transcription
    );

    let intents;
    try {
      intents = JSON.parse(rawIntents);
      if (!Array.isArray(intents)) throw new Error("Bad JSON");
    } catch {
      intents = [{ intent: "chat", parameters: { prompt: transcription } }];
    }

    // ✅ Enforce limits
    for (const i of intents) {
      if (i.intent === "image") {
        const check = await checkAndConsume(slug, tier, "image", 1);
        if (!check.ok) {
          i.intent = "limit_reached";
          i.parameters = { extra: "Daily image limit reached" };
        }
      }

      if (i.intent === "video" && tier < 1) {
        i.intent = "subscription_required";
        i.parameters = {
          extra: "Video generation requires subscription"
        };
      }
    }

  // ✅ Save user input (atomic placeholder) - returns the index for later AI update
  const appended = await appendUser(slug, `User: ${transcription}`);

    // ✅ Run task handler
    const results = await handleIntents(slug, intents, { device });

    // ✅ Compute final speaking reply from results (results align with `intents` order)
    let finalReply = "";
    let song_url = null;

    // Prefer music reply first (music always gets a proper response)
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

    // Then prefer chat/general (user just wants to talk)
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

    // Skip file/task intents (they return status messages like "✅ Creating notes...") unless no chat found
    // If we still don't have a reply and there are file/task intents, use their status message
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

    // Fallback: first non-empty string in results
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

    // ✅ Save only AI reply by updating the last user entry
    if (finalReply) {
      const idx = appended?.index ?? null;
      await updateLastAI(slug, finalReply, idx);
    }

    // ✅ ✅ ✅ ✅ FINAL CLEAN RESPONSE (NO TRASH)
    const responseObj = { reply: finalReply };
    if (song_url) {
      responseObj.song_url = song_url;
    }
    return res.json(responseObj);

  } catch (err) {
    logError("VOICE ERROR:", err);
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
