import crypto from "crypto";
import { randomUUID } from "crypto";
import { createSessionToken } from "./sessionToken.js";
import { DESKTOP_CONFIG } from "../configuration/index.js";
import { verifySessionToken } from "./sessionToken.js";

function now() {
  return Date.now();
}

export function createDeviceBridgeRegistry({ store }) {
  const sessionsByDevice = new Map();
  const commandWaiters = new Map();

  function isHeartbeatFresh(session) {
    return Boolean(session) && now() - session.lastHeartbeatAt <= DESKTOP_CONFIG.deviceHeartbeatMs;
  }

  function verifySignature({ deviceId, sessionId, timestamp, signature }) {
    if (DESKTOP_CONFIG.allowUnsignedDeviceRequests) {
      return true;
    }

    if (!DESKTOP_CONFIG.deviceRequestSecret) {
      throw new Error("Device bridge secret is not configured.");
    }

    const expected = crypto
      .createHmac("sha256", DESKTOP_CONFIG.deviceRequestSecret)
      .update(`${deviceId}:${sessionId}:${timestamp}`)
      .digest("hex");

    return expected === signature;
  }

  return {
    async registerSession({ deviceId, userId, sessionId, timestamp, signature, metadata = {} }) {
      const signed = verifySignature({ deviceId, sessionId, timestamp, signature });
      if (!signed) {
        throw new Error("Invalid device registration signature.");
      }

      const record = {
        id: `${deviceId}:${sessionId}`,
        deviceId,
        userId,
        sessionId,
        metadata,
        state: {},
        queue: [],
        connectedAt: now(),
        lastHeartbeatAt: now(),
      };

      sessionsByDevice.set(deviceId, record);
      await store.upsertDeviceSession({
        id: record.id,
        device_id: deviceId,
        session_id: sessionId,
        user_id: userId,
        status: "active",
        metadata,
        connected_at: new Date(record.connectedAt).toISOString(),
        last_heartbeat_at: new Date(record.lastHeartbeatAt).toISOString(),
      });

      // Create a short-lived session token for the device to use in subsequent requests
      try {
        const token = createSessionToken({ deviceId, sessionId });
        return { ...record, token };
      } catch (err) {
        return record;
      }
    },

    async heartbeat({ deviceId, sessionId, state = {} }) {
      const session = sessionsByDevice.get(deviceId);
      if (!session || session.sessionId !== sessionId) {
        throw new Error("Active device session not found.");
      }

      session.lastHeartbeatAt = now();
      session.state = { ...session.state, ...state };
      await store.upsertDeviceSession({
        id: `${deviceId}:${sessionId}`,
        device_id: deviceId,
        session_id: sessionId,
        user_id: session.userId,
        status: "active",
        metadata: session.metadata,
        state: session.state,
        connected_at: new Date(session.connectedAt).toISOString(),
        last_heartbeat_at: new Date(session.lastHeartbeatAt).toISOString(),
      });
      return session;
    },

    async updateState({ deviceId, sessionId, state }) {
      return this.heartbeat({ deviceId, sessionId, state });
    },

    getActiveSession(deviceId) {
      const session = sessionsByDevice.get(deviceId);
      if (!isHeartbeatFresh(session)) return null;
      return session;
    },

    ensureAuthorizedSession({ deviceId, sessionId, userId, sessionToken } = {}) {
      const session = this.getActiveSession(deviceId);
      if (!session) {
        throw new Error("No active device session.");
      }

      // Token-based short-circuit verification (if provided)
      if (sessionToken) {
        try {
          const payload = verifySessionToken(sessionToken);
          if (!payload) throw new Error("Invalid session token.");
          if (payload.deviceId !== deviceId || payload.sessionId !== sessionId) {
            throw new Error("Session token mismatch.");
          }
        } catch (err) {
          throw new Error("Invalid session token.");
        }
      }

      if (session.sessionId !== sessionId) {
        throw new Error("Session mismatch.");
      }
      if (userId && session.userId && session.userId !== userId) {
        throw new Error("Device ownership mismatch.");
      }
      return session;
    },

    async enqueueCommand({ deviceId, sessionId, userId, jobId, toolName, payload }) {
      const session = this.ensureAuthorizedSession({ deviceId, sessionId, userId });
      const command = {
        id: randomUUID(),
        jobId,
        toolName,
        payload,
        createdAt: new Date().toISOString(),
      };
      session.queue.push(command);
      return command;
    },

    async getPendingCommands({ deviceId, sessionId, userId, limit = 1 }) {
      const session = this.ensureAuthorizedSession({ deviceId, sessionId, userId });
      return session.queue.slice(0, limit);
    },

    async acknowledgeCommand({ deviceId, sessionId, userId, commandId, result }) {
      const session = this.ensureAuthorizedSession({ deviceId, sessionId, userId });
      session.queue = session.queue.filter((command) => command.id !== commandId);

      const waiter = commandWaiters.get(commandId);
      if (waiter) {
        waiter.resolve({
          status: "acknowledged",
          result,
          acknowledgedAt: new Date().toISOString(),
        });
        commandWaiters.delete(commandId);
      }

      return { ok: true };
    },

    waitForCommandAck(commandId, timeoutMs = DESKTOP_CONFIG.commandAckTimeoutMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          commandWaiters.delete(commandId);
          reject(new Error(`Command acknowledgment timed out for ${commandId}`));
        }, timeoutMs);

        commandWaiters.set(commandId, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
        });
      });
    },
  };
}
