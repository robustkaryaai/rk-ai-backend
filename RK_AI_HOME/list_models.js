import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

async function listModels() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("❌ GEMINI_API_KEY not found in .env");
    return;
  }

  const genAI = new GoogleGenAI(apiKey);
  
  try {
    const models = await genAI.listModels();
    console.log("\n🚀 AVAILABLE GEMINI MODELS:");
    console.log("----------------------------");
    models.forEach(m => {
      if (m.supportedGenerationMethods.includes('generateContent')) {
        console.log(`- ${m.name.replace('models/', '')} (${m.displayName})`);
      }
    });
    console.log("----------------------------\n");
  } catch (error) {
    console.error("❌ Failed to fetch models:", error.message);
  }
}

listModels();
