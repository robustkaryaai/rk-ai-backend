RK AI Desktop - Architecture Overview

Goal

RK AI Desktop is an execution-first subsystem dedicated to interpreting goals, generating structured plans, executing tools on a desktop client, verifying outcomes, and learning from execution history.

Core Principles

- Subsystem isolation: RK_AI_DESKTOP is a standalone backend subsystem with its own manager, planner, queue, memory, execution, autonomy, providers, and device bridge.
- Manager authority: LLMs propose plans only; the Manager authorizes and orchestrates execution lifecycle.
- Lifecycle enforcement: Every job follows a strict lifecycle and is persisted as checkpoints.
- Security: Device sessions are validated and signed tokens are used; commands are routed only to the owning device.
- Storage: Supabase used for metadata and small blobs; Supabase Storage (or external object store) used for encrypted blobs.
- Encryption: AES-256-GCM with key versioning supported; sensitive blobs encrypted before storage.

Components

- Manager: Orchestrates Verify → Queue → Load Memory → Build Context → Plan → Validate → Execute → Verify → Checkpoint → Save → Unload → Complete.
- Planner: Routes goals to tool-groups and reasoning provider (Gemini Flash Lite recommended).
- Scheduler: Weighted priority queues with requeue, persistence, and recovery.
- Worker Pool: Configurable workers, graceful shutdown, health endpoint.
- Device Bridge: Session registration, heartbeat, signed session tokens, command queueing and acknowledgment.
- Memory Service: Short-term, long-term, semantic, experiences, prediction matrix.
- Providers: Plan service, store (Supabase), reasoning provider, tool providers.

Scaling and Reliability

- Scheduler persists minimal job state and supports recovery on restart.
- Workers are stateless executors pulling from scheduler; increase `DESKTOP_CONFIG.workerCount` to scale horizontally.
- Checkpointing after each task prevents rework and allows resume.
- Retry/backoff at step and job level prevents transient failures from causing permanent job failure.

Security

- Device requests signed via HMAC; short-lived session tokens provided to devices.
- Sensitive memory is encrypted client-side before storage; key versioning supports rotation.

Next steps

- Formalize tool capability declarations and access controls.
- Add observability (metrics, traces).
- Expand automated tests for resume/requeue/crypto.

Recent changes (June 2026)

- Implemented persistent deferred requeue scheduling on restart: `scheduler.requeue` now persists `next_attempt_at` and `scheduler.startRecoveryLoop()` rehydrates timers from storage so deferred jobs survive restarts.
- Centralized deferred timer scheduling via `scheduleDeferred()` and exposed `startRecoveryLoop()` / `stopRecoveryLoop()` on the scheduler API.
- Added an integration test suite `tests/integration/requeue_resume.test.js` validating requeue and recovery behavior using the in-memory store fallback.
- Added a minimal OpenAPI spec for the desktop API at `RK_AI_DESKTOP/api/openapi.yaml`.

- Added lightweight in-memory metrics counters at `RK_AI_DESKTOP/observability/metrics.js` and instrumented the scheduler to count enqueues, requeues and dequeues.
- Added integration tests for checkpoint persistence and scheduler metrics:
	- `tests/integration/checkpoint_resume.test.js`
	- `tests/integration/scheduler_metrics.test.js`

These changes improve resilience of delayed jobs across process restarts and provide a baseline API spec and integration tests for CI.

Recent Changes (June 2026)

- Added a robust scheduler recovery loop that scans persisted waiting jobs and schedules deferred enqueues using `next_attempt_at` so delays survive process restarts.
- Centralized deferred scheduling logic to `scheduler.scheduleDeferred()` and exposed `startRecoveryLoop()` / `stopRecoveryLoop()` for lifecycle management.
- Integrated recovery loop startup into `RK_AI_DESKTOP/index.js` and added graceful shutdown to stop workers and recovery timers.
- Added integration tests validating requeue and recovery behavior (tests/integration/requeue_resume.test.js).
- Added a minimal OpenAPI spec for desktop endpoints at `RK_AI_DESKTOP/api/openapi.yaml`.

These changes increase queue reliability and make deferred requeues robust to restarts; consider adding observability and longer integration scenarios next.
