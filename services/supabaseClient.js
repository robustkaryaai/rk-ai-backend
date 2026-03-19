import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { logError, logInfo } from "../utils/logger.js";
import {
  ensureFolder,
  cleanupOldFiles,
  canSaveFile,
  getFolderSize
} from "./storageManager.js";
import { getUserPlanBySlug, db } from "./appwriteClient.js";

dotenv.config();

// ---------------- SUPABASE CLIENT ----------------
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const supabase = createClient(supabaseUrl, supabaseKey);

// ---------------- CONFIG ----------------
const BUCKET = process.env.SUPABASE_BUCKET || "user-files";
const MEMORY_ROOT = "memory";

// ---------------- ENCRYPTION HELPER ----------------
function encryptBuffer(buffer, secretKey) {
  const iv = crypto.randomBytes(16);
  // Ensure key is 32 bytes for aes-256-cbc
  const key = crypto.createHash('sha256').update(String(secretKey)).digest();
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([iv, cipher.update(buffer), cipher.final()]);
  return encrypted;
}

// ---------------- DECRYPTION HELPER ----------------
function decryptBuffer(encryptedBuffer, secretKey) {
  try {
    const iv = encryptedBuffer.slice(0, 16);
    const encryptedData = encryptedBuffer.slice(16);
    const key = crypto.createHash('sha256').update(String(secretKey)).digest();
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
    return decrypted;
  } catch (err) {
    logError("Decryption failed:", err.message);
    return encryptedBuffer; // Return original if decryption fails (might not be encrypted)
  }
}

