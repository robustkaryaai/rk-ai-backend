import { randomUUID } from "crypto";

export const JOB_STATUS = {
  waiting: "waiting",
  running: "running",
  verifying: "verifying",
  checkpointing: "checkpointing",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

export const JOB_LIFECYCLE = [
  "verify",
  "queue",
  "load_memory",
  "build_context",
  "plan",
  "validate",
  "execute",
  "verify_execution",
  "checkpoint",
  "save",
  "unload",
  "complete",
];

export function createJobRecord(input) {
  return {
    id: input.id || randomUUID(),
    userId: input.userId,
    deviceId: input.deviceId,
    deviceSlug: input.deviceSlug,
    sessionId: input.sessionId || null,
    goal: input.goal,
    metadata: input.metadata || {},
    plan: input.plan || null,
    lifecycleStage: "verify",
    report: null,
    status: JOB_STATUS.waiting,
    retryCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
  };
}
