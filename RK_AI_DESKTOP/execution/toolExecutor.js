import { search as ddgSearch } from "duck-duck-scrape";

function toDeviceCommand(toolName, input) {
  return {
    intent: toolName,
    args: input,
  };
}

export function createToolExecutor({ bridge }) {
  return {
    async executeStep({ job, step }) {
      switch (step.tool) {
        case "search_web": {
          const query = String(step.input?.query || step.input?.goal || job.goal || "").trim();
          if (!query) {
            throw new Error("search_web requires a query.");
          }
          const results = await ddgSearch(query, { safeSearch: 0, locale: "en-us" });
          return {
            mode: "provider",
            tool: step.tool,
            results: (results.results || []).slice(0, 5).map((result) => ({
              title: result.title,
              url: result.url,
              snippet: result.description,
            })),
          };
        }

        case "launch_app":
        case "open_url":
        case "execute_terminal":
        case "type_text":
        case "hotkey":
        case "switch_scene": {
          const command = await bridge.enqueueCommand({
            deviceId: job.deviceId,
            sessionId: job.sessionId,
            userId: job.userId,
            jobId: job.id,
            toolName: step.tool,
            payload: toDeviceCommand(step.tool, step.input || {}),
          });

          const ack = await bridge.waitForCommandAck(command.id);
          return {
            mode: "device",
            tool: step.tool,
            commandId: command.id,
            ack,
          };
        }

        case "read_knowledge_file":
          return {
            mode: "provider",
            tool: step.tool,
            results: [],
            warning: "Knowledge retrieval adapter is not implemented yet.",
          };

        default:
          throw new Error(`Tool executor is not implemented for ${step.tool}`);
      }
    },
  };
}
