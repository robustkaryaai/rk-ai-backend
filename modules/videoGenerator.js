import fs from "fs";
import { saveFileToSlug } from "../services/supabaseClient.js";
import { generateFilename } from "../utils/fileNaming.js";

const HF_TOKEN = process.env.HF_TOKEN;
if (!HF_TOKEN) {
  throw new Error("HF_TOKEN environment variable is not set.");
}

export async function generateVideo(prompt, slug, tier, storageLimitMB) {
  const endpoint = "https://router.huggingface.co/models/Lightricks/LTX-Video";

  const payload = {
    inputs: {
      prompt,
      num_frames: 16,
      fps: 8
    }
  };

  let attempts = 0;
  let lastErr = null;
  while (attempts < 6) {
    attempts += 1;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HF_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (res.status === 503 || res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") || 0);
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(5000 * attempts, 20000);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    if (!res.ok) {
      const t = await res.text();
      lastErr = new Error(`HF LTX-Video failed: ${res.status} - ${t}`);
      break;
    }

    const ct = res.headers.get("content-type") || "";
    try {
      if (ct.includes("application/json")) {
        const j = await res.json();
        const videoUrl = j.videoUrl || j.video_url || j.url;
        const base64 = j.video || j.data;

        if (videoUrl) {
          const dl = await fetch(videoUrl);
          if (!dl.ok) throw new Error(`Download failed: ${dl.status}`);
          const buf = Buffer.from(await dl.arrayBuffer());
          const filename = generateFilename(prompt, "video", "mp4");
          await saveFileToSlug(slug, filename, buf);
          return { video: filename };
        }

        if (base64) {
          const raw = String(base64).includes(",") ? String(base64).split(",").pop() : String(base64);
          const buf = Buffer.from(raw, "base64");
          const filename = generateFilename(prompt, "video", "mp4");
          await saveFileToSlug(slug, filename, buf);
          return { video: filename };
        }

        lastErr = new Error("HF LTX-Video returned JSON without video content.");
        break;
      } else {
        const buf = Buffer.from(await res.arrayBuffer());
        const filename = generateFilename(prompt, "video", "mp4");
        await saveFileToSlug(slug, filename, buf);
        return { video: filename };
      }
    } catch (e) {
      lastErr = e;
      break;
    }
  }

  if (lastErr) throw lastErr;
  throw new Error("HF LTX-Video request did not complete.");
}
