import express from "express";
import { logInfo, logError } from "../../RK_AI_HOME/utils/logger.js";
import {
  getUserPlanBySlug,
  ensureDeviceBySlug,
  updateSubscription,
  upgradeDatabaseUser,
} from "../../RK_AI_HOME/services/appwriteClient.js";
import { db } from "../../RK_AI_HOME/services/appwriteClient.js";

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
    
    // Attempt to upgrade the user's account in the custom 'users' collection first
    try {
        const targetEmail = email || slug;
        const dbSlug = await upgradeDatabaseUser(targetEmail, plan);
        if (dbSlug) {
            finalDeviceSlug = dbSlug;
            logInfo(`[Billing] User ${targetEmail} upgraded to ${plan}. Linked device slug: ${finalDeviceSlug}`);
        }
    } catch (dbErr) {
        logError(`[Billing] Could not update users collection for ${email || slug}:`, dbErr.message);
    }

    // ── Validation ──────────────────────────────────────────────
    if (!plan) {
      return res.status(400).json({ ok: false, error: "Plan is required" });
    }
    if (!finalDeviceSlug) {
      return res.status(400).json({ ok: false, error: "Device slug is required" });
    }
    if (isNaN(Number(finalDeviceSlug))) {
      return res.status(404).json({ ok: false, error: "Device not found for this account. Ensure you have a registered device." });
    }
    if (!PLANS[plan]) {
      return res.status(400).json({ ok: false, error: `Invalid plan. Valid options: ${Object.keys(PLANS).join(", ")}` });
    }

    logInfo(`[Billing] Upgrade request — plan: ${plan} | deviceSlug: ${finalDeviceSlug} | email: ${email || slug}`);

    // ── Step 1: Ensure device exists ─────────────────────────────
    await ensureDeviceBySlug(finalDeviceSlug, "desktop");

    // ── Step 2: Ensure device is tagged as desktop ───────────────
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
    // TODO: Replace this block with real Stripe charge
    logInfo(`[Billing] Payment token received: ${payment_token ? payment_token.slice(0, 12) + "..." : "none (simulated)"}`);

    // ── Step 4: Update subscription in Appwrite ──────────────────
    const planMeta = PLANS[plan];
    const duration = duration_days || planMeta.duration_days_default;
    // Update the device in Appwrite (slug -> integer)
    const updatedStatus = await updateSubscription(finalDeviceSlug, plan, duration);

    logInfo(`[Billing] ✓ Upgraded device ${finalDeviceSlug} → ${plan} (${duration} days)`);

    // ── Step 5: Respond ──────────────────────────────────────────
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

  } catch (err) {
    logError("[Billing] Upgrade error:", err);
    return res.status(500).json({ ok: false, error: "Failed to process upgrade. Please try again." });
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

export default router;
