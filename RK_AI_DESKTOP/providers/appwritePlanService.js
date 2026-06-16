import { getSubscriptionStatus, getUserPlanBySlug } from "../../RK_AI_HOME/services/appwriteClient.js";
import { normalizePlan } from "../contracts/plans.js";

function mapExistingPlan(device, subscriptionStatus) {
  const explicitPlan = device?.desktop_plan || device?.desktopPlan || subscriptionStatus?.plan;
  const normalized = normalizePlan(explicitPlan);

  if (normalized !== "free") {
    return normalized;
  }

  const legacyTier = Number(device?.["subscription-tier"] ?? subscriptionStatus?.tier ?? 0);
  if (legacyTier >= 4) return "studio";
  if (legacyTier >= 1) return "core";
  return "free";
}

export function createAppwritePlanService() {
  return {
    async verifyDeviceAccess(deviceSlug) {
      const device = await getUserPlanBySlug(deviceSlug);
      const subscription = await getSubscriptionStatus(deviceSlug);
      const plan = mapExistingPlan(device, subscription);

      return {
        deviceId: device.$id,
        deviceSlug: String(device.slug || deviceSlug).padStart(9, "0"),
        userId: device.user_id || device.userId || device.owner_id || device.ownerId || null,
        plan,
        subscriptionStatus: subscription.status,
        activeSubscription: subscription.status === "active" || plan === "free",
        rawDevice: device,
      };
    },
  };
}
