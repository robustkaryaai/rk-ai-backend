import express from "express";

function requireBody(value, fieldName) {
  if (value == null || value === "") {
    const error = new Error(`${fieldName} is required.`);
    error.statusCode = 400;
    throw error;
  }
}

export function createDesktopApiRouter({ manager, bridge, planService, scheduler }) {
  const router = express.Router();

  router.get("/health", (req, res) => {
    return res.json({
      ok: true,
      service: "RK AI Desktop",
      scheduler: scheduler.snapshot(),
      timestamp: new Date().toISOString(),
    });
  });

  router.post("/jobs", async (req, res) => {
    try {
      const { deviceSlug, sessionId, goal, metadata } = req.body;
      requireBody(deviceSlug, "deviceSlug");
      requireBody(goal, "goal");

      const job = await manager.createJobRequest({
        deviceSlug: String(deviceSlug).padStart(9, "0"),
        sessionId,
        goal,
        metadata,
      });

      return res.status(202).json({ ok: true, ...job });
    } catch (error) {
      return res.status(error.statusCode || 400).json({ ok: false, error: error.message });
    }
  });

  router.get("/jobs/:id", async (req, res) => {
    const job = await manager.getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ ok: false, error: "Job not found." });
    }
    return res.json({ ok: true, job });
  });

  router.post("/jobs/:id/cancel", async (req, res) => {
    try {
      const job = await manager.cancelJob(req.params.id);
      if (!job) {
        return res.status(404).json({ ok: false, error: "Job not found." });
      }
      return res.json({ ok: true, job });
    } catch (error) {
      return res.status(409).json({ ok: false, error: error.message });
    }
  });

  router.get("/jobs/:id/report", async (req, res) => {
    const job = await manager.getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ ok: false, error: "Job not found." });
    }
    return res.json({
      ok: true,
      report: job.report || null,
      status: job.status,
    });
  });

  router.post("/device/connect", async (req, res) => {
    try {
      const { deviceSlug, sessionId, timestamp, signature, metadata } = req.body;
      requireBody(deviceSlug, "deviceSlug");
      requireBody(sessionId, "sessionId");
      requireBody(timestamp, "timestamp");

      const access = await planService.verifyDeviceAccess(String(deviceSlug).padStart(9, "0"));
      const session = await bridge.registerSession({
        deviceId: access.deviceId,
        userId: access.userId || access.deviceId,
        sessionId,
        timestamp,
        signature,
        metadata,
      });

      return res.json({
        ok: true,
        deviceId: session.deviceId,
        userId: session.userId,
        sessionId: session.sessionId,
        token: session.token || null,
      });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
  });

  router.post("/device/heartbeat", async (req, res) => {
    try {
      const { deviceSlug, sessionId, state } = req.body;
      requireBody(deviceSlug, "deviceSlug");
      requireBody(sessionId, "sessionId");

      const access = await planService.verifyDeviceAccess(String(deviceSlug).padStart(9, "0"));
      const session = await bridge.heartbeat({
        deviceId: access.deviceId,
        sessionId,
        state,
      });
      return res.json({ ok: true, lastHeartbeatAt: session.lastHeartbeatAt });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
  });

  router.post("/device/state", async (req, res) => {
    try {
      const { deviceSlug, sessionId, state } = req.body;
      requireBody(deviceSlug, "deviceSlug");
      requireBody(sessionId, "sessionId");

      const access = await planService.verifyDeviceAccess(String(deviceSlug).padStart(9, "0"));
      const session = await bridge.updateState({
        deviceId: access.deviceId,
        sessionId,
        state,
      });
      return res.json({ ok: true, state: session.state });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
  });

  router.post("/device/commands/next", async (req, res) => {
    try {
      const { deviceSlug, sessionId, limit } = req.body;
      requireBody(deviceSlug, "deviceSlug");
      requireBody(sessionId, "sessionId");

      const access = await planService.verifyDeviceAccess(String(deviceSlug).padStart(9, "0"));
      const commands = await bridge.getPendingCommands({
        deviceId: access.deviceId,
        sessionId,
        userId: access.userId || access.deviceId,
        limit: Number(limit) || 1,
      });
      return res.json({ ok: true, commands });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
  });

  router.post("/device/commands/:commandId/ack", async (req, res) => {
    try {
      const { deviceSlug, sessionId, result } = req.body;
      requireBody(deviceSlug, "deviceSlug");
      requireBody(sessionId, "sessionId");

      const access = await planService.verifyDeviceAccess(String(deviceSlug).padStart(9, "0"));
      await bridge.acknowledgeCommand({
        deviceId: access.deviceId,
        sessionId,
        userId: access.userId || access.deviceId,
        commandId: req.params.commandId,
        result,
      });
      return res.json({ ok: true });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
  });

  return router;
}
