import crypto from "crypto";

const desktopConnections = new Map();
const ALLOWED_DESKTOP_INTENTS = new Set([
  "open_app",
  "cozy_setup",
  "lumina_coding_session",
  "desktop_shutdown",
  "focus_mode",
]);

function getRelaySecret() {
  return String(process.env.RK_WEBHOOK_SECRET || process.env.RK_DESKTOP_BRIDGE_SECRET || "").trim();
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function isAuthorizedDesktopRelayRequest(req) {
  const expectedSecret = getRelaySecret();
  if (!expectedSecret) return true;

  const providedSecret = String(req.get("X-RK-Webhook-Secret") || "").trim();
  return Boolean(providedSecret) && timingSafeEqual(providedSecret, expectedSecret);
}

export function openDesktopRelayConnection(slug, req, res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  console.log(`[Relay] Desktop Agent connected for slug: ${slug}`);
  desktopConnections.set(slug, res);

  const keepAlive = setInterval(() => {
    res.write(": keep-alive\n\n");
  }, 30000);

  req.on("close", () => {
    clearInterval(keepAlive);
    desktopConnections.delete(slug);
    console.log(`[Relay] Desktop Agent disconnected for slug: ${slug}`);
  });
}

export function relayDesktopCommand(slug, command) {
  const intent = String(command?.intent || "").trim();
  if (!ALLOWED_DESKTOP_INTENTS.has(intent)) {
    return { ok: false, status: 400, error: "Unsupported desktop intent" };
  }

  const desktopRes = desktopConnections.get(slug);
  if (!desktopRes) {
    return { ok: false, status: 404, error: "Desktop agent not connected for this slug" };
  }

  console.log(`[Relay] Sending command to desktop ${slug}:`, command);
  desktopRes.write(`data: ${JSON.stringify(command)}\n\n`);
  return { ok: true, status: 200, message: "Relayed to desktop" };
}

export function isDesktopConnected(slug) {
  return desktopConnections.has(slug);
}
