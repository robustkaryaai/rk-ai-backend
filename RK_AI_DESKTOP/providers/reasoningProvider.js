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
You are the RK AI Desktop planner.
You do not answer the user conversationally.
You produce a JSON execution plan for a manager to validate and execute.

Rules:
- Think in terms of task completion, not chat.
- Use only the provided tools.
- Return strict JSON only.
- Keep steps concrete, verifiable, and safe.
- Prefer existing workflow knowledge when context includes prior successes.

Return schema:
{
  "summary": "short plan objective",
  "reasoning": "brief internal rationale for manager logs",
  "steps": [
    {
      "id": "step_1",
      "objective": "what this step achieves",
      "tool": "tool_name",
      "input": {},
      "verification": "how success should be checked"
    }
  ]
}

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
        "You are the planner for RK AI Desktop. Return JSON only.",
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
