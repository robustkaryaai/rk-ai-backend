import { callGemini } from "../services/gemini.js";

/**
 * Clean up strings into clean kebab-case names
 */
function cleanToKebab(str, maxLen = 40) {
  return String(str || "")
    .toLowerCase()
    .replace(/^(rk\s+|please\s+|make\s+me\s+a\s+|create\s+a\s+|generate\s+a\s+|write\s+a\s+|build\s+a\s+)+/gi, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, maxLen);
}

/**
 * Generate a smart, human-readable slug using Gemini.
 * Falls back to concise heuristic cleaning if Gemini is unavailable.
 */
export async function generateSmartFilename(prompt, type, extension, slug = null) {
  const ext = String(extension).toLowerCase().replace(/^\./, "");
  let cleanName = null;

  try {
    const systemPrompt = `You generate concise, elegant, slug-style filenames for user requests.
Rules:
- 2 to 4 words maximum.
- Use only lowercase letters, digits, and hyphens (kebab-case).
- Do NOT include file extensions.
- Do NOT include dates or timestamps.
- Examples:
  "make me a study planner for jee mains exam" -> "jee-mains-study-planner"
  "a car driving on a rainy road at night" -> "rainy-car-drive"
  "grade 12 physics notes on electromagnetism" -> "physics-electromagnetism-notes"
  "financial report spreadsheet for quarterly sales" -> "quarterly-sales-report"
Output ONLY the kebab-case filename slug and nothing else.`;

    const result = await callGemini(systemPrompt, [], String(prompt || type), 2, null, "gemini-3.5-flash-lite", slug);
    if (result && typeof result === "string" && !result.toLowerCase().includes("trouble connecting") && !result.toLowerCase().includes("please try again")) {
      const sanitized = result.trim()
        .toLowerCase()
        .replace(/[`"'*]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .substring(0, 45);

      if (sanitized && sanitized.length > 2 && sanitized !== "file") {
        cleanName = sanitized;
      }
    }
  } catch (err) {
    // Fall back to rule-based cleaning
  }

  if (!cleanName) {
    cleanName = cleanToKebab(prompt || type || "file", 35);
  }

  const timestamp = Date.now();
  return `${cleanName}-${timestamp}.${ext}`;
}

/**
 * Synchronous backward-compatible fallback
 */
export function generateFilename(topic, type, extension) {
  const cleanName = cleanToKebab(topic || type || "file", 35);
  const timestamp = Date.now();
  const ext = String(extension).toLowerCase().replace(/^\./, "");
  return `${cleanName}-${timestamp}.${ext}`;
}

export function extractTimestampFromFilename(filename) {
  const match = filename.match(/-(\d+)\.[^.]+$/);
  return match ? parseInt(match[1], 10) : null;
}

export function extractTopicFromFilename(filename) {
  const match = filename.match(/^(.+?)-[a-z]+-\d+\./);
  return match ? match[1] : null;
}
