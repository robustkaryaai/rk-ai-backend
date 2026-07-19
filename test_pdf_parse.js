import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');
console.log("pdf is array?", Array.isArray(pdf));
console.log("typeof pdf:", typeof pdf);
console.log("pdf keys:", Object.keys(pdf));
console.log("pdf default type:", typeof pdf.default);
