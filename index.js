import express from "express";
import dotenv from "dotenv";
import { HfInference } from "@huggingface/inference";
import ytSearch from "yt-search";

import { logInfo, logError } from "./RK_AI_HOME/utils/logger.js";
import { getUserPlanBySlug, checkDeviceBySlug, ensureDeviceBySlug, db, users, getSubscriptionStatus, updateSubscription, getDatabaseUserByEmail, createDatabaseUser, upgradeDatabaseUser } from "./RK_AI_HOME/services/appwriteClient.js";
import { Query, ID } from "node-appwrite";
import { loadChat, appendChat, appendUser, updateLastAI, deleteChatEntry } from "./RK_AI_HOME/memory.js";
import { ensureLimitFile, getLimitsForTier } from "./RK_AI_HOME/limitManager.js";
import { callGemini, listGeminiModels } from "./RK_AI_HOME/services/gemini.js";
import { handleIntents } from "./RK_AI_HOME/taskHandler.js";
import { cleanupSupabaseFiles, migrateToGoogleDrive, listFilesFromSlug, downloadFileFromSlug, deleteFileFromSlug } from "./RK_AI_HOME/services/supabaseClient.js";
import { startPulseWorker } from "./RK_AI_HOME/pulseWorker.js";

dotenv.config();

const FRONTEND_URL = process.env.FRONTEND_URL || "https://rexycore.vercel.app";

// Helper to normalize slug to 9-digit string
const normalizeSlug = (slug) => {
  if (!slug) return "";
  const s = String(slug);
  return s.padStart(9, '0');
};

const hf = new HfInference(process.env.HF_TOKEN);
const app = express();
import expressWs from "express-ws";
expressWs(app);

// 🚀 ENHANCED CORS (With Credentials Support for Vercel)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowedOrigins = ["https://rexycore.vercel.app", "http://localhost:3000"];

  if (allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Credentials", "true");
  } else {
    res.header("Access-Control-Allow-Origin", "*");
  }

  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Appwrite-Project, X-Appwrite-Key, x-user-id, X-Device-Slug");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// ---------------- ALL AUTH ENDPOINTS (UNPROTECTED) ----------------
// ---------------- GOOGLE OAUTH START ----------------
app.get("/auth/google/start/:slug", async (req, res) => {
  try {
    // 🚀 Fixed: Use raw params to avoid double-encoding issues with slug|native
    const slug = req.params.slug;
    const state = slug; // Keep it as is

    // 🚀 CHECK SUBSCRIPTION TIER: Only paid users can link Google Drive
    const cleanSlug = normalizeSlug(slug.split('|')[0]);
    const device = await getUserPlanBySlug(cleanSlug);

    if (!device || device.subscription !== "true") {
      console.log(`[Google OAuth] Refusing flow for ${slug} - Subscription not active.`);
      const isNative = state.includes('|native');
      const baseRedirectUrl = isNative ? 'com.rexycore.rkai://settings' : `${FRONTEND_URL}/settings`;
      return res.redirect(`${baseRedirectUrl}?google_error=subscription_required`);
    }

    // 🚀 FORCE PRODUCTION URL IF ON RENDER
    const host = req.get('host') || "";
    let redirectUri = `https://rk-ai-backend.onrender.com/auth/google/callback`;

    if (host.includes('localhost')) {
      redirectUri = `http://localhost:4000/auth/google/callback`;
    }

    console.log(`[Google OAuth] Starting flow for ${slug}. Host: ${host}, Redirect URI: ${redirectUri}`);

    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/drive.file email",
      access_type: "offline",
      prompt: "consent",
      state
    });

    return res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  } catch (err) {
    console.error("Google OAuth start error:", err);
    return res.status(500).send(String(err));
  }
});

