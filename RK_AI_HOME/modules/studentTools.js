import fs from "fs";
import path from "path";
import { callGemini } from "../services/gemini.js";
import { saveFileToSlug } from "../services/supabaseClient.js";
import { logInfo, logError } from "../utils/logger.js";

const MEMORY_DIR = path.resolve("./memory");
const NOTES_DIR = path.join(MEMORY_DIR, "notes");
const PLANS_DIR = path.join(MEMORY_DIR, "plans");
const TIMETABLE_DIR = path.join(MEMORY_DIR, "timetables");

fs.mkdirSync(NOTES_DIR, { recursive: true });
fs.mkdirSync(PLANS_DIR, { recursive: true });
fs.mkdirSync(TIMETABLE_DIR, { recursive: true });

const TIER_STORAGE = {
  free: 1024,
  student: 5120,
  creator: 10240,
  pro: 51200,
  studio: 122880
};

// ------------------ Prompts ------------------
const SYSTEM_PROMPTS = {
  note: `Education specialist creating study notes for {student_name} ({student_level}).

Format:
- H2 for main topics, H3 for subtopics.
- 3-5 bullet points per subtopic — concise, exam-focused.
- End each section with a 1-line key takeaway.
- Use NCERT curriculum if specified.
Output: plain text only.`,

  planner: `Study planner for {student_name} ({student_level}). Create a structured daily plan.

Format per day:
- Time blocks: [HH:MM–HH:MM] Subject — specific task
- Include 15-min breaks every 90 minutes.
- Mark priority: HIGH / MED / LOW per block.`,

  timetable: `Timetable generator for {student_name} ({student_level}). Output a formatted weekly timetable.

Use a markdown table: | Time | Mon | Tue | Wed | Thu | Fri | Sat |
Include break periods. Label subjects clearly.`
};

// ------------------ Helpers ------------------
function _timestamp() {
  return new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
}

async function _generateFile(intent, prompt, slug, tier = "free") {
  try {
    const systemMsg = SYSTEM_PROMPTS[intent]

    // ✅ Generate from Gemini
    const content = await callGemini(systemMsg, "", prompt);

    const fname = `${intent}_${_timestamp()}.txt`;

    const localDir =
      intent === "note"
        ? NOTES_DIR
        : intent === "planner"
        ? PLANS_DIR
        : TIMETABLE_DIR;

    const fpath = path.join(localDir, fname);

    const fileData =
      `Title/Task: ${prompt}\n` +
      `Generated: ${new Date().toISOString()}\n\n` +
      content;

    const buffer = Buffer.from(fileData, "utf-8");

    // ✅ Save locally
    fs.writeFileSync(fpath, buffer);
    logInfo(`[studentHelper] ${intent} saved locally: ${fpath}`);

    // ✅ Tier-based upload
    const storageLimitMB = TIER_STORAGE[tier] || TIER_STORAGE.free;

    await saveFileToSlug(slug, fname, buffer, tier, storageLimitMB);

    logInfo(`[studentHelper] ${intent} uploaded to Supabase: ${slug}/${fname}`);

    // ✅ ONLY RETURN AI CONTENT
    return content;

  } catch (err) {
    logError(`[studentHelper] ${intent} generation error:`, err);
    throw err;
  }
}

// ------------------ Public Handler ------------------
export async function handleStudentTask(intent, params, slug, tier = "free") {
  const prompt = params.prompt || "No prompt provided";

  if (!["note", "planner", "timetable"].includes(intent)) {
    throw new Error(`Unknown student intent: ${intent}`);
  }

  return await _generateFile(intent, prompt, slug, tier);
}
