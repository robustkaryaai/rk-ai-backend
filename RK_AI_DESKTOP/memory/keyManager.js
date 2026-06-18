import crypto from "crypto";
import { DESKTOP_CONFIG } from "../configuration/index.js";

function parseEnvKeys() {
  const raw = process.env.RK_DESKTOP_ENCRYPTION_KEYS || "";
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed;
  } catch (err) {
    // support simple format: v1:secret,v2:secret
    const out = {};
    for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
      const [k, ...rest] = part.split(":");
      if (!k || rest.length === 0) continue;
      out[k] = rest.join(":");
    }
    return Object.keys(out).length ? out : null;
  }
}

const envKeys = parseEnvKeys();

export function listKeyVersions() {
  if (envKeys) return Object.keys(envKeys);
  if (DESKTOP_CONFIG.encryptionSecret) return [DESKTOP_CONFIG.encryptionKeyVersion || "v1"];
  return [];
}

export function getRawKeyForVersion(version) {
  if (envKeys && envKeys[version]) return envKeys[version];
  if (version === DESKTOP_CONFIG.encryptionKeyVersion && DESKTOP_CONFIG.encryptionSecret) {
    return DESKTOP_CONFIG.encryptionSecret;
  }
  return null;
}

export function deriveKey(version) {
  const raw = getRawKeyForVersion(version);
  if (!raw) throw new Error(`Encryption key for version ${version} is not configured.`);
  // normalize to 32 bytes using sha256
  return crypto.createHash("sha256").update(String(raw)).digest();
}

export function currentKeyVersion() {
  return DESKTOP_CONFIG.encryptionKeyVersion || "v1";
}
