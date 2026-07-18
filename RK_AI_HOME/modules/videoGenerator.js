import fs from "fs";
import { saveFileToSlug, downloadFileFromSlug, supabase } from "../services/supabaseClient.js";
import { generateFilename } from "../utils/fileNaming.js";
import { generateImage } from "./imageGenerator.js";
import { HfInference } from "@huggingface/inference";

const HF_TOKEN = process.env.HF_TOKEN;
if (!HF_TOKEN) {
  throw new Error("HF_TOKEN environment variable is not set.");
}
const PIXWITH_API_KEY = process.env.PIXWITH_API_KEY;
const LTX_API_KEY = process.env.LTX_API_KEY;
const VIDEO_PROVIDER = process.env.VIDEO_PROVIDER || "ltx";
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "user-files";

export async function generateVideo(prompt, slug, tier, storageLimitMB) {
  if (VIDEO_PROVIDER === "ltx") {
    if (!LTX_API_KEY) {
      throw new Error("LTX_API_KEY environment variable is not set.");
    }

    const payload = {
      prompt,
      model: "ltx-2-3-pro",
      duration: 8,
      resolution: "1920x1080"
    };

    const response = await fetch("https://api.ltx.video/v1/text-to-video", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${LTX_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      let errorMsg = `LTX API Error: ${response.status}`;
      try {
        const errorData = await response.json();
        errorMsg += ` - ${JSON.stringify(errorData)}`;
      } catch (e) {
        // Fallback if not JSON
        const text = await response.text();
        errorMsg += ` - ${text}`;
      }

      // Specific error handling based on status codes
      switch (response.status) {
        case 400: throw new Error(`Bad Request: ${errorMsg}`);
        case 401: throw new Error(`Unauthorized: Check your LTX_API_KEY. ${errorMsg}`);
        case 422: throw new Error(`Unprocessable Entity: Validation failed. ${errorMsg}`);
        case 429: throw new Error(`Too Many Requests: Rate limit exceeded. ${errorMsg}`);
        case 500: throw new Error(`Internal Server Error: LTX side issue. ${errorMsg}`);
        case 503: throw new Error(`Service Unavailable: LTX is down. ${errorMsg}`);
        case 504: throw new Error(`Gateway Timeout: LTX took too long. ${errorMsg}`);
        default: throw new Error(errorMsg);
      }
    }

    const buf = Buffer.from(await response.arrayBuffer());
    const filename = generateFilename(prompt, "video", "mp4");
    await saveFileToSlug(slug, filename, buf);
    return { video: filename };
  }

  if (VIDEO_PROVIDER === "pixwith") {
    // Choose text-to-video for Pro/Studio, fallback to image-to-video for others
    const isPro = tier === "pro" || tier === "studio";
    const createPayload = isPro
      ? {
          prompt,
          model_id: "2-9",
          options: {
            prompt_optimization: true,
            aspect_ratio: "16:9",
            resolution: "480p",
            duration: 5
          }
        }
      : (() => {
          // Fallback: image-to-video (should not run due to gating, kept for completeness)
          // Generate base image and use its public URL
          return (async () => {
            const img = await generateImage(prompt, slug, tier, storageLimitMB);
            const imageFilename = img?.image;
            if (!imageFilename) throw new Error("Image generation did not return a filename");
            let imageUrl = null;
            const signed = await supabase.storage.from(SUPABASE_BUCKET).createSignedUrl(`${slug}/${imageFilename}`, 3600);
            if (signed?.data?.signedUrl) {
              imageUrl = signed.data.signedUrl;
            } else {
              const pub = await supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(`${slug}/${imageFilename}`);
              imageUrl = pub?.data?.publicUrl || null;
            }
            if (!imageUrl) throw new Error("Unable to create public URL for generated image");
            return {
              prompt,
              image_urls: [imageUrl],
              model_id: "2-10",
              options: {
                prompt_optimization: true,
                aspect_ratio: "16:9",
                resolution: "480p",
                duration: 5
              }
            };
          })();
        })();

    const payload = createPayload instanceof Promise ? await createPayload : createPayload;

    const createRes = await fetch("https://api.pixwith.ai/api/task/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Api-Key": String(PIXWITH_API_KEY || "")
      },
      body: JSON.stringify(payload)
    });
    if (!createRes.ok) {
      const t = await createRes.text();
      throw new Error(`Pixwith create failed: ${createRes.status} - ${t}`);
    }
    const createJson = await createRes.json();
    const taskId = createJson?.data?.task_id;
    if (!taskId) {
      throw new Error("Pixwith did not return task_id");
    }
    let videoUrl = null;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const statusRes = await fetch(`https://api.pixwith.ai/api/task/status?task_id=${encodeURIComponent(taskId)}`, {
        method: "GET",
        headers: { "Api-Key": String(PIXWITH_API_KEY || "") }
      });
      if (!statusRes.ok) {
        continue;
      }
      const statusJson = await statusRes.json();
      const status = statusJson?.data?.status || statusJson?.status;
      if (String(status).toLowerCase() === "success") {
        videoUrl = statusJson?.data?.video_url || statusJson?.video_url || statusJson?.data?.url;
        break;
      }
      if (String(status).toLowerCase() === "failed") {
        throw new Error("Pixwith task failed");
      }
    }
    if (!videoUrl) {
      throw new Error("Pixwith task did not complete");
    }
    const dl = await fetch(videoUrl);
    if (!dl.ok) throw new Error(`Download failed: ${dl.status}`);
    const buf = Buffer.from(await dl.arrayBuffer());
    const filename = generateFilename(prompt, "video", "mp4");
    await saveFileToSlug(slug, filename, buf);
    return { video: filename };
  }
  const hf = new HfInference(HF_TOKEN);

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
      const blobImage = new Blob([imageBuffer], { type: "image/jpeg" });
      const blob = await hf.imageToVideo({
        provider: "auto",
        model: "Lightricks/LTX-Video",
        inputs: blobImage,
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
