import fs from "fs"; // Kept for consistency, though not strictly needed for network-to-Supabase flow
import { saveFileToSlug } from "../services/supabaseClient.js";
import { generateFilename } from "../utils/fileNaming.js";

// --- Configuration ---
// Note: Replace with your actual Veo API endpoint and API Key management
const VEO_BASE_URL = "https://veo3api.com";
const VEO_API_KEY = process.env.VEO_API_KEY; // **IMPORTANT**: Load this securely from environment variables (e.g., process.env.VEO_API_KEY)

// Define the polling status for clarity
const STATUS_COMPLETED = "COMPLETED";

/**
 * Generates a video using the external Veo API, polls for completion,
 * downloads the video, and saves it to a specified storage slug.
 *
 * @param {string} prompt - The text prompt for video generation.
 * @param {string} slug - The identifier for the storage location (e.g., Supabase bucket path).
 * @returns {Promise<{video: string}>} - An object containing the saved filename.
 */
export async function generateVideo(prompt, slug) {
  // 1. **Request Video Generation**
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
      // Include your desired watermark here
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
    // Wait for 10 seconds before the next poll
    await new Promise((resolve) => setTimeout(resolve, 10000));

    const feedResponse = await fetch(`${VEO_BASE_URL}/feed?task_id=${taskId}`);

    if (!feedResponse.ok) {
        const errorBody = await feedResponse.text();
        console.error(`Veo API Feed Status Failed: ${feedResponse.status} - ${errorBody}`);
        // Optionally break or retry after an error
        throw new Error(`Veo API Feed Status Failed for task ${taskId}.`);
    }

    const feedData = await feedResponse.json();
    status = feedData.data.status;

    if (status === STATUS_COMPLETED) {
        console.log("🎉 Video generation completed!");
        // The URL is typically in the 'response' array
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

  // Convert the response stream to an ArrayBuffer (or Node.js Buffer)
  const buffer = await downloadResponse.arrayBuffer();
  // If running in a Node.js environment, you might convert ArrayBuffer to Buffer
  const videoBuffer = Buffer.from(buffer);

  // 4. **Save File to Storage (Supabase/Google Cloud, etc.)**
  // ----------------------------------------------------------
  const filename = generateFilename(prompt, "video", "mp4");
  console.log(`Saving video file: ${filename}`);

  // The saveFileToSlug function handles the upload logic
  await saveFileToSlug(slug, filename, videoBuffer);
  console.log(`✅ Video successfully saved to storage under slug: ${slug}`);

  return { video: filename };
}

// Example of how to use this (assuming an async context):
/*
(async () => {
    try {
        const result = await generateVideo("An astronaut surfing on a cloud in space", "user-videos-folder");
        console.log("Final Result:", result);
    } catch (error) {
        console.error("An error occurred during video generation/saving:", error.message);
    }
})();
*/import fs from "fs"; // Kept for consistency, though not strictly needed for network-to-Supabase flow
import { saveFileToSlug } from "../services/supabaseClient.js";
import { generateFilename } from "../utils/fileNaming.js";

// --- Configuration ---
// Note: Replace with your actual Veo API endpoint and API Key management
const VEO_BASE_URL = "https://veo3api.com";
const VEO_API_KEY = "YOUR_API_KEY"; // **IMPORTANT**: Load this securely from environment variables (e.g., process.env.VEO_API_KEY)

// Define the polling status for clarity
const STATUS_COMPLETED = "COMPLETED";

/**
 * Generates a video using the external Veo API, polls for completion,
 * downloads the video, and saves it to a specified storage slug.
 *
 * @param {string} prompt - The text prompt for video generation.
 * @param {string} slug - The identifier for the storage location (e.g., Supabase bucket path).
 * @returns {Promise<{video: string}>} - An object containing the saved filename.
 */
export async function generateVideo(prompt, slug) {
  // 1. **Request Video Generation**
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
      // Include your desired watermark here
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
    // Wait for 10 seconds before the next poll
    await new Promise((resolve) => setTimeout(resolve, 10000));

    const feedResponse = await fetch(`${VEO_BASE_URL}/feed?task_id=${taskId}`);

    if (!feedResponse.ok) {
        const errorBody = await feedResponse.text();
        console.error(`Veo API Feed Status Failed: ${feedResponse.status} - ${errorBody}`);
        // Optionally break or retry after an error
        throw new Error(`Veo API Feed Status Failed for task ${taskId}.`);
    }

    const feedData = await feedResponse.json();
    status = feedData.data.status;

    if (status === STATUS_COMPLETED) {
        console.log("🎉 Video generation completed!");
        // The URL is typically in the 'response' array
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

  // Convert the response stream to an ArrayBuffer (or Node.js Buffer)
  const buffer = await downloadResponse.arrayBuffer();
  // If running in a Node.js environment, you might convert ArrayBuffer to Buffer
  const videoBuffer = Buffer.from(buffer);

  // 4. **Save File to Storage (Supabase/Google Cloud, etc.)**
  // ----------------------------------------------------------
  const filename = generateFilename(prompt, "video", "mp4");
  console.log(`Saving video file: ${filename}`);

  // The saveFileToSlug function handles the upload logic
  await saveFileToSlug(slug, filename, videoBuffer);
  console.log(`✅ Video successfully saved to storage under slug: ${slug}`);

  return { video: filename };
}

// Example of how to use this (assuming an async context):
/*
(async () => {
    try {
        const result = await generateVideo("An astronaut surfing on a cloud in space", "user-videos-folder");
        console.log("Final Result:", result);
    } catch (error) {
        console.error("An error occurred during video generation/saving:", error.message);
    }
})();
*/
