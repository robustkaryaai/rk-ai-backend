import { DESKTOP_PLANS } from "../configuration/index.js";

export const PLAN_ORDER = [
  DESKTOP_PLANS.free,
  DESKTOP_PLANS.core,
  DESKTOP_PLANS.studio,
  DESKTOP_PLANS.studio_max,
];

export const PLAN_FEATURES = {
  [DESKTOP_PLANS.free]: {
    cloudExecution: false,
    cloudQueue: false,
    autonomy: false,
    deviceAutomation: false,
    allowedToolGroups: [],
  },
  [DESKTOP_PLANS.core]: {
    cloudExecution: true,
    cloudQueue: true,
    autonomy: false,
    deviceAutomation: false,
    allowedToolGroups: ["search_tools", "browser_tools", "knowledge_tools"],
  },
  [DESKTOP_PLANS.studio]: {
    cloudExecution: true,
    cloudQueue: true,
    autonomy: true,
    deviceAutomation: true,
    allowedToolGroups: [
      "search_tools",
      "browser_tools",
      "knowledge_tools",
      "system_tools",
      "file_tools",
      "screen_tools",
      "developer_tools",
      "obs_tools",
      "automation_tools",
    ],
  },
  [DESKTOP_PLANS.studio_max]: {
    cloudExecution: true,
    cloudQueue: true,
    autonomy: true,
    deviceAutomation: true,
    allowedToolGroups: [
      "search_tools",
      "browser_tools",
      "knowledge_tools",
      "system_tools",
      "file_tools",
      "screen_tools",
      "developer_tools",
      "obs_tools",
      "automation_tools",
      "media_tools",
    ],
  },
};

export function normalizePlan(plan) {
  const value = String(plan || "").trim().toLowerCase();
  if (PLAN_ORDER.includes(value)) return value;

  const aliases = {
    student: DESKTOP_PLANS.core,
    creator: DESKTOP_PLANS.core,
    pro: DESKTOP_PLANS.core,
    studio_max: DESKTOP_PLANS.studio_max,
    studiomax: DESKTOP_PLANS.studio_max,
  };

  return aliases[value] || DESKTOP_PLANS.free;
}

export function planIncludes(plan, requiredPlan) {
  return PLAN_ORDER.indexOf(normalizePlan(plan)) >= PLAN_ORDER.indexOf(normalizePlan(requiredPlan));
}

export function getPlanFeatures(plan) {
  return PLAN_FEATURES[normalizePlan(plan)] || PLAN_FEATURES[DESKTOP_PLANS.free];
}
