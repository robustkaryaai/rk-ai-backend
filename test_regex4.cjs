const fs = require('fs');
const html = fs.readFileSync('ddg.html', 'utf-8');
const resultBlocks = html.split(/class="[^"]*result__body[^"]*"/i);
console.log("Blocks:", resultBlocks.length);
if (resultBlocks.length > 1) {
    console.log(resultBlocks[1].substring(0, 500));
}
