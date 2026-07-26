// teacherHelper.js ✅ PRODUCTION SAFE
import fs from "fs";
import path from "path";
import { callGemini } from "../services/gemini.js";
import { saveFileToSlug } from "../services/supabaseClient.js";
import { logInfo, logError } from "../utils/logger.js";

const MEMORY_DIR = path.resolve("./memory");
const OUTPUT_DIR = path.join(MEMORY_DIR, "teacher_outputs");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ---------------- Prompts ----------------
const SYSTEM_PROMPTS = {
  question_paper: (teacher) =>
    `Exam paper creator for ${teacher.name} — ${teacher.subject}.

Structure:
Section A: MCQ (1 mark each)
Section B: Short Answer (3-4 marks each)
Section C: Long Answer (8-10 marks each)

Label marks per question. Vary difficulty: 40% easy, 40% medium, 20% hard.`,

  assignment: (teacher) =>
    `Assignment creator for ${teacher.name} — ${teacher.subject}. Generate 10-15 questions.

Format per question:
Q[N]. <question text> [<marks>]
Key Point: <1-line expected answer focus>`,

  explanation: (teacher) =>
    `Classroom content writer for ${teacher.name} — ${teacher.subject}.

Structure:
1. Concept: Define the topic clearly in 2-3 sentences.
2. Example: Give 1-2 concrete, relatable examples.
3. Summary: One-sentence takeaway students should remember.`,

  class_planner: (teacher) =>
    `Lesson planner for ${teacher.name} — ${teacher.subject}. One period class.

Sections:
- Learning Objectives (3 max, measurable)
- Materials Required
- Time Plan: [0-5 min] Intro | [5-35 min] Activity | [35-45 min] Wrap-up
- Homework / Reflection Task`
};

// ---------------- Helpers ----------------
function _timestamp() {
  return new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
}

async function _generateFile(intent, prompt, teacher, slug, extra = {}) {
  try {
    const systemMsg = SYSTEM_PROMPTS[intent](teacher);

    let userMsg = prompt;

    if (intent === "question_paper" && extra.difficulty) {
      userMsg += ` Difficulty: ${extra.difficulty}`;
    }

    if (intent === "class_planner" && extra.duration) {
      userMsg += ` Duration: ${extra.duration}`;
    }

    // ✅ 1️⃣ Gemini generates reply
    const content = await callGemini(systemMsg, userMsg);

    // ✅ 2️⃣ Local Save
    const fname = `${intent}_${_timestamp()}.txt`;
    const fpath = path.join(OUTPUT_DIR, fname);

    const fullText =
`Teacher: ${teacher.name} (${teacher.subject})
Generated: ${new Date().toISOString()}

${content}
`;

    fs.writeFileSync(fpath, fullText, "utf-8");
    logInfo(`[teacherHelper] ${intent} saved locally: ${fpath}`);

    // ✅ 3️⃣ Supabase Upload (BUFFER — NOT FILE PATH)
    const supaPath = `slug-${slug}/${fname}`;
    const buffer = Buffer.from(fullText, "utf-8");

    await saveFileToSlug(slug, supaPath, buffer);

    logInfo(`[teacherHelper] ${intent} uploaded to Supabase: ${supaPath}`);

    // ✅ 4️⃣ ONLY RETURN SPOKEN CONTENT
    return content;

  } catch (err) {
    logError(`[teacherHelper] ${intent} generation error:`, err);
    throw err;
  }
}

// ---------------- Public Handler ----------------
export async function handleTeacherTask(intent, params, teacher, slug) {
  const prompt = params.prompt || "";
  const difficulty = params.difficulty || "moderate";
  const duration = params.duration || "45 minutes";

  if (!["question_paper", "assignment", "explanation", "class_planner"].includes(intent)) {
    throw new Error(`Unknown teacher intent: ${intent}`);
  }

  return await _generateFile(intent, prompt, teacher, slug, { difficulty, duration });
}
