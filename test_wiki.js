import fetch from "node-fetch";

async function testWikipedia(query) {
    console.log("Testing Wikipedia API...");
    try {
        const res = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&utf8=&format=json`);
        console.log(`Wiki Status: ${res.status}`);
        if (!res.ok) {
             const text = await res.text();
             console.log(`Wiki Error Body: ${text}`);
             return false;
        }
        const data = await res.json();
        const results = data?.query?.search?.map(r => ({
            title: r.title,
            url: \`https://en.wikipedia.org/wiki/\${encodeURIComponent(r.title.replace(/ /g, '_'))}\`,
            description: r.snippet.replace(/<[^>]*>?/gm, '')
        })) || [];
        
        console.log("Wiki Success. Results:", results.length);
        console.log(results[0]);
        return true;
    } catch (e) {
        console.error("Wiki fetch failed:", e.message);
        return false;
    }
}

testWikipedia("impact of AI on autonomous driving safety benefits and risks");
