// services/gemini.js
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import { logError, logInfo } from "../utils/logger.js";

dotenv.config();

// ✅ Load multiple API keys
const API_KEYS = [
  process.env.GEMINI_API_KEY_FOR_HOME,
  process.env.GEMINI_API_KEY_BACKUP_FOR_HOME,
  process.env.GEMINI_API_KEY
].filter(Boolean);

let currentKeyIndex = 0;
let genAI = new GoogleGenAI({ apiKey: API_KEYS[currentKeyIndex] || "dummy" });

// ✅ Auto Switch Key
function switchApiKey() {
  if (API_KEYS.length <= 1) return;
  currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
  genAI = new GoogleGenAI({ apiKey: API_KEYS[currentKeyIndex] });
  logInfo(`🔁 Switched to Gemini API Key #${currentKeyIndex + 1} (${API_KEYS[currentKeyIndex].substring(0, 6)}...)`);
}

// ✅ Ultra-Safe Gemini Caller
export async function listGeminiModels(customApiKey = null) {
  return [
    { name: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash (Ultra Fast & Stable)" },
    { name: "gemini-1.5-flash", displayName: "Gemini 1.5 Flash (Reliable Fallback)" },
    { name: "gemma-4-26b-a4b-it", displayName: "Gemma 4 26B (Pro Default)" }
  ];
}

export async function callGemini(systemPrompt, chatHistory = [], userPrompt = "", retries = 5, customApiKey = null, customModel = null, slug = null, useWebSearch = false, returnMetadata = false) {
  const startTime = Date.now();
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
    const modelToUse = customModel || "gemini-2.5-flash"; // Default to rock-solid Gemini Flash

    const config = {};
    if (useWebSearch) {
       config.tools = [{ googleSearch: {} }];
    }

    const response = await currentGenAI.models.generateContent({
      model: modelToUse,
      contents: finalPrompt,
      config: config
    });
    console.log(`💬 Gemini Response (${modelToUse}):`, response.text?.trim().substring(0, 100) + "...");

    const execTime = Date.now() - startTime;
    let tokensUsed = 0;
    let inputTokens = 0;
    let outputTokens = 0;

    // Track tokens if slug is provided
    if (response.usageMetadata) {
      inputTokens = response.usageMetadata.promptTokenCount || 0;
      outputTokens = response.usageMetadata.candidatesTokenCount || 0;
      tokensUsed = response.usageMetadata.totalTokenCount || (inputTokens + outputTokens);
      
      if (slug && tokensUsed > 0) {
        try {
          const { incrementAppwriteUsage } = await import("./appwriteClient.js");
          await incrementAppwriteUsage(slug, "tokens", tokensUsed);
        } catch (err) {
          logError("Failed to track Gemini tokens:", err);
        }
      }
    }

    const textOutput = response.text ?? "";
    
    if (returnMetadata) {
      return {
        text: textOutput,
        metadata: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: tokensUsed,
          execution_time_ms: execTime
        }
      };
    }

    return textOutput;

  } catch (err) {
    const msg = err?.message || String(err);
    logError(`❌ Gemini call attempt failed (${retries} retries left):`, msg);

    // If using custom API key, fallback to System Keys if it hit a rate limit or 500
    if (customApiKey) {
      logInfo("🔄 Custom Key failure! Falling back to System API Keys...");
      customApiKey = null;
    }

    // Determine fallback model on failure
    let fallbackModel = "gemini-1.5-flash";
    if (customModel === "gemini-1.5-flash") {
      fallbackModel = "gemini-2.5-flash";
    }

    // Always rotate key on any transient, rate-limit, 500, or network error
    if (retries > 0) {
      switchApiKey();
      // Brief jitter delay
      await new Promise(r => setTimeout(r, 1000));
      return callGemini(systemPrompt, chatHistory, userPrompt, retries - 1, customApiKey, fallbackModel, slug, useWebSearch, returnMetadata);
    }

    logError("❌ Gemini final failure after all retries:", msg);
    return "I am having trouble connecting to AI servers right now. Please try again in a moment.";
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
    if (slug && response.usageMetadata) {
      const inputTokens = response.usageMetadata.promptTokenCount || 0;
      const outputTokens = response.usageMetadata.candidatesTokenCount || 0;
      const tokensUsed = response.usageMetadata.totalTokenCount || (inputTokens + outputTokens);
      if (tokensUsed > 0) {
        try {
          const { incrementAppwriteUsage } = await import("./appwriteClient.js");
          await incrementAppwriteUsage(slug, "tokens", tokensUsed);
        } catch (err) {
          logError("Failed to track Gemini tokens:", err);
        }
      }
    }

    return response.text ?? "";
  } catch (err) {
    logError("❌ Gemini Vision failure:", err?.message);
    return "Error interpreting the image. Please try again.";
  }
}
