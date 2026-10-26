import { createProfessionalDocx, createProfessionalExcel } from "./officeGenerator.js";
import { logInfo, logError } from "../utils/logger.js";

export async function handleTeacherTask(intent, params, teacher, slug) {
  const prompt = params.prompt || "";
  const teacherContext = teacher ? ` (Teacher: ${teacher.name || "Educator"} - ${teacher.subject || "General"})` : "";
  const fullPrompt = `${prompt}${teacherContext}`;

  logInfo(`[TeacherTools] Handling intent: "${intent}" with prompt: "${fullPrompt}"`);

  try {
    if (intent === "grading_sheet") {
      // Marksheets, grading sheets, rubric scores format as real Excel spreadsheets
      return await createProfessionalExcel(fullPrompt, slug, "grading_sheet");
    }

    if (["lesson_plan", "exam_paper", "question_paper", "class_planner", "teacher_note", "assignment", "explanation"].includes(intent)) {
      // Lesson plans, exam papers, syllabus and teacher notes format as clean Word documents (.docx)
      return await createProfessionalDocx(fullPrompt, slug, intent);
    }

    // Default fallback to Word doc
    return await createProfessionalDocx(fullPrompt, slug, intent);
  } catch (err) {
    logError(`[TeacherTools] Error handling ${intent}:`, err);
    throw err;
  }
}
