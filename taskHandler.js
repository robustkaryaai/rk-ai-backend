// taskHandler.js

import { generateImage } from "./modules/imageGenerator.js";
import { generateVideo } from "./modules/videoGenerator.js";
import { loadChat, appendChat } from "./memory.js";
import { createDocx } from "./modules/docxGenerator.js";
import { createPPT } from "./modules/pptGenerator.js";
import { handleStudentTask } from "./modules/studentTools.js";
import { handleTeacherTask } from "./modules/teacherTools.js";
import { handleMusic } from "./modules/musicPlayer.js";
import { callGemini } from "./services/gemini.js";
import { getSlugStorageUsed } from "./services/supabaseClient.js";
import { transcribeMP3 } from "./services/assemblyai.js";
import { checkAndConsume } from "./limitManager.js";

/* ---------------- MCU PASS THROUGH ---------------- */
const PASS_THROUGH = [
  "reminder",
  "alarm",
  "period_bell",
  "emergency_alarm",
  "fire_alarm",
  "stop_alarm"
];

/* ---------------- TIER STORAGE ---------------- */
const TIER_STORAGE = {
  free: 1024,
  student: 5120,
  creator: 10240,
  pro: 51200,
  studio: 122880
};

/* ---------------- HUMAN TASK REPLY ---------------- */
function buildTaskReply(intent, parameters = {}) {
  const prompt = parameters.prompt || "your request";

  if (intent === "note") return `✅ Creating notes for ${prompt}`;
  if (intent === "planner") return `📅 Creating planner for ${prompt}`;
  if (intent === "timetable") return `🕒 Generating timetable for ${prompt}`;
  if (intent === "task") return `📌 Organizing tasks for ${prompt}`;

  if (intent === "lesson_plan") return `📘 Creating lesson plan for ${prompt}`;
  if (intent === "exam_paper") return `📝 Preparing exam paper for ${prompt}`;
  if (intent === "grading_sheet") return `✅ Creating grading sheet for ${prompt}`;
  if (intent === "class_planner") return `🏫 Preparing class planner for ${prompt}`;
  if (intent === "teacher_note") return `📒 Creating teacher notes for ${prompt}`;

  if (intent === "image") return `🖼️ Generating image for ${prompt}`;
  if (intent === "video") return `🎬 Creating video for ${prompt}`;
  if (intent === "docx") return `📄 Creating document for ${prompt}`;
  if (intent === "ppt") return `📽️ Creating presentation for ${prompt}`;
  if (intent === "music") return `🎵 Playing music for you`;
  if (intent === "transcribe") return `🎙️ Transcribing your audio`;

  return `✅ Working on ${prompt}`;
}

/* ============================================================
   ✅ ✅ ✅ MAIN INTENT HANDLER — NEVER BREAK THIS AGAIN ✅ ✅ ✅
   ============================================================ */
