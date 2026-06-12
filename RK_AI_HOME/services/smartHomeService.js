import crypto from "crypto";

import { db } from "./appwriteClient.js";

const TUYA_BASE_URLS = {
  cn: "https://openapi.tuyacn.com",
  us: "https://openapi.tuyaus.com",
  eu: "https://openapi.tuyaeu.com",
  in: "https://openapi.tuyain.com",
};

const TUYA_SWITCH_CODES = [
  "switch_led",
  "switch",
  "switch_1",
  "power_switch",
  "start",
];

const TUYA_BRIGHTNESS_CODES = [
  "bright_value_v2",
  "bright_value",
  "brightness",
];

const TUYA_COLOR_CODES = [
  "colour_data_v2",
  "colour_data",
];

const DEFAULT_SMART_HOME_CONFIG = {
  version: 1,
  providers: {
    local: {
      enabled: true,
      label: "Local LAN",
    },
    tuya: {
      enabled: false,
      label: "Tuya / Wipro / Smart Life",
      region: "in",
      accessId: "",
      accessSecret: "",
      uid: "",
      brandLabel: "Tuya",
      appName: "Smart Life",
      lastSyncAt: null,
      lastError: "",
    },
    xiaomi: {
      enabled: true,
      label: "Xiaomi Local",
      mode: "miio",
    },
    webhook: {
      enabled: true,
      label: "Webhook",
    },
  },
};

function safeJsonParse(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeWakeWordList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim().toLowerCase())
    .filter(Boolean);
}

function parseWakeWordsBlob(raw) {
  const parsed = safeJsonParse(raw, null);
  if (Array.isArray(parsed)) {
    return { words: normalizeWakeWordList(parsed), meta: {} };
  }
  if (parsed && typeof parsed === "object") {
    const words = parsed.words ?? parsed.wakeWords ?? parsed.list ?? parsed.items ?? [];
    return {
      words: normalizeWakeWordList(words),
      meta: parsed.meta && typeof parsed.meta === "object" ? parsed.meta : {},
    };
  }
  return { words: [], meta: {} };
}

function mergeWakeWordsBlob(raw, patch = {}) {
  const current = parseWakeWordsBlob(raw);
  return {
    words: Array.isArray(patch.words) ? normalizeWakeWordList(patch.words) : current.words,
    meta: {
      ...current.meta,
      ...(patch.meta && typeof patch.meta === "object" ? patch.meta : {}),
    },
  };
}

function cloneDefaultConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_SMART_HOME_CONFIG));
}

export function normalizeSmartHomeConfig(rawConfig = {}) {
  const base = cloneDefaultConfig();
  const incoming = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
  const incomingProviders = incoming.providers && typeof incoming.providers === "object"
    ? incoming.providers
    : {};

  const mergedProviders = { ...base.providers };
  for (const [providerKey, providerDefaults] of Object.entries(base.providers)) {
    const patch = incomingProviders[providerKey];
    mergedProviders[providerKey] = {
      ...providerDefaults,
      ...(patch && typeof patch === "object" ? patch : {}),
    };
  }

  for (const [providerKey, providerValue] of Object.entries(incomingProviders)) {
    if (mergedProviders[providerKey]) continue;
    mergedProviders[providerKey] = providerValue;
  }

  return {
    ...base,
    ...(incoming && typeof incoming === "object" ? incoming : {}),
    providers: mergedProviders,
  };
}

function parseSmartDevices(device, wakeWordsBlob) {
  const topLevel = safeJsonParse(device?.smart_devices, null);
  if (Array.isArray(topLevel)) return topLevel;
  const legacy = safeJsonParse(wakeWordsBlob?.meta?.smart_devices, []);
  return Array.isArray(legacy) ? legacy : [];
}

export function getSmartHomeState(device) {
  const wakeWordsBlob = parseWakeWordsBlob(device?.wakeWords);
  const smartHomeConfig = normalizeSmartHomeConfig(wakeWordsBlob.meta.smartHomeConfig || {});
  const smartDevices = parseSmartDevices(device, wakeWordsBlob);
  return {
    wakeWordsBlob,
    smartHomeConfig,
    smartDevices,
  };
}

