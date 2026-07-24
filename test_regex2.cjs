const fs = require('fs');

const html = fs.readFileSync('ddg.html', 'utf-8');
const results = [];

const resultBlocks = html.split('class="result__body"');
for (let i = 1; i < resultBlocks.length; i++) {
    const block = resultBlocks[i];
    
    // Simpler regexes
    const linkMatch = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
    
    if (linkMatch) {
        let url = linkMatch[1];
        const title = linkMatch[2].replace(/<\/?[^>]+(>|$)/g, "").trim();
        let description = snippetMatch ? snippetMatch[1].replace(/<\/?[^>]+(>|$)/g, "").trim() : "";
        
        if (url.includes('uddg=')) {
            url = decodeURIComponent(url.split('uddg=')[1].split('&')[0]);
        } else if (!url.startsWith('http')) {
            url = 'https:' + url;
        }
        
        results.push({ title, url, description });
    }
}

console.log(`Found ${results.length} results`);
if (results.length > 0) {
    console.log(results[0]);
}
