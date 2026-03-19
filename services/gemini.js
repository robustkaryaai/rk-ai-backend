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
export async function listGeminiModels(customApiKey = null) {
  try {
    const currentGenAI = customApiKey ? new GoogleGenAI({ apiKey: customApiKey }) : genAI;
    const models = await currentGenAI.listModels();
    // Filter for generative models only
    return models.filter(m => m.supportedGenerationMethods.includes('generateContent'))
                 .map(m => ({ name: m.name.replace('models/', ''), displayName: m.displayName }));
  } catch (err) {
    logError("❌ Failed to list Gemini models:", err.message);
    // Fallback models
    return [
      { name: "gemini-1.5-flash", displayName: "Gemini 1.5 Flash (Default)" },
      { name: "gemini-1.5-pro", displayName: "Gemini 1.5 Pro" },
      { name: "gemini-2.0-flash", displayName: "Gemini 2.0 Flash (Fastest)" }
    ];
  }
}

export async function callGemini(systemPrompt, chatHistory = [], userPrompt = "", retries = 2, customApiKey = null, customModel = null) {
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

    // Use custom API key and model if provided, otherwise fallback to system default
    const currentGenAI = customApiKey ? new GoogleGenAI({ apiKey: customApiKey }) : genAI;
    const modelToUse = customModel || "gemini-1.5-flash"; // Default to 1.5-flash for speed

    const response = await currentGenAI.models.generateContent({
      model: modelToUse,
      contents: finalPrompt
    });
    console.log(`💬 Gemini Response (${modelToUse}):`, response.text?.trim().substring(0, 100) + "...");

    return response.text ?? "";

  } catch (err) {
    const msg = err?.message || "";
    
    // If using custom API key, don't retry with system keys as it might violate user privacy/choice
    if (customApiKey) {
      logError("❌ Gemini custom key failure:", msg);
      return `Custom AI Error: ${msg.includes("401") ? "Invalid API Key" : msg}`;
    }

    // ✅ Auto switch on 503 or suspension for system keys
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
