import path from "path";
import fs from "fs";
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
    // Hybrid Approach: Small PDFs parsed locally to save API quota, Heavy PDFs sent to Gemini to prevent OOM
    const FILE_SIZE_LIMIT = 5 * 1024 * 1024; // 5 MB

    if (buffer.length < FILE_SIZE_LIMIT) {
      logInfo(`[Knowledge Parser] File ${filename} is ${Math.round(buffer.length/1024)}KB (< 5MB). Parsing locally.`);
      const require = createRequire(import.meta.url);
      let pdfParse;
      try {
        const mod = require("pdf-parse");
        pdfParse = typeof mod === "function" ? mod : mod.default;
        const data = await pdfParse(buffer);
        return data.text;
      } catch (err) {
        logError("[Knowledge Parser] Local pdf-parse failed, falling back to Gemini:", err);
        // Fallthrough to Gemini
      }
    } else {
      logInfo(`[Knowledge Parser] File ${filename} is massive (${Math.round(buffer.length/1024/1024)}MB). Delegating to Gemini to prevent OOM.`);
    }

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
