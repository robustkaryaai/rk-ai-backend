import { DESKTOP_CONFIG } from "../configuration/index.js";

export function createWorkerPool({ scheduler, manager }) {
  let started = false;
  const activeWorkers = new Set();

  async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function runWorker(workerId) {
    while (started) {
      const job = scheduler.next();
      if (!job) {
        await sleep(500);
        continue;
      }

      activeWorkers.add(workerId);
      try {
        await manager.processJob(job);
      } catch (error) {
        try {
          await manager.failJob(job, error);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("Error while failing job:", err.message || err);
        }
      } finally {
        activeWorkers.delete(workerId);
      }
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      for (let index = 0; index < DESKTOP_CONFIG.workerCount; index += 1) {
        runWorker(index);
      }
    },

    async stop(timeoutMs = 30_000) {
      started = false;
      const start = Date.now();
      while (activeWorkers.size > 0 && Date.now() - start < timeoutMs) {
        // wait for active workers to finish
        // eslint-disable-next-line no-await-in-loop
        await sleep(500);
      }
      return activeWorkers.size === 0;
    },

    health() {
      return {
        started,
        activeWorkers: activeWorkers.size,
        queue: scheduler.snapshot(),
      };
    },
  };
}