export async function persistSmartHomeState(device, { smartHomeConfig, smartDevices }) {
  const { wakeWordsBlob } = getSmartHomeState(device);
  const nextWakeWordsBlob = mergeWakeWordsBlob(device?.wakeWords, {
    meta: {
      ...wakeWordsBlob.meta,
      smartHomeConfig: normalizeSmartHomeConfig(smartHomeConfig || wakeWordsBlob.meta.smartHomeConfig || {}),
    },
  });

  const updateData = {
    wakeWords: JSON.stringify(nextWakeWordsBlob),
  };

  if (smartDevices !== undefined) {
    updateData.smart_devices = JSON.stringify(Array.isArray(smartDevices) ? smartDevices : []);
  }

  await db.updateDocument(
    process.env.APPWRITE_DB_ID,
    process.env.APPWRITE_DEVICES_COLLECTION,
    device.$id,
    updateData,
  );

  return {
    wakeWordsBlob: nextWakeWordsBlob,
    smartHomeConfig: nextWakeWordsBlob.meta.smartHomeConfig,
    smartDevices: smartDevices !== undefined ? smartDevices : parseSmartDevices(device, nextWakeWordsBlob),
  };
}

function normalizeRoom(device) {
  return device.room ? String(device.room).trim() : "";
}

function normalizeAliases(device) {
  const aliases = Array.isArray(device.aliases) ? device.aliases : [];
  return aliases
    .map((alias) => String(alias || "").trim())
    .filter(Boolean);
}

function buildDeviceIdentityKey(device) {
  const provider = String(device.provider || device.type || "generic").toLowerCase();
  const providerDeviceId = String(device.provider_device_id || device.id || "").trim().toLowerCase();
  const ip = String(device.ip || "").trim().toLowerCase();
  const name = String(device.name || "").trim().toLowerCase();
  if (providerDeviceId) return `${provider}:${providerDeviceId}`;
  if (ip) return `${provider}:ip:${ip}`;
  return `${provider}:name:${name}`;
}

export function mergeSmartDevices(existingDevices = [], incomingDevices = []) {
  const merged = new Map();
  for (const rawDevice of [...existingDevices, ...incomingDevices]) {
    if (!rawDevice || typeof rawDevice !== "object") continue;
    const device = {
      ...rawDevice,
      room: normalizeRoom(rawDevice),
      aliases: normalizeAliases(rawDevice),
    };
    const key = buildDeviceIdentityKey(device);
    const prev = merged.get(key) || {};
    merged.set(key, {
      ...prev,
      ...device,
      aliases: Array.from(new Set([...(prev.aliases || []), ...(device.aliases || [])])),
    });
  }
  return Array.from(merged.values());
}

function getTuyaBaseUrl(region) {
  return TUYA_BASE_URLS[String(region || "in").toLowerCase()] || TUYA_BASE_URLS.in;
}

