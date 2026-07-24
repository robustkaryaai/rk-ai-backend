async function fallbackSearch(query) {
    try {
        console.log(`Scraping HTML DDG for: ${query}`);
        const response = await fetch('https://html.duckduckgo.com/html/', {
            method: 'POST',
            body: `q=${encodeURIComponent(query)}`,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
            }
        });
        
        const html = await response.text();
        import('fs').then(fs => fs.writeFileSync('ddg.html', html));
        const results = [];
        
        // Regex to extract title, snippet, and URL from DDG HTML
        const resultBlocks = html.split('class="result__body"');
        for (let i = 1; i < resultBlocks.length; i++) {
            const block = resultBlocks[i];
            const titleMatch = block.match(/class="result__title".*?>\s*<a[^>]*>(.*?)<\/a>/is);
            const urlMatch = block.match(/class="result__url"\s*href="([^"]+)"/i);
            const snippetMatch = block.match(/class="result__snippet[^>]*>(.*?)<\/a>/is);
            
            if (titleMatch && urlMatch) {
                const title = titleMatch[1].replace(/<\/?[^>]+(>|$)/g, "").trim();
                let url = urlMatch[1];
                let description = snippetMatch ? snippetMatch[1].replace(/<\/?[^>]+(>|$)/g, "").trim() : "";
                
                if (url.includes('uddg=')) {
                    url = decodeURIComponent(url.split('uddg=')[1].split('&')[0]);
                } else if (!url.startsWith('http')) {
                    url = 'https:' + url;
                }
                
                results.push({ title, url, description });
            }
        }
        
        console.log(`Success! Found ${results.length} results via HTML fallback.`);
        if (results.length > 0) {
            console.log(`Top result: ${results[0].title} - ${results[0].url}`);
        }
        return results;
    } catch (e) {
        console.error("HTML DDG Test Failed:", e.message);
        return [];
    }
}

fallbackSearch("latest quantum computing news");
