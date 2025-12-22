import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
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

// ---------------- SAVE FILE (LOCAL → SUPABASE → DELETE LOCAL) ----------------
export async function saveFileToSlug(
  slug,
  filename,
  buffer,
  tier = "free",
  storageLimitMB = 10240
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
          const metadata = { name: filename, parents: folderId ? [folderId] : undefined };
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
              "Content-Length": String(buffer.length)
            },
            body: buffer
          });

          if (!uploadRes.ok) throw new Error(`Drive upload failed: ${uploadRes.status}`);

          const uploaded = await uploadRes.json();

          // Clean up local file
          if (fs.existsSync(localPath)) fs.unlinkSync(localPath);

          logInfo(`[Google Drive] ✅ File uploaded successfully: ${uploaded.id}`);

          return {
            localPath: null,
            supaPath: `gdrive:${uploaded.id}`,
            sizeMB: buffer.length / (1024 * 1024)
          };
        } catch (err) {
          logError("Google Drive upload failed, falling back to Supabase:", err.message || err);
          // fallthrough to supabase upload
        }
      }
    } catch (err) {
      logError("Could not fetch user storage prefs, continuing with Supabase:", err.message || err);
    }

    // ✅ CORRECT SUPABASE PATH (NO slug- PREFIX)
    const supaPath = `${safeSlug}/${filename}`;

    const { error: uploadError } = await supabase
      .storage
      .from(BUCKET)
      .upload(supaPath, buffer, { upsert: true });

    if (uploadError) {
      if (uploadError.message?.includes("already exists")) {
        await supabase.storage.from(BUCKET).remove([supaPath]);

        const retry = await supabase
          .storage
          .from(BUCKET)
          .upload(supaPath, buffer, { upsert: true });

        if (retry.error) throw retry.error;
      } else {
        throw uploadError;
      }
    }

    // ✅🔥 DELETE LOCAL FILE AFTER SUCCESSFUL UPLOAD 🔥✅
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
        let query = `name='${filename}' and trashed=false`;
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
          const fileId = searchResult.files[0].id;
          logInfo(`[Google Drive Download] Found file: ${fileId}`);

          // Download the file
          const downloadRes = await fetch(
            `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
            { headers: { Authorization: `Bearer ${token}` } }
          );

          if (!downloadRes.ok) {
            throw new Error(`Download failed: ${downloadRes.status}`);
          }

          const arrayBuffer = await downloadRes.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          logInfo(`[Google Drive Download] ✅ Downloaded successfully: ${buffer.length} bytes`);
          return buffer;
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

    if (error || !data) {
      logError(`[Supabase Download] Error: ${error?.message || "No data"}`);
      return null;
    }

    const buffer = await data.arrayBuffer();
    logInfo(`[Supabase Download] ✅ Downloaded successfully: ${buffer.length} bytes`);
    return Buffer.from(buffer);

  } catch (err) {
    logError("downloadFileFromSlug error:", err.message || err);
    return null;
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

// ---------------- GET TOTAL STORAGE USED (LOCAL CACHE ONLY) ----------------
export async function getSlugStorageUsed(slug) {
  try {
    const localFolder = path.join(MEMORY_ROOT, `slug-${slug}`);
    ensureFolder(localFolder);
    return getFolderSize(localFolder) / (1024 * 1024);

  } catch (err) {
    logError("getSlugStorageUsed error:", err.message || err);
    return 0;
  }
}