// ---------------- SAVE FILE (LOCAL → SUPABASE → DELETE LOCAL) ----------------
export async function saveFileToSlug(
  slug,
  filename,
  buffer,
  tier = "free",
  storageLimitMB = 10240,
  forceSupabase = false
) {
  try {
    const safeSlug = String(slug);
    const localFolder = path.join(MEMORY_ROOT, safeSlug);

    ensureFolder(localFolder);
    cleanupOldFiles(localFolder, tier);

    if (!canSaveFile(localFolder, buffer.length, storageLimitMB)) {
      throw new Error(`Storage limit reached for ${slug}`);
    }

    const localPath = path.join(localFolder, filename);
    fs.writeFileSync(localPath, buffer); // ✅ TEMP LOCAL SAVE

    // If user prefers Google Drive and has a valid token + tier, upload there instead
    try {
      if (!forceSupabase) {
        const user = await getUserPlanBySlug(safeSlug);
        const storageUsing = String(user.storageUsing || "").toLowerCase();

        logInfo(`[Google Drive Check] storageUsing=${storageUsing}, hasToken=${!!user.googleAccessToken}`);

        if (storageUsing === "google" && user.googleAccessToken) {
          logInfo("[Google Drive] Attempting upload to Google Drive...");
        try {
          let token = user.googleAccessToken;

          // Validate token first. If invalid/expired, try to refresh using stored refresh token.
          const validateRes = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${token}`);
          logInfo(`[Google Drive] Token validation: ${validateRes.ok ? "VALID" : "INVALID"}`);
          if (!validateRes.ok) {
            // Try refresh if refresh token available and client creds present
            if (user.googleRefreshToken && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
              try {
                const refreshBody = new URLSearchParams();
                refreshBody.append("client_id", process.env.GOOGLE_CLIENT_ID);
                refreshBody.append("client_secret", process.env.GOOGLE_CLIENT_SECRET);
                refreshBody.append("grant_type", "refresh_token");
                refreshBody.append("refresh_token", user.googleRefreshToken);

                const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
                  method: "POST",
                  headers: { "Content-Type": "application/x-www-form-urlencoded" },
                  body: refreshBody.toString()
                });

                if (tokenRes.ok) {
                  const tokenJson = await tokenRes.json();
                  token = tokenJson.access_token || token;

                  // Persist new access token to Appwrite
                  try {
                    await db.updateDocument(
                      process.env.APPWRITE_DB_ID,
                      process.env.APPWRITE_DEVICES_COLLECTION,
                      user.$id,
                      { googleAccessToken: token }
                    );
                  } catch (err) {
                    logError("Failed to persist refreshed token to Appwrite:", err.message || err);
                  }
                } else {
                  throw new Error(`refresh failed: ${tokenRes.status}`);
                }
              } catch (err) {
                logError("Token refresh failed:", err.message || err);
                throw err;
              }
            } else {
              throw new Error("Invalid access token and no refresh token available");
            }
          }
          // Determine or create folder
          let folderId = user.googleFolderId || null;

          if (!folderId) {
            // Create folder named 'RK AI Files' in user's drive
            const metaRes = await fetch("https://www.googleapis.com/drive/v3/files", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json; charset=UTF-8"
              },
              body: JSON.stringify({ name: "RK AI Files", mimeType: "application/vnd.google-apps.folder" })
            });

            if (metaRes.ok) {
              const metaJson = await metaRes.json();
              folderId = metaJson.id;

              // Persist folderId back to Appwrite for future uploads
              try {
                await db.updateDocument(
                  process.env.APPWRITE_DB_ID,
                  process.env.APPWRITE_DEVICES_COLLECTION,
                  user.$id,
                  { googleFolderId: folderId }
                );
              } catch (err) {
                logError("Failed to persist folderId to Appwrite:", err.message || err);
              }
            } else {
              throw new Error(`Create folder failed: ${metaRes.status}`);
            }
          }

          // Check Google Drive available space
          const aboutRes = await fetch("https://www.googleapis.com/drive/v3/about?fields=storageQuota", {
            headers: { Authorization: `Bearer ${token}` }
          });
          if (aboutRes.ok) {
            const aboutJson = await aboutRes.json();
            const quotaBytes = aboutJson.storageQuota?.limit || 0;
            const usedBytes = aboutJson.storageQuota?.usage || 0;
            const availableBytes = quotaBytes - usedBytes;

            if (availableBytes < buffer.length) {
              throw new Error(`Google Drive: No space available. Need ${buffer.length} bytes, have ${availableBytes} bytes`);
            }
            logInfo(`[Google Drive] Space check: ${(availableBytes / (1024 * 1024 * 1024)).toFixed(2)} GB available`);
          }

          // Start resumable upload to Drive
          const metadata = { 
            name: filename + ".enc", // Append .enc to indicate encryption
            parents: folderId ? [folderId] : undefined,
            description: "Encrypted by RK AI"
          };
          
          // Encrypt buffer before upload
          const encryptionKey = process.env.DRIVE_ENCRYPTION_SECRET || "rk-ai-default-vault-key";
          const encryptedBuffer = encryptBuffer(buffer, encryptionKey);

          const initRes = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json; charset=UTF-8"
            },
            body: JSON.stringify(metadata)
          });

          if (!initRes.ok) throw new Error(`Drive init failed: ${initRes.status}`);

          const uploadUrl = initRes.headers.get("location");
          if (!uploadUrl) throw new Error("No upload URL from Drive");

          const uploadRes = await fetch(uploadUrl, {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/octet-stream",
              "Content-Length": String(encryptedBuffer.length)
            },
            body: encryptedBuffer
          });

          if (!uploadRes.ok) throw new Error(`Drive upload failed: ${uploadRes.status}`);

          const uploaded = await uploadRes.json();

          // Clean up local file
          if (fs.existsSync(localPath)) fs.unlinkSync(localPath);

          logInfo(`[Google Drive] ✅ Encrypted file uploaded successfully: ${uploaded.id}`);

          return {
            localPath: null,
            supaPath: `gdrive:${uploaded.id}`,
            sizeMB: encryptedBuffer.length / (1024 * 1024),
            encrypted: true
          };
        } catch (err) {
          logError("Google Drive upload failed, falling back to Supabase:", err.message || err);
          // fallthrough to supabase upload
        }
      }
      } // end if (!forceSupabase)
    } catch (err) {
      logError("[Google Drive Check] Failed to query user preferences:", err.message || err);
    }

    // ---------------- FALLBACK TO SUPABASE ----------------
    logInfo(`[Supabase] Uploading ${filename} to Supabase...`);
    const supaPath = `${slug}/${filename}`;
    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(supaPath, buffer, { upsert: true });

    if (uploadError) {
      logError("Supabase upload error:", uploadError.message);
      throw uploadError;
    }

    // Clean up local file
    if (fs.existsSync(localPath)) fs.unlinkSync(localPath);

    return {
      localPath: null,
      supaPath,
      sizeMB: buffer.length / (1024 * 1024)
    };

  } catch (err) {
    logError("saveFileToSlug error:", err.message || err);
    throw err;
  }
}

// ---------------- DOWNLOAD FILE ----------------
export async function downloadFileFromSlug(slug, filename) {
  try {
    const safeSlug = String(slug);
    const user = await getUserPlanBySlug(safeSlug);

    if (!user) {
      logError(`[Download] User not found for slug: ${slug}`);
      return null;
    }

    const storageUsing = String(user.storageUsing || "").toLowerCase();
    logInfo(`[Download] Checking storage for ${filename}: storageUsing=${storageUsing}`);

    // 🔥 TRY GOOGLE DRIVE FIRST if user has it connected
    if (storageUsing === "google" && user.googleAccessToken) {
      try {
        logInfo(`[Google Drive Download] Searching for ${filename}...`);
        let token = user.googleAccessToken;

        // Validate token, refresh if needed
        const validateRes = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${token}`);
        if (!validateRes.ok) {
          if (user.googleRefreshToken && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
            logInfo("[Google Drive Download] Token expired, refreshing...");
            const refreshBody = new URLSearchParams();
            refreshBody.append("client_id", process.env.GOOGLE_CLIENT_ID);
            refreshBody.append("client_secret", process.env.GOOGLE_CLIENT_SECRET);
            refreshBody.append("grant_type", "refresh_token");
            refreshBody.append("refresh_token", user.googleRefreshToken);

            const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: refreshBody.toString()
            });

            if (tokenRes.ok) {
              const tokenJson = await tokenRes.json();
              token = tokenJson.access_token || token;
              logInfo("[Google Drive Download] Token refreshed");

              // Persist new token
              try {
                await db.updateDocument(
                  process.env.APPWRITE_DB_ID,
                  process.env.APPWRITE_DEVICES_COLLECTION,
                  user.$id,
                  { googleAccessToken: token }
                );
              } catch (err) {
                logError("Failed to persist refreshed token:", err.message || err);
              }
            } else {
              throw new Error("Token refresh failed");
            }
          } else {
            throw new Error("Token invalid and cannot refresh");
          }
        }

        // Search for file in Drive (in the RK AI Files folder if it exists)
        const folderId = user.googleFolderId;
        // Search for both original filename and .enc version
        let query = `(name='${filename}' or name='${filename}.enc') and trashed=false`;
        if (folderId) {
          query += ` and '${folderId}' in parents`;
        }

        const searchRes = await fetch(
          `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,webContentLink)&pageSize=1`,
          { headers: { Authorization: `Bearer ${token}` } }
        );

        if (!searchRes.ok) {
          throw new Error(`Search failed: ${searchRes.status}`);
        }

        const searchResult = await searchRes.json();
        if (!searchResult.files || searchResult.files.length === 0) {
          logInfo(`[Google Drive Download] File not found: ${filename}, falling back to Supabase...`);
          // Fall through to Supabase
        } else {
          const file = searchResult.files[0];
          const fileId = file.id;
          const isEncrypted = file.name.endsWith(".enc");
          logInfo(`[Google Drive Download] Found file: ${fileId}, encrypted: ${isEncrypted}`);

          // Download the file
          const downloadRes = await fetch(
            `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
            { headers: { Authorization: `Bearer ${token}` } }
          );

          if (!downloadRes.ok) throw new Error(`Download failed: ${downloadRes.status}`);

          let data = Buffer.from(await downloadRes.arrayBuffer());
          
          if (isEncrypted) {
            logInfo("[Google Drive Download] Decrypting file...");
            const encryptionKey = process.env.DRIVE_ENCRYPTION_SECRET || "rk-ai-default-vault-key";
            data = decryptBuffer(data, encryptionKey);
          }

          logInfo(`[Google Drive Download] ✅ Downloaded successfully: ${data.length} bytes`);
          return data;
        }
      } catch (err) {
        logError(`[Google Drive Download] Error: ${err.message || err}, falling back to Supabase...`);
      }
    }

    // 🔄 FALLBACK TO SUPABASE
    logInfo(`[Supabase Download] Downloading ${filename} from Supabase...`);
    const { data, error } = await supabase
      .storage
      .from(BUCKET)
      .download(`${slug}/${filename}`);

    if (error) {
      if (error.status === 404 || error.message?.includes("Object not found") || error.name === "StorageUnknownError") {
        logInfo(`[Supabase Download] File ${filename} not accessible (New user or Empty?).`);
        return null;
      }
      logError(`[Supabase Download] Error: ${JSON.stringify(error)}`);
      return null;
    }

    if (!data) return null;

    const buffer = await data.arrayBuffer();
    const finalBuffer = Buffer.from(buffer);
    logInfo(`[Supabase Download] ✅ Downloaded successfully: ${finalBuffer.length} bytes`);
    return finalBuffer;

  } catch (err) {
    logError("downloadFileFromSlug error:", err.message || err);
    return null;
  }
}

// ---------------- GET STORAGE USED ----------------
export async function getSlugStorageUsed(slug) {
  try {
    const safeSlug = String(slug);
    const { data, error } = await supabase.storage.from(BUCKET).list(safeSlug);
    if (error || !data) return 0;

    let totalSize = 0;
    for (const file of data) {
      if (file.metadata && file.metadata.size) {
        totalSize += file.metadata.size;
      }
    }
    return totalSize / (1024 * 1024); // Return total size in MB
  } catch (err) {
    logError("getSlugStorageUsed error:", err.message || err);
    return 0;
  }
}

// ---------------- CHECK FILE EXISTS ----------------
export async function fileExists(slug, filename) {
  try {
    const { data, error } = await supabase
      .storage
      .from(BUCKET)
      .list(slug, { limit: 1000 });

    if (error || !data) return false;
    return data.some(item => item.name === filename);

  } catch (err) {
    logError("fileExists error:", err.message || err);
    return false;
  }
}

// ---------------- CLEANUP OLD SUPABASE FILES ----------------
export async function cleanupSupabaseFiles(slug, tier) {
  try {
    const safeSlug = String(slug);

    // Retention defined in hours (Privacy focused)
    const RETENTION_HOURS = {
      free: 24,
      student: 24,
      creator: 48,
      pro: 72,
      studio: 168
    };

    const retention = RETENTION_HOURS[tier] || 24;
    const now = new Date();

    const { data, error } = await supabase.storage.from(BUCKET).list(safeSlug);
    if (error) throw error;

    let totalSize = 0;
    for (const file of data) {
      const created = new Date(file.created_at);
      const diffHours = (now - created) / (1000 * 60 * 60);

      if (diffHours > retention) {
        logInfo(`[Cleanup] Deleting expired file: ${file.name}`);
        await supabase.storage.from(BUCKET).remove([`${safeSlug}/${file.name}`]);
      } else {
        totalSize += file.metadata.size;
      }
    }

    return totalSize / (1024 * 1024); // Return total size in MB

  } catch (err) {
    logError("cleanupSupabaseFiles error:", err.message || err);
    return 0;
  }
}

// ---------------- MIGRATE TO GOOGLE DRIVE ----------------
/**
 * Copies all files from Supabase to Google Drive for a specific slug.
 * Skips 'limit.txt' as requested.
 */
export async function migrateToGoogleDrive(slug) {
  try {
    const safeSlug = String(slug);
    const user = await getUserPlanBySlug(safeSlug);

    if (!user || !user.googleAccessToken || !user.googleFolderId) {
      logError(`[Migration] User ${slug} not ready for migration (missing token or folderId).`);
      return false;
    }

    logInfo(`[Migration] Starting migration for slug: ${slug}...`);

    // 1. List all files in Supabase for this slug
    const { data: files, error } = await supabase.storage.from(BUCKET).list(safeSlug, { limit: 1000 });
    if (error) {
      logError(`[Migration] Failed to list files in Supabase for ${slug}: ${error.message}`);
      return false;
    }

    if (!files || files.length === 0) {
      logInfo(`[Migration] No files found in Supabase for ${slug}. Migration complete.`);
      return true;
    }

    let token = user.googleAccessToken;
    const folderId = user.googleFolderId;
    const encryptionKey = process.env.DRIVE_ENCRYPTION_SECRET || "rk-ai-default-vault-key";

    let successCount = 0;
    let skipCount = 0;
    let failCount = 0;

    for (const file of files) {
      const filename = file.name;

      // 🛑 SKIP limit.txt as per user requirement
      if (filename.toLowerCase() === "limit.txt") {
        logInfo(`[Migration] Skipping system file: ${filename}`);
        skipCount++;
        continue;
      }

      try {
        logInfo(`[Migration] Processing: ${filename}...`);

        // 2. Download from Supabase
        const { data: blob, error: dlError } = await supabase.storage
          .from(BUCKET)
          .download(`${safeSlug}/${filename}`);

        if (dlError || !blob) {
          logError(`[Migration] Failed to download ${filename} from Supabase: ${dlError?.message}`);
          failCount++;
          continue;
        }

        const buffer = Buffer.from(await blob.arrayBuffer());

        // 3. Encrypt buffer
        const encryptedBuffer = encryptBuffer(buffer, encryptionKey);

        // 4. Upload to Google Drive (Resumable)
        const metadata = {
          name: filename + ".enc",
          parents: [folderId],
          description: "Migrated from Supabase by RK AI"
        };

        const initRes = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=UTF-8"
          },
          body: JSON.stringify(metadata)
        });

        if (!initRes.ok) throw new Error(`Drive init failed: ${initRes.status}`);

        const uploadUrl = initRes.headers.get("location");
        if (!uploadUrl) throw new Error("No upload URL from Drive");

        const uploadRes = await fetch(uploadUrl, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/octet-stream",
            "Content-Length": String(encryptedBuffer.length)
          },
          body: encryptedBuffer
        });

        if (!uploadRes.ok) throw new Error(`Drive upload failed: ${uploadRes.status}`);

        logInfo(`[Migration] ✅ Successfully migrated ${filename} to Google Drive.`);
        successCount++;

      } catch (err) {
        logError(`[Migration] Error migrating ${filename}: ${err.message || err}`);
        failCount++;
      }
    }

    logInfo(`[Migration] Migration for ${slug} finished. Success: ${successCount}, Skipped: ${skipCount}, Failed: ${failCount}`);
    return true;

  } catch (err) {
    logError(`[Migration] Critical error during migration for ${slug}: ${err.message || err}`);
    return false;
  }
}

// ---------------- LIST FILES ----------------
export async function listFilesFromSlug(slug) {
  try {
    const safeSlug = String(slug);
    const user = await getUserPlanBySlug(safeSlug);
    if (!user) return [];

    const storageUsing = String(user.storageUsing || "").toLowerCase();
    
    // 1. TRY GOOGLE DRIVE FIRST
    if (storageUsing === "google" && user.googleAccessToken) {
      try {
        let token = user.googleAccessToken;
        const validateRes = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${token}`);
        if (!validateRes.ok && user.googleRefreshToken) {
          const refreshBody = new URLSearchParams();
          refreshBody.append("client_id", process.env.GOOGLE_CLIENT_ID);
          refreshBody.append("client_secret", process.env.GOOGLE_CLIENT_SECRET);
          refreshBody.append("grant_type", "refresh_token");
          refreshBody.append("refresh_token", user.googleRefreshToken);

          const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: refreshBody.toString()
          });

          if (tokenRes.ok) {
            const tokenJson = await tokenRes.json();
            token = tokenJson.access_token || token;
            await db.updateDocument(process.env.APPWRITE_DB_ID, process.env.APPWRITE_DEVICES_COLLECTION, user.$id, { googleAccessToken: token });
          }
        }

        const folderId = user.googleFolderId;
        if (folderId) {
          let query = `'${folderId}' in parents and trashed=false`;
          const searchRes = await fetch(
            `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,size,mimeType,createdTime)&orderBy=createdTime desc&pageSize=100`,
            { headers: { Authorization: `Bearer ${token}` } }
          );

          if (searchRes.ok) {
            const searchResult = await searchRes.json();
            return (searchResult.files || []).map(file => {
              // Strip .enc from name for frontend display
              const isEnc = file.name.endsWith(".enc");
              const baseName = isEnc ? file.name.slice(0, -4) : file.name;
              
              // Guess true mimeType if encrypted, since it uploads as octet-stream
              let actualMime = file.mimeType;
              if (isEnc) {
                if (baseName.endsWith(".jpg") || baseName.endsWith(".jpeg")) actualMime = "image/jpeg";
                else if (baseName.endsWith(".png")) actualMime = "image/png";
                else if (baseName.endsWith(".mp4")) actualMime = "video/mp4";
                else if (baseName.endsWith(".mp3")) actualMime = "audio/mpeg";
              }

              return {
                id: file.id,
                name: baseName,
                size: parseInt(file.size || 0, 10),
                mimeType: actualMime,
                createdAt: file.createdTime,
                source: 'google'
              };
            });
          }
        }
      } catch (err) {
        logError(`[Google Drive List] Error: ${err.message || err}, falling back to Supabase...`);
      }
    }

    // 2. FALLBACK TO SUPABASE
    const { data, error } = await supabase.storage.from(BUCKET).list(safeSlug, { limit: 100, sortBy: { column: 'created_at', order: 'desc' } });
    if (error || !data) return [];

    return data.map(file => ({
      id: file.id || file.name,
      name: file.name,
      size: file.metadata?.size || 0,
      mimeType: file.metadata?.mimetype || 'application/octet-stream',
      createdAt: file.created_at,
      source: 'supabase'
    }));

  } catch (err) {
    logError("listFilesFromSlug error:", err.message || err);
    return [];
  }
}

