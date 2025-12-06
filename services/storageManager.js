import fs from "fs";
import path from "path";

// Default cleanup ages (days) for Free and Paid users
const CLEANUP_AGE_DAYS = {
  free: 15,
  student: 30,
  creator: 60,
  pro: 95,
  studio: 150 
};

// -------------------- FOLDER SIZE --------------------
export function getFolderSize(folderPath) {
  if (!fs.existsSync(folderPath)) return 0;

  let totalSize = 0;
  fs.readdirSync(folderPath).forEach(file => {
    const filePath = path.join(folderPath, file);
    const stats = fs.statSync(filePath);
    if (stats.isFile()) totalSize += stats.size;
  });
  return totalSize; // bytes
}

// -------------------- CLEANUP OLD FILES --------------------
export function cleanupOldFiles(folderPath, tier = "free") {
  if (!fs.existsSync(folderPath)) return;

  const now = Date.now();
  const maxAge = (CLEANUP_AGE_DAYS[tier] || 30) * 24 * 60 * 60 * 1000; // ms

  fs.readdirSync(folderPath).forEach(file => {
    const filePath = path.join(folderPath, file);
    const stats = fs.statSync(filePath);
    if (now - stats.mtimeMs > maxAge) {
      fs.unlinkSync(filePath);
    }
  });
}

// -------------------- CHECK STORAGE BEFORE SAVE --------------------
export function canSaveFile(folderPath, fileSizeBytes, userLimitMB) {
  const currentSizeMB = getFolderSize(folderPath) / (1024 * 1024);
  return (currentSizeMB + fileSizeBytes / (1024 * 1024)) <= userLimitMB;
}

// -------------------- ENSURE FOLDER EXISTS --------------------
export function ensureFolder(folderPath) {
  if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });
}
