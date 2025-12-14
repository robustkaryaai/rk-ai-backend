import fs from "fs"; 
import { saveFileToSlug } from "../services/supabaseClient.js";
import { generateFilename } from "../utils/fileNaming.js";

// --- Configuration ---
const DEAPI_BASE_URL = "https://api.deapi.ai";
// Use DEAPI_API_KEY environment variable for the secret token
const DEAPI_API_KEY = process.env.DEAPI_API_KEY; 

if (!DEAPI_API_KEY) {
    throw new Error("DEAPI_API_KEY environment variable is not set. Please set it to your DeAPI secret token.");
}

/**
 * Polls the DeAPI status endpoint until the job is complete or times out.
 * * NOTE: The status URL and response structure for the final result are inferred 
 * based on common API design patterns. They might need adjustment based on the 
 * actual DeAPI documentation for the job status endpoint.
 */
async function pollJobStatus(requestId, apiKey) {
    // *** ASSUMED ENDPOINT ***
    const statusUrl = `${DEAPI_BASE_URL}/api/v1/client/job/${requestId}`; 
    const maxRetries = 30; // Max polling attempts (30 seconds total)
    const delayMs = 1000;

    console.log(`Starting poll for request ID: ${requestId}`);

    for (let i = 0; i < maxRetries; i++) {
        await new Promise(resolve => setTimeout(resolve, delayMs));

        const response = await fetch(statusUrl, {
            method: 'GET',
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Accept": "application/json",
            }
        });

        if (!response.ok) {
            console.error(`Status check failed with ${response.status}. Retrying...`);
            continue; 
        }

        const data = await response.json();
        // Assuming the status is nested or at the top level, and "completed" means success
        const status = data.data?.status || data.status; 
        
        if (status === "completed" || status === "success") {
            // *** ASSUMED RESULT KEY ***
            // Assuming the result contains the final image URL, potentially nested
            const resultUrl = data.data?.image_url || data.data?.result_url || data.data?.url || data.result?.url;
            
            if (resultUrl) {
                return resultUrl;
            } else {
                throw new Error(`Job completed but no image URL found in response: ${JSON.stringify(data)}`);
            }
        }
        
        if (status === "failed" || status === "error") {
            throw new Error(`Image generation failed: ${JSON.stringify(data)}`);
        }

        console.log(`Job ${requestId} status: ${status}. Polling attempt ${i + 1}/${maxRetries}...`);
    }
    
    throw new Error(`Image generation timed out after ${maxRetries} seconds.`);
}

/**
 * Generates an image using the external DeAPI platform, 
 * processes the result asynchronously, downloads the image, 
 * and saves it to a specified storage slug.
 *
 * @param {string} prompt - The text prompt for image generation.
 * @param {string} slug - The identifier for the storage location.
 * @param {string} tier - The user's service tier.
 * @param {number} storageLimitMB - The user's current storage limit in megabytes.
 * @returns {Promise<{image: string}>} - An object containing the saved filename.
 */
export async function generateImage(prompt, slug, tier, storageLimitMB) {
  // 1. **Submit Image Generation Request**
  // -------------------------------------
  console.log(`Sending DeAPI image generation request for prompt: "${prompt}"`);

  // Default parameters based on your example
  const payload = {
    "prompt": prompt,
    "negative_prompt": "blur, darkness, noise, bad quality, artifacts",
    "model": "Flux1schnell", 
    "width": 512,
    "height": 512,
    "guidance": 7.5,
    // API requires steps <= 10
    "steps": 10,
    "seed": 42
  };

  const generateResponse = await fetch(`${DEAPI_BASE_URL}/api/v1/client/txt2img`, {
    method: 'POST',
    headers: {
      "Authorization": `Bearer ${DEAPI_API_KEY}`,
      "Accept": "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!generateResponse.ok) {
    // Attempt a single automatic correction on 4xx validation errors
    if (generateResponse.status === 422) {
      let errJson;
      try { errJson = await generateResponse.json(); } catch { errJson = null; }

      const corrected = { ...payload };
      // Ensure steps are within allowed range
      corrected.steps = Math.min(Number(corrected.steps || 10), 10);
      // Ensure no loras
      delete corrected.loras;

      const retry = await fetch(`${DEAPI_BASE_URL}/api/v1/client/txt2img`, {
        method: 'POST',
        headers: {
          "Authorization": `Bearer ${DEAPI_API_KEY}`,
          "Accept": "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(corrected)
      });

      if (!retry.ok) {
        const retryBody = await retry.text();
        throw new Error(`DeAPI Submission Failed (retry): ${retry.status} - ${retryBody}`);
      }

      const retryData = await retry.json();
      const requestId = retryData.data?.request_id;
      if (!requestId) {
        throw new Error(`DeAPI did not return a request_id (retry). Full response: ${JSON.stringify(retryData)}`);
      }

      // Continue with polling using retry requestId
      const imageUrl = await pollJobStatus(requestId, DEAPI_API_KEY);
      const downloadResponse = await fetch(imageUrl);
      if (!downloadResponse.ok) {
        throw new Error(`Failed to download image from ${imageUrl}: ${downloadResponse.status}`);
      }
      const buf = await downloadResponse.arrayBuffer();
      const imageBuffer = Buffer.from(buf);
      const filename = generateFilename(prompt, "image", "jpeg");
      await saveFileToSlug(slug, filename, imageBuffer);
      return { image: filename };
    }

    const errorBody = await generateResponse.text();
    throw new Error(`DeAPI Submission Failed: ${generateResponse.status} - ${errorBody}`);
  }

  const generateData = await generateResponse.json();
  const requestId = generateData.data?.request_id;
  
  if (!requestId) {
      throw new Error(`DeAPI did not return a request_id. Full response: ${JSON.stringify(generateData)}`);
  }

  // 2. **Poll for Result**
  // ----------------------
  const imageUrl = await pollJobStatus(requestId, DEAPI_API_KEY);
  console.log(`Image URL successfully retrieved: ${imageUrl}`);

  // 3. **Download Image**
  // ---------------------
  console.log("⬇️ Starting image download...");
  const downloadResponse = await fetch(imageUrl);

  if (!downloadResponse.ok) {
    throw new Error(`Failed to download image from ${imageUrl}: ${downloadResponse.status}`);
  }

  const buffer = await downloadResponse.arrayBuffer();
  const imageBuffer = Buffer.from(buffer);

  // 4. **Save File to Storage**
  // ----------------------------------------------------------
  const filename = generateFilename(prompt, "image", "jpeg"); 
  console.log(`Saving image file: ${filename}`);

  await saveFileToSlug(slug, filename, imageBuffer);
  console.log(`✅ Image successfully saved to storage under slug: ${slug}`);

  return { image: filename };
}
