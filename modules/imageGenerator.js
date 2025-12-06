import { GoogleGenAI } from "@google/genai";
import fs from "fs";
import path from "path";
import { saveFileToSlug } from "../services/supabaseClient.js";
import { generateFilename } from "../utils/fileNaming.js";

const ai = new GoogleGenAI({});

export async function generateImage(prompt, slug) {
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-image",
    contents: [{ text: prompt }]
  });

  for (const part of response.candidates[0].content.parts) {
    if (part.inlineData) {
      const buffer = Buffer.from(part.inlineData.data, "base64");
      const filename = generateFilename(prompt, "image", "png");

      await saveFileToSlug(slug, filename, buffer);

      return { image: filename };
    }
  }
}
