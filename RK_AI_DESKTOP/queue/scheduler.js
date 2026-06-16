import { DESKTOP_CONFIG, DESKTOP_PLANS, DESKTOP_QUEUE_WEIGHTS } from "../configuration/index.js";
import { JOB_STATUS } from "../contracts/job.js";

export function createWeightedScheduler() {
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

  return {
    enqueue(job) {
      if (!queues.has(job.plan)) {
        throw new Error(`Plan ${job.plan} is not eligible for cloud scheduling.`);
      }
      if (countQueuedJobsForDevice(job.deviceId) >= DESKTOP_CONFIG.maxQueuedJobsPerDevice) {
        throw new Error("Too many queued jobs for this device.");
      }

      job.status = JOB_STATUS.waiting;
      jobsById.set(job.id, job);
      queues.get(job.plan).push(job);
      return job;
    },

    cancel(jobId) {
      const job = jobsById.get(jobId);
      if (!job) return null;
      job.status = JOB_STATUS.cancelled;
      for (const queue of queues.values()) {
        const index = queue.findIndex((entry) => entry.id === jobId);
        if (index >= 0) {
          queue.splice(index, 1);
        }
      }
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
      return nextJob;
    },

    get(jobId) {
      return jobsById.get(jobId) || null;
    },

    snapshot() {
      return {
        waiting: Object.fromEntries(
          [...queues.entries()].map(([plan, queue]) => [plan, queue.map((job) => job.id)])
        ),
      };
    },
  };
}
