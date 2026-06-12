import express from "express";
import { logInfo, logError } from "../../RK_AI_HOME/utils/logger.js";
import { getUserPlanBySlug, ensureDeviceBySlug, updateSubscription } from "../../RK_AI_HOME/services/appwriteClient.js";
import { db } from "../../RK_AI_HOME/services/appwriteClient.js";

const router = express.Router();

// Map plan strings to existing tier values in Appwrite
const PLAN_FEATURES = {
  free: [],
  core: ["priority_queue"],
  studio: ["matrix_memory", "priority_queue", "custom_models"]
};

// Billing Upgrade Endpoint
router.post("/upgrade", async (req, res) => {
  try {
    const { plan, payment_token, slug, duration_days } = req.body;
    const deviceSlug = req.headers["x-device-slug"] || slug;

    if (!plan) {
      return res.status(400).json({ ok: false, error: "Plan is required" });
    }

    if (!deviceSlug) {
      return res.status(400).json({ ok: false, error: "Device slug required" });
    }

    const validPlans = ["free", "core", "studio"];
    if (!validPlans.includes(plan)) {
      return res.status(400).json({ ok: false, error: "Invalid plan" });
    }

    logInfo(`[Billing] Upgrade request for plan: ${plan} (slug: ${deviceSlug})`);

    // Step 1: Ensure the device exists and is marked as desktop device
    await ensureDeviceBySlug(deviceSlug, "desktop");

    // Step 2: Get the device document from Appwrite to set device_type
    const device = await getUserPlanBySlug(deviceSlug);
    if (device.device_type !== "desktop") {
      await db.updateDocument(
        process.env.APPWRITE_DB_ID,
        process.env.APPWRITE_DEVICES_COLLECTION,
        device.$id,
        { device_type: "desktop" }
      );
    }

    // Step 3: (PLACEHOLDER) Process Payment - Replace with actual Stripe/PayPal integration
    logInfo(`[Billing] Processing payment (token: ${payment_token ? payment_token.slice(0, 8) + '...' : 'none'})`);

    // Step 4: Update subscription with expiry
    const duration = duration_days || 30; // Default to 30 days
    const updatedStatus = await updateSubscription(deviceSlug, plan, duration);

    logInfo(`[Billing] Successfully upgraded slug ${deviceSlug} to ${plan} tier`);

    // Step 5: Return success response with unlocked features
    return res.json({
      ok: true,
      message: `Payment successful. Upgraded to ${plan.charAt(0).toUpperCase() + plan.slice(1)} tier.`,
      unlocked_features: PLAN_FEATURES[plan],
      subscription: updatedStatus
    });

  } catch (err) {
    logError("[Billing] Upgrade error:", err);
    return res.status(500).json({ ok: false, error: "Failed to process upgrade" });
  }
});

export default router;
