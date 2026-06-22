import { DESKTOP_CONFIG } from "../configuration/index.js";

function nowIso() {
  return new Date().toISOString();
}

function sanitizeUrl(rawUrl) {
  if (!rawUrl) return "";
  try {
    const url = new URL(rawUrl);
    return `${url.protocol}//${url.hostname}`;
  } catch {
    return rawUrl;
  }
}

function describeError(err) {
  const message = String(err?.message || "");
  return {
    name: err?.name,
    message: message.length > 500 ? `${message.slice(0, 500)}...` : message,
    code: err?.code,
    details: err?.details,
    hint: err?.hint,
    cause: err?.cause
      ? {
          name: err.cause.name,
          message: err.cause.message,
          code: err.cause.code,
          errno: err.cause.errno,
          syscall: err.cause.syscall,
          hostname: err.cause.hostname,
          address: err.cause.address,
          port: err.cause.port,
        }
      : null,
  };
}

function createMemoryFallback() {
  return {
    jobs: new Map(),
    checkpoints: new Map(),
    memory: new Map(),
    experiences: new Map(),
    predictions: new Map(),
    executionGraph: new Map(),
    deviceSessions: new Map(),
  };
}

export function createSupabaseDesktopStore() {
  const hasConfig =
    Boolean(DESKTOP_CONFIG.storage.url) && Boolean(DESKTOP_CONFIG.storage.serviceRoleKey);
  let client = null;
  let lastListJobsFailureLogAt = 0;
  if (hasConfig) {
    console.log("[Desktop Store] Supabase persistence configured", {
      url: sanitizeUrl(DESKTOP_CONFIG.storage.url),
      bucket: DESKTOP_CONFIG.storage.bucket,
      jobsTable: DESKTOP_CONFIG.storage.tableNames.jobs,
      strictPersistence: DESKTOP_CONFIG.strictPersistence,
    });
    // dynamically import to avoid hard dependency in tests/environments without @supabase/supabase-js
    import('@supabase/supabase-js')
      .then((mod) => {
        try {
          client = mod.createClient(DESKTOP_CONFIG.storage.url, DESKTOP_CONFIG.storage.serviceRoleKey);
          console.log("[Desktop Store] Supabase client initialized", {
            url: sanitizeUrl(DESKTOP_CONFIG.storage.url),
            jobsTable: DESKTOP_CONFIG.storage.tableNames.jobs,
          });
        } catch (err) {
          console.warn("[Desktop Store] Supabase client initialization failed", describeError(err));
          client = null;
        }
      })
      .catch((err) => {
        console.warn("[Desktop Store] Supabase module import failed", describeError(err));
        // keep client null (use in-memory fallback)
      });
  } else {
    console.warn("[Desktop Store] Supabase persistence not configured", {
      hasUrl: Boolean(DESKTOP_CONFIG.storage.url),
      hasServiceRoleKey: Boolean(DESKTOP_CONFIG.storage.serviceRoleKey),
      strictPersistence: DESKTOP_CONFIG.strictPersistence,
    });
  }
  const memoryFallback = createMemoryFallback();

  function ensureStoreReady() {
    if (client) return;
    if (!DESKTOP_CONFIG.strictPersistence) return;
    // allow an explicit override for in-memory fallback (useful for tests/dev)
    if (process.env.RK_DESKTOP_ALLOW_INMEMORY_FALLBACK === '1') return;
    console.warn("⚠️ RK AI Desktop persistence requires Supabase configuration. Falling back to in-memory store.");
  }

  async function uploadBlob(blobPath, body, contentType = "application/json") {
    ensureStoreReady();
    if (!client) {
      return { path: blobPath, fallbackBody: body.toString("base64") };
    }

    const { error } = await client.storage
      .from(DESKTOP_CONFIG.storage.bucket)
      .upload(blobPath, body, {
        contentType,
        cacheControl: "0",
        upsert: true,
      });

    if (error) {
      throw error;
    }

    return { path: blobPath };
  }

  async function downloadBlob(blobPath, fallbackCollection) {
    ensureStoreReady();
    if (!client) {
      const value = fallbackCollection.get(blobPath);
      return value ? Buffer.from(value, "base64") : null;
    }

    const { data, error } = await client.storage
      .from(DESKTOP_CONFIG.storage.bucket)
      .download(blobPath);

    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer());
  }

  async function upsert(table, payload, fallbackMap) {
    ensureStoreReady();
    if (!client) {
      fallbackMap.set(payload.id, payload);
      return payload;
    }

    const { data, error } = await client
      .from(table)
      .upsert(payload, { onConflict: "id" })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async function getById(table, id, fallbackMap) {
    ensureStoreReady();
    if (!client) {
      return fallbackMap.get(id) || null;
    }

    const { data, error } = await client
      .from(table)
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  return {
    async createJob(job) {
      return upsert(
        DESKTOP_CONFIG.storage.tableNames.jobs,
        { ...job, updated_at: nowIso() },
        memoryFallback.jobs
      );
    },

    async updateJob(jobId, patch) {
      const current = (await this.getJob(jobId)) || { id: jobId };
      return upsert(
        DESKTOP_CONFIG.storage.tableNames.jobs,
        {
          ...current,
          ...patch,
          id: jobId,
          updated_at: nowIso(),
        },
        memoryFallback.jobs
      );
    },

    async getJob(jobId) {
      return getById(DESKTOP_CONFIG.storage.tableNames.jobs, jobId, memoryFallback.jobs);
    },

    async listJobsByStatus(statuses = []) {
      ensureStoreReady();
      if (!client) {
        return [...memoryFallback.jobs.values()].filter((j) => statuses.includes(j.status));
      }

      let data;
      let error;
      try {
        const result = await client
          .from(DESKTOP_CONFIG.storage.tableNames.jobs)
          .select("*")
          .in("status", statuses);
        data = result.data;
        error = result.error;
      } catch (err) {
        const now = Date.now();
        if (now - lastListJobsFailureLogAt > 5 * 60 * 1000) {
          lastListJobsFailureLogAt = now;
          console.warn("[Desktop Store] listJobsByStatus fetch failed; using in-memory fallback for recovery scan", {
            url: sanitizeUrl(DESKTOP_CONFIG.storage.url),
            table: DESKTOP_CONFIG.storage.tableNames.jobs,
            statuses,
            error: describeError(err),
          });
        }
        return [...memoryFallback.jobs.values()].filter((j) => statuses.includes(j.status));
      }

      if (error) {
        const now = Date.now();
        if (now - lastListJobsFailureLogAt > 5 * 60 * 1000) {
          lastListJobsFailureLogAt = now;
          console.warn("[Desktop Store] listJobsByStatus Supabase error; using in-memory fallback for recovery scan", {
            url: sanitizeUrl(DESKTOP_CONFIG.storage.url),
            table: DESKTOP_CONFIG.storage.tableNames.jobs,
            statuses,
            error: describeError(error),
          });
        }
        return [...memoryFallback.jobs.values()].filter((j) => statuses.includes(j.status));
      }
      return data || [];
    },

    async saveCheckpoint(jobId, checkpoint) {
      const id = `${jobId}:${checkpoint.sequence}`;
      const blobPath = `desktop/checkpoints/${jobId}/${checkpoint.sequence}.json`;
      const body = Buffer.from(JSON.stringify(checkpoint), "utf8");
      const blob = await uploadBlob(blobPath, body);
      if (!client) {
        memoryFallback.checkpoints.set(blobPath, body.toString("base64"));
      }
      return upsert(
        DESKTOP_CONFIG.storage.tableNames.checkpoints,
        {
          id,
          job_id: jobId,
          sequence: checkpoint.sequence,
          blob_path: blob.path,
          lifecycle_stage: checkpoint.lifecycleStage,
          created_at: nowIso(),
        },
        memoryFallback.checkpoints
      );
    },

    async getLatestCheckpoint(jobId) {
      ensureStoreReady();
      if (!client) {
        const matches = [...memoryFallback.checkpoints.values()].filter((item) => item.job_id === jobId);
        return matches.sort((a, b) => b.sequence - a.sequence)[0] || null;
      }

      const { data, error } = await client
        .from(DESKTOP_CONFIG.storage.tableNames.checkpoints)
        .select("*")
        .eq("job_id", jobId)
        .order("sequence", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      return data;
    },

    async loadCheckpointPayload(checkpointRecord) {
      if (!checkpointRecord?.blob_path) return null;
      const blob = await downloadBlob(checkpointRecord.blob_path, memoryFallback.checkpoints);
      return blob ? JSON.parse(blob.toString("utf8")) : null;
    },

    async saveEncryptedMemory({ scope, key, payloadBuffer, metadata = {} }) {
      const blobPath = `desktop/memory/${scope}/${key}.bin`;
      const blob = await uploadBlob(blobPath, payloadBuffer, "application/octet-stream");
      if (!client) {
        memoryFallback.memory.set(blobPath, payloadBuffer.toString("base64"));
      }

      return upsert(
        DESKTOP_CONFIG.storage.tableNames.memories,
        {
          id: `${scope}:${key}`,
          scope,
          key,
          blob_path: blob.path,
          metadata,
          updated_at: nowIso(),
        },
        memoryFallback.memory
      );
    },

    async loadEncryptedMemory(scope, key) {
      ensureStoreReady();
      if (!client) {
        const record = memoryFallback.memory.get(`${scope}:${key}`);
        if (!record?.blob_path) return null;
        const blob = memoryFallback.memory.get(record.blob_path);
        return blob ? Buffer.from(blob, "base64") : null;
      }

      const { data, error } = await client
        .from(DESKTOP_CONFIG.storage.tableNames.memories)
        .select("*")
        .eq("scope", scope)
        .eq("key", key)
        .maybeSingle();

      if (error) throw error;
      if (!data?.blob_path) return null;
      return downloadBlob(data.blob_path, memoryFallback.memory);
    },

    async saveExperience(experience) {
      return upsert(
        DESKTOP_CONFIG.storage.tableNames.experiences,
        {
          ...experience,
          id: experience.id,
          updated_at: nowIso(),
        },
        memoryFallback.experiences
      );
    },

    async listRecentExperiences(userId, limit = 5) {
      ensureStoreReady();
      if (!client) {
        return [...memoryFallback.experiences.values()]
          .filter((item) => item.user_id === userId)
          .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
          .slice(0, limit);
      }

      const { data, error } = await client
        .from(DESKTOP_CONFIG.storage.tableNames.experiences)
        .select("*")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false })
        .limit(limit);

      if (error) throw error;
      return data || [];
    },

    async savePrediction(prediction) {
      return upsert(
        DESKTOP_CONFIG.storage.tableNames.predictions,
        {
          ...prediction,
          id: prediction.id,
          updated_at: nowIso(),
        },
        memoryFallback.predictions
      );
    },

    async saveExecutionGraph(graph) {
      return upsert(
        DESKTOP_CONFIG.storage.tableNames.executionGraph,
        {
          ...graph,
          id: graph.id,
          updated_at: nowIso(),
        },
        memoryFallback.executionGraph
      );
    },

    async upsertDeviceSession(record) {
      return upsert(
        DESKTOP_CONFIG.storage.tableNames.deviceSessions,
        {
          ...record,
          id: record.id,
          updated_at: nowIso(),
        },
        memoryFallback.deviceSessions
      );
    },
  };
}
