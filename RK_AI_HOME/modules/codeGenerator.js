import fs from "fs";
import path from "path";
import os from "os";
import { Archiver } from "archiver";
import { v4 as uuidv4 } from "uuid";
import { callGemini } from "../services/gemini.js";
import { supabase } from "../services/supabaseClient.js";
import { logInfo, logError } from "../utils/logger.js";

const SYSTEM_PROMPT = `You are an autonomous Senior Full-Stack Software Engineer operating inside an AI-powered IDE. You build and modify real, working codebases — not toy demos.

═══════════════════════════════════
OPERATING MODE
═══════════════════════════════════
You will receive:
1. A user request (new project OR a change to an existing one)
2. CONTEXT: either "EXISTING_FILES": [] (empty, new project) or a list of current files with their full content

Determine your mode:
- CREATE MODE: EXISTING_FILES is empty → design and generate a full project
- EDIT MODE: EXISTING_FILES is non-empty → modify only what's necessary. Never regenerate unrelated files. Never delete a file unless the user's request implies removing that functionality.

═══════════════════════════════════
REQUIRED PROCESS (internal, do not output as prose)
═══════════════════════════════════
Before writing code, silently plan:
- What is the minimal set of files needed to satisfy the request?
- What is the stack? Default to plain HTML/CSS/JS unless the user specifies a framework or EXISTING_FILES implies one (e.g. package.json with React → stay in React).
- What are the dependencies between files (which functions/exports does each file need from another)?
- In EDIT MODE: which specific files does this change actually touch? Do not touch anything else.

Do not narrate this plan. It informs your output — it is not part of it.

═══════════════════════════════════
OUTPUT CONTRACT — STRICT
═══════════════════════════════════
Respond with ONLY a single valid JSON object. No markdown fences, no \`\`\`json, no prose before or after, no trailing commentary. The response must be raw JSON, parseable by JSON.parse() with no preprocessing.

Structure:
{
  "status": "ok" | "needs_clarification",
  "summary": "One sentence describing what was built or changed",
  "clarification_question": "Only present if status is needs_clarification, else omit this key",
  "files": [
    {
      "path": "relative/path/like/this.js",
      "action": "create" | "modify" | "delete",
      "content": "Full file content. Empty string if action is delete."
    }
  ]
}

Rules:
- "files" contains ONLY files that are new or changed. In EDIT MODE, never include unchanged files.
- "content" for "create" or "modify" must be the COMPLETE file — never diffs, never "// ... rest unchanged", never truncated code.
- Paths must be relative, must not contain "..", must not be absolute (no leading "/"), must not escape the project root.
- If a single file's complete content would be unusually long (very large data files, generated assets), split logic into multiple smaller files instead of emitting one giant file.
- If the request is genuinely ambiguous in a way that would cause you to guess at core functionality (not styling/minor details — just pick reasonable defaults for those), set status to "needs_clarification", ask exactly one specific question, and return an empty "files" array.
- Never invent file content you're unsure about (e.g. API keys, real credentials). Use clearly-marked placeholders instead (e.g. "YOUR_API_KEY_HERE").

═══════════════════════════════════
CODE QUALITY BAR
═══════████████═══════════════════
- Code must run as-is, with no missing imports, undefined variables, or mismatched exports across files.
- Keep a consistent stack, naming convention, and code style across all files in one project.
- No placeholder/TODO logic for anything the user actually asked for — implement it fully. Placeholders are only acceptable for external secrets (API keys) or explicitly out-of-scope items you've flagged in "summary".
- Prefer small, focused files over monolithic ones once a project exceeds trivial size.`;

export async function generateAndZipCode(prompt, slug) {
  try {
    logInfo(`[Code Generator] Generating code for prompt: "${prompt}"`);
    
    // 1. Call Gemini to get the JSON structure
    const fullPrompt = `${prompt}\n\nCONTEXT:\n"EXISTING_FILES": []`;
    let responseText = await callGemini(SYSTEM_PROMPT, "", fullPrompt);
    
    // Clean up response if it accidentally included markdown formatting
    responseText = responseText.trim();
    // Robust JSON extraction
    const firstBrace = responseText.indexOf('{');
    const lastBrace = responseText.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      responseText = responseText.slice(firstBrace, lastBrace + 1);
    }
    
    let parsedData;
    try {
      parsedData = JSON.parse(responseText);
    } catch (parseErr) {
      logError("[Code Generator] Failed to parse Gemini response as JSON. Response was:", responseText.slice(0, 200) + "...");
      throw new Error("AI did not return a valid JSON structure.");
    }
    
    if (!parsedData.files || !Array.isArray(parsedData.files) || parsedData.files.length === 0) {
      throw new Error("AI returned empty file structure.");
    }

    // 2. Setup temp directory
    const projectId = `code_${uuidv4()}`;
    const tempDir = path.join(os.tmpdir(), projectId);
    fs.mkdirSync(tempDir, { recursive: true });
    
    // 3. Write files to disk
    parsedData.files.forEach(file => {
      if (file.path && file.content) {
        // Prevent path traversal
        const safePath = path.normalize(file.path).replace(/^(\.\.(\/|\\|$))+/, "");
        const fullPath = path.join(tempDir, safePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, file.content, "utf8");
      }
    });

    // 4. Zip the files
    const zipFilePath = path.join(os.tmpdir(), `${projectId}.zip`);
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipFilePath);
      const archive = new Archiver("zip", { zlib: { level: 9 } });

      output.on("close", () => resolve());
      archive.on("error", (err) => reject(err));

      archive.pipe(output);
      archive.directory(tempDir, false); // false means put files at the root of the zip
      archive.finalize();
    });
    
    // 5. Upload to Supabase
    logInfo(`[Code Generator] Uploading zip to Supabase for user: ${slug}`);
    const zipBuffer = fs.readFileSync(zipFilePath);
    const fileName = `code_projects/${projectId}.zip`;
    const bucket = process.env.SUPABASE_BUCKET || "user-files";
    
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(`${slug}/${fileName}`, zipBuffer, {
        contentType: "application/zip",
        upsert: true
      });
      
    if (uploadError) {
      logError("[Code Generator] Supabase Upload Error:", uploadError);
      throw uploadError;
    }

    // 6. Get Public URL
    const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(`${slug}/${fileName}`);
    const publicUrl = urlData?.publicUrl;

    // Cleanup local temp files
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.unlinkSync(zipFilePath);

    return { url: publicUrl, fileCount: parsedData.files.length };
    
  } catch (err) {
    logError("[Code Generator] Error:", err);
    throw err;
  }
}