// ---------------- DELETE FILE ----------------
export async function deleteFileFromSlug(slug, filename) {
  try {
    const safeSlug = String(slug);
    const user = await getUserPlanBySlug(safeSlug);
    if (!user) return false;

    const storageUsing = String(user.storageUsing || "").toLowerCase();

    // 1. TRY GOOGLE DRIVE FIRST
    if (storageUsing === "google" && user.googleAccessToken) {
      try {
        let token = user.googleAccessToken;
        const validateRes = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${token}`);
        if (!validateRes.ok && user.googleRefreshToken) {
          const refreshBody = new URLSearchParams();
          refreshBody.append("client_id", process.env.GOOGLE_CLIENT_ID);
          refreshBody.append("client_secret", process.env.GOOGLE_CLIENT_SECRET);
          refreshBody.append("grant_type", "refresh_token");
          refreshBody.append("refresh_token", user.googleRefreshToken);
          const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: refreshBody.toString()
          });
          if (tokenRes.ok) {
            const tokenJson = await tokenRes.json();
            token = tokenJson.access_token || token;
            await db.updateDocument(process.env.APPWRITE_DB_ID, process.env.APPWRITE_DEVICES_COLLECTION, user.$id, { googleAccessToken: token });
          }
        }

        const folderId = user.googleFolderId;
        let query = `(name='${filename}' or name='${filename}.enc') and trashed=false`;
        if (folderId) query += ` and '${folderId}' in parents`;

         const searchRes = await fetch(
          `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=1`,
          { headers: { Authorization: `Bearer ${token}` } }
        );

        if (searchRes.ok) {
          const searchResult = await searchRes.json();
          if (searchResult.files && searchResult.files.length > 0) {
            const fileId = searchResult.files[0].id;
            const delRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
              method: "DELETE",
              headers: { Authorization: `Bearer ${token}` }
            });
            if (delRes.ok) return true;
          }
        }
      } catch (err) {
        logError(`[Google Drive Delete] Error: ${err.message || err}`);
      }
    }

    // 2. FALLBACK TO SUPABASE
    const { error } = await supabase.storage.from(BUCKET).remove([`${safeSlug}/${filename}`]);
    return !error;

  } catch (err) {
    logError("deleteFileFromSlug error:", err.message || err);
    return false;
  }
}
