import fs from "fs";
import fetch from "node-fetch";
import { callGemini } from "../services/gemini.js";
import { saveFileToSlug } from "../services/supabaseClient.js";
import { generateFilename } from "../utils/fileNaming.js";

// memory folder
const PPT_DIR = "./memory/ppt";
fs.mkdirSync(PPT_DIR, { recursive: true });

export async function createPPT(userPrompt, slug) {
  let content = "";
  let n_slides = 5;
  let theme = "swift";
  let language = "English";

  try {
    // 1️⃣ Ask Gemini for slide content, slides, theme
    const geminiResponse = await callGemini(
      "Create a professional PPT structure. Provide title, bullet points, number of slides, theme. JSON format.",
      "",
      userPrompt
    );

    // Try parsing Gemini output as JSON
    try {
      const parsed = JSON.parse(geminiResponse);
      content = parsed.content || userPrompt;
      n_slides = parsed.n_slides || n_slides;
      theme = parsed.theme || theme;
      language = parsed.language || language;
    } catch {
      // Fallback: use userPrompt as content, defaults for others
      content = geminiResponse || userPrompt;
    }

    // If content is empty, send to microcontroller
    if (!content || content.trim() === "") {
      // sendToMicrocontroller is a placeholder, hook your serial/ws code here
      console.log("Microcontroller message: Please tell me prompt, slides, theme for the ppt generation");
      return { error: "Prompt missing. Microcontroller notified." };
    }

    // 2️⃣ Call Presenton API
    const data = {
      content,
      n_slides,
      language,
      template: theme,
      export_as: "pptx"
    };

    const response = await fetch("https://api.presenton.ai/api/v1/ppt/presentation/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.PRESENTON_API_KEY}`
      },
      body: JSON.stringify(data)
    });

    if (!response.ok) {
      throw new Error(`Presenton API error: ${response.status}`);
    }

    // Parse response JSON to get path, presentation_id, credits_consumed
    const result = await response.json();
    console.log("Presenton API response:", { presentation_id: result.presentation_id, credits_consumed: result.credits_consumed });

    if (!result.path) {
      throw new Error("No path returned from Presenton API");
    }

    // 🔥 DOWNLOAD PPT DIRECTLY FROM URL
    const downloadRes = await fetch(result.path);
    if (!downloadRes.ok) {
      throw new Error(`Failed to download PPT: ${downloadRes.status}`);
    }

    const buffer = await downloadRes.buffer();
    console.log(`✅ Downloaded PPT: ${buffer.length} bytes`);

    // 3️⃣ SAVE TO STORAGE (Supabase/Google Drive) - NO LOCAL TEMP FILE
    const filename = generateFilename(userPrompt, "ppt", "pptx");
    await saveFileToSlug(slug, filename, buffer);
    console.log(`✅ PPT saved to storage: ${filename}`);

    return { ppt: filename, presentation_id: result.presentation_id, credits_consumed: result.credits_consumed, download_url: result.path };

  } catch (err) {
    console.error("PPT generation error:", err);
    return { error: err.message };
  }
}
