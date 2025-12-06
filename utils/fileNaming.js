/**
 * Generate standardized filenames for generated files
 * Format: {topic}-{type}-{timestamp}.{ext}
 * Example: photosynthesis-ppt-1764961234.pptx
 */
export function generateFilename(topic, type, extension) {
  // Clean topic: remove special chars, limit length, convert to lowercase
  const cleanTopic = String(topic || "file")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") // Remove leading/trailing dashes
    .substring(0, 40); // Limit to 40 chars

  const timestamp = Date.now();
  const typeStr = String(type).toLowerCase();
  const ext = String(extension).toLowerCase().replace(/^\./, ""); // Remove leading dot if present

  return `${cleanTopic}-${typeStr}-${timestamp}.${ext}`;
}

/**
 * Extract timestamp from standardized filename
 * Example: photosynthesis-ppt-1764961234.pptx → 1764961234
 */
export function extractTimestampFromFilename(filename) {
  const match = filename.match(/-(\d+)\.[^.]+$/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Extract topic from standardized filename
 * Example: photosynthesis-ppt-1764961234.pptx → photosynthesis
 */
export function extractTopicFromFilename(filename) {
  const match = filename.match(/^(.+?)-[a-z]+-\d+\./);
  return match ? match[1] : null;
}
