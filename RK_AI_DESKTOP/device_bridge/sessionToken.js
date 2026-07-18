import crypto from "crypto";
import { DESKTOP_CONFIG } from "../configuration/index.js";

function hmac(value) {
  if (!DESKTOP_CONFIG.deviceRequestSecret) throw new Error("Device bridge secret not configured for token signing.");
  return crypto.createHmac("sha256", DESKTOP_CONFIG.deviceRequestSecret).update(value).digest("hex");
}

export function createSessionToken({ deviceId, sessionId, expiresInMs = 1000 * 60 * 60 }) {
  const expiresAt = Date.now() + Number(expiresInMs || 0);
  const payload = JSON.stringify({ deviceId, sessionId, expiresAt });
  const payloadB64 = Buffer.from(payload, "utf8").toString("base64url");
  const sig = hmac(payloadB64);
  return `${payloadB64}.${sig}`;
}

export function verifySessionToken(token) {
  if (!token) return false;
  const parts = String(token).split(".");
  if (parts.length !== 2) return false;
  const [payloadB64, sig] = parts;
  const expected = hmac(payloadB64);
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return false;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    if (Date.now() > payload.expiresAt) return false;
    return payload;
  } catch (err) {
    return false;
  }
}
