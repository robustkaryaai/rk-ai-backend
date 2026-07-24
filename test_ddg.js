import { search, SafeSearchType } from "duck-duck-scrape";

async function testDDG() {
    try {
        console.log("Testing DDG locally...");
        const res = await search("latest quantum computing news", {
            safeSearch: "MODERATE"
        });
        console.log(`Success! Found ${res.results.length} results.`);
        console.log(`Top result: ${res.results[0].title} - ${res.results[0].url}`);
    } catch (e) {
        console.error("DDG Test Failed:", e);
    }
}

testDDG();
