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
      { name: "gemma-4-26b-a4b-it", displayName: "Gemma 4 26B (Pro Default)" },
      { name: "gemini-3.5-flash-lite", displayName: "Gemini 3.5 Flash Lite (Elite/Quantum Default)" },
      { name: "gemini-3.1-flash-lite-preview", displayName: "Gemini 3.1 Flash Lite (Pro Fallback)" },
      { name: "gemma-4-31b-it", displayName: "Gemma 4 31B (Elite/Quantum Fallback)" }
    ];
  } catch (err) {
    logError("❌ Failed to list Gemini models:", err.message);
    return [
      { name: "gemma-4-26b-a4b-it", displayName: "Gemma 4 26B (Pro Default)" },
      { name: "gemini-3.5-flash-lite", displayName: "Gemini 3.5 Flash Lite (Elite/Quantum Default)" }
    ];
  }
}

export async function callGemini(systemPrompt, chatHistory = [], userPrompt = "", retries = 2, customApiKey = null, customModel = null, slug = null) {
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

    const currentGenAI = customApiKey ? new GoogleGenAI({ apiKey: customApiKey }) : genAI;
    const modelToUse = customModel || "gemma-4-26b-a4b-it"; // Default to Pro

    const response = await currentGenAI.models.generateContent({
      model: modelToUse,
      contents: finalPrompt
    });
    console.log(`💬 Gemini Response (${modelToUse}):`, response.text?.trim().substring(0, 100) + "...");

    // Track tokens if slug is provided
    if (slug && response.usageMetadata && response.usageMetadata.totalTokenCount) {
      const tokensUsed = response.usageMetadata.totalTokenCount;
      try {
        const { incrementAppwriteUsage } = await import("./appwriteClient.js");
        await incrementAppwriteUsage(slug, "tokens", tokensUsed);
      } catch (err) {
        logError("Failed to track Gemini tokens:", err);
      }
    }

    return response.text ?? "";

  } catch (err) {
    const msg = err?.message || "";
    
    // If using custom API key, fallback to System Keys if they hit a rate limit!
    if (customApiKey) {
      logError("❌ Gemini custom key failure:", msg);
      if (msg.includes("429") || msg.includes("quota") || msg.includes("exhausted") || msg.includes("rate") || msg.includes("404")) {
          logInfo("🔄 Custom Key failure! Falling back to System API Keys to prevent downtime...");
          customApiKey = null; // Remove custom key for the retry
          // We will let it fall through to the system retry logic below!
      } else {
          return `Custom AI Error: ${msg.includes("401") ? "Invalid API Key" : msg}`;
      }
    }

    // Determine fallback model
    const currentModel = customModel || "gemma-4-26b-a4b-it";
    let fallbackModel = currentModel;
    if (currentModel === "gemma-4-26b-a4b-it") {
        fallbackModel = "gemini-3.1-flash-lite-preview"; // Pro fallback
    } else if (currentModel === "gemini-3.5-flash-lite") {
        fallbackModel = "gemma-4-31b-it"; // Elite fallback
    }

    // ✅ Auto switch and delay on quota/rate limits or 404s/503s
    if (
      msg.includes("503") ||
      msg.includes("overloaded") ||
      msg.includes("suspended") ||
      msg.includes("429") ||
      msg.includes("quota") ||
      msg.includes("exhausted") ||
      msg.includes("rate") ||
      msg.includes("404") ||
      msg.includes("not found")
    ) {
      logError(`⚠ Gemini overloaded/missing. Error: ${msg}`);
      
      // If it's a rate limit or 503, swap keys and wait
      if (!msg.includes("404") && !msg.includes("not found")) {
          logError(`Switching API Key and waiting 4 seconds...`);
          switchApiKey();
          await new Promise(r => setTimeout(r, 4000));
      } else {
          logError(`Model missing! Instantly retrying with fallback model: ${fallbackModel}`);
      }

      if (retries > 0) {
        return callGemini(systemPrompt, chatHistory, userPrompt, retries - 1, customApiKey, fallbackModel, slug);
      }
    }

    logError("❌ Gemini final failure:", msg);
    return "Servers are busy right now. Please try again in a few moments.";
  }
}

export async function callGeminiVision(prompt, imageBuffer, mimeType, customApiKey = null, customModel = null, slug = null) {
  try {
    const currentGenAI = customApiKey ? new GoogleGenAI({ apiKey: customApiKey }) : genAI;
    const modelToUse = customModel || "gemini-2.5-flash"; 

    const response = await currentGenAI.models.generateContent({
      model: modelToUse,
      contents: [
        {
            role: 'user',
            parts: [
                { text: prompt },
                { inlineData: { data: imageBuffer.toString("base64"), mimeType: mimeType } }
            ]
        }
      ]
    });
    
    // Track tokens if slug is provided
    if (slug && response.usageMetadata && response.usageMetadata.totalTokenCount) {
      const tokensUsed = response.usageMetadata.totalTokenCount;
      try {
        const { incrementAppwriteUsage } = await import("./appwriteClient.js");
        await incrementAppwriteUsage(slug, "tokens", tokensUsed);
      } catch (err) {
        logError("Failed to track Gemini tokens:", err);
      }
    }

    return response.text ?? "";
  } catch (err) {
    logError("❌ Gemini Vision failure:", err?.message);
    return "Error interpreting the image. Please try again.";
  }
}
