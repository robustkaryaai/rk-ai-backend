// services/gemini.js
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import { logError, logInfo } from "../utils/logger.js";

dotenv.config();

// ✅ Load multiple API keys
const API_KEYS = [
  process.env.GEMINI_API_KEY,        // Primary
  process.env.GEMINI_API_KEY_BACKUP  // Backup
].filter(Boolean);

let currentKeyIndex = 0;
let genAI = new GoogleGenAI({ apiKey: API_KEYS[currentKeyIndex] });

// ✅ Auto Switch Key
function switchApiKey() {
  currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
  genAI = new GoogleGenAI({ apiKey: API_KEYS[currentKeyIndex] });
  logInfo(`🔁 Switched to Gemini API Key #${currentKeyIndex + 1}`);
}

// ✅ Ultra-Safe Gemini Caller
export async function callGemini(systemPrompt, chatHistory = [], userPrompt = "", retries = 2) {
  try {
    const historyText = Array.isArray(chatHistory)
      ? chatHistory.join("\n")
      : chatHistory || "";

    const finalPrompt = `
${systemPrompt}

${historyText ? `Previous Context:\n${historyText}` : ""}

User Says:
${userPrompt}
`;

    const response = await genAI.models.generateContent({
      model: "gemma-3-12b-it",
      contents: finalPrompt
    });
    console.log("💬 Gemini Response:", response.text?.trim().substring(0, 100) + "...");

    return response.text ?? "";

  } catch (err) {
    const msg = err?.message || "";

    // ✅ Auto switch on 503 or suspension
    if (
      msg.includes("503") ||
      msg.includes("overloaded") ||
      msg.includes("suspended")
    ) {
      logError("⚠ Gemini failed. Switching API Key...");
      switchApiKey();

      if (retries > 0) {
        return callGemini(systemPrompt, chatHistory, userPrompt, retries - 1);
      }
    }

    logError("❌ Gemini final failure:", msg);
    return "Servers are busy right now. Please try again in a few moments.";
  }
}
