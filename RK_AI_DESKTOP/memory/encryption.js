import crypto from "crypto";
import { DESKTOP_CONFIG } from "../configuration/index.js";
import { deriveKey, currentKeyVersion } from "./keyManager.js";

export function encryptJson({ userId, scope, value, keyVersion }) {
  const version = keyVersion || currentKeyVersion();
  const iv = crypto.randomBytes(12);
  const key = deriveKey(version);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.from(
    JSON.stringify({
      alg: "aes-256-gcm",
      keyVersion: version,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      payload: ciphertext.toString("base64"),
    }),
    "utf8"
  );
}

export function decryptJson({ userId, scope, buffer }) {
  const envelope = JSON.parse(buffer.toString("utf8"));
  const version = envelope.keyVersion || DESKTOP_CONFIG.encryptionKeyVersion;
  const key = deriveKey(version);
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.payload, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}
