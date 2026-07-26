import { Document, Packer, Paragraph } from "docx";
import fs from "fs";
import { callGemini } from "../services/gemini.js";
import { saveFileToSlug } from "../services/supabaseClient.js";
import { generateFilename } from "../utils/fileNaming.js";

export async function createDocx(prompt, slug) {
  const text = await callGemini(`Technical writer. Produce a well-structured document on the given topic.

Document format:
- Start with an introduction paragraph.
- Use H2 headings for major sections, H3 for subsections.
- Use bullet points for lists; use tables for comparative data.
- End with a conclusion or summary section.
- Minimum 3 sections. No filler text.`, "", prompt);

  const doc = new Document({
    sections: [{ children: [new Paragraph(text)] }]
  });

  const buffer = await Packer.toBuffer(doc);
  const filename = generateFilename(prompt, "docx", "docx");

  await saveFileToSlug(slug, filename, buffer);

  return { docx: filename };
}
