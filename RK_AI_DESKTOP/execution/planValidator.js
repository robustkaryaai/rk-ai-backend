import { DESKTOP_CONFIG } from "../configuration/index.js";
import { getToolByName } from "../contracts/toolCatalog.js";
import { planIncludes } from "../contracts/plans.js";

const BLOCKED_COMMAND_PATTERNS = [
  /git\s+reset\s+--hard/i,
  /rm\s+-rf\s+\/($|\s)/i,
  /mkfs\./i,
  /shutdown\s+-h/i,
];

export function createPlanValidator() {
  return {
    validatePlan({ plan, planAccess }) {
      if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
        throw new Error("Planner returned no executable steps.");
      }

      if (plan.steps.length > DESKTOP_CONFIG.maxPlanSteps) {
        throw new Error("Planner exceeded maximum step count.");
      }

      const allowedGroups = new Set(planAccess.allowedToolGroups);

      for (const step of plan.steps) {
        const tool = getToolByName(step.tool);
        if (!tool) {
          throw new Error(`Unsupported tool requested by planner: ${step.tool}`);
        }
        if (!allowedGroups.has(tool.category)) {
          throw new Error(`Tool group not allowed for plan: ${tool.category}`);
        }
        if (!planIncludes(planAccess.plan, tool.requiredPlan)) {
          throw new Error(`Plan ${planAccess.plan} does not permit tool ${tool.name}`);
        }
        if (tool.name === "execute_terminal") {
          const command = String(step.input?.command || "");
          if (!command) {
            throw new Error("Terminal execution requires a non-empty command.");
          }
          for (const pattern of BLOCKED_COMMAND_PATTERNS) {
            if (pattern.test(command)) {
              throw new Error(`Blocked terminal command: ${command}`);
            }
          }
        }
      }

      return true;
    },
  };
}
