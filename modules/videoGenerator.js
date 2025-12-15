import fs from "fs";
import { saveFileToSlug, downloadFileFromSlug } from "../services/supabaseClient.js";
import { generateFilename } from "../utils/fileNaming.js";
import { generateImage } from "./imageGenerator.js";
import { InferenceClient } from "@huggingface/inference";

const HF_TOKEN = process.env.HF_TOKEN;
if (!HF_TOKEN) {
  throw new Error("HF_TOKEN environment variable is not set.");
}

export async function generateVideo(prompt, slug, tier, storageLimitMB) {
  const client = new InferenceClient(HF_TOKEN);

  // 1) Generate base image via DeAPI
  const img = await generateImage(prompt, slug, tier, storageLimitMB);
  const imageFilename = img?.image;
  if (!imageFilename) {
    throw new Error("Image generation did not return a filename");
  }

  const imageBuffer = await downloadFileFromSlug(slug, imageFilename);
  if (!imageBuffer || imageBuffer.length === 0) {
    throw new Error("Failed to load generated image for video conversion");
  }

  const base64Image = `data:image/jpeg;base64,${imageBuffer.toString("base64")}`;

  // 2) Convert image → video with LTX-Video on HF
  const params = { prompt, num_frames: 16, fps: 8 };

  let attempts = 0;
  let lastErr = null;
  while (attempts < 6) {
    attempts += 1;
    try {
      const blob = await client.imageToVideo({
        provider: "auto",
        model: "Lightricks/LTX-Video",
        inputs: imageBuffer,
        parameters: params
      });

      const ab = await blob.arrayBuffer();
      const buf = Buffer.from(ab);
      const filename = generateFilename(prompt, "video", "mp4");
      await saveFileToSlug(slug, filename, buf);
      return { video: filename };
    } catch (err) {
      const msg = String(err?.message || err);
      if (msg.includes("503") || msg.toLowerCase().includes("rate") || msg.toLowerCase().includes("cold")) {
        const waitMs = Math.min(5000 * attempts, 20000);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      lastErr = err;
      break;
    }
  }

  if (lastErr) throw lastErr;
  throw new Error("HF LTX-Video request did not complete.");
}
