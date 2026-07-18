const truthy = new Set(["1", "true", "yes", "on"]);

function envFlag(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  return truthy.has(String(raw).trim().toLowerCase());
}

function envNumber(name, defaultValue) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : defaultValue;
}

export const DESKTOP_PLANS = {
  free: "free",
  core: "core",
  studio: "studio",
  studio_max: "studio_max",
};

export const DESKTOP_QUEUE_WEIGHTS = {
  [DESKTOP_PLANS.core]: envNumber("RK_DESKTOP_QUEUE_WEIGHT_CORE", 3),
  [DESKTOP_PLANS.studio]: envNumber("RK_DESKTOP_QUEUE_WEIGHT_STUDIO", 5),
  [DESKTOP_PLANS.studio_max]: envNumber("RK_DESKTOP_QUEUE_WEIGHT_STUDIO_MAX", 8),
};

export const DESKTOP_CONFIG = {
  serviceName: "RK AI Desktop",
  workerCount: envNumber("RK_DESKTOP_WORKER_COUNT", 1),
  maxPlanSteps: envNumber("RK_DESKTOP_MAX_PLAN_STEPS", 12),
  maxQueuedJobsPerDevice: envNumber("RK_DESKTOP_MAX_QUEUED_JOBS_PER_DEVICE", 3),
  deviceHeartbeatMs: envNumber("RK_DESKTOP_DEVICE_HEARTBEAT_MS", 30_000),
  commandAckTimeoutMs: envNumber("RK_DESKTOP_COMMAND_ACK_TIMEOUT_MS", 45_000),
  queueAgingFactorMs: envNumber("RK_DESKTOP_QUEUE_AGING_FACTOR_MS", 20_000),
  strictPersistence: envFlag("RK_DESKTOP_STRICT_PERSISTENCE", true),
  // Retry/backoff settings for step execution
  maxStepRetries: envNumber("RK_DESKTOP_MAX_STEP_RETRIES", 3),
  retryBaseMs: envNumber("RK_DESKTOP_RETRY_BASE_MS", 1000),
  retryMaxMs: envNumber("RK_DESKTOP_RETRY_MAX_MS", 30_000),
  // Job-level retry limits
  maxJobRetries: envNumber("RK_DESKTOP_MAX_JOB_RETRIES", 2),
  allowUnsignedDeviceRequests: envFlag("RK_DESKTOP_ALLOW_UNSIGNED_DEVICE_REQUESTS", false),
  deviceRequestSecret: process.env.RK_DESKTOP_DEVICE_SHARED_SECRET || "",
  encryptionSecret: process.env.RK_DESKTOP_ENCRYPTION_SECRET || "",
  encryptionKeyVersion: process.env.RK_DESKTOP_ENCRYPTION_KEY_VERSION || "v1",
  plannerModel: process.env.RK_DESKTOP_PLANNER_MODEL || "gemini-3.1-flash-lite-preview",
  storage: {
    url: process.env.SUPABASE_URL || "",
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
    bucket: process.env.RK_DESKTOP_SUPABASE_BUCKET || process.env.SUPABASE_BUCKET || "user-files",
    tableNames: {
      jobs: process.env.RK_DESKTOP_TABLE_JOBS || "command",
      checkpoints: process.env.RK_DESKTOP_TABLE_CHECKPOINTS || "desktop_checkpoints",
      memories: process.env.RK_DESKTOP_TABLE_MEMORIES || "desktop_memories",
      experiences: process.env.RK_DESKTOP_TABLE_EXPERIENCES || "desktop_experiences",
      predictions: process.env.RK_DESKTOP_TABLE_PREDICTIONS || "desktop_predictions",
      executionGraph: process.env.RK_DESKTOP_TABLE_EXECUTION_GRAPH || "desktop_execution_graph",
      deviceSessions: process.env.RK_DESKTOP_TABLE_DEVICE_SESSIONS || "desktop_device_sessions",
    },
  },
};

export function requiresCloudExecution(plan) {
  return plan !== DESKTOP_PLANS.free;
}
