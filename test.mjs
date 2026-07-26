import fs from 'fs';
const dir = './node_modules/@google/genai/dist/src/models';
fs.readdirSync(dir).forEach(file => console.log(file));
