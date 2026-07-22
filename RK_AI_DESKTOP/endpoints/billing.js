import express from "express";
import { logInfo, logError } from "../../RK_AI_HOME/utils/logger.js";
import {
  getUserPlanBySlug,
  ensureDeviceBySlug,
  updateSubscription,
  upgradeDatabaseUser,
} from "../../RK_AI_HOME/services/appwriteClient.js";
import { db } from "../../RK_AI_HOME/services/appwriteClient.js";
import { ID } from "node-appwrite";
import { getLimitsForTier, ensureLimitFile } from "../../RK_AI_HOME/limitManager.js";
import { listFilesFromSlug, supabase } from "../../RK_AI_HOME/services/supabaseClient.js";

const router = express.Router();

/* ─────────────────────────────────────────────────────────────────
   PLAN DEFINITIONS
   Keep in sync with:
     - frontend/setup.js  (desktop app)
     - arkis/app/payment/page.js  (website)
───────────────────────────────────────────────────────────────── */
const PLANS = {
  free: {
    label: "Free",
    features: [
      "local_models",
      "local_stt",
      "local_tts",
      "offline_mode"
    ],
    local_only: true,
  },

  pro: {
    label: "Pro",
    features: [
      "cloud_models",
      "google_stt_tts",
      "online_search",
      "coding_mode"
    ],
    monthly_token_limit: 1000000,
    rpm_limit: 5,
    image_limit: 100,
    video_limit: 10,
    duration_days_default: 30,
  },

  elite: {
    label: "Elite",
    features: [
      "cloud_models",
      "google_stt_tts",
      "online_search",
      "coding_mode",
      "rk_ai_autonomy"
    ],
    monthly_token_limit: 5000000,
    rpm_limit: 15,
    image_limit: 300,
    video_limit: 50,
    computer_control_sessions: 20,
    duration_days_default: 30,
  },

  quantum: {
    label: "Quantum",
    features: [
      "cloud_models",
      "google_stt_tts",
      "online_search",
      "coding_mode",
      "rk_ai_autonomy",
      "os_screen_control",
      "autonomous_tasks",
      "media_tools",
      "gemini_live",
      "priority_queue"
    ],
    monthly_token_limit: 15000000,
    rpm_limit: 50,
    image_limit: 750,
    video_limit: 100,
    live_minutes_limit: 200,
    duration_days_default: 30,
  },
};

