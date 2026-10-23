import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import webPush from "web-push";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@localhost";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

const pcs = new Map();
const pairingCodes = new Map();
const phonesByConn = new Map();
const phonesByDevice = new Map();

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
]);

function nowMs() {
  return Date.now();
}

function connId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("base64url")}`;
}

function send(ws, frame) {
  if (ws.readyState !== ws.OPEN) return false;
  ws.send(JSON.stringify(frame));
  return true;
}

function closeQuietly(ws, code = 1000, reason = "") {
  try {
    ws.close(code, reason);
  } catch {
    // best effort
  }
}

function clearPc(ws) {
  for (const [pcId, pc] of pcs) {
    if (pc.ws !== ws) continue;
    pcs.delete(pcId);
    for (const [code, entry] of pairingCodes) {
      if (entry.pcId === pcId) pairingCodes.delete(code);
    }
    for (const phone of phonesByDevice.values()) {
      if (phone.pcId === pcId) {
        send(phone.ws, { kind: "pc_status", reachable: false });
      }
    }
  }
}

function clearPhone(ws) {
  for (const [phoneConnId, phone] of phonesByConn) {
    if (phone.ws !== ws) continue;
    phonesByConn.delete(phoneConnId);
    if (phone.deviceId) phonesByDevice.delete(phone.deviceId);
    const pc = phone.pcId ? pcs.get(phone.pcId) : null;
    if (pc && phone.deviceId) {
      send(pc.ws, { kind: "phone_disconnected", device_id: phone.deviceId });
    }
  }
}

function routePairingRequest(ws, frame) {
  const code = String(frame.code || "").trim();
  const entry = pairingCodes.get(code);
  if (!entry || entry.expiresAtMs <= nowMs()) {
    pairingCodes.delete(code);
    send(ws, {
      kind: "pairing_response",
      accepted: false,
      error: "Pairing code expired or not found.",
    });
    return;
  }
  const pc = pcs.get(entry.pcId);
  if (!pc || pc.ws.readyState !== pc.ws.OPEN) {
    send(ws, {
      kind: "pairing_response",
      accepted: false,
      error: "PC unreachable.",
    });
    return;
  }

  const phoneConnId = connId("phone");
  phonesByConn.set(phoneConnId, {
    phoneConnId,
    ws,
    pcId: entry.pcId,
    deviceId: null,
  });
  send(pc.ws, {
    kind: "pairing_request",
    phone_conn_id: phoneConnId,
    code,
    device_name: String(frame.deviceName || "Phone"),
    phone_public_key: String(frame.phonePublicKey || ""),
  });
}

function routePhoneHello(ws, frame) {
  const pcId = String(frame.pcId || "");
  const deviceId = String(frame.deviceId || "");
  const phoneConnId = connId("phone");
  const phone = { phoneConnId, ws, pcId, deviceId };
  phonesByConn.set(phoneConnId, phone);
  if (deviceId) phonesByDevice.set(deviceId, phone);

  const pc = pcs.get(pcId);
  const reachable = Boolean(pc && pc.ws.readyState === pc.ws.OPEN);
  send(ws, { kind: "pc_status", reachable });
  if (reachable) {
    send(pc.ws, { kind: "phone_connected", device_id: deviceId });
  }
}

function routePhoneCipher(ws, frame) {
  const deviceId = String(frame.deviceId || "");
  const phone = phonesByDevice.get(deviceId) || [...phonesByConn.values()].find((p) => p.ws === ws);
  const pc = phone?.pcId ? pcs.get(phone.pcId) : null;
  if (!pc || pc.ws.readyState !== pc.ws.OPEN) {
    send(ws, { kind: "pc_status", reachable: false });
    return;
  }
  send(pc.ws, {
    kind: "phone_cipher",
    device_id: deviceId,
    envelope: frame.envelope,
  });
}

async function sendPush(subscription, payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return { ok: false, error: "Web Push VAPID keys are not configured." };
  }
  const body = JSON.stringify({
    title: payload?.title || "Axecode",
    body: payload?.body || "Response ready",
    conversationId: payload?.conversation_id || payload?.conversationId || null,
  });
  try {
    await webPush.sendNotification(subscription, body, { TTL: 60 * 60 });
    return { ok: true };
  } catch (err) {
    console.warn("push delivery failed", err?.statusCode || "", err?.message || err);
    return { ok: false, error: String(err?.message || err) };
  }
}

function handlePcFrame(ws, frame) {
  switch (frame.kind) {
    case "pc_hello": {
      const pcId = String(frame.pc_id || "");
      if (!pcId) return;
      const existing = pcs.get(pcId);
      if (existing && existing.ws !== ws) closeQuietly(existing.ws, 4000, "replaced");
      pcs.set(pcId, { ws, pcId, protocolVersion: frame.protocol_version || 1 });
      send(ws, { kind: "pc_registered", pc_id: pcId });
      for (const phone of phonesByDevice.values()) {
        if (phone.pcId === pcId) {
          send(phone.ws, { kind: "pc_status", reachable: true });
          send(ws, { kind: "phone_connected", device_id: phone.deviceId });
        }
      }
      break;
    }
    case "pc_pairing_code": {
      const pcId = String(frame.pc_id || "");
      const code = String(frame.code || "");
      if (!pcId || !code) return;
      pairingCodes.set(code, {
        pcId,
        expiresAtMs: Number(frame.expires_at_ms || 0),
      });
      break;
    }
    case "pc_pair_response": {
      const phone = phonesByConn.get(String(frame.phone_conn_id || ""));
      if (!phone) return;
      send(phone.ws, {
        kind: "pairing_response",
        accepted: Boolean(frame.accepted),
        pcPublicKey: frame.pc_public_key || null,
        encrypted: frame.encrypted || null,
        error: frame.error || null,
      });
      break;
    }
    case "pc_cipher": {
      const phone = phonesByDevice.get(String(frame.device_id || ""));
      if (phone) send(phone.ws, { kind: "pc_cipher", envelope: frame.envelope });
      break;
    }
    case "pc_push": {
      void sendPush(frame.subscription, frame.payload);
      break;
    }
    case "pc_revoke_device": {
      const deviceId = String(frame.device_id || "");
      const phone = phonesByDevice.get(deviceId);
      if (phone) {
        send(phone.ws, { kind: "device_revoked" });
        closeQuietly(phone.ws, 4001, "device revoked");
      }
      break;
    }
    default:
      send(ws, { kind: "error", message: `unknown pc frame: ${frame.kind}` });
  }
}

function handlePhoneFrame(ws, frame) {
  switch (frame.kind) {
    case "phone_pair_request":
      routePairingRequest(ws, frame);
      break;
    case "phone_hello":
      routePhoneHello(ws, frame);
      break;
    case "phone_cipher":
      routePhoneCipher(ws, frame);
      break;
    default:
      send(ws, { kind: "relay_error", message: `unknown phone frame: ${frame.kind}` });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/vapid-public-key") {
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ publicKey: VAPID_PUBLIC_KEY || null }));
      return;
    }

    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";
    const requested = path.normalize(path.join(PUBLIC_DIR, pathname));
    const safePath = requested.startsWith(PUBLIC_DIR) ? requested : path.join(PUBLIC_DIR, "index.html");
    let filePath = safePath;
    let body;
    try {
      body = await readFile(filePath);
    } catch {
      filePath = path.join(PUBLIC_DIR, "index.html");
      body = await readFile(filePath);
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "content-type": MIME.get(ext) || "application/octet-stream",
      "cache-control": ext === ".html" ? "no-store" : "public, max-age=3600",
      "x-content-type-options": "nosniff",
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(String(err?.message || err));
  }
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  ws.on("message", (data) => {
    let frame;
    try {
      frame = JSON.parse(data.toString("utf8"));
    } catch {
      send(ws, { kind: "relay_error", message: "invalid JSON frame" });
      return;
    }
    const kind = String(frame.kind || "");
    if (kind.startsWith("pc_")) {
      handlePcFrame(ws, frame);
    } else if (kind.startsWith("phone_")) {
      handlePhoneFrame(ws, frame);
    } else {
      send(ws, { kind: "relay_error", message: `unknown frame: ${kind}` });
    }
  });
  ws.on("close", () => {
    clearPc(ws);
    clearPhone(ws);
  });
  ws.on("error", () => {
    clearPc(ws);
    clearPhone(ws);
  });
});

setInterval(() => {
  const now = nowMs();
  for (const [code, entry] of pairingCodes) {
    if (entry.expiresAtMs <= now) pairingCodes.delete(code);
  }
}, 30_000).unref();

server.listen(PORT, HOST, () => {
  console.log(`Axecode remote relay listening on http://${HOST}:${PORT}`);
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.warn("Web Push disabled: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.");
  }
});
