import { Document, Packer, Paragraph } from "docx";
import fs from "fs";
import { callGemini } from "../services/gemini.js";
import { saveFileToSlug } from "../services/supabaseClient.js";
import { generateFilename } from "../utils/fileNaming.js";

export async function createDocx(prompt, slug) {
  const text = await callGemini("Write detailed content", "", prompt);

  const doc = new Document({
    sections: [{ children: [new Paragraph(text)] }]
  });

  const buffer = await Packer.toBuffer(doc);
  const filename = generateFilename(prompt, "docx", "docx");

  await saveFileToSlug(slug, filename, buffer);

  return { docx: filename };
}
