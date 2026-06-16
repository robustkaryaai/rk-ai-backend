import { DESKTOP_PLANS } from "../configuration/index.js";

export const TOOL_CATALOG = [
  {
    name: "launch_app",
    category: "system_tools",
    requiredPlan: DESKTOP_PLANS.studio,
    description: "Launches a desktop application on the target device.",
    constraints: ["Requires active device session", "Application must exist on device"],
    examples: ["Open OBS Studio", "Launch Discord"],
    validationRules: ["Require app identifier or executable name"],
    verificationHints: ["Expect device acknowledgment with process/window details"],
    retryGuidance: "Retry once after refocusing the device session.",
  },
  {
    name: "open_url",
    category: "browser_tools",
    requiredPlan: DESKTOP_PLANS.core,
    description: "Opens a URL on the target desktop browser.",
    constraints: ["Requires normalized https/http URL", "Requires active session"],
    examples: ["Open YouTube Studio", "Open Gmail"],
    validationRules: ["Require absolute URL"],
    verificationHints: ["Expect client to confirm browser open and final URL"],
    retryGuidance: "Retry with a fresh browser tab if navigation fails.",
  },
  {
    name: "execute_terminal",
    category: "developer_tools",
    requiredPlan: DESKTOP_PLANS.studio,
    description: "Executes a terminal command through the desktop client.",
    constraints: ["Never accept destructive shell commands", "Requires explicit command string"],
    examples: ["Run npm test", "Run git status"],
    validationRules: ["Reject empty commands", "Reject hard reset and destructive disk wipes"],
    verificationHints: ["Expect exit code and output summary from client"],
    retryGuidance: "Retry only after planner adjusts the command.",
  },
  {
    name: "type_text",
    category: "automation_tools",
    requiredPlan: DESKTOP_PLANS.studio,
    description: "Types text into the currently focused application.",
    constraints: ["Requires active focused window", "Text may contain secrets and must be redacted in logs"],
    examples: ["Fill a title field", "Enter a search query"],
    validationRules: ["Require non-empty text payload"],
    verificationHints: ["Expect client confirmation with target window metadata"],
    retryGuidance: "Retry after focus correction.",
  },
  {
    name: "hotkey",
    category: "automation_tools",
    requiredPlan: DESKTOP_PLANS.studio,
    description: "Sends a hotkey combination to the device.",
    constraints: ["Requires valid key combination"],
    examples: ["Ctrl+Shift+S", "Alt+Tab"],
    validationRules: ["Require at least one key"],
    verificationHints: ["Expect client confirmation with pressed keys"],
    retryGuidance: "Retry with slower key cadence.",
  },
  {
    name: "switch_scene",
    category: "obs_tools",
    requiredPlan: DESKTOP_PLANS.studio,
    description: "Switches OBS scene on the desktop client.",
    constraints: ["OBS must already be open"],
    examples: ["Switch to Gameplay", "Switch to Starting Soon"],
    validationRules: ["Require scene name"],
    verificationHints: ["Expect scene metadata in device acknowledgment"],
    retryGuidance: "Retry after reopening OBS if disconnected.",
  },
  {
    name: "search_web",
    category: "search_tools",
    requiredPlan: DESKTOP_PLANS.core,
    description: "Performs a backend web search for planning support.",
    constraints: ["Uses cloud provider, not device automation"],
    examples: ["Search for OBS bitrate recommendations"],
    validationRules: ["Require query text"],
    verificationHints: ["Search provider returns results directly"],
    retryGuidance: "Retry with a narrower query.",
  },
  {
    name: "read_knowledge_file",
    category: "knowledge_tools",
    requiredPlan: DESKTOP_PLANS.core,
    description: "Retrieves a stored knowledge document reference for execution context.",
    constraints: ["Document contents remain encrypted at rest"],
    examples: ["Read uploaded project brief"],
    validationRules: ["Require file reference or search phrase"],
    verificationHints: ["Store must return metadata or decrypted content summary"],
    retryGuidance: "Retry with a broader document search phrase.",
  },
];

export function getToolByName(name) {
  return TOOL_CATALOG.find((tool) => tool.name === name) || null;
}

export function getToolsForGroups(groups) {
  const allowed = new Set(groups);
  return TOOL_CATALOG.filter((tool) => allowed.has(tool.category));
}
