import fs from "fs";
import path from "path";
import os from "os";
import { ZipArchive } from "archiver";
import { v4 as uuidv4 } from "uuid";
import { callGemini } from "../services/gemini.js";
import { supabase } from "../services/supabaseClient.js";
import { logInfo, logError } from "../utils/logger.js";

const BLUEPRINT_PROMPT = `You are a Software Architect. Based on the user's request, design the COMPLETE file structure for the project. 
Respond with ONLY a single valid JSON object. No markdown fences.
Structure:
{
  "files": [
    {
      "path": "relative/path/like/this.js",
      "description": "detailed description of what this file must contain and do"
    }
  ]
}`;

const FILE_GENERATION_PROMPT = `You are a Senior Software Engineer. Generate the COMPLETE, robust code for the requested file.
Respond with ONLY a single valid JSON object. No markdown fences.
Structure:
{
  "content": "Full code for the file. No placeholders. No truncation."
}`;

export async function generateAndZipCode(prompt, slug, interaction_id, tier = "free") {
    // Select model based on tier
    let customModel = "gemini-2.5-flash-lite"; // Free and Pro
    if (tier === "elite" || tier === "quantum") {
        customModel = "gemini-3.1-flash-lite-preview";
    }

  try {
    logInfo(`[Code Generator] Generating blueprint for: "${prompt}" [Tier: ${tier}]`);
    
    // 1. Generate Blueprint
    const blueprintPrompt = `${prompt}\n\nDesign the complete project architecture.`;
    let blueprintText = await callGemini(BLUEPRINT_PROMPT, "", blueprintPrompt, 50, null, customModel);
    blueprintText = blueprintText.trim();
    const firstB = blueprintText.indexOf('{');
    const lastB = blueprintText.lastIndexOf('}');
    if (firstB !== -1 && lastB !== -1) {
      blueprintText = blueprintText.slice(firstB, lastB + 1);
    }
    
    let blueprint;
    try {
      blueprint = JSON.parse(blueprintText);
    } catch (e) {
      logError("Blueprint parsing failed", blueprintText.slice(0, 200));
      throw new Error("AI did not return a valid blueprint JSON.");
    }
    
    if (!blueprint.files || !Array.isArray(blueprint.files)) {
      throw new Error("Blueprint missing files array.");
    }

    logInfo(`[Code Generator] Blueprint generated with ${blueprint.files.length} files.`);
    
    // Setup Temp Directory
    const projectId = `code_${interaction_id}`;
    const tempDir = path.join(os.tmpdir(), projectId);
    fs.mkdirSync(tempDir, { recursive: true });

    // 2. Sequential File Generation (Strict 15 RPM limit for Gemini Free Tier)
    let generatedFiles = [];
    let completedCount = 0;
    
    for (let i = 0; i < blueprint.files.length; i++) {
        const fileObj = blueprint.files[i];
        
        const contextPrompt = `
Overall Project Requirements:
${prompt}

Project Blueprint (for context):
${JSON.stringify(blueprint.files.map(f => f.path))}

Your Task:
Write the complete code for: ${fileObj.path}
Description: ${fileObj.description}
`;
        
        let fileParseSuccess = false;
        let parseAttempts = 0;
        
        while (!fileParseSuccess && parseAttempts < 3) {
            parseAttempts++;
            try {
                let fileText = await callGemini(FILE_GENERATION_PROMPT, "", contextPrompt, 50, null, customModel);
                fileText = fileText.trim();
                const f1 = fileText.indexOf('{');
                const f2 = fileText.lastIndexOf('}');
                if (f1 !== -1 && f2 !== -1) {
                  fileText = fileText.slice(f1, f2 + 1);
                }
                
                const fileData = JSON.parse(fileText);
                if (fileData.content) {
                     const safePath = path.normalize(fileObj.path).replace(/^(\.\.(\/|\\|$))+/, "");
                     const fullPath = path.join(tempDir, safePath);
                     fs.mkdirSync(path.dirname(fullPath), { recursive: true });
                     fs.writeFileSync(fullPath, fileData.content, "utf8");
                     generatedFiles.push({ path: fileObj.path, content: fileData.content });
                     fileParseSuccess = true;
                }
            } catch (e) {
                logError(`File generation parse failed for ${fileObj.path} (Attempt ${parseAttempts}/3): ${e.message}`);
                if (parseAttempts < 3) {
                    await new Promise(r => setTimeout(r, 2000)); // Wait 2 seconds before retrying parse
                }
            }
        }
        
        completedCount++;
        if (global.activeJobs && global.activeJobs[interaction_id]) {
            global.activeJobs[interaction_id].progress = Math.floor((completedCount / blueprint.files.length) * 100);
        }
        
        // Strict rate limit enforcement (15 RPM = 1 request per 4 seconds)
        // Wait 4100ms before requesting the next file
        if (i < blueprint.files.length - 1) {
            await new Promise(r => setTimeout(r, 4100));
        }
    }

    // 3. Zip the files
    const zipFilePath = path.join(os.tmpdir(), `${projectId}.zip`);
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipFilePath);
      const archive = new ZipArchive({ zlib: { level: 9 } });

      output.on("close", () => resolve());
      archive.on("error", (err) => reject(err));

      archive.pipe(output);
      archive.directory(tempDir, false);
      archive.finalize();
    });
    
    // 4. Upload to Supabase
    logInfo(`[Code Generator] Uploading zip to Supabase for interaction: ${interaction_id}`);
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
      throw uploadError;
    }

    const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(`${slug}/${fileName}`);
    const publicUrl = urlData?.publicUrl;

    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.unlinkSync(zipFilePath);

    return { url: publicUrl, fileCount: generatedFiles.length };
    
  } catch (err) {
    logError("[Code Generator] Error:", err);
    throw err;
  }
}
