import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

async function testLangSearch(query) {
    const LANGSEARCH_API_KEY = "sk-d2dd78018749414e917eee25412d27cf";
    console.log("Testing LangSearch API...");
    try {
        const res = await fetch("https://api.langsearch.com/v1/web-search", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${LANGSEARCH_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                query: query,
                freshness: "noLimit",
                summary: true,
                count: 10
            })
        });

        console.log(`LangSearch Status: ${res.status}`);
        if (!res.ok) {
             const text = await res.text();
             console.log(`LangSearch Error Body: ${text}`);
             return false;
        }
        const data = await res.json();
        console.log("LangSearch Success. Results:", data?.data?.webPages?.value?.length || 0);
        return true;
    } catch (e) {
        console.error("LangSearch fetch failed:", e.message);
        return false;
    }
}

async function testSearXNG(query) {
    console.log("Testing SearXNG Fallback API...");
    try {
        const res = await fetch(`https://searx.be/search?q=${encodeURIComponent(query)}&format=json`);
        console.log(`SearXNG Status: ${res.status}`);
        if (!res.ok) {
             const text = await res.text();
             console.log(`SearXNG Error Body: ${text}`);
             return false;
        }
        const data = await res.json();
        console.log("SearXNG Success. Results:", data?.results?.length || 0);
        return true;
    } catch (e) {
        console.error("SearXNG fetch failed:", e.message);
        return false;
    }
}

async function runTests() {
    const query = "impact of AI on autonomous driving safety benefits and risks academic research industry reports";
    console.log(`Query: "${query}"\n`);
    
    await testLangSearch(query);
    console.log("\n------------------\n");
    await testSearXNG(query);
}

runTests();