/* ─────────────────────────────────────────────────────────────────
   POST /billing/upgrade
   Body: { plan, payment_token, slug, email, duration_days? }
   Headers: X-Device-Slug
───────────────────────────────────────────────────────────────── */
router.post("/upgrade", async (req, res) => {
  try {
    const { plan, payment_token, slug, email, deviceSlug, duration_days } = req.body;
    let finalDeviceSlug = deviceSlug || req.headers["x-device-slug"] || "";

    // ── Validation ──────────────────────────────────────────────
    if (!plan) {
      return res.status(400).json({ ok: false, error: "Plan is required" });
    }
    if (!PLANS[plan]) {
      return res.status(400).json({ ok: false, error: `Invalid plan. Valid options: ${Object.keys(PLANS).join(", ")}` });
    }

    const planMeta = PLANS[plan];
    const duration = duration_days || planMeta.duration_days_default;

    // ── Step 1: Upgrade user account in users collection ────────
    // This works for both web users and device users
    let dbSlug = null;
    try {
      const targetEmail = email || slug;
      if (targetEmail) {
        dbSlug = await upgradeDatabaseUser(targetEmail, plan, duration);
        if (dbSlug) {
          finalDeviceSlug = dbSlug;
          logInfo(`[Billing] User ${targetEmail} upgraded to ${plan}. Linked device slug: ${finalDeviceSlug}`);
        }
      }
    } catch (dbErr) {
      // Not fatal — user may not have a users collection entry yet
      logError(`[Billing] Could not update users collection for ${email || slug}:`, dbErr.message);
    }

    try {
      // Sync subscription state to the frontend `subscriptions` collection
      const targetUserId = email || slug;
      if (targetUserId) {
        const appwritePlanMap = { free: "free", pro: "core", elite: "apex" };
        const dbPlan = appwritePlanMap[plan] || "free";
        await db.createDocument(
          process.env.APPWRITE_DB_ID,
          "subscriptions",
          ID.unique(),
          {
            userId: targetUserId,
            plan: dbPlan,
            status: "active"
          }
        );
      }
    } catch (subErr) {
      logError(`[Billing] Could not sync subscriptions collection:`, subErr.message);
    }

    logInfo(`[Billing] Upgrade request — plan: ${plan} | deviceSlug: ${finalDeviceSlug || "none (web user)"} | email: ${email || slug}`);

    // ── Step 2: If a valid numeric device slug exists, upgrade device too ──
    const hasDevice = finalDeviceSlug && !isNaN(Number(finalDeviceSlug));

    if (hasDevice) {
      // Ensure device exists and is tagged as desktop
      await ensureDeviceBySlug(finalDeviceSlug, "desktop");

      const device = await getUserPlanBySlug(finalDeviceSlug);
      if (device.device_type !== "desktop") {
        await db.updateDocument(
          process.env.APPWRITE_DB_ID,
          process.env.APPWRITE_DEVICES_COLLECTION,
          device.$id,
          { device_type: "desktop" }
        );
      }

      // ── Step 3: Payment processing ───────────────────────────────
      logInfo(`[Billing] Payment token received: ${payment_token ? payment_token.slice(0, 12) + "..." : "none (simulated)"}`);

      // ── Step 4: Update subscription on the device ────────────────
      const updatedStatus = await updateSubscription(finalDeviceSlug, plan, duration);
      logInfo(`[Billing] ✓ Upgraded device ${finalDeviceSlug} → ${plan} (${duration} days)`);

      return res.json({
        ok: true,
        message: `Successfully upgraded to ${planMeta.label} tier.`,
        plan,
        unlocked_features: planMeta.features,
        limits: {
          tokens_per_request: planMeta.token_limit,
          requests_per_minute: planMeta.rpm_limit,
        },
        subscription: updatedStatus,
      });
    }

    // ── Web-only user: no device, upgrade recorded on account only ──
    logInfo(`[Billing] Payment token received: ${payment_token ? payment_token.slice(0, 12) + "..." : "none (simulated)"}`);
    logInfo(`[Billing] ✓ Upgraded web account → ${plan}`);

    return res.json({
      ok: true,
      message: `Successfully upgraded to ${planMeta.label} tier.`,
      plan,
      unlocked_features: planMeta.features,
      limits: {
        tokens_per_request: planMeta.token_limit,
        requests_per_minute: planMeta.rpm_limit,
      },
      subscription: {
        active: true,
        device_linked: false,
        note: "Plan applied to your account. Link a device to apply device-level features.",
      },
    });

  } catch (err) {
    logError("[Billing] Upgrade error:", err);
    return res.status(500).json({ ok: false, error: "Failed to process upgrade. Please try again." });
  }
});

/* ─────────────────────────────────────────────────────────────────
   POST /billing/downgrade
   Reverts a user's plan to 'free' directly from the Desktop app
───────────────────────────────────────────────────────────────── */
router.post("/downgrade", async (req, res) => {
  try {
    const { slug, email, deviceSlug } = req.body;
    let finalDeviceSlug = deviceSlug || req.headers["x-device-slug"] || "";
    const targetUserId = email || slug;

    // ── Step 1: Update user account in users collection to 'free' ──
    if (targetUserId) {
      try {
        await upgradeDatabaseUser(targetUserId, "free", 0);
      } catch (dbErr) {
        logError(`[Billing] Could not downgrade users collection for ${targetUserId}:`, dbErr.message);
      }
    }

    // ── Step 2: Sync subscription state to 'free' ──
    if (targetUserId) {
      try {
        await db.createDocument(
          process.env.APPWRITE_DB_ID,
          "subscriptions",
          ID.unique(),
          {
            userId: targetUserId,
            plan: "free",
            status: "active"
          }
        );
      } catch (subErr) {
        logError(`[Billing] Could not sync subscriptions collection downgrade:`, subErr.message);
      }
    }

    // ── Step 3: Update subscription on the device ──
    const hasDevice = finalDeviceSlug && !isNaN(Number(finalDeviceSlug));
    if (hasDevice) {
      const updatedStatus = await updateSubscription(finalDeviceSlug, "free", 0);
      logInfo(`[Billing] ✓ Downgraded device ${finalDeviceSlug} → free`);
    } else {
      logInfo(`[Billing] ✓ Downgraded web account ${targetUserId} → free`);
    }

    return res.json({
      ok: true,
      message: `Successfully downgraded to Free tier.`,
      plan: "free"
    });

  } catch (err) {
    logError("[Billing] Downgrade error:", err);
    return res.status(500).json({ ok: false, error: "Failed to process downgrade. Please try again." });
  }
});

