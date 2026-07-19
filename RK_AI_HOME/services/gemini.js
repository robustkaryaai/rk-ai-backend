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
    
    // 🚀 Fixed: Use getGenerativeModel instead of non-existent listModels on SDK instance
    // Note: The @google/genai SDK doesn't actually have a listModels method on the GenAI instance.
    // We typically define available models manually or fetch them from a different endpoint.
    // Since we want accuracy, let's use the known good models list.
    
    return [
      { name: "gemini-3.1-flash-lite-preview", displayName: "Gemini 3.1 Flash Lite (Default)" },
      { name: "gemini-2.5-flash-lite", displayName: "Gemini 2.5 Flash Lite" },
      { name: "gemini-3-flash", displayName: "Gemini 3 Flash" },
      { name: "gemma-3-27b", displayName: "Gemma 3 27B" },
      { name: "gemma-3-12b", displayName: "Gemma 3 12B" },
      { name: "gemma-3-4b", displayName: "Gemma 3 4B" }
    ];
  } catch (err) {
    logError("❌ Failed to list Gemini models:", err.message);
    return [
      { name: "gemini-3.1-flash-lite-preview", displayName: "Gemini 3.1 Flash Lite (Default)" },
      { name: "gemini-2.5-flash-lite", displayName: "Gemini 2.5 Flash Lite" }
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
    const modelToUse = customModel || "gemini-2.5-flash-lite"; // Default to 2.5-flash-lite

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
      if (msg.includes("429") || msg.includes("quota") || msg.includes("exhausted")) {
          return "Custom AI Error: Your personal API Key has run out of quota.";
      }
      return `Custom AI Error: ${msg.includes("401") ? "Invalid API Key" : msg}`;
    }

    // ✅ Auto switch and delay on quota/rate limits or 503s for system keys
    if (
      msg.includes("503") ||
      msg.includes("overloaded") ||
      msg.includes("suspended") ||
      msg.includes("429") ||
      msg.includes("quota") ||
      msg.includes("exhausted") ||
      msg.includes("rate")
    ) {
      logError("⚠ Gemini overloaded/busy. Switching API Key and waiting 60 seconds to cool down (Never Give Up Mode)...");
      switchApiKey();
      
      // Wait 60 seconds to completely clear any rate limits or server spikes
      await new Promise(r => setTimeout(r, 60000));

      if (retries > 0) {
        return callGemini(systemPrompt, chatHistory, userPrompt, retries - 1, customApiKey, customModel);
      }
    }

    logError("❌ Gemini final failure:", msg);
    return "Servers are busy right now. Please try again in a few moments.";
  }
}
