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

export async function generateAndZipCode(prompt, slug, interaction_id) {
  try {
    logInfo(`[Code Generator] Generating blueprint for: "${prompt}"`);
    
    // 1. Generate Blueprint
    const blueprintPrompt = `${prompt}\n\nDesign the complete project architecture.`;
    let blueprintText = await callGemini(BLUEPRINT_PROMPT, "", blueprintPrompt);
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

    // 2. Parallel File Generation
    // We process in small batches to respect RPM / concurrency limits
    const maxConcurrent = 5; 
    let generatedFiles = [];
    let completedCount = 0;
    
    // Create a generic queue execution
    for (let i = 0; i < blueprint.files.length; i += maxConcurrent) {
        const batch = blueprint.files.slice(i, i + maxConcurrent);
        
        const batchPromises = batch.map(async (fileObj) => {
            const contextPrompt = `
Overall Project Requirements:
${prompt}

Project Blueprint (for context):
${JSON.stringify(blueprint.files.map(f => f.path))}

Your Task:
Write the complete code for: ${fileObj.path}
Description: ${fileObj.description}
`;
            
            let fileText = await callGemini(FILE_GENERATION_PROMPT, "", contextPrompt);
            fileText = fileText.trim();
            const f1 = fileText.indexOf('{');
            const f2 = fileText.lastIndexOf('}');
            if (f1 !== -1 && f2 !== -1) {
              fileText = fileText.slice(f1, f2 + 1);
            }
            
            try {
              const fileData = JSON.parse(fileText);
              if (fileData.content) {
                 return { path: fileObj.path, content: fileData.content };
              }
            } catch (e) {
              logError(`File generation parse failed for ${fileObj.path}`);
            }
            return { path: fileObj.path, content: `// Failed to generate ${fileObj.path}` };
        });

        const results = await Promise.all(batchPromises);
        results.forEach(file => {
           if (file.path && file.content) {
             const safePath = path.normalize(file.path).replace(/^(\.\.(\/|\\|$))+/, "");
             const fullPath = path.join(tempDir, safePath);
             fs.mkdirSync(path.dirname(fullPath), { recursive: true });
             fs.writeFileSync(fullPath, file.content, "utf8");
             generatedFiles.push(file);
           }
        });
        
        completedCount += batch.length;
        if (global.activeJobs && global.activeJobs[interaction_id]) {
            global.activeJobs[interaction_id].progress = Math.floor((completedCount / blueprint.files.length) * 100);
        }
        
        // Respect potential Token Limit or RPM here if implemented.
        // For now, small delay to avoid Google 429 Too Many Requests
        await new Promise(r => setTimeout(r, 2000));
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
