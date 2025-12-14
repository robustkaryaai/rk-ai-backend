import fs from "fs"; 
import { saveFileToSlug } from "../services/supabaseClient.js";
import { generateFilename } from "../utils/fileNaming.js";

// --- Configuration ---
const VEO_BASE_URL = "https://veo3api.com";
// Ensure this is properly defined outside the function to fail fast, as we discussed
const VEO_API_KEY = process.env.VEO_API_KEY; 

// Define the polling status for clarity
const STATUS_COMPLETED = "COMPLETED";

// Check if the API Key is available (Good practice)
if (!VEO_API_KEY) {
    throw new Error("VEO_API_KEY environment variable is not set. Please set it to your Veo API key.");
}


/**
 * Generates a video using the external Veo API, polls for completion,
 * downloads the video, and saves it to a specified storage slug.
 * * **UPDATED SIGNATURE** to accept tier and storageLimitMB
 *
 * @param {string} prompt - The text prompt for video generation.
 * @param {string} slug - The identifier for the storage location (e.g., Supabase bucket path).
 * @param {string} tier - The user's service tier (e.g., 'free', 'pro').
 * @param {number} storageLimitMB - The user's current storage limit in megabytes.
 * @returns {Promise<{video: string}>} - An object containing the saved filename.
 */
export async function generateVideo(prompt, slug, tier, storageLimitMB) {
  // If you don't use tier or storageLimitMB yet, they are simply accepted and ignored.
  // You might add logic here later, e.g.:
  // if (tier === 'free') { 
  //   // Use a faster/lower-res model or check storage limits
  // }
  
  // 1. **Request Video Generation**
  // ... (REST OF THE FUNCTION BODY REMAINS THE SAME)
  // ---------------------------------
  console.log(`Sending video generation request for prompt: "${prompt}"`);

  const generateResponse = await fetch(`${VEO_BASE_URL}/generate`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${VEO_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      prompt: prompt,
      model: 'veo3-fast',
      watermark: 'RK AI'
    })
  });

  if (!generateResponse.ok) {
    const errorBody = await generateResponse.text();
    throw new Error(`Veo API Generation Failed: ${generateResponse.status} - ${errorBody}`);
  }

  const generateData = await generateResponse.json();
  const taskId = generateData.data.task_id;
  console.log(`✅ Generation request accepted. Task ID: ${taskId}`);

  // 2. **Poll for Completion**
  // --------------------------
  let status = null;
  let videoUrl = null;

  while (status !== STATUS_COMPLETED) {
    console.log(`⏳ Polling status for Task ID ${taskId}...`);
    await new Promise((resolve) => setTimeout(resolve, 10000));

    const feedResponse = await fetch(`${VEO_BASE_URL}/feed?task_id=${taskId}`);

    if (!feedResponse.ok) {
        const errorBody = await feedResponse.text();
        console.error(`Veo API Feed Status Failed: ${feedResponse.status} - ${errorBody}`);
        throw new Error(`Veo API Feed Status Failed for task ${taskId}.`);
    }

    const feedData = await feedResponse.json();
    status = feedData.data.status;

    if (status === STATUS_COMPLETED) {
        console.log("🎉 Video generation completed!");
        if (feedData.data.response && feedData.data.response.length > 0) {
            videoUrl = feedData.data.response[0];
            console.log(`Video URL: ${videoUrl}`);
        } else {
            throw new Error(`Task ${taskId} completed but no video URL found in response.`);
        }
    } else if (status === 'FAILED') {
        throw new Error(`Video generation task ${taskId} failed on the server.`);
    } else {
        console.log(`Current status: ${status}. Continuing to poll...`);
    }
  }

  // 3. **Download Video**
  // ---------------------
  if (!videoUrl) {
    throw new Error("Could not retrieve video URL after completion.");
  }

  console.log("⬇️ Starting video download...");
  const downloadResponse = await fetch(videoUrl);

  if (!downloadResponse.ok) {
    throw new Error(`Failed to download video from ${videoUrl}: ${downloadResponse.status}`);
  }

  const buffer = await downloadResponse.arrayBuffer();
  const videoBuffer = Buffer.from(buffer);

  // 4. **Save File to Storage (Supabase/Google Cloud, etc.)**
  // ----------------------------------------------------------
  const filename = generateFilename(prompt, "video", "mp4");
  console.log(`Saving video file: ${filename}`);

  await saveFileToSlug(slug, filename, videoBuffer);
  console.log(`✅ Video successfully saved to storage under slug: ${slug}`);

  return { video: filename };
}
