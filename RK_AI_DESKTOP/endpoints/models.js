import express from "express";
import { logInfo, logError } from "../../RK_AI_HOME/utils/logger.js";
import { createAppwritePlanService } from "../providers/appwritePlanService.js";

const router = express.Router();
const planService = createAppwritePlanService();

// GitHub Release asset mapping by plan
const GITHUB_REPO = "robustkaryaai/RK-AI-THINKER-MODELS";
const GITHUB_API = "https://api.github.com";

// Map plan names to the exact asset filename in the GitHub Release
const PLAN_TO_ASSET = {
  free: "rk_ai_thinker_mlx_encrypted.zip",
  core: "rk_ai_thinker_mlx_encrypted.zip",
  pro: "rk_ai_thinker_pro_encrypted.zip",
  studio: "rk_ai_thinker_pro_encrypted.zip",
  elite: "rk_ai_thinker_elite_encrypted.zip",
  quantum: "rk_ai_thinker_elite_encrypted.zip",
};

/**
 * GET /rk-ai-desktop/models/download-url
 * 
 * Verifies the device's plan via Appwrite, then fetches a temporary
 * redirect download URL from the private GitHub Release for their
 * authorized model tier. The GitHub PAT never leaves the server.
 * 
 * Query params: ?slug=<device-slug>
 */
router.get("/download-url", async (req, res) => {
  const { slug } = req.query;

  if (!slug) {
    return res.status(400).json({ ok: false, error: "Missing device slug." });
  }

  const githubPat = process.env.GITHUB_MODEL_PAT;
  if (!githubPat) {
    logError("GITHUB_MODEL_PAT environment variable is not set on server.");
    return res.status(500).json({ ok: false, error: "Server misconfiguration." });
  }

  try {
    // 1. Verify device and get plan from Appwrite
    logInfo(`[ModelDownload] Verifying device: ${slug}`);
    const deviceInfo = await planService.verifyDeviceAccess(slug);

    if (!deviceInfo.activeSubscription) {
      return res.status(403).json({ ok: false, error: "No active subscription." });
    }

    const plan = deviceInfo.plan || "free";
    const targetAsset = PLAN_TO_ASSET[plan] || PLAN_TO_ASSET["free"];

    logInfo(`[ModelDownload] Device ${slug} is on plan '${plan}'. Serving asset: ${targetAsset}`);

    // 2. Fetch the latest release from the private GitHub repo using PAT
    const releasesRes = await fetch(
      `${GITHUB_API}/repos/${GITHUB_REPO}/releases/latest`,
      {
        headers: {
          Authorization: `Bearer ${githubPat}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );

    if (!releasesRes.ok) {
      const err = await releasesRes.text();
      logError(`[ModelDownload] GitHub API error: ${err}`);
      return res.status(502).json({ ok: false, error: "Failed to reach model repository." });
    }

    const release = await releasesRes.json();
    const asset = release.assets?.find((a) => a.name === targetAsset);

    if (!asset) {
      logError(`[ModelDownload] Asset '${targetAsset}' not found in latest release.`);
      return res.status(404).json({
        ok: false,
        error: `Model asset for plan '${plan}' is not yet available.`,
      });
    }

    // 3. Fetch the actual redirected download URL via the GitHub API
    // We do NOT expose the raw asset URL — instead we proxy via a server-side redirect
    // so the PAT token never touches the client.
    const downloadApiUrl = asset.url; // e.g. https://api.github.com/repos/.../assets/<id>

    const assetRes = await fetch(downloadApiUrl, {
      method: "GET",
      redirect: "manual", // Don't follow redirect — we want the Location header
      headers: {
        Authorization: `Bearer ${githubPat}`,
        Accept: "application/octet-stream",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    // GitHub returns a 302 redirect to a temporary CDN URL (no auth needed)
    const temporaryUrl = assetRes.headers.get("location");

    if (!temporaryUrl) {
      logError("[ModelDownload] GitHub did not return a redirect URL for the asset.");
      return res.status(502).json({ ok: false, error: "Could not generate download link." });
    }

    // 4. Return the temporary URL + metadata to the desktop app
    return res.json({
      ok: true,
      plan,
      asset: targetAsset,
      size_bytes: asset.size,
      download_url: temporaryUrl,    // Temporary GitHub CDN URL (expires quickly)
      tag: release.tag_name,
    });

  } catch (err) {
    logError("[ModelDownload] Unexpected error:", err);
    return res.status(500).json({ ok: false, error: "Internal server error." });
  }
});

export default router;
