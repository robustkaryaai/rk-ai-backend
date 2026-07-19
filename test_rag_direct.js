import fs from 'fs';
import { KnowledgeEngine } from './RK_AI_HOME/services/knowledge_engine/knowledge_engine.js';
import { Retriever } from './RK_AI_HOME/services/knowledge_engine/retriever.js';

async function run() {
    try {
        console.log("1. Forcing Supabase off (fallback to local SQLite)...");
        Retriever.setUseSupabase(false);
        
        console.log("2. Loading Text File...");
        const buf = fs.readFileSync("test_rag.txt");
        
        console.log("3. Processing Document...");
        const slug = "test_slug_123";
        await KnowledgeEngine.processDocumentForRAG(buf, "test_rag.txt", slug);
        
        console.log("4. Waiting for background indexing to settle...");
        await new Promise(r => setTimeout(r, 2000));
        
        console.log("5. Querying...");
        const results = await KnowledgeEngine.search("secure document", slug, 3);
        console.log("Query Results:", results);
        
        console.log("Done.");
    } catch(err) {
        console.error("Test failed:", err);
    }
}
run();
