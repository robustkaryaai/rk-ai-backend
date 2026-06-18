import { randomUUID } from "crypto";
import { decryptJson, encryptJson } from "./encryption.js";

export function createDesktopMemoryService({ store }) {
  const activeContexts = new Map();

  return {
    async loadPersistentMemory({ userId, deviceId }) {
      const safeUserId = userId || deviceId;

      const [longTermRaw, semanticRaw, predictionsRaw, recentExperiences] = await Promise.all([
        store.loadEncryptedMemory("long_term", safeUserId),
        store.loadEncryptedMemory("semantic", safeUserId),
        store.loadEncryptedMemory("prediction_matrix", safeUserId),
        store.listRecentExperiences(safeUserId, 5),
      ]);

      return {
        shortTerm: {
          recentMessages: [],
          activePlan: null,
          activeTasks: [],
        },
        longTerm: longTermRaw
          ? decryptJson({ userId: safeUserId, scope: "long_term", buffer: longTermRaw })
          : { preferences: [], habits: [], facts: [] },
        semantic: semanticRaw
          ? decryptJson({ userId: safeUserId, scope: "semantic", buffer: semanticRaw })
          : { embeddings: [], relationships: [] },
        experiences: recentExperiences,
        predictions: predictionsRaw
          ? decryptJson({ userId: safeUserId, scope: "prediction_matrix", buffer: predictionsRaw })
          : { transitions: [] },
      };
    },

    buildExecutionContext({ job, planAccess, deviceState, memory }) {
      const runtimeContext = {
        id: randomUUID(),
        userId: job.userId || job.deviceId,
        jobId: job.id,
        deviceId: job.deviceId,
        deviceSlug: job.deviceSlug,
        deviceState: deviceState || {},
        goal: job.goal,
        planAccess,
        memory,
        createdAt: new Date().toISOString(),
      };

      activeContexts.set(job.id, runtimeContext);
      return runtimeContext;
    },

    getActiveContext(jobId) {
      return activeContexts.get(jobId) || null;
    },

    async saveExecutionOutcome({ job, memory, experience, executionGraph, predictionMatrix }) {
      const safeUserId = job.userId || job.deviceId;

      await Promise.all([
        store.saveEncryptedMemory({
          scope: "long_term",
          key: safeUserId,
          payloadBuffer: encryptJson({
            userId: safeUserId,
            scope: "long_term",
            value: memory.longTerm,
          }),
          metadata: { jobId: job.id },
        }),
        store.saveEncryptedMemory({
          scope: "semantic",
          key: safeUserId,
          payloadBuffer: encryptJson({
            userId: safeUserId,
            scope: "semantic",
            value: memory.semantic,
          }),
          metadata: { jobId: job.id },
        }),
        store.saveEncryptedMemory({
          scope: "prediction_matrix",
          key: safeUserId,
          payloadBuffer: encryptJson({
            userId: safeUserId,
            scope: "prediction_matrix",
            value: predictionMatrix,
          }),
          metadata: { jobId: job.id },
        }),
        store.saveExperience({
          ...experience,
          id: experience.id || randomUUID(),
          user_id: safeUserId,
          device_id: job.deviceId,
          job_id: job.id,
        }),
        store.saveExecutionGraph({
          ...executionGraph,
          id: executionGraph.id || randomUUID(),
          user_id: safeUserId,
          device_id: job.deviceId,
          job_id: job.id,
        }),
      ]);
    },

    purge(jobId) {
      activeContexts.delete(jobId);
    },
  };
}
