import fs from "fs"; 
import { saveFileToSlug } from "../services/supabaseClient.js";
import { generateFilename } from "../utils/fileNaming.js";

// --- Configuration ---
const DEPIN_BASE_URL = "https://depin.gamercoin.com";
const DEPIN_API_KEY = process.env.DEPIN_API_KEY; 

if (!DEPIN_API_KEY) {
    throw new Error("DEPIN_API_KEY environment variable is not set. Please set it to your DePIN API key.");
}

/**
 * Generates an image using the external DePIN API (GamerCoin), 
 * downloads the result, and saves it to a specified storage slug.
 * * **UPDATED SIGNATURE** to accept tier and storageLimitMB
 *
 * @param {string} prompt - The text prompt for image generation.
 * @param {string} slug - The identifier for the storage location (e.g., Supabase bucket path).
 * @param {string} tier - The user's service tier (e.g., 'free', 'pro').
 * @param {number} storageLimitMB - The user's current storage limit in megabytes.
 * @returns {Promise<{image: string}>} - An object containing the saved filename.
 */
export async function generateImage(prompt, slug, tier, storageLimitMB) {
  // 1. **Request Image Generation**
  // ---------------------------------
  console.log(`Sending image generation request for prompt: "${prompt}"`);

  // Optional: You could use the 'tier' or 'storageLimitMB' here to adjust payload
  // e.g., using a lower resolution for the 'free' tier.
  const payload = {
    model_id: 20, // Example model ID
    prompt: prompt,
    image_count: 1, 
    style_id: 11 // Example style ID
  };

  const generateResponse = await fetch(`${DEPIN_BASE_URL}/v1/api/image/generate`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${DEPIN_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!generateResponse.ok) {
    const errorBody = await generateResponse.text();
    throw new Error(`DePIN API Image Generation Failed: ${generateResponse.status} - ${errorBody}`);
  }

  const generateData = await generateResponse.json();
  console.log("Image generation response received.");

  // 2. **Process Response and Get Image URL**
  // ------------------------------------------
  const imageUrls = generateData?.response?.result?.images;
  
  if (!imageUrls || imageUrls.length === 0) {
      throw new Error(`DePIN API did not return any image URLs. Full response: ${JSON.stringify(generateData)}`);
  }

  const imageUrl = imageUrls[0].url; 
  console.log(`Image URL received: ${imageUrl}`);

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
  const filename = generateFilename(prompt, "image", "png");
  console.log(`Saving image file: ${filename}`);

  await saveFileToSlug(slug, filename, imageBuffer);
  console.log(`✅ Image successfully saved to storage under slug: ${slug}`);

  return { image: filename };
}
