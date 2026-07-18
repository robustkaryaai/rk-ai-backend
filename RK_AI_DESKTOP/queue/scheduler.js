import { DESKTOP_CONFIG, DESKTOP_PLANS, DESKTOP_QUEUE_WEIGHTS } from "../configuration/index.js";
import { JOB_STATUS } from "../contracts/job.js";
import { metrics } from "../observability/metrics.js";

export function createWeightedScheduler({ store } = {}) {
  const queues = new Map([
    [DESKTOP_PLANS.core, []],
    [DESKTOP_PLANS.studio, []],
    [DESKTOP_PLANS.studio_max, []],
  ]);
  const jobsById = new Map();

  function countQueuedJobsForDevice(deviceId) {
    return [...jobsById.values()].filter(
      (job) => job.deviceId === deviceId && job.status === JOB_STATUS.waiting
    ).length;
  }

  function getPriorityScore(job) {
    const weight = DESKTOP_QUEUE_WEIGHTS[job.plan] || 1;
    const ageBoost = (Date.now() - new Date(job.createdAt).getTime()) / DESKTOP_CONFIG.queueAgingFactorMs;
    return weight + ageBoost;
  }

  function enqueueLocal(jobItem) {
    jobsById.set(jobItem.id, jobItem);
    const queue = queues.get(jobItem.plan);
    if (queue) queue.push(jobItem);
    try {
      metrics.inc('jobs_enqueued');
    } catch (e) {
      // ignore
    }
  }
  const scheduledTimers = new Map();
  let recoveryInterval = null;

  function scheduleDeferred(job) {
    const now = Date.now();
    const nextAttempt = job.next_attempt_at ? new Date(job.next_attempt_at).getTime() : job.nextAttemptAt ? new Date(job.nextAttemptAt).getTime() : 0;
    if (!nextAttempt || nextAttempt <= now) {
      enqueueLocal(job);
      return;
    }

    const delay = Math.max(0, nextAttempt - now);
    if (scheduledTimers.has(job.id)) return; // already scheduled
    const timer = setTimeout(async () => {
      try {
        enqueueLocal(job);
        if (store && store.updateJob) {
          try {
            await store.updateJob(job.id, { next_attempt_at: null });
          } catch (err) {
            // best-effort
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("Failed to enqueue deferred job", job.id, err.message || err);
      } finally {
        scheduledTimers.delete(job.id);
      }
    }, delay);
    scheduledTimers.set(job.id, timer);
  }

  function startRecoveryLoop(intervalMs = 60_000) {
    if (recoveryInterval) return;
    recoveryInterval = setInterval(async () => {
      if (!store || !store.listJobsByStatus) return;
      try {
        const waiting = await store.listJobsByStatus([JOB_STATUS.waiting]);
        const now = Date.now();
        for (const job of waiting) {
          const nextAttempt = job.next_attempt_at ? new Date(job.next_attempt_at).getTime() : 0;
          if (nextAttempt && nextAttempt > now && !scheduledTimers.has(job.id)) {
            scheduleDeferred(job);
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        if (!String(err.message || err).includes("schema cache")) {
          console.warn("Recovery loop error:", err.message || err);
        }
      }
    }, intervalMs);
  }

  function stopRecoveryLoop() {
    if (recoveryInterval) {
      clearInterval(recoveryInterval);
      recoveryInterval = null;
    }
  }

  return {
    async init() {
      if (!store || !store.listJobsByStatus) return;
      // Recover waiting jobs and jobs that were running but stale
      const waiting = await store.listJobsByStatus([JOB_STATUS.waiting]);
      const now = Date.now();
      for (const job of waiting) {
        try {
          const nextAttempt = job.next_attempt_at ? new Date(job.next_attempt_at).getTime() : job.nextAttemptAt ? new Date(job.nextAttemptAt).getTime() : 0;
          if (!nextAttempt || nextAttempt <= now) {
            enqueueLocal(job);
          } else {
            // schedule deferred enqueue
            scheduleDeferred(job);
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("Failed to enqueue recovered waiting job", job.id, err.message || err);
        }
      }

      const running = await store.listJobsByStatus([JOB_STATUS.running]);
      const STALE_MS = DESKTOP_CONFIG.deviceHeartbeatMs * 4;
      for (const job of running) {
        try {
          const started = job.started_at ? new Date(job.started_at).getTime() : 0;
          if (!started || now - started > STALE_MS) {
            // Requeue stale running jobs
            job.status = JOB_STATUS.waiting;
            job.retryCount = (job.retryCount || 0) + 1;
            enqueueLocal(job);
            if (store.updateJob) {
              try {
                await store.updateJob(job.id, { status: job.status, retryCount: job.retryCount });
              } catch (err) {
                // best-effort
                // eslint-disable-next-line no-console
                console.warn("Failed to persist requeued job", job.id, err.message || err);
              }
            }
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("Failed to process running job for recovery", job.id, err.message || err);
        }
      }
    },

    enqueue(job) {
      if (!queues.has(job.plan)) {
        throw new Error(`Plan ${job.plan} is not eligible for cloud scheduling.`);
      }
      if (countQueuedJobsForDevice(job.deviceId) >= DESKTOP_CONFIG.maxQueuedJobsPerDevice) {
        throw new Error("Too many queued jobs for this device.");
      }

      job.status = JOB_STATUS.waiting;
      enqueueLocal(job);
      if (DESKTOP_CONFIG.strictPersistence && store && store.updateJob) {
        try {
          store.updateJob(job.id, { status: job.status, lifecycle_stage: job.lifecycleStage });
        } catch (err) {
          // best-effort persistence
          // eslint-disable-next-line no-console
          console.warn("Scheduler persistence failed on enqueue:", err.message || err);
        }
      }
      return job;
    },

    async requeue(job, delayMs = 0) {
      // mark as waiting and persist next_attempt_at
      const nextAttemptAt = new Date(Date.now() + Math.max(0, delayMs)).toISOString();
      job.status = JOB_STATUS.waiting;
      job.nextAttemptAt = nextAttemptAt;
      if (store && store.updateJob) {
        try {
          await store.updateJob(job.id, { status: job.status, next_attempt_at: nextAttemptAt });
        } catch (err) {
          // best-effort
          // eslint-disable-next-line no-console
          console.warn("Failed to persist requeue info for job", job.id, err.message || err);
        }
      }

      // clear any existing timer
      if (scheduledTimers.has(job.id)) {
        clearTimeout(scheduledTimers.get(job.id));
        scheduledTimers.delete(job.id);
      }

      if (delayMs <= 0) {
        enqueueLocal(job);
        // clear nextAttemptAt when enqueued
        job.nextAttemptAt = null;
        if (store && store.updateJob) {
          try {
            await store.updateJob(job.id, { next_attempt_at: null });
          } catch (err) {
            // best-effort
          }
        }
        return job;
      }

      // schedule via centralized helper (dedupes timers)
      scheduleDeferred(job);
      try {
        metrics.inc('jobs_requeued');
      } catch (e) {}
      return job;
    },

    next() {
      const candidates = [...queues.values()]
        .map((queue) => queue[0])
        .filter(Boolean)
        .sort((a, b) => getPriorityScore(b) - getPriorityScore(a));

      const nextJob = candidates[0];
      if (!nextJob) return null;

      const queue = queues.get(nextJob.plan);
      queue.shift();
      jobsById.set(nextJob.id, nextJob);
      try {
        metrics.inc('jobs_dequeued');
      } catch (e) {}
      if (DESKTOP_CONFIG.strictPersistence && store && store.updateJob) {
        try {
          store.updateJob(nextJob.id, { status: JOB_STATUS.running, lifecycle_stage: nextJob.lifecycleStage });
        } catch (err) {
          // best-effort
          // eslint-disable-next-line no-console
          console.warn("Scheduler persistence failed on next():", err.message || err);
        }
      }
      return nextJob;
    },
    get(jobId) {
      return jobsById.get(jobId) || null;
    },

    startRecoveryLoop,
    stopRecoveryLoop,

    snapshot() {
      return {
        waiting: Object.fromEntries(
          [...queues.entries()].map(([plan, queue]) => [plan, queue.map((job) => job.id)])
        ),
      };
    },
  };
}
