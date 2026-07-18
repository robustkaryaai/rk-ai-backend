/**
 * Chunks text into smaller pieces for semantic search.
 * Constraint: ~1000 characters per chunk, 20% overlap (~200 chars).
 * Never chunk purely by words if it breaks context.
 */

export class Chunker {
  constructor(chunkSize = 1000, overlap = 200) {
    this.chunkSize = chunkSize;
    this.overlap = overlap;
  }

  /**
   * Splits text into chunks.
   * @param {string} text 
   * @returns {string[]} array of text chunks
   */
  chunkText(text) {
    if (!text || typeof text !== 'string') return [];
    
    // Normalize whitespace
    const cleanText = text.replace(/\s+/g, ' ').trim();
    
    if (cleanText.length <= this.chunkSize) {
      return [cleanText];
    }

    const chunks = [];
    let i = 0;
    
    while (i < cleanText.length) {
      // Find a reasonable break point (period or space) near the chunk size
      let end = i + this.chunkSize;
      
      if (end < cleanText.length) {
        // Try to find a period first
        let breakPoint = cleanText.lastIndexOf('. ', end);
        
        // If no period in the last 150 chars, fall back to space
        if (breakPoint < i || (end - breakPoint) > 150) {
          breakPoint = cleanText.lastIndexOf(' ', end);
        }
        
        // If still no space, hard cut
        if (breakPoint < i) {
          breakPoint = end;
        }
        end = breakPoint + 1; // Include the punctuation/space
      } else {
        end = cleanText.length;
      }
      
      const chunk = cleanText.substring(i, end).trim();
      if (chunk.length > 0) {
        chunks.push(chunk);
      }
      
      // Advance `i` but keep overlap
      i = end - this.overlap;
      
      // Ensure we always make progress to prevent infinite loop
      if (i <= end - this.chunkSize) {
        i = end;
      }
    }
    
    return chunks;
  }
}
