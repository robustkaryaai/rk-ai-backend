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
import { checkAndConsume } from "./limitManager.js";

/* ---------------- MCU PASS THROUGH ---------------- */
const PASS_THROUGH = [
  "reminder",
  "alarm",
  "set_alarm",
  "delete_alarm",
  "set_schedule",
  "delete_schedule",
  "period_bell",
  "emergency_alarm",
  "fire_alarm",
  "stop_alarm"
];

/* ---------------- TIER STORAGE ---------------- */
const TIER_STORAGE = {
  free: 50,
  student: 500,
  creator: 1000,
  pro: 5000,
  studio: 12000
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

      /* ---------------- ALARMS ---------------- */
      if (intent === "set_alarm") {
        const time = parameters.time;
        const label = parameters.label || "Alarm";
        const sound = parameters.sound || "freesound_community-alarm-clock-short-6402.mp3";
        const days = parameters.days || []; // 🚀 RECURRING DAYS
        
        // 🚀 USE GEMINI TO GENERATE A WAKE-UP MESSAGE
        let wakeUpMessage = `Radhe Radhe! It's ${time}. Time for ${label}.`;
        try {
          const geminiPrompt = `The user set an alarm for ${time} with the label "${label}". Generate a short, creative, and motivating wake-up message (max 20 words). Start with "Radhe Radhe!".`;
          const aiResponse = await callGemini(geminiPrompt);
          if (aiResponse) wakeUpMessage = aiResponse.trim();
        } catch (err) {
          console.error("[Gemini-Alarm] Failed to generate message:", err);
        }

        const reply = `⏰ Alarm set for ${time}${label !== "Alarm" ? " (" + label + ")" : ""}. I'll wake you up with a custom message!`;
        
        // Update device doc with the new alarm
        const device = await getUserPlanBySlug(slug);
        let alarms = [];
        try {
          alarms = typeof device.alarms === 'string' ? JSON.parse(device.alarms) : (device.alarms || []);
        } catch (e) {
          alarms = [];
        }
        
        const newAlarm = { 
          id: Date.now().toString(), 
          time, 
          label, 
          sound, 
          days, // 🚀 Save recurring days
          wakeUpMessage,
          active: true 
        };
        alarms.push(newAlarm);
        
        await db.updateDocument(
          process.env.APPWRITE_DB_ID,
          process.env.APPWRITE_DEVICES_COLLECTION,
          device.$id,
          { alarms: JSON.stringify(alarms) }
        );
        
        await appendChat(slug, userPrompt, reply);
        results.push({ intent, parameters: { ...parameters, sound, wakeUpMessage, days }, execution: "microcontroller", reply });
        continue;
      }

      if (intent === "delete_alarm") {
        const alarmId = parameters.alarm_id;
        const device = await getUserPlanBySlug(slug);
        let alarms = [];
        try {
          alarms = typeof device.alarms === 'string' ? JSON.parse(device.alarms) : (device.alarms || []);
        } catch (e) {
          alarms = [];
        }
        
        const updatedAlarms = alarms.filter(a => a.id !== alarmId);
        
        await db.updateDocument(
          process.env.APPWRITE_DB_ID,
          process.env.APPWRITE_DEVICES_COLLECTION,
          device.$id,
          { alarms: JSON.stringify(updatedAlarms) }
        );
        
        const reply = "🗑️ Alarm deleted.";
        await appendChat(slug, userPrompt, reply);
        results.push({ intent, parameters, execution: "microcontroller", reply });
        continue;
      }

      /* ---------------- SCHEDULES ---------------- */
      if (intent === "set_schedule") {
        const { date, time, task } = parameters;
        const reply = `📅 Task scheduled for ${date} at ${time}: "${task}"`;
        
        const device = await getUserPlanBySlug(slug);
        let schedules = [];
        try {
          schedules = typeof device.schedules === 'string' ? JSON.parse(device.schedules) : (device.schedules || []);
        } catch (e) {
          schedules = [];
        }
        
        const newSchedule = { id: Date.now().toString(), date, time, task, active: true };
        schedules.push(newSchedule);
        
        await db.updateDocument(
          process.env.APPWRITE_DB_ID,
          process.env.APPWRITE_DEVICES_COLLECTION,
          device.$id,
          { schedules: JSON.stringify(schedules) }
        );
        
        await appendChat(slug, userPrompt, reply);
        results.push({ intent, parameters, execution: "microcontroller", reply });
        continue;
      }

      if (intent === "delete_schedule") {
        const scheduleId = parameters.schedule_id;
        const device = await getUserPlanBySlug(slug);
        let schedules = [];
        try {
          schedules = typeof device.schedules === 'string' ? JSON.parse(device.schedules) : (device.schedules || []);
        } catch (e) {
          schedules = [];
        }
        
        const updatedSchedules = schedules.filter(s => s.id !== scheduleId);
        
        await db.updateDocument(
          process.env.APPWRITE_DB_ID,
          process.env.APPWRITE_DEVICES_COLLECTION,
          device.$id,
          { schedules: JSON.stringify(updatedSchedules) }
        );
        
        const reply = "🗑️ Schedule deleted.";
        await appendChat(slug, userPrompt, reply);
        results.push({ intent, parameters, execution: "microcontroller", reply });
        continue;
      }

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

        const statusMsg = buildTaskReply(intent, parameters);
        await appendChat(slug, userPrompt, statusMsg);
        await generateImage(userPrompt, slug, tierName, storageLimitMB);
        results.push(statusMsg);
        continue;
      }

      /* ---------------- VIDEO ---------------- */
      if (intent === "video") {
        if (!(tierNum === 3 || tierNum === 4)) {
          const reply = "❌ Video generation is available only for Pro and Studio plans.";
          await appendChat(slug, userPrompt, reply);
          results.push(reply);
          continue;
        }

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

      /* ---------------- MUSIC (HANDLED BY PI) ---------------- */
      // if (intent === "music") {
      //   const music = await handleMusic(userPrompt, slug);
      //
      //   if (music?.link) {
      //     const reply = `Playing ${userPrompt}`;
      //     const jsonResponse = {
      //       intent: "music",
      //       reply: reply,
      //       link: music.link
      //     };
      //
      //     await appendChat(slug, userPrompt, reply);
      //     results.push(jsonResponse);
      //   } else {
      //     const reply = "Could not find that song.";
      //     await appendChat(slug, userPrompt, reply);
      //     results.push({ intent: "music", reply });
      //   }
      //   continue;
      // }


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

      /* ---------------- ANNOUNCEMENT ---------------- */
      if (intent === "announcement") {
        const announcementText = parameters.prompt || userPrompt;

        const jsonResponse = {
          intent: "announcement",
          reply: announcementText
        };

        await appendChat(slug, userPrompt, `📢 Announcement: ${announcementText}`);
        results.push(jsonResponse);
        continue;
      }

      /* ---------------- ALARM ---------------- */
      if (intent === "alarm") {
        const alarmTime = parameters.time;

        if (alarmTime) {
          const reply = `Alarm set for ${alarmTime}`;
          const jsonResponse = {
            intent: "alarm",
            reply: reply,
            time: alarmTime
          };

          await appendChat(slug, userPrompt, reply);
          results.push(jsonResponse);
        } else {
          const reply = "What time should I set the alarm?";
          const jsonResponse = {
            intent: "alarm",
            reply: reply
          };

          await appendChat(slug, userPrompt, reply);
          results.push(jsonResponse);
        }
        continue;
      }

      /* ---------------- GEMINI CHAT ---------------- */
      if (intent === "chat" || intent === "general") {
        const history = await loadChat(slug);

        // Call Gemini first, validate/normalize the response, then append to chat.
        const rawReply = await callGemini(
          "You are RexyCore created by Robust Karya. Reply clearly in 1-2 lines.",
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
