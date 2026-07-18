import path from "path";
import { logError } from "../../utils/logger.js";

// Lazy load parsers so missing ones don't crash the server at boot
let pdfParse = null;

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
        return await this.parsePdf(buffer);
      } else if ([".txt", ".md", ".csv", ".json"].includes(ext)) {
        return buffer.toString("utf-8");
      } else if (ext === ".docx") {
        return "DOCX extraction not implemented yet.";
        // In the future: const mammoth = await import("mammoth"); return (await mammoth.extractRawText({buffer})).value;
      } else {
        // Fallback: try reading as plain text
        return buffer.toString("utf-8");
      }
    } catch (err) {
      logError(`[Knowledge Parser] Error parsing ${filename}:`, err);
      return "";
    }
  }

  static async parsePdf(buffer) {
    if (!pdfParse) {
      try {
        pdfParse = (await import("pdf-parse")).default || (await import("pdf-parse"));
      } catch (err) {
        throw new Error("pdf-parse is not installed. Run 'npm install pdf-parse'");
      }
    }
    const data = await pdfParse(buffer);
    return data.text;
  }
}