/* ─────────────────────────────────────────────────────────────────
   GET /billing/status
   Returns current plan and limits for a device
───────────────────────────────────────────────────────────────── */
router.get("/status", async (req, res) => {
  try {
    const deviceSlug = (req.headers["x-device-slug"] || req.query.slug || "").trim();

    if (!deviceSlug) {
      return res.status(400).json({ ok: false, error: "Device slug is required" });
    }

    const device = await getUserPlanBySlug(deviceSlug);
    const plan = device.plan || "free";
    const planMeta = PLANS[plan] || PLANS.free;

    return res.json({
      ok: true,
      plan,
      label: planMeta.label,
      unlocked_features: planMeta.features,
      limits: {
        tokens_per_request: planMeta.token_limit,
        requests_per_minute: planMeta.rpm_limit,
      },
      subscription: {
        expires_at: device.subscription_expires_at || null,
        active: device.subscription_active || false,
      },
    });

  } catch (err) {
    logError("[Billing] Status check error:", err);
    return res.status(500).json({ ok: false, error: "Failed to fetch billing status." });
  }
});
// Cloud Dashboard API for Desktop Settings
router.post("/usage/increment", async (req, res) => {
  try {
    const slug = req.headers["x-device-slug"] || req.body.slug;
    const { type, amount } = req.body;
    if (!slug || !type || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    const { incrementAppwriteUsage } = await import("../../RK_AI_HOME/services/appwriteClient.js");
    await incrementAppwriteUsage(slug, type, amount);
    return res.json({ ok: true });
  } catch (err) {
    logError("[Billing] Usage increment error:", err);
    return res.status(500).json({ error: "Failed to increment usage" });
  }
});

router.get("/cloud-dashboard/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    if (!slug) return res.status(400).json({ error: "Slug required" });

    const device = await getUserPlanBySlug(slug);
    const tier = Number(device["subscription-tier"] || 0);
    const allowed = getLimitsForTier(tier);
    const used = await ensureLimitFile(slug); // returns { image, video, tokens }

    let imagePercent = 0;
    if (allowed.image > 0) {
      imagePercent = Math.min(100, Math.round((used.image / allowed.image) * 100));
    }

    let videoPercent = 0;
    if (allowed.video > 0) {
      videoPercent = Math.min(100, Math.round((used.video / allowed.video) * 100));
    }

    let tokensPercent = 0;
    if (allowed.tokens > 0) {
      tokensPercent = Math.min(100, Math.round((used.tokens / allowed.tokens) * 100));
    }

    const filesResponse = await listFilesFromSlug(slug);
    
    // Attach public URLs to files
    const bucket = process.env.SUPABASE_BUCKET || "user-files";
    const mappedFiles = filesResponse.map(f => {
      const { data } = supabase.storage.from(bucket).getPublicUrl(`${slug}/${f.name}`);
      return {
        ...f,
        url: data ? data.publicUrl : null
      };
    });

    return res.json({
      ok: true,
      tier,
      usage: {
        imagePercent,
        videoPercent,
        tokensPercent,
        imageUsed: used.image,
        imageAllowed: allowed.image,
        videoUsed: used.video,
        videoAllowed: allowed.video,
        tokensUsed: used.tokens,
        tokensAllowed: allowed.tokens
      },
      files: mappedFiles
    });
  } catch (err) {
    logError("Cloud Dashboard Error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