function buildQueryString(query) {
  if (!query || typeof query !== "object") return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function buildTuyaStringToSign(method, pathWithQuery, bodyText, signedHeaders) {
  const headersText = Object.entries(signedHeaders)
    .map(([key, value]) => `${key}:${value}`)
    .join("\n");

  return [
    method.toUpperCase(),
    sha256Hex(bodyText || ""),
    headersText,
    pathWithQuery,
  ].join("\n");
}

async function tuyaRequest(providerConfig, method, path, { query, body, accessToken } = {}) {
  const accessId = String(providerConfig.accessId || process.env.TUYA_CLIENT_ID || "").trim();
  const accessSecret = String(providerConfig.accessSecret || process.env.TUYA_CLIENT_SECRET || "").trim();
  if (!accessId || !accessSecret) {
    throw new Error("Missing Tuya Access ID or Access Secret.");
  }

  const region = providerConfig.region || process.env.TUYA_REGION || "in";
  const baseUrl = getTuyaBaseUrl(region);
  const pathWithQuery = `${path}${buildQueryString(query)}`;
  const url = `${baseUrl}${pathWithQuery}`;
  const bodyText = body ? JSON.stringify(body) : "";
  const t = String(Date.now());
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const signedHeaders = {};
  const stringToSign = buildTuyaStringToSign(method, pathWithQuery, bodyText, signedHeaders);
  const signPayload = `${accessId}${accessToken || ""}${t}${nonce}${stringToSign}`;
  const sign = crypto
    .createHmac("sha256", accessSecret)
    .update(signPayload)
    .digest("hex")
    .toUpperCase();

  const headers = {
    client_id: accessId,
    t,
    sign,
    sign_method: "HMAC-SHA256",
    nonce,
    "Content-Type": "application/json",
  };

  if (accessToken) headers.access_token = accessToken;

  const response = await fetch(url, {
    method,
    headers,
    body: bodyText || undefined,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    const message = data.msg || data.message || `Tuya request failed (${response.status})`;
    throw new Error(message);
  }
  return data;
}

async function getTuyaProjectToken(providerConfig) {
  const res = await tuyaRequest(providerConfig, "GET", "/v1.0/token", {
    query: { grant_type: 1 },
  });
  return res.result?.access_token || res.result?.accessToken;
}

function pickFirstSupportedCode(functions = [], preferredCodes = []) {
  const functionCodes = new Set(
    (Array.isArray(functions) ? functions : [])
      .map((item) => String(item?.code || "").trim())
      .filter(Boolean),
  );
  return preferredCodes.find((code) => functionCodes.has(code)) || null;
}

function buildTuyaDeviceRecord(device, specsResult, statusResult, providerConfig) {
  const functions = Array.isArray(specsResult?.functions) ? specsResult.functions : [];
  const status = Array.isArray(statusResult) ? statusResult : [];
  const switchCode = pickFirstSupportedCode(functions, TUYA_SWITCH_CODES);
  const brightnessCode = pickFirstSupportedCode(functions, TUYA_BRIGHTNESS_CODES);
  const colorCode = pickFirstSupportedCode(functions, TUYA_COLOR_CODES);
  const aliases = [];
  if (device?.custom_name && device.custom_name !== device.name) aliases.push(device.custom_name);

  return {
    id: `tuya_${device.id}`,
    provider: "tuya",
    provider_device_id: device.id,
    provider_label: providerConfig.brandLabel || providerConfig.label || "Tuya",
    brand: providerConfig.brandLabel || providerConfig.label || "Tuya",
    control_via: "backend_proxy",
    cloud: true,
    type: "tuya",
    name: device.custom_name || device.name || "Tuya Device",
    room: device.space_name || device.room_name || "",
    category: device.category || "",
    product_name: device.product_name || "",
    icon: device.icon || "",
    online: device.online !== false,
    capabilities: {
      power: Boolean(switchCode),
      brightness: Boolean(brightnessCode),
      color: Boolean(colorCode),
    },
    control_codes: {
      switch: switchCode,
      brightness: brightnessCode,
      color: colorCode,
    },
    aliases,
    provider_meta: {
      appName: providerConfig.appName || "Smart Life",
      region: providerConfig.region || "in",
    },
    raw_status: status,
  };
}

export async function syncTuyaDevicesForDevice(device) {
  const { smartHomeConfig, smartDevices } = getSmartHomeState(device);
  const providerConfig = smartHomeConfig.providers?.tuya || {};
  if (!providerConfig.enabled) {
    throw new Error("Tuya connector is disabled.");
  }

  const uid = String(providerConfig.uid || "").trim();
  if (!uid) {
    throw new Error("Missing Tuya user UID.");
  }

  const projectToken = await getTuyaProjectToken(providerConfig);
  const listRes = await tuyaRequest(
    providerConfig,
    "GET",
    `/v1.0/iot-01/voice/users/${encodeURIComponent(uid)}/devices`,
    { accessToken: projectToken },
  );

  const devicesFromCloud = Array.isArray(listRes.result?.devices)
    ? listRes.result.devices
    : Array.isArray(listRes.result)
      ? listRes.result
      : [];

  const enrichedDevices = [];
  for (const remoteDevice of devicesFromCloud) {
    try {
      const [specsRes, statusRes] = await Promise.all([
        tuyaRequest(
          providerConfig,
          "GET",
          `/v1.0/iot-03/devices/${encodeURIComponent(remoteDevice.id)}/specifications`,
          { accessToken: projectToken },
        ),
        tuyaRequest(
          providerConfig,
          "GET",
          `/v1.0/devices/${encodeURIComponent(remoteDevice.id)}/status`,
          { accessToken: projectToken },
        ),
      ]);

      enrichedDevices.push(
        buildTuyaDeviceRecord(
          remoteDevice,
          specsRes.result || {},
          statusRes.result || [],
          providerConfig,
        ),
      );
    } catch (deviceErr) {
      enrichedDevices.push({
        id: `tuya_${remoteDevice.id}`,
        provider: "tuya",
        provider_device_id: remoteDevice.id,
        provider_label: providerConfig.brandLabel || providerConfig.label || "Tuya",
        brand: providerConfig.brandLabel || providerConfig.label || "Tuya",
        control_via: "backend_proxy",
        cloud: true,
        type: "tuya",
        name: remoteDevice.custom_name || remoteDevice.name || "Tuya Device",
        room: remoteDevice.space_name || "",
        category: remoteDevice.category || "",
        online: remoteDevice.online !== false,
        aliases: [],
        sync_warning: String(deviceErr.message || deviceErr),
      });
    }
  }

  const preservedDevices = smartDevices.filter((item) => item?.provider !== "tuya");
  const mergedDevices = mergeSmartDevices(preservedDevices, enrichedDevices);
  const nextConfig = normalizeSmartHomeConfig({
    ...smartHomeConfig,
    providers: {
      ...smartHomeConfig.providers,
      tuya: {
        ...providerConfig,
        lastSyncAt: new Date().toISOString(),
        lastError: "",
      },
    },
  });

  await persistSmartHomeState(device, {
    smartHomeConfig: nextConfig,
    smartDevices: mergedDevices,
  });

  return {
    provider: "tuya",
    synced: enrichedDevices.length,
    devices: mergedDevices,
    providerConfig: nextConfig.providers.tuya,
  };
}

function findSmartDeviceById(devices, deviceId) {
  return devices.find((device) => String(device?.id || "") === String(deviceId || ""));
}

export async function controlCloudSmartDevice(device, deviceId, action, payload = {}) {
  const { smartHomeConfig, smartDevices } = getSmartHomeState(device);
  const targetDevice = findSmartDeviceById(smartDevices, deviceId);
  if (!targetDevice) {
    throw new Error("Smart device not found.");
  }

  if (targetDevice.provider !== "tuya") {
    throw new Error("This device is not configured for backend cloud control.");
  }

  const providerConfig = smartHomeConfig.providers?.tuya || {};
  const remoteDeviceId = targetDevice.provider_device_id || String(deviceId).replace(/^tuya_/, "");
  const switchCode = targetDevice.control_codes?.switch || TUYA_SWITCH_CODES[0];
  const commands = [];

  if (action === "toggle") {
    throw new Error("Toggle is not supported for cloud proxy devices. Use on or off.");
  }

  if (action === "on" || action === "off") {
    commands.push({
      code: switchCode,
      value: action === "on",
    });
  } else if (action === "set_brightness") {
    const brightnessCode = targetDevice.control_codes?.brightness;
    if (!brightnessCode) {
      throw new Error("Brightness is not supported on this device.");
    }
    const brightness = Number(payload.brightness);
    if (!Number.isFinite(brightness)) {
      throw new Error("Brightness must be a number.");
    }
    commands.push({
      code: brightnessCode,
      value: Math.max(1, Math.min(1000, Math.round(brightness))),
    });
  } else {
    throw new Error(`Unsupported action: ${action}`);
  }

  const projectToken = await getTuyaProjectToken(providerConfig);
  await tuyaRequest(
    providerConfig,
    "POST",
    `/v1.0/iot-03/devices/${encodeURIComponent(remoteDeviceId)}/commands`,
    {
      accessToken: projectToken,
      body: { commands },
    },
  );

  return {
    ok: true,
    device: targetDevice,
    action,
  };
}
