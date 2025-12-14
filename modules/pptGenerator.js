import fs from "fs";
import fetch from "node-fetch";
import { callGemini } from "../services/gemini.js";
import { saveFileToSlug } from "../services/supabaseClient.js";
import { generateFilename } from "../utils/fileNaming.js";

// --- CONFIGURATION ---
// BASE URL provided by the user
const POWERPOINT_ENGINE_API_BASE = "https://api.powerpointengine.io";

// Assuming the primary generation endpoint based on industry standard practices
// *** YOU MAY NEED TO ADJUST THIS ENDPOINT ***
const POWERPOINT_ENGINE_GENERATE_ENDPOINT = `${POWERPOINT_ENGINE_API_BASE}/v1/generate/presentation`;

// Directory for local memory (if needed, but we'll try to keep it serverless)
const PPT_DIR = "./memory/ppt";
fs.mkdirSync(PPT_DIR, { recursive: true });

export async function createPPT(userPrompt, slug) {
  let content = "";
  let n_slides = 5;
  let theme = "swift"; // Renamed to template/theme, depends on API
  let language = "English";

  // *** NOTE: The original code used process.env.PRESENTON_API_KEY. ***
  // We assume the new key is available as process.env.POWERPOINT_ENGINE_API_KEY
  const apiKey = process.env.POWERPOINT_ENGINE_API_KEY;

  if (!apiKey) {
    console.error("API Key Missing: Please set POWERPOINT_ENGINE_API_KEY environment variable.");
    return { error: "Configuration Error: API Key missing." };
  }

  try {
    // 1️⃣ Ask Gemini for slide content, slides, theme
    // Keep this part the same as it relies on your internal callGemini function
    const geminiResponse = await callGemini(
      // Improved prompt for structured content to feed the new API
      "Create a professional PPT structure. Provide the full slide content as an array of slide objects, where each object has a 'title' and 'bullets' array. Also, specify the total number of slides (n_slides) and a suggested presentation template name (theme). JSON format.",
      "",
      userPrompt
    );

    // Try parsing Gemini output as JSON
    // We are expecting a more complex JSON structure for the new API
    let parsedContent;
    try {
      parsedContent = JSON.parse(geminiResponse);
      content = parsedContent.content || userPrompt;
      n_slides = parsedContent.n_slides || n_slides;
      theme = parsedContent.theme || theme;
      language = parsedContent.language || language;
      // *** Crucially, we assume the new API expects the full slide structure from Gemini ***
      // We will send the parsedContent object itself as the body (after cleanup/restructuring if needed)
    } catch {
      // Fallback: use userPrompt as content, defaults for others
      content = geminiResponse || userPrompt;
      console.log("Warning: Gemini response not valid JSON. Using raw prompt as content.");
    }

    // Basic content validation
    if (!content || content.trim() === "") {
      console.log("Microcontroller message: Please tell me prompt, slides, theme for the ppt generation");
      return { error: "Prompt missing. Microcontroller notified." };
    }

    // 2️⃣ Call PowerPoint Engine API
    // We are restructuring the payload for the new, assumed API format.
    const apiPayload = {
      // Assuming the API takes the structured output directly, or needs a simple prompt
      // If the API is simple, use: content: content
      // If the API is advanced (preferred), use:
      content_structure: parsedContent,
      prompt: userPrompt, // Include original prompt for context
      num_slides: n_slides,
      design_template: theme, // Assuming 'template' is the key
      export_language: language,
      export_format: "pptx"
    };

    console.log("Calling PowerPoint Engine API...");

    const response = await fetch(POWERPOINT_ENGINE_GENERATE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // *** IMPORTANT: Swapping the API Key and Header ***
        "Authorization": `Bearer ${apiKey}`,
        // Some APIs use an 'X-API-Key' header instead of Authorization. Check docs.
        // "X-API-Key": apiKey
      },
      body: JSON.stringify(apiPayload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`PowerPoint Engine API error: ${response.status} - ${errorText}`);
    }

    // Parse response JSON to get path/download_url
    const result = await response.json();
    console.log("PowerPoint Engine API response:", result);

    // *** IMPORTANT: Swapping the result key from 'path' to 'download_url' ***
    // Most modern APIs return a key like 'download_url' or 'file_url'
    const downloadUrl = result.download_url || result.file_url || result.path;

    if (!downloadUrl) {
      throw new Error("No download URL returned from PowerPoint Engine API");
    }

    // 🔥 DOWNLOAD PPT DIRECTLY FROM URL
    const downloadRes = await fetch(downloadUrl);
    if (!downloadRes.ok) {
      throw new Error(`Failed to download PPT from ${downloadUrl}: ${downloadRes.status}`);
    }

    const buffer = await downloadRes.buffer();
    console.log(`✅ Downloaded PPT: ${buffer.length} bytes`);

    // 3️⃣ SAVE TO STORAGE (Supabase/Google Drive) - NO LOCAL TEMP FILE
    const filename = generateFilename(userPrompt, "ppt", "pptx");
    await saveFileToSlug(slug, filename, buffer);
    console.log(`✅ PPT saved to storage: ${filename}`);

    // Return the successful result
    return {
      ppt: filename,
      download_url: downloadUrl,
      // Pass other fields returned by the API if they exist (e.g., presentation_id, credits_consumed)
      ...result 
    };

  } catch (err) {
    console.error("PPT generation error:", err);
    return { error: err.message };
  }
}
