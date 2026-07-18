import { db } from "../../RK_AI_HOME/services/appwriteClient.js";
import { ID, Query } from "node-appwrite";
import { DESKTOP_CONFIG } from "../configuration/index.js";

function nowIso() {
  return new Date().toISOString();
}

function createMemoryFallback() {
  return {
    checkpoints: new Map(),
    memory: new Map(),
    experiences: new Map(),
    predictions: new Map(),
    executionGraph: new Map(),
    deviceSessions: new Map(),
  };
}

function deserializeJob(doc) {
  let rest = {};
  try {
    rest = JSON.parse(doc.payload || "{}");
  } catch (e) {}

  let result = doc.result;
  try {
    result = JSON.parse(doc.result);
  } catch (e) {}

  return {
    id: doc.$id,
    deviceId: String(doc.slug),
    type: doc.commandType,
    status: doc.status,
    created_at: doc.createdAt,
    executed_at: doc.executedAt,
    result: result,
    ...rest,
  };
}

export function createAppwriteDesktopStore() {
  const memoryFallback = createMemoryFallback();

  return {
    async createJob(job) {
      const payloadObj = { ...job };
      delete payloadObj.id;
      delete payloadObj.deviceId;
      delete payloadObj.type;
      delete payloadObj.status;
      delete payloadObj.created_at;
      delete payloadObj.executed_at;
      delete payloadObj.result;

      const appwritePayload = {
        slug: Number(job.deviceId) || 0,
        commandType: (job.type || "unknown").slice(0, 50),
        payload: JSON.stringify(payloadObj).slice(0, 500),
        status: job.status || "waiting",
        createdAt: job.created_at || nowIso(),
      };

      const doc = await db.createDocument(
        process.env.APPWRITE_DB_ID,
        DESKTOP_CONFIG.storage.tableNames.jobs,
        job.id && job.id.length <= 36 ? job.id : ID.unique(),
        appwritePayload
      );
      return deserializeJob(doc);
    },

    async updateJob(jobId, patch) {
      const current = await this.getJob(jobId);
      if (!current) return null;
      const updatedJob = { ...current, ...patch };

      const payloadObj = { ...updatedJob };
      delete payloadObj.id;
      delete payloadObj.deviceId;
      delete payloadObj.type;
      delete payloadObj.status;
      delete payloadObj.created_at;
      delete payloadObj.executed_at;
      delete payloadObj.result;

      const appwritePayload = {
        status: updatedJob.status,
        payload: JSON.stringify(payloadObj).slice(0, 500),
      };

      if (updatedJob.executed_at) appwritePayload.executedAt = updatedJob.executed_at;
      if (updatedJob.result) {
        appwritePayload.result =
          typeof updatedJob.result === "string"
            ? updatedJob.result.slice(0, 500)
            : JSON.stringify(updatedJob.result).slice(0, 500);
      }

      const doc = await db.updateDocument(
        process.env.APPWRITE_DB_ID,
        DESKTOP_CONFIG.storage.tableNames.jobs,
        jobId,
        appwritePayload
      );

      return deserializeJob(doc);
    },

    async getJob(jobId) {
      try {
        const doc = await db.getDocument(
          process.env.APPWRITE_DB_ID,
          DESKTOP_CONFIG.storage.tableNames.jobs,
          jobId
        );
        return deserializeJob(doc);
      } catch (err) {
        return null;
      }
    },

    async listJobsByStatus(statuses = []) {
      if (!statuses.length) return [];
      try {
        const queries = [Query.limit(100)];
        if (statuses.length === 1) {
          queries.push(Query.equal("status", statuses[0]));
        } else {
          queries.push(Query.equal("status", statuses));
        }

        const res = await db.listDocuments(
          process.env.APPWRITE_DB_ID,
          DESKTOP_CONFIG.storage.tableNames.jobs,
          queries
        );
        return res.documents.map(deserializeJob);
      } catch (err) {
        return [];
      }
    },

    // ── FALLBACK FOR OTHER STORE METHODS ──────────────────────────────
    async saveCheckpoint(jobId, checkpoint) {
      const id = `${jobId}:${checkpoint.sequence}`;
      const blobPath = `desktop/checkpoints/${jobId}/${checkpoint.sequence}.json`;
      const body = Buffer.from(JSON.stringify(checkpoint), "utf8");
      memoryFallback.checkpoints.set(blobPath, body.toString("base64"));
      return { id, job_id: jobId, sequence: checkpoint.sequence, blob_path: blobPath };
    },

    async getLatestCheckpoint(jobId) {
      const matches = [...memoryFallback.checkpoints.keys()].filter((p) => p.includes(`/${jobId}/`));
      if (!matches.length) return null;
      const latestPath = matches.sort().reverse()[0];
      return { blob_path: latestPath, sequence: parseInt(latestPath.split("/").pop(), 10) };
    },

    async loadCheckpointPayload(checkpointRecord) {
      if (!checkpointRecord?.blob_path) return null;
      const b64 = memoryFallback.checkpoints.get(checkpointRecord.blob_path);
      return b64 ? JSON.parse(Buffer.from(b64, "base64").toString("utf8")) : null;
    },

    async saveEncryptedMemory({ scope, key, payloadBuffer, metadata = {} }) {
      const blobPath = `desktop/memory/${scope}/${key}.bin`;
      memoryFallback.memory.set(blobPath, payloadBuffer.toString("base64"));
      return { id: `${scope}:${key}`, scope, key, blob_path: blobPath };
    },

    async loadEncryptedMemory(scope, key) {
      const b64 = memoryFallback.memory.get(`desktop/memory/${scope}/${key}.bin`);
      return b64 ? Buffer.from(b64, "base64") : null;
    },

    async saveExperience(experience) {
      memoryFallback.experiences.set(experience.id, experience);
      return experience;
    },

    async listRecentExperiences(userId, limit = 5) {
      return [...memoryFallback.experiences.values()]
        .filter((item) => item.user_id === userId)
        .slice(0, limit);
    },

    async savePrediction(prediction) {
      memoryFallback.predictions.set(prediction.id, prediction);
      return prediction;
    },

    async saveExecutionGraph(graph) {
      memoryFallback.executionGraph.set(graph.id, graph);
      return graph;
    },

    async upsertDeviceSession(record) {
      memoryFallback.deviceSessions.set(record.id, record);
      return record;
    },
  };
}