// ---------------- GOOGLE OAUTH CALLBACK ----------------
app.get("/auth/google/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    // Decode state carefully
    const decodedState = decodeURIComponent(state || "");

    // 🚀 NEW: Detect if this is a web login flow
    const isWebFlow = decodedState.startsWith("web|");
    const webRedirect = isWebFlow ? decodedState.split('|')[1] : null;

    const slug = isWebFlow ? null : decodedState.split('|')[0];

    if (!code || (!isWebFlow && !slug)) {
      console.error("Missing code or state:", { code: !!code, slug, isWebFlow });
      return res.redirect(`${FRONTEND_URL}/settings?google_error=missing_params`);
    }

    // 🚀 FORCE PRODUCTION URL IF ON RENDER
    const host = req.get('host') || "";
    let redirectUri = `https://rk-ai-backend.onrender.com/auth/google/callback`;
    if (host.includes('localhost')) {
      redirectUri = `http://localhost:4000/auth/google/callback`;
    }

    // Exchange code for tokens
    const body = new URLSearchParams();
    body.append("code", String(code));
    body.append("client_id", process.env.GOOGLE_CLIENT_ID);
    body.append("client_secret", process.env.GOOGLE_CLIENT_SECRET);
    body.append("redirect_uri", redirectUri);
    body.append("grant_type", "authorization_code");

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });

    if (!tokenRes.ok) {
      const errorText = await tokenRes.text();
      console.error(`Token exchange failed: ${tokenRes.status}`, errorText);
      return res.redirect(`${FRONTEND_URL}/settings?google_error=token_exchange_failed`);
    }

    const tokenJson = await tokenRes.json();
    const access_token = tokenJson.access_token;
    const refresh_token = tokenJson.refresh_token;

    // Get user email & info
    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    if (!userInfoRes.ok) {
      console.error("Failed to fetch user info");
      return res.redirect(`${FRONTEND_URL}/settings?google_error=userinfo_failed`);
    }

    const userInfo = await userInfoRes.json();
    console.log("✅ User email:", userInfo.email);

    // ── CASE 1: WEB LOGIN FLOW ──
    if (isWebFlow) {
      console.log("[Web Auth] Google callback web flow", {
        email: userInfo.email,
        redirect: webRedirect,
      });

      // Find or create user in Appwrite
      let appwriteUser;
      try {
        const existing = await users.list([Query.equal("email", userInfo.email)]);
        if (existing.total > 0) {
          appwriteUser = existing.users[0];
        } else {
          const randomPassword = Math.random().toString(36).slice(-10) + Math.random().toString(36).slice(-10) + "A1!";
          appwriteUser = await users.create(ID.unique(), userInfo.email, undefined, randomPassword, userInfo.name);
        }
      } catch (err) {
        console.error("[Web Auth] Appwrite User Error:", err);
        return res.redirect(`${FRONTEND_URL}/login?error=auth_failed`);
      }

      // Ensure user exists in custom users database collection for slug and plan
      let dbUser = await getDatabaseUserByEmail(userInfo.email);
      if (!dbUser) {
          dbUser = await createDatabaseUser(userInfo.email, userInfo.name || userInfo.email.split("@")[0]);
      }

      // Redirect to frontend with token, userId, slug, and plan
      console.log("[Web Auth] Redirecting web session", {
        userId: appwriteUser.$id,
        email: appwriteUser.email,
        slug: dbUser.slug,
        plan: dbUser.plan,
        redirect: webRedirect,
      });
      return res.redirect(`${FRONTEND_URL}/auth/web-callback?token=${appwriteUser.$id}&userId=${appwriteUser.$id}&slug=${dbUser.slug}&plan=${dbUser.plan}&redirect=${encodeURIComponent(webRedirect)}`);
    }

    // ── CASE 2: DEVICE LINKING FLOW (Existing Logic) ──
    // ✅ Check if refresh_token exists
    if (!refresh_token) {
      console.error("❌ No refresh_token received! User may have already authorized.");
      console.log("💡 User needs to revoke access and re-authorize, or we use existing token");
      return res.redirect(`${FRONTEND_URL}/settings?google_error=no_refresh_token`);
    }

    // Check for existing folder or create new one (search by name)
    const searchRes = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=name='RK AI Files' and mimeType='application/vnd.google-apps.folder' and trashed=false&fields=files(id,name)`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    const searchResult = await searchRes.json();

    let folderId;
    if (searchResult.files && searchResult.files.length > 0) {
      folderId = searchResult.files[0].id;
      console.log('✅ Reusing existing folder:', folderId);
    } else {
      const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: 'RK AI Files',
          mimeType: 'application/vnd.google-apps.folder'
        })
      });
      const newFolder = await createRes.json();
      folderId = newFolder.id;
      console.log('✅ Created new folder:', folderId);
    }

    // Update Appwrite with all required fields
    const device = await getUserPlanBySlug(slug);
    console.log("📝 Updating Appwrite for device:", device.$id);
    await db.updateDocument(
      process.env.APPWRITE_DB_ID,
      process.env.APPWRITE_DEVICES_COLLECTION,
      device.$id,
      {
        storageUsing: 'google',
        googleAccessToken: access_token,
        googleRefreshToken: refresh_token,
        googleFolderId: folderId,
        email: userInfo.email
      }
    );

    // 🚀 AUTOMATIC MIGRATION: Copy existing files from Supabase to Drive (except limit.txt)
    // We run this asynchronously so the user doesn't wait for the migration to finish
    migrateToGoogleDrive(slug).catch(err => {
      console.error(`[Migration] Async migration failed for ${slug}:`, err);
    });

    // 🚀 Robust Deep Link Redirect
    const isNative = decodedState.includes('|native');
    const baseRedirectUrl = isNative ? 'com.rexycore.rkai://settings' : `${FRONTEND_URL}/settings`;

    console.log(`✅ Appwrite updated! Native: ${isNative}, Redirecting to: ${baseRedirectUrl}`);
    return res.redirect(`${baseRedirectUrl}?google_connected=true&email=${encodeURIComponent(userInfo.email || '')}&username=${encodeURIComponent(userInfo.name || '')}`);
  } catch (err) {
    console.error("OAuth callback error:", err);
    const decodedStateErr = decodeURIComponent(req.query.state || "");
    const isWebFlow = decodedStateErr.startsWith("web|");
    const baseRedirectUrl = isWebFlow ? `${FRONTEND_URL}/login` : (decodedStateErr.includes('|native') ? 'com.rexycore.rkai://settings' : `${FRONTEND_URL}/settings`);
    return res.redirect(`${baseRedirectUrl}?google_error=callback_failed`);
  }
});

// ---------------- SPOTIFY OAUTH START ----------------
app.get("/auth/spotify/start/:slug", async (req, res) => {
  try {
    const slug = req.params.slug;
    const state = slug;

    // 🚀 USE DYNAMIC REDIRECT URI
    const host = req.get('host') || "";
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const redirectUri = `${protocol}://${host}/auth/spotify/callback`;

    console.log(`[Spotify OAuth] Using Redirect URI: ${redirectUri}`);

    if (!process.env.SPOTIFY_CLIENT_ID) {
      console.error("SPOTIFY_CLIENT_ID is not defined in .env");
      return res.status(500).send("Spotify Client ID is missing on the server.");
    }

    const params = new URLSearchParams({
      client_id: process.env.SPOTIFY_CLIENT_ID,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: "user-read-private user-read-email user-modify-playback-state user-read-playback-state streaming",
      show_dialog: "true", // 🚀 FORCE LOGIN DIALOG AS REQUESTED
      state
    });
    return res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
  } catch (err) {
    return res.status(500).send(String(err));
  }
});

