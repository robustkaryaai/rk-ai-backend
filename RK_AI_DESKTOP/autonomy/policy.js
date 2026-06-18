import { DESKTOP_PLANS } from "../configuration/index.js";

const POLICIES = {
  [DESKTOP_PLANS.free]: {
    enabled: false,
    maxDepth: 0,
    maxRetries: 0,
    runtimeBudgetMs: 0,
    allowedTools: [],
  },
  [DESKTOP_PLANS.core]: {
    enabled: false,
    maxDepth: 0,
    maxRetries: 0,
    runtimeBudgetMs: 60_000,
    allowedTools: [],
  },
  [DESKTOP_PLANS.studio]: {
    enabled: true,
    maxDepth: 4,
    maxRetries: 2,
    runtimeBudgetMs: 10 * 60_000,
    allowedTools: ["system_tools", "browser_tools", "developer_tools", "file_tools", "obs_tools"],
  },
  [DESKTOP_PLANS.studio_max]: {
    enabled: true,
    maxDepth: 6,
    maxRetries: 4,
    runtimeBudgetMs: 20 * 60_000,
    allowedTools: [
      "system_tools",
      "browser_tools",
      "developer_tools",
      "file_tools",
      "obs_tools",
      "automation_tools",
      "screen_tools",
      "media_tools",
    ],
  },
};

export function getAutonomyPolicy(plan) {
  return POLICIES[plan] || POLICIES[DESKTOP_PLANS.free];
}
