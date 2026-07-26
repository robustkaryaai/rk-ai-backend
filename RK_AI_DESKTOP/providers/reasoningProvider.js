import { callGemini } from "../../RK_AI_HOME/services/gemini.js";
import { DESKTOP_CONFIG } from "../configuration/index.js";

function sanitizeTool(tool) {
  return {
    name: tool.name,
    category: tool.category,
    requiredPlan: tool.requiredPlan,
    description: tool.description,
    constraints: tool.constraints,
    examples: tool.examples,
    verificationHints: tool.verificationHints,
  };
}

function buildPrompt({ goal, context, tools }) {
  return `
Produce a strict JSON execution plan. Return JSON only — no prose, no markdown.

Schema:
{"summary":"<objective>","reasoning":"<brief rationale>","steps":[{"id":"step_1","objective":"<what this achieves>","tool":"<tool_name>","input":{},"verification":"<success check>","retry_on_failure":"<fallback if this step fails>"}]}

Rules:
1. Steps must be concrete and verifiable — no vague objectives.
2. Include dependencies between steps (reference step IDs if a step depends on another).
3. If a step can fail, define retry_on_failure.
4. Use only tools from the Available Tools list.
5. Prefer existing context/workflow knowledge over re-doing completed work.

Goal:
${goal}

Execution Context:
${JSON.stringify(context, null, 2)}

Available Tools:
${JSON.stringify(tools.map(sanitizeTool), null, 2)}
`.trim();
}

function fallbackPlan(goal, tools) {
  const defaultTool = tools[0];
  return {
    summary: `Deterministic execution plan for: ${goal}`,
    reasoning: "Fell back to deterministic planning because the model response was unavailable or invalid.",
    steps: defaultTool
      ? [
          {
            id: "step_1",
            objective: "Perform the most likely first action toward the goal.",
            tool: defaultTool.name,
            input: { goal },
            verification: "Wait for explicit device/provider acknowledgment.",
          },
        ]
      : [],
  };
}

export function createReasoningProvider() {
  return {
    async generatePlan({ goal, context, tools }) {
      const prompt = buildPrompt({ goal, context, tools });
      const raw = await callGemini(
        "Execute as an RK AI Desktop task planner. Return strict JSON matching this schema: {\"summary\":string,\"steps\":[{\"id\":string,\"tool\":string,\"input\":object,\"verification\":string}]}",
        [],
        prompt,
        2,
        null,
        DESKTOP_CONFIG.plannerModel
      );

      try {
        const jsonStart = raw.indexOf("{");
        const jsonEnd = raw.lastIndexOf("}");
        if (jsonStart === -1 || jsonEnd === -1) {
          return fallbackPlan(goal, tools);
        }

        const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
        if (!Array.isArray(parsed.steps)) {
          return fallbackPlan(goal, tools);
        }
        return parsed;
      } catch {
        return fallbackPlan(goal, tools);
      }
    },
  };
}
