import { randomUUID } from "crypto";
import { JOB_STATUS, createJobRecord, JOB_LIFECYCLE } from "./contracts/job.js";
import { getPlanFeatures } from "./contracts/plans.js";
import { getAutonomyPolicy } from "./autonomy/policy.js";
import { DESKTOP_CONFIG } from "./configuration/index.js";

export function createDesktopManager({
  planService,
  store,
  scheduler,
  bridge,
  memoryService,
  planner,
  validator,
  executor,
}) {
  const checkpointSequences = new Map();

  async function setJobState(job, patch) {
    // lifecycle enforcement: ensure transitions follow JOB_LIFECYCLE ordering or allow same
    if (patch.lifecycleStage) {
      const currentIndex = JOB_LIFECYCLE.indexOf(job.lifecycleStage);
      const nextIndex = JOB_LIFECYCLE.indexOf(patch.lifecycleStage);
      if (currentIndex >= 0 && nextIndex >= 0 && nextIndex < currentIndex) {
        throw new Error(`Invalid lifecycle transition from ${job.lifecycleStage} -> ${patch.lifecycleStage}`);
      }
    }

    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    if (store && store.updateJob) await store.updateJob(job.id, patch);
    return job;
  }

  async function saveCheckpoint(job, payload) {
    const sequence = (checkpointSequences.get(job.id) || 0) + 1;
    checkpointSequences.set(job.id, sequence);
    await store.saveCheckpoint(job.id, {
      ...payload,
      sequence,
      lifecycleStage: job.lifecycleStage,
      createdAt: new Date().toISOString(),
    });
  }

  return {
    async createJobRequest({ deviceSlug, sessionId, goal, metadata = {} }) {
      const access = await planService.verifyDeviceAccess(deviceSlug);
      const planFeatures = getPlanFeatures(access.plan);

      if (!planFeatures.cloudExecution) {
        throw new Error("Free plan requests must execute locally and cannot enter the cloud queue.");
      }

      const activeSession = bridge.getActiveSession(access.deviceId);
      if (!activeSession) {
        throw new Error("The owning desktop client is not connected or heartbeat is stale.");
      }
      if (sessionId && activeSession.sessionId !== sessionId) {
        throw new Error("Active device session does not match the supplied session.");
      }

      const job = createJobRecord({
        userId: access.userId || access.deviceId,
        deviceId: access.deviceId,
        deviceSlug: access.deviceSlug,
        sessionId: activeSession.sessionId,
        goal,
        metadata,
      });
      job.plan = access.plan;

      await store.createJob({
        id: job.id,
        user_id: job.userId,
        device_id: job.deviceId,
        device_slug: job.deviceSlug,
        session_id: job.sessionId,
        goal: job.goal,
        metadata: job.metadata,
        plan: job.plan,
        status: job.status,
        lifecycle_stage: job.lifecycleStage,
        created_at: job.createdAt,
        updated_at: job.updatedAt,
      });

      scheduler.enqueue(job);
      await saveCheckpoint(job, {
        objective: job.goal,
        planVersion: 1,
        completedTasks: [],
        pendingTasks: [],
        executionState: "queued",
        retryCounts: {},
        memorySummary: {},
        deviceStateSummary: activeSession.state || {},
      });

      return {
        jobId: job.id,
        plan: access.plan,
        status: job.status,
        deviceId: job.deviceId,
      };
    },

    async processJob(job) {
      const planAccess = {
        plan: job.plan,
        ...getPlanFeatures(job.plan),
      };
      const autonomyPolicy = getAutonomyPolicy(job.plan);
      const activeSession = bridge.ensureAuthorizedSession({
        deviceId: job.deviceId,
        sessionId: job.sessionId,
        userId: job.userId,
      });

      await setJobState(job, {
        status: JOB_STATUS.running,
        lifecycleStage: "load_memory",
        startedAt: new Date().toISOString(),
      });

      // Attempt to resume from latest checkpoint if present
      const latestCheckpointRecord = await store.getLatestCheckpoint(job.id);
      let checkpointPayload = null;
      if (latestCheckpointRecord) {
        try {
          checkpointPayload = await store.loadCheckpointPayload(latestCheckpointRecord);
        } catch (err) {
          // best-effort; ignore and continue fresh
          checkpointPayload = null;
        }
      }

      const memory = await memoryService.loadPersistentMemory({
        userId: job.userId,
        deviceId: job.deviceId,
      });
      await saveCheckpoint(job, {
        objective: job.goal,
        planVersion: 1,
        completedTasks: [],
        pendingTasks: [],
        executionState: "memory_loaded",
        retryCounts: {},
        memorySummary: {
          experiences: memory.experiences.length,
          longTermFacts: memory.longTerm.facts?.length || 0,
        },
        deviceStateSummary: activeSession.state || {},
      });

      await setJobState(job, { lifecycleStage: "build_context" });
      const context = memoryService.buildExecutionContext({
        job,
        planAccess,
        deviceState: activeSession.state,
        memory,
      });


      let plan = null;
      let completedTasks = [];
      if (checkpointPayload && checkpointPayload.plan) {
        // resume from checkpoint
        plan = checkpointPayload.plan;
        completedTasks = checkpointPayload.completedTasks || [];
        await setJobState(job, { plan, lifecycleStage: "resume" });
      } else {
        await setJobState(job, { lifecycleStage: "plan" });
        plan = await planner.createPlan({
          goal: job.goal,
          context,
          planAccess,
        });
        await setJobState(job, { plan, lifecycleStage: "validate" });

        validator.validatePlan({ plan, planAccess });
        await saveCheckpoint(job, {
          objective: job.goal,
          planVersion: 1,
          plan,
          completedTasks: [],
          pendingTasks: plan.steps.map((step) => step.id),
          executionState: "validated",
          retryCounts: {},
          memorySummary: {
            recentExperienceIds: memory.experiences.map((experience) => experience.id),
          },
          deviceStateSummary: activeSession.state || {},
        });
      }

      await setJobState(job, { lifecycleStage: "execute" });

      let stepResults = checkpointPayload && checkpointPayload.stepResults ? checkpointPayload.stepResults.slice() : [];
      // If we resumed, skip already completed steps
      const pendingStepIds = plan.steps.map((s) => s.id).filter((id) => !completedTasks.includes(id));
      for (const step of plan.steps.filter((s) => pendingStepIds.includes(s.id))) {
        let attempt = 0;
        const maxRetries = (autonomyPolicy && autonomyPolicy.maxRetries) || DESKTOP_CONFIG.maxStepRetries || 3;
        const baseMs = DESKTOP_CONFIG.retryBaseMs || 1000;
        const maxMs = DESKTOP_CONFIG.retryMaxMs || 30000;

        while (true) {
          try {
            const result = await executor.executeStep({ job, step, autonomyPolicy });
            completedTasks.push(step.id);
            stepResults.push({
              stepId: step.id,
              tool: step.tool,
              result,
            });

            await setJobState(job, { lifecycleStage: "checkpointing" });
            await saveCheckpoint(job, {
              objective: job.goal,
              planVersion: 1,
              completedTasks,
              pendingTasks: plan.steps
                .map((entry) => entry.id)
                .filter((stepId) => !completedTasks.includes(stepId)),
              executionState: "step_completed",
              retryCounts: { [step.id]: attempt },
              stepResults,
              memorySummary: {
                lastTool: step.tool,
              },
              deviceStateSummary: activeSession.state || {},
            });
            await setJobState(job, { lifecycleStage: "execute" });
            break;
          } catch (err) {
            attempt += 1;
            job.retryCount = (job.retryCount || 0) + 1;
            await setJobState(job, { lifecycleStage: "retry" });
            await saveCheckpoint(job, {
              objective: job.goal,
              planVersion: 1,
              completedTasks,
              pendingTasks: plan.steps
                .map((entry) => entry.id)
                .filter((stepId) => !completedTasks.includes(stepId)),
              executionState: "step_failed",
              retryCounts: { [step.id]: attempt },
              stepResults,
              memorySummary: { lastTool: step.tool },
              deviceStateSummary: activeSession.state || {},
            });

            if (attempt > maxRetries) {
              // Exhausted retries for this step — surface error to worker which will call failJob
              throw new Error(`Step ${step.id} (${step.tool}) failed after ${attempt} attempts: ${err.message}`);
            }

            // Exponential backoff before retrying
            const backoff = Math.min(baseMs * 2 ** (attempt - 1), maxMs);
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => setTimeout(resolve, backoff));
            // continue retrying
          }
        }
      }

      await setJobState(job, {
        status: JOB_STATUS.verifying,
        lifecycleStage: "verify_execution",
      });

      const report = {
        id: randomUUID(),
        summary: plan.summary,
        goal: job.goal,
        reasoning: plan.reasoning,
        stepsExecuted: stepResults.length,
        results: stepResults,
        autonomyPolicy,
      };

      await setJobState(job, { status: JOB_STATUS.checkpointing, lifecycleStage: "save" });
      await memoryService.saveExecutionOutcome({
        job,
        memory,
        experience: {
          objective: job.goal,
          outcome: "success",
          plan_summary: plan.summary,
          tools_used: stepResults.map((result) => result.tool),
          failures: [],
          retries: job.retryCount,
          execution_duration_ms:
            new Date().getTime() - new Date(job.startedAt || job.createdAt).getTime(),
        },
        executionGraph: {
          goal: job.goal,
          plan_summary: plan.summary,
          tasks: plan.steps.map((step) => ({
            id: step.id,
            tool: step.tool,
            objective: step.objective,
          })),
          results: stepResults,
          success: true,
        },
        predictionMatrix: {
          transitions: stepResults
            .slice(0, -1)
            .map((result, index) => ({
              from: result.tool,
              to: stepResults[index + 1].tool,
              confidence: 0.7,
            })),
        },
      });

      await setJobState(job, {
        status: JOB_STATUS.completed,
        lifecycleStage: "complete",
        finishedAt: new Date().toISOString(),
        report,
      });
      memoryService.purge(job.id);
      checkpointSequences.delete(job.id);

      return report;
    },

    async failJob(job, error) {
      // increment retry count
      job.retryCount = (job.retryCount || 0) + 1;

      const maxJobRetries = DESKTOP_CONFIG.maxJobRetries || 2;
      if (job.retryCount <= maxJobRetries && scheduler && typeof scheduler.requeue === "function") {
        // schedule requeue with exponential backoff
        const base = DESKTOP_CONFIG.retryBaseMs || 1000;
        const maxMs = DESKTOP_CONFIG.retryMaxMs || 30000;
        const delay = Math.min(base * 2 ** (job.retryCount - 1), maxMs);

        await setJobState(job, {
          status: JOB_STATUS.waiting,
          lifecycleStage: "retry_scheduled",
          retryCount: job.retryCount,
        });

        await saveCheckpoint(job, {
          objective: job.goal,
          planVersion: 1,
          completedTasks: [],
          pendingTasks: [],
          executionState: "scheduled_retry",
          retryCounts: { overall: job.retryCount },
          memorySummary: {},
          deviceStateSummary: {},
        });

        await scheduler.requeue(job, delay);
        memoryService.purge(job.id);
        checkpointSequences.delete(job.id);
        return job;
      }

      // exhausted retries — mark failed
      await setJobState(job, {
        status: JOB_STATUS.failed,
        lifecycleStage: "complete",
        finishedAt: new Date().toISOString(),
        report: {
          summary: "Execution failed",
          error: error.message,
        },
      });
      await saveCheckpoint(job, {
        objective: job.goal,
        planVersion: 1,
        completedTasks: [],
        pendingTasks: [],
        executionState: "failed",
        retryCounts: {},
        memorySummary: {},
        deviceStateSummary: {},
      });
      memoryService.purge(job.id);
      checkpointSequences.delete(job.id);
      return job;
    },

    async getJob(jobId) {
      return store.getJob(jobId);
    },

    async cancelJob(jobId) {
      const queuedJob = scheduler.cancel(jobId);
      if (queuedJob) {
        await setJobState(queuedJob, {
          status: JOB_STATUS.cancelled,
          lifecycleStage: "complete",
          finishedAt: new Date().toISOString(),
        });
        return queuedJob;
      }

      const persisted = await store.getJob(jobId);
      if (!persisted) return null;
      if (persisted.status === JOB_STATUS.running) {
        throw new Error("Running jobs cannot be cancelled yet.");
      }
      return store.updateJob(jobId, {
        status: JOB_STATUS.cancelled,
        lifecycle_stage: "complete",
        finished_at: new Date().toISOString(),
      });
    },
  };
}