// ---------------- SPOTIFY OAUTH CALLBACK ----------------
app.get("/auth/spotify/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    const decodedState = decodeURIComponent(state || "");
    const slug = decodedState.split('|')[0];

    if (!code || !slug) {
      console.error("Missing code or state:", { code: !!code, slug });
      return res.redirect(`${FRONTEND_URL}/settings?spotify_error=missing_params`);
    }

    // 🚀 FORCE PRODUCTION URL IF ON RENDER
    const host = req.get('host') || "";
    let redirectUri = `https://rk-ai-backend.onrender.com/auth/spotify/callback`;
    if (host.includes('localhost')) {
      redirectUri = `http://localhost:4000/auth/spotify/callback`;
    }

    const body = new URLSearchParams();
    body.append("code", String(code));
    body.append("grant_type", "authorization_code");
    body.append("redirect_uri", redirectUri);

    const authHeader = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString("base64");

    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": `Basic ${authHeader}`
      },
      body: body.toString()
    });

    if (!tokenRes.ok) {
      return res.redirect(`${FRONTEND_URL}/settings?spotify_error=token_exchange_failed`);
    }

    const tokenJson = await tokenRes.json();

    // Update Appwrite device doc with Spotify tokens
    try {
      const device = await getUserPlanBySlug(slug);
      console.log(`[Spotify OAuth] Updating device doc ${device.$id} for ${slug}...`);

      await db.updateDocument(
        process.env.APPWRITE_DB_ID,
        process.env.APPWRITE_DEVICES_COLLECTION,
        device.$id,
        {
          spotifyAccessToken: tokenJson.access_token,
          spotifyRefreshToken: tokenJson.refresh_token,
          spotifyConnected: "true"
        }
      );
      console.log(`[Spotify OAuth] ✅ Appwrite updated successfully for ${slug}.`);
    } catch (appwriteErr) {
      console.error(`[Spotify OAuth] ❌ Appwrite update failed (Check if attributes exist):`, appwriteErr.message || appwriteErr);
    }

    const isNative = decodedState.includes('|native');
    const baseRedirectUrl = isNative ? 'com.rexycore.rkai://settings' : `${FRONTEND_URL}/settings`;

    return res.redirect(`${baseRedirectUrl}?spotify_connected=true`);
  } catch (err) {
    console.error("Spotify OAuth error:", err);
    const decodedStateErr = decodeURIComponent(req.query.state || "");
    const isNative = decodedStateErr.includes('|native');
    const baseRedirectUrl = isNative ? 'com.rexycore.rkai://settings' : `${FRONTEND_URL}/settings`;
    return res.redirect(`${baseRedirectUrl}?spotify_error=callback_failed`);
  }
});

