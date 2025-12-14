import fs from "fs"; 
import { saveFileToSlug } from "../services/supabaseClient.js";
import { generateFilename } from "../utils/fileNaming.js";

// --- Configuration ---
const DEPIN_BASE_URL = "https://depin.gamercoin.com";
// **IMPORTANT**: Load the API key securely from environment variables
const DEPIN_API_KEY = process.env.DEPIN_API_KEY; 

// Check if the API Key is available immediately (Good practice)
if (!DEPIN_API_KEY) {
    throw new Error("DEPIN_API_KEY environment variable is not set. Please set it to your DePIN API key.");
}

/**
 * Generates an image using the external DePIN API (GamerCoin), 
 * downloads the result, and saves it to a specified storage slug.
 *
 * @param {string} prompt - The text prompt for image generation.
 * @param {string} slug - The identifier for the storage location (e.g., Supabase bucket path).
 * @returns {Promise<{image: string}>} - An object containing the saved filename.
 */
export async function generateImage(prompt, slug) {
  // 1. **Request Image Generation**
  // ---------------------------------
  console.log(`Sending image generation request for prompt: "${prompt}"`);

  // Define API payload based on DePIN API documentation
  const payload = {
    // You should use the highest available model ID for best results, e.g., 20.
    // Assuming model_id is used to specify the model (e.g., SDXL/Dall-E style)
    model_id: 20, 
    prompt: prompt,
    // Add other optional parameters as needed, e.g., negative_prompt, width, height
    image_count: 1, 
    style_id: 11 // Example style ID (e.g., 11 for Photorealistic)
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
  // The DePIN documentation shows a response structure where the image URLs 
  // are directly available under 'response.result.images'.
  const imageUrls = generateData?.response?.result?.images;
  
  if (!imageUrls || imageUrls.length === 0) {
      throw new Error(`DePIN API did not return any image URLs. Full response: ${JSON.stringify(generateData)}`);
  }

  const imageUrl = imageUrls[0].url; // Assuming we only need the first image
  console.log(`Image URL received: ${imageUrl}`);

  // 3. **Download Image**
  // ---------------------
  console.log("⬇️ Starting image download...");
  const downloadResponse = await fetch(imageUrl);

  if (!downloadResponse.ok) {
    throw new Error(`Failed to download image from ${imageUrl}: ${downloadResponse.status}`);
  }

  // Convert the response stream to an ArrayBuffer
  const buffer = await downloadResponse.arrayBuffer();
  // Convert ArrayBuffer to Node.js Buffer for storage (Supabase)
  const imageBuffer = Buffer.from(buffer);

  // 4. **Save File to Storage**
  // ----------------------------------------------------------
  const filename = generateFilename(prompt, "image", "png"); // PNG is a safe default, check if API output is JPG
  console.log(`Saving image file: ${filename}`);

  // The saveFileToSlug function handles the upload logic
  await saveFileToSlug(slug, filename, imageBuffer);
  console.log(`✅ Image successfully saved to storage under slug: ${slug}`);

  // Return the filename in the expected format
  return { image: filename };
}
