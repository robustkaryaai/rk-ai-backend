import { createProfessionalDocx, createProfessionalExcel } from "./officeGenerator.js";
import { logInfo, logError } from "../utils/logger.js";

export async function handleStudentTask(intent, params, slug) {
  const prompt = params.prompt || "";
  logInfo(`[StudentTools] Handling intent: "${intent}" for prompt: "${prompt}"`);

  try {
    if (intent === "timetable") {
      // Generate formatted Excel timetable
      return await createProfessionalExcel(prompt, slug, "timetable");
    }

    if (intent === "planner" || intent === "task") {
      // Study planners & tasks formatted as structured Word doc / checklists
      return await createProfessionalDocx(prompt, slug, "planner");
    }

    if (intent === "note" || intent === "assignment") {
      // Academic notes and assignments formatted as professional Word documents
      return await createProfessionalDocx(prompt, slug, "notes");
    }

    // Default fallback to Word doc
    return await createProfessionalDocx(prompt, slug, intent);
  } catch (err) {
    logError(`[StudentTools] Error handling ${intent}:`, err);
    throw err;
  }
}
