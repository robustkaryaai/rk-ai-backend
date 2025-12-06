// limitManager.js
import { loadLimit, saveLimit } from "./memory.js";
import { logInfo, logWarn } from "./utils/logger.js";

const DEFAULT_DAILY = {
  image: 0,
  video: 0
};

const TIER_LIMITS = {
  0: { image: 5, video: 0 },     // free
  1: { image: 20, video: 2 },    // basic
  2: { image: 100, video: 10 },  // pro
  3: { image: 999999, video: 999999 } // ultra/unlimited
};

function todayKey() {
  return new Date().toISOString().split("T")[0];
}

export async function ensureLimitFile(slug) {
  let limits = (await loadLimit(slug)) || {};
  const t = todayKey();
  if (!limits[t]) {
    limits[t] = { ...DEFAULT_DAILY };
    await saveLimit(slug, limits);
  }
  return limits;
}

export async function checkAndConsume(slug, tier, feature, amount = 1) {
  const limits = (await ensureLimitFile(slug)) || {};
  const t = todayKey();
  const used = limits[t][feature] || 0;
  const allowed = TIER_LIMITS[tier]?.[feature] ?? 0;

  if (used + amount > allowed) {
    return { ok: false, used, allowed };
  }

  limits[t][feature] = used + amount;
  await saveLimit(slug, limits);
  logInfo(`Consumed ${amount} ${feature} for ${slug} — ${limits[t][feature]}/${allowed}`);
  return { ok: true, used: limits[t][feature], allowed };
}

export function getLimitsForTier(tier) {
  return TIER_LIMITS[tier] || TIER_LIMITS[0];
}
