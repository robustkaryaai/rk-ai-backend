import { GoogleGenAI } from "@google/genai";
import fs from "fs";
import { saveFileToSlug } from "../services/supabaseClient.js";
import { generateFilename } from "../utils/fileNaming.js";

const ai = new GoogleGenAI({});

export async function generateVideo(prompt, slug) {
  let operation = await ai.models.generateVideos({
    model: "veo-3.1-generate-preview",
    prompt
  });

  while (!operation.done) {
    await new Promise((r) => setTimeout(r, 10000));
    operation = await ai.operations.getVideosOperation({ operation });
  }

  const file = operation.response.generatedVideos[0].video;
  const buffer = await ai.files.download({ file });

  const filename = generateFilename(prompt, "video", "mp4");

  await saveFileToSlug(slug, filename, buffer);

  return { video: filename };
}