// ---------------- WEB AUTH GOOGLE START ----------------
app.get("/web/auth/google/start", (req, res) => {
  const redirect = req.query.redirect || "/";
  console.log("[Web Auth] Google start", {
    redirect,
    origin: req.headers.origin || null,
    referer: req.headers.referer || null,
  });
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: `https://rk-ai-backend.onrender.com/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state: `web|${redirect}`
  });
  return res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

// ---------------- SUBSCRIPTION ENDPOINTS ----------------
// Get subscription status (for RK AI Home/Desktop)
app.get("/subscription/:slug", async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    if (req.body.source === "rk-ai-phone") {
      const { intent, parameters, source_slug } = req.body;
      if (!source_slug) return res.status(401).json({ error: "Missing source_slug" });
      const phoneExists = await checkDeviceBySlug(source_slug);
      if (!phoneExists) return res.status(401).json({ error: "Unauthorized phone device" });
      const desktopRes = desktopConnections.get(slug);
      if (desktopRes) {
        console.log(`[Relay] Phone ${source_slug} sending intent ${intent} to desktop ${slug}`);
        desktopRes.write(`data: ${JSON.stringify({ intent, parameters })}\n\n`);
        return res.json({ ok: true, message: "Relayed to desktop" });
      } else {
        return res.status(404).json({ error: "Desktop agent not connected for this slug" });
      }
    }

    const status = await getSubscriptionStatus(slug);
    return res.json({ ok: true, ...status });
  } catch (err) {
    logError("Get subscription status error:", err);
    return res.status(500).json({ ok: false, error: "Failed to get subscription status" });
  }
});

// Get subscription status via X-Device-Slug header
app.get("/subscription", async (req, res) => {
  const slug = req.headers["x-device-slug"];
  const email = req.headers["x-user-email"];
  if (!slug) {
    return res.status(400).json({ ok: false, error: "X-Device-Slug header required" });
  }
  try {
    const normalizedSlug = normalizeSlug(slug);
    const status = await getSubscriptionStatus(normalizedSlug, email);
    return res.json({ ok: true, ...status });
  } catch (err) {
    logError("Get subscription status error:", err);
    return res.status(500).json({ ok: false, error: "Failed to get subscription status" });
  }
});

// ---------------- RK AI DESKTOP ENDPOINTS ----------------
const { default: desktopRouter } = await import("./RK_AI_DESKTOP/index.js");
const { default: billingRouter } = await import("./RK_AI_DESKTOP/endpoints/billing.js");

app.use("/rk-ai-desktop", desktopRouter);
app.use("/billing", billingRouter);
app.use("/rk-ai-desktop/billing", billingRouter);

const { default: homeRouter } = await import("./RK_AI_HOME/index.js");
app.use("/", homeRouter);
// ---------------- START SERVER ----------------
const PORT = process.env.PORT || 10000;

app.listen(PORT, '0.0.0.0', () => {
  logInfo(`🔥 RexyCore Backend Running on ${PORT}`);
  startPulseWorker();
});
