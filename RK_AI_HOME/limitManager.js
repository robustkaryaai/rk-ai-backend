// limitManager.js
import { logInfo, logWarn } from "./utils/logger.js";
import { getSubscriptionStatus, incrementAppwriteUsage } from "./services/appwriteClient.js";

// Monthly Limits per Tier
const TIER_LIMITS = {
  0: { tokens: 0, image: 0, video: 0, ppt: 0, ppt_slides: 0, rpm: 15 }, // Free
  1: { tokens: 1500000, image: 150, video: 15, ppt: 999999, ppt_slides: 999999, rpm: 5, rpd: 20 }, // Pro
  2: { tokens: 5000000, image: 600, video: 30, ppt: 999999, ppt_slides: 999999, rpm: 60 }, // Elite
  3: { tokens: 15000000, image: 2000, video: 100, ppt: 999999, ppt_slides: 999999, rpm: 150 }, // Quantum
  4: { tokens: 99999999, image: 999999, video: 999999, ppt: 999999, ppt_slides: 999999, rpm: 300 }, // Infinity
  'infinity': { tokens: 99999999, image: 999999, video: 999999, ppt: 999999, ppt_slides: 999999, rpm: 300 },
  'Infinity': { tokens: 99999999, image: 999999, video: 999999, ppt: 999999, ppt_slides: 999999, rpm: 300 }
};

export async function ensureLimitFile(slug) {
  // Legacy function - we now rely on Appwrite, but we return a mock to avoid breaking legacy code
  const sub = await getSubscriptionStatus(slug);
  return {
    image: sub.imagesUsed || 0,
    video: sub.videosUsed || 0,
    tokens: sub.tokensUsed || 0
  };
}

export async function checkAndConsume(slug, tier, feature, amount = 1) {
  try {
    const sub = await getSubscriptionStatus(slug);
    const allowed = TIER_LIMITS[tier]?.[feature] ?? 0;
    
    // Map feature to Appwrite field
    let used = 0;
    if (feature === "image") used = sub.imagesUsed || 0;
    if (feature === "video") used = sub.videosUsed || 0;
    if (feature === "tokens") used = sub.tokensUsed || 0;
    
    // Legacy support for PPT which we don't track tightly in Appwrite yet
    if (feature === "ppt" || feature === "ppt_slides") used = 0; 

    if (used + amount > allowed) {
      return { ok: false, used, allowed };
    }

    // Increment in Appwrite (ONLY for images and videos - tokens are calculated EXACTLY by callGemini)
    if (feature === "image" || feature === "video") {
      await incrementAppwriteUsage(slug, feature, amount);
    }
    
    if (feature === "tokens") {
      console.log(`\n\x1b[36m[RK AI QUOTA] ⚖️ Verified ${amount} tokens buffer for ${slug} — Usage: ${used} / ${allowed}\x1b[0m\n`);
      logInfo(`Verified buffer of ${amount} ${feature} for ${slug} — ${used}/${allowed}`);
      return { ok: true, used, allowed };
    } else {
      console.log(`\n\x1b[36m[RK AI QUOTA] 📊 Consumed ${amount} ${feature} for ${slug} — Usage: ${used + amount} / ${allowed}\x1b[0m\n`);
      logInfo(`Consumed ${amount} ${feature} for ${slug} — ${used + amount}/${allowed}`);
      return { ok: true, used: used + amount, allowed };
    }
  } catch (err) {
    logWarn(`Error checking limits for ${slug}: ${err}`);
    return { ok: false, used: 0, allowed: 0 };
  }
}

export function getLimitsForTier(tier) {
  return TIER_LIMITS[tier] || TIER_LIMITS[0];
}
