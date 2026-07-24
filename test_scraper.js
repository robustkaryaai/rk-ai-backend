import axios from 'axios';
import * as cheerio from 'cheerio';

async function fallbackSearch(query) {
    try {
        console.log(`Scraping HTML DDG for: ${query}`);
        const response = await axios.post('https://html.duckduckgo.com/html/', `q=${encodeURIComponent(query)}`, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
            }
        });
        
        const $ = cheerio.load(response.data);
        const results = [];
        
        $('.result').each((i, el) => {
            const title = $(el).find('.result__title .result__a').text().trim();
            const url = $(el).find('.result__url').attr('href');
            let description = $(el).find('.result__snippet').text().trim();
            if (title && url) {
                // DDG redirect URLs sometimes look like //duckduckgo.com/l/?uddg=actual_url
                let actualUrl = url;
                if (url.includes('uddg=')) {
                    actualUrl = decodeURIComponent(url.split('uddg=')[1].split('&')[0]);
                } else if (!url.startsWith('http')) {
                    actualUrl = 'https:' + url;
                }
                
                results.push({
                    title,
                    url: actualUrl,
                    description
                });
            }
        });
        
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
