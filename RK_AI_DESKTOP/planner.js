import { getToolsForGroups } from "./contracts/toolCatalog.js";

const ROUTING_RULES = [
  { match: /(obs|stream|record|scene|bitrate)/i, groups: ["obs_tools", "system_tools", "automation_tools"] },
  { match: /(code|terminal|git|build|debug|project|vscode)/i, groups: ["developer_tools", "file_tools", "system_tools"] },
  { match: /(browser|tab|website|url|youtube|gmail|chrome|web)/i, groups: ["browser_tools", "search_tools", "automation_tools"] },
  { match: /(document|pdf|ppt|docx|knowledge|file)/i, groups: ["knowledge_tools", "file_tools", "search_tools"] },
];

function routeToolGroups(goal, allowedToolGroups) {
  const selected = new Set();

  for (const rule of ROUTING_RULES) {
    if (rule.match.test(goal)) {
      rule.groups.forEach((group) => selected.add(group));
    }
  }

  if (selected.size === 0) {
    allowedToolGroups.slice(0, 3).forEach((group) => selected.add(group));
  }

  return [...selected].filter((group) => allowedToolGroups.includes(group));
}

export function createDesktopPlanner({ reasoningProvider }) {
  return {
    async createPlan({ goal, context, planAccess }) {
      const selectedGroups = routeToolGroups(goal, planAccess.allowedToolGroups);
      const tools = getToolsForGroups(selectedGroups);

      return reasoningProvider.generatePlan({
        goal,
        context: {
          plan: planAccess.plan,
          selectedGroups,
          deviceState: context.deviceState,
          longTermMemory: context.memory.longTerm,
          recentExperiences: context.memory.experiences,
          predictionMatrix: context.memory.predictions,
        },
        tools,
      });
    },
  };
}
