// memory.js
import { saveFileToSlug, downloadFileFromSlug } from "./services/supabaseClient.js";
import { logError } from "./utils/logger.js";

// ------------------- UTILS -------------------
function formatTime(date = new Date()) {
  return date.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

function formatDate(date = new Date()) {
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
}

// ------------------- CHAT -------------------
// Load chat as JSON array
export async function loadChat(slug) {
  try {
    const buf = await downloadFileFromSlug(slug, "chat.txt");
    if (!buf) return [];

    const text = buf.toString("utf8").trim();
    if (!text) return [];

    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) return [];
      return parsed;
    } catch (e) {
      logError("⚠ chat.txt corrupted, resetting:", e);
      return [];
    }

  } catch (err) {
    logError("loadChat error:", err);
    return [];
  }
}

// ✅ ✅ ✅ NEW ATOMIC CHAT APPENDER
// Usage: appendChat(slug, userPrompt, aiReply)
export async function appendChat(slug, userPrompt, aiReply) {
  try {

    // 🔒 HARD VALIDATION
    if (!slug) {
      console.error("❌ appendChat FAILED: Missing slug");
      return [];
    }

    if (typeof userPrompt !== "string" || !userPrompt.trim()) {
      console.error("❌ appendChat FAILED: Invalid userPrompt:", userPrompt);
      return [];
    }

    if (typeof aiReply !== "string" || !aiReply.trim()) {
      console.error("❌ appendChat FAILED: Invalid aiReply:", aiReply);
      return [];
    }

    const prev = await loadChat(slug);
    const list = Array.isArray(prev) ? prev : [];

    // ✅ ATOMIC PUSH (USER + AI TOGETHER)
    list.push({
      User: userPrompt.trim(),
      AI: aiReply.trim(),
      Date: formatDate(),
      Time: formatTime()
    });

    const buffer = Buffer.from(JSON.stringify(list, null, 2), "utf8");
    await saveFileToSlug(slug, "chat.txt", buffer);

    return list;

  } catch (err) {
    logError("appendChat error:", err);
    return [];
  }
}

// ------------------- USER/AI ATOMIC HELPERS -------------------
// Append only the user line and return the updated list and the index of the new entry
export async function appendUser(slug, userText) {
  try {
    if (!slug || typeof userText !== "string" || !userText.trim()) return null;
    const prev = await loadChat(slug);
    const list = Array.isArray(prev) ? prev : [];

    list.push({
      User: userText.trim(),
      AI: "", // placeholder
      Date: formatDate(),
      Time: formatTime()
    });

    const buffer = Buffer.from(JSON.stringify(list, null, 2), "utf8");
    await saveFileToSlug(slug, "chat.txt", buffer);
    return { list, index: list.length - 1 };
  } catch (err) {
    logError("appendUser error:", err);
    return null;
  }
}

// Update the last appended user's AI field (or a specific index if provided)
export async function updateLastAI(slug, aiReply, index = null) {
  try {
    if (!slug || typeof aiReply !== "string" || !aiReply.trim()) return null;
    const prev = await loadChat(slug);
    const list = Array.isArray(prev) ? prev : [];

    const idx = typeof index === "number" && index >= 0 && index < list.length ? index : list.length - 1;
    if (idx < 0) return null;

    list[idx].AI = aiReply.trim();

    const buffer = Buffer.from(JSON.stringify(list, null, 2), "utf8");
    await saveFileToSlug(slug, "chat.txt", buffer);
    return list;
  } catch (err) {
    logError("updateLastAI error:", err);
    return null;
  }
}

// ------------------- LIMIT -------------------
export async function loadLimit(slug) {
  try {
    const buf = await downloadFileFromSlug(slug, "limit.txt");
    if (!buf) return null;

    const text = buf.toString("utf8").trim();
    if (!text) return null;

    try {
      return JSON.parse(text);
    } catch (e) {
      logError("loadLimit parse error:", e);
      return null;
    }

  } catch (err) {
    logError("loadLimit error:", err);
    return null;
  }
}

export async function saveLimit(slug, obj) {
  try {
    if (!obj || typeof obj !== "object") {
      throw new Error("Invalid limit object");
    }

    const buffer = Buffer.from(JSON.stringify(obj, null, 2), "utf8");
    await saveFileToSlug(slug, "limit.txt", buffer);
    return true;

  } catch (err) {
    logError("saveLimit error:", err);
    throw err;
  }
}