export async function handleIntents(slug, intents, context = {}) {
  const results = [];

  const tierNum = context.device?.subscription === "true"
    ? Number(context.device?.["subscription-tier"] || 0)
    : 0;
  const tierMap = { 0: "free", 1: "student", 2: "creator", 3: "pro", 4: "studio" };
  const tierName = tierMap[tierNum] || "free";
  const storageLimitMB = TIER_STORAGE[tierName] || TIER_STORAGE.free;

  for (const task of intents) {
    const { intent, parameters = {} } = task;

    try {
      const userPrompt = parameters.prompt || intent;
      console.log(`🔍 Handling intent: ${intent} | Prompt: ${userPrompt}`);

      /* -------- MCU PASS THROUGH -------- */
      if (PASS_THROUGH.includes(intent)) {
        results.push({ intent, parameters, execution: "microcontroller" });
        continue;
      }

      /* -------- STORAGE CHECK -------- */
      const fileIntents = ["image", "video", "docx", "ppt"];
      if (fileIntents.includes(intent)) {
        const usedMB = await getSlugStorageUsed(slug);

        if (usedMB >= storageLimitMB) {
          const reply = `❌ Storage limit of ${storageLimitMB} MB reached.`;
          await appendChat(slug, userPrompt, reply);
          results.push(reply);
          continue;
        }
      }

      /* ---------------- IMAGE ---------------- */
      if (intent === "image") {
        const check = await checkAndConsume(slug, tierNum, "image", 1);
        if (!check.ok) {
          const reply = "❌ Daily image limit reached";
          await appendChat(slug, userPrompt, reply);
          results.push(reply);
          continue;
        }

        await generateImage(userPrompt, slug, tierName, storageLimitMB);
        const reply = buildTaskReply(intent, parameters);
        await appendChat(slug, userPrompt, reply);
        results.push(reply);
        continue;
      }

      /* ---------------- VIDEO ---------------- */
      if (intent === "video") {
        const check = await checkAndConsume(slug, tierNum, "video", 1);
        if (!check.ok) {
          const reply = "❌ Daily video limit reached";
          await appendChat(slug, userPrompt, reply);
          results.push(reply);
          continue;
        }

        await generateVideo(userPrompt, slug, tierName, storageLimitMB);
        const reply = buildTaskReply(intent, parameters);
        await appendChat(slug, userPrompt, reply);
        results.push(reply);
        continue;
      }

      /* ---------------- DOCX ---------------- */
      if (intent === "docx") {
        await createDocx(userPrompt, slug, tierName, storageLimitMB);
        const reply = buildTaskReply(intent, parameters);
        await appendChat(slug, userPrompt, reply);
        results.push(reply);
        continue;
      }

      /* ---------------- PPT ---------------- */
      if (intent === "ppt") {
        const checkPpt = await checkAndConsume(slug, tierNum, "ppt", 1);
        if (!checkPpt.ok) {
          const reply = "❌ Daily presentation limit reached";
          await appendChat(slug, userPrompt, reply);
          results.push(reply);
          continue;
        }

        const resp = await createPPT(userPrompt, slug, tierName, storageLimitMB);
        const reply = buildTaskReply(intent, parameters);
        await appendChat(slug, userPrompt, reply);
        results.push(reply);

        const slides = Number(resp?.num_slides || 0);
        if (slides > 0) {
          const checkSlides = await checkAndConsume(slug, tierNum, "ppt_slides", slides);
          if (!checkSlides.ok) {
            const warn = `⚠️ Slide limit reached for today (${checkSlides.allowed}). Presentation generated.`;
            await appendChat(slug, userPrompt, warn);
            results.push(warn);
          }
        }
        continue;
      }

      /* ---------------- MUSIC ---------------- */
      if (intent === "music") {
        const music = await handleMusic(userPrompt, slug);

        const reply = music?.link
          ? `🎶 Now playing: ${userPrompt}\n🔗 Stream: ${music.link}`
          : "⚠️ I couldn't find that song.";

        await appendChat(slug, userPrompt, reply);
        // Return both reply and song_url so frontend can use them
        results.push({ reply, song_url: music?.link || null });
        continue;
      }

      /* ---------------- TRANSCRIBE ---------------- */
      if (intent === "transcribe" && parameters.audioUrl) {
        const transcript = await transcribeMP3(parameters.audioUrl);
        const reply = transcript || "❌ Could not transcribe audio.";
        await appendChat(slug, "Audio uploaded", reply);
        results.push(reply);
        continue;
      }

      /* ---------------- STUDENT TASKS ---------------- */
      if (["note", "planner", "timetable", "task"].includes(intent)) {
        // Generate and save student files, but reply with a concise human-friendly status
        try {
          await handleStudentTask(intent, parameters, slug);
        } catch (err) {
          console.error("Student task generation failed:", err);
        }

        const reply = buildTaskReply(intent, parameters);
        await appendChat(slug, userPrompt, reply);
        results.push(reply);
        continue;
      }

      /* ---------------- TEACHER TASKS ---------------- */
      if (["lesson_plan", "exam_paper", "grading_sheet", "class_planner", "teacher_note"].includes(intent)) {
        try {
          await handleTeacherTask(intent, parameters, context.teacher, slug);
        } catch (err) {
          console.error("Teacher task generation failed:", err);
        }

        const reply = buildTaskReply(intent, parameters);
        await appendChat(slug, userPrompt, reply);
        results.push(reply);
        continue;
      }

      /* ---------------- GEMINI CHAT ---------------- */
      if (intent === "chat" || intent === "general") {
        const history = await loadChat(slug);

        // Call Gemini first, validate/normalize the response, then append to chat.
        const rawReply = await callGemini(
          "You are RK AI created by RK Innovators. Reply clearly in 1-2 lines.",
          history,
          userPrompt
        );

        // Normalize reply: support string replies or objects with a `text` field.
        const reply =
          typeof rawReply === "string"
            ? rawReply
            : rawReply && typeof rawReply === "object" && typeof rawReply.text === "string"
            ? rawReply.text
            : null;

        if (reply) {
          await appendChat(slug, userPrompt, reply);
          results.push(reply);
          continue;
        } else {
          results.push("❌ Failed to get a valid response from Gemini.");
          console.warn("❌ Invalid response from Gemini:", rawReply);
          continue;
        }
      }

    } catch (err) {
      console.error(`❌ Error handling ${intent}:`, err);
      const failReply = "❌ Something went wrong while processing your request.";
      await appendChat(slug, parameters.prompt || intent, failReply);
      results.push(failReply);
    }
  }

  return results;
}
