
import express from "express";
import aiRouter from "./endpoints/ai.js";
import authRouter from "./endpoints/auth.js";
import searchRouter from "./endpoints/search.js";
import knowledgeRouter from "./endpoints/knowledge.js";
import billingRouter from "./endpoints/billing.js";
import { createDesktopApiRouter } from "./api/router.js";
import { createAppwritePlanService } from "./providers/appwritePlanService.js";
import { createSupabaseDesktopStore } from "./providers/supabaseDesktopStore.js";
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
const store = createSupabaseDesktopStore();
const bridge = createDeviceBridgeRegistry({ store });
const memoryService = createDesktopMemoryService({ store });
const planner = createDesktopPlanner({
  reasoningProvider: createReasoningProvider(),
});
const validator = createPlanValidator();
const executor = createToolExecutor({ bridge });
const scheduler = createWeightedScheduler();
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
workerPool.start();

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
