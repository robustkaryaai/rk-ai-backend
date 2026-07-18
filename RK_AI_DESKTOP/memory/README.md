Memory Layers — RK AI Desktop

Purpose

Memory is focused on improving execution quality, not chat transcripts. It provides layered storage to support planning, retrieval, and learning from execution history.

Layers

1. Short-Term Memory (RAM)
   - Active execution context for a running job.
   - Not persisted across restarts.
2. Long-Term Memory (Encrypted persistent)
   - User preferences, facts, habits.
   - Stored encrypted using AES-256-GCM with key versioning.
3. Semantic Memory
   - Embeddings, vector indices for similarity retrieval.
   - May be stored in a vector DB or persisted as encrypted blobs.
4. Experience Memory
   - Execution outcomes (success/failure), tools used, durations.
   - Indexed for retrieval to reuse successful workflows.
5. Prediction Matrix
   - Transition probabilities and learned workflow patterns.

Checkpointing

- Checkpoints are saved frequently: after completed tasks, before long operations, before retries, and before replanning.
- Checkpoint schema includes: objective, planVersion, plan (optional), completedTasks, pendingTasks, stepResults (partial), executionState, retryCounts, memorySummary, deviceStateSummary.
- Manager attempts to resume jobs from the latest checkpoint when available.

Encryption

- All long-term/semantic/prediction blobs are encrypted before storage.
- Key versioning is supported via `RK_DESKTOP_ENCRYPTION_KEYS` or `RK_DESKTOP_ENCRYPTION_SECRET` + `RK_DESKTOP_ENCRYPTION_KEY_VERSION`.

