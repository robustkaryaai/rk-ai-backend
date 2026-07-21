import { GoogleGenAI } from "@google/genai";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config({ path: "/Users/davthelegend/Downloads/rk-ai-backend-main/.env" });

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function test() {
  const tempPath = "/tmp/test.pdf";
  fs.writeFileSync(tempPath, "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length 21 >>\nstream\nBT\n/F1 24 Tf\n100 700 Td\n(Hello World) Tj\nET\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000213 00000 n \ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n283\n%%EOF");
  
  const uploadResult = await ai.files.upload({ file: tempPath, mimeType: "application/pdf" });
  console.log("Uploaded:", uploadResult.name);
  
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-lite",
    contents: [
      uploadResult,
      "Extract all text from this document. Output ONLY the exact raw text verbatim, nothing else."
    ]
  });
  
  console.log("Text:", response.text);
}

test().catch(console.error);
