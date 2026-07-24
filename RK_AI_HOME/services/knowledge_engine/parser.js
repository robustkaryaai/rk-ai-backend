import path from "path";
import fs from "fs";
import { createRequire } from "module";
import os from "os";
import { logError, logInfo } from "../../utils/logger.js";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

export class Parser {
  /**
   * Extracts raw text from a document buffer based on its extension.
   * @param {Buffer} buffer 
   * @param {string} filename 
   * @returns {Promise<string>} Extracted text
   */
  static async parse(buffer, filename) {
    const ext = path.extname(filename || "").toLowerCase();
    
    try {
      if (ext === ".pdf") {
        return await this.parsePdf(buffer, filename);
      } else if ([".txt", ".md", ".csv", ".json"].includes(ext)) {
        return buffer.toString("utf-8");
      } else if (ext === ".docx") {
        return "DOCX extraction not implemented yet.";
      } else {
        // Fallback: try reading as plain text
        return buffer.toString("utf-8");
      }
    } catch (err) {
      logError(`[Knowledge Parser] Error parsing ${filename}:`, err);
      return "";
    }
  }

  static async parsePdf(buffer, filename) {
    logInfo(`[Knowledge Parser] Delegating PDF parsing to Gemini to prevent backend OOM (${Math.round(buffer.length/1024)}KB).`);
    
    const tempPath = path.join(os.tmpdir(), `${Date.now()}_${filename}`);
    fs.writeFileSync(tempPath, buffer);

    try {
      if (!process.env.GEMINI_API_KEY) {
         throw new Error("No GEMINI_API_KEY set. Cannot parse massive PDF via Gemini.");
      }
      
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

      // Upload directly to Gemini to bypass Node.js RAM limits
      const uploadResult = await ai.files.upload({
        file: tempPath,
        mimeType: "application/pdf"
      });

      // Extract raw text using Flash Lite
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-lite",
        contents: [
          uploadResult,
          "Extract all text from this document sequentially. Output ONLY the exact raw text verbatim, nothing else. Do not summarize or format."
        ]
      });

      // Explicitly delete from Gemini to save user storage space
      try {
        await ai.files.delete({ name: uploadResult.name });
      } catch (delErr) {
        logError("[Knowledge Parser] Failed to delete file from Gemini:", delErr);
      }
      
      return response.text;
    } finally {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    }
  }
}
