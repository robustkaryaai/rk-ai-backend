const fs = require('fs');

const html = fs.readFileSync('ddg.html', 'utf-8');
const results = [];

const resultBlocks = html.split('class="result__body"');
for (let i = 1; i < resultBlocks.length; i++) {
    const block = resultBlocks[i];
    const titleMatch = block.match(/class="result__title"[^>]*>\s*<a[^>]*>(.*?)<\/a>/is);
    const urlMatch = block.match(/class="result__url"\s*href="([^"]+)"/i);
    const snippetMatch = block.match(/class="result__snippet[^>]*>(.*?)<\/a>/is);
    
    if (titleMatch && urlMatch) {
        const title = titleMatch[1].replace(/<\/?[^>]+(>|$)/g, "").trim();
        let url = urlMatch[1];
        let description = snippetMatch ? snippetMatch[1].replace(/<\/?[^>]+(>|$)/g, "").trim() : "";
        results.push({ title, url, description });
    } else {
        console.log("Block missed:", !!titleMatch, !!urlMatch);
    }
}
console.log(`Found ${results.length} results`);
if (results.length > 0) {
    console.log(results[0]);
}
