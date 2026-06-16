import { DESKTOP_CONFIG } from "../configuration/index.js";

export function createWorkerPool({ scheduler, manager }) {
  let started = false;
  const activeWorkers = new Set();

  async function runWorker(workerId) {
    while (started) {
      if (activeWorkers.has(workerId)) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }

      const job = scheduler.next();
      if (!job) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }

      activeWorkers.add(workerId);
      try {
        await manager.processJob(job);
      } catch (error) {
        await manager.failJob(job, error);
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

    stop() {
      started = false;
    },
  };
}
