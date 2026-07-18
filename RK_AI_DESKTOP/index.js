
import express from "express";
import aiRouter from "./endpoints/ai.js";
import authRouter from "./endpoints/auth.js";
import searchRouter from "./endpoints/search.js";
import knowledgeRouter from "./endpoints/knowledge.js";
import billingRouter from "./endpoints/billing.js";
import { createDesktopApiRouter } from "./api/router.js";
import { createAppwritePlanService } from "./providers/appwritePlanService.js";
import { createAppwriteDesktopStore } from "./providers/appwriteDesktopStore.js";
import { createReasoningProvider } from "./providers/reasoningProvider.js";
import { createDeviceBridgeRegistry } from "./device_bridge/registry.js";
import { createDesktopMemoryService } from "./memory/service.js";
import { createDesktopPlanner } from "./planner.js";
import { createPlanValidator } from "./execution/planValidator.js";
import { createToolExecutor } from "./execution/toolExecutor.js";
import { createWeightedScheduler } from "./queue/scheduler.js";
import { createWorkerPool } from "./queue/workerPool.js";
import { createDesktopManager } from "./manager.js";

const desktopRouter = express.Router();
const legacyRouter = express.Router();

const planService = createAppwritePlanService();
const store = createAppwriteDesktopStore();
const bridge = createDeviceBridgeRegistry({ store });
const memoryService = createDesktopMemoryService({ store });
const planner = createDesktopPlanner({
  reasoningProvider: createReasoningProvider(),
});
const validator = createPlanValidator();
const executor = createToolExecutor({ bridge });
const scheduler = createWeightedScheduler({ store });
const manager = createDesktopManager({
  planService,
  store,
  scheduler,
  bridge,
  memoryService,
  planner,
  validator,
  executor,
});
const workerPool = createWorkerPool({ scheduler, manager });
// Initialize scheduler recovery before starting workers
if (typeof scheduler.init === "function") {
  // best-effort await
  await scheduler.init();
}
workerPool.start();
// start recovery loop to persist and rehydrate deferred requeues
if (typeof scheduler.startRecoveryLoop === "function") {
  scheduler.startRecoveryLoop();
}

// graceful shutdown
async function shutdown() {
  try {
    if (workerPool && typeof workerPool.stop === "function") {
      await workerPool.stop(30_000);
    }
  } finally {
    if (typeof scheduler.stopRecoveryLoop === "function") scheduler.stopRecoveryLoop();
    process.exit(0);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

desktopRouter.use(
  "/",
  createDesktopApiRouter({
    manager,
    bridge,
    planService,
    scheduler,
  })
);

// Legacy routes remain available under /rk-ai-desktop/legacy during migration.
legacyRouter.use("/ai", aiRouter);
legacyRouter.use("/auth", authRouter);
legacyRouter.use("/search", searchRouter);
legacyRouter.use("/knowledge", knowledgeRouter);
legacyRouter.use("/billing", billingRouter);
desktopRouter.use("/legacy", legacyRouter);

export default desktopRouter;
