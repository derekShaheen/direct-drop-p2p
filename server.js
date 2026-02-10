import express from "express";
import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { WebSocketServer } from "ws";

function formatBitsFromBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 Mb";

  let bits = bytes * 8;
  const units = ["b", "Kb", "Mb", "Gb", "Tb", "Pb"];
  let v = bits;
  let i = 0;

  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }

  const dec = v >= 100 || i === 0 ? 0 : (v >= 10 ? 1 : 2);
  return `${v.toFixed(dec)} ${units[i]}`;
}


const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/signal" });

const PUBLIC_DIR = path.join(process.cwd(), "public");
const STATS_FILE = process.env.PUBLIC_STATS_FILE
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "/public-stats.json")
    : path.join(process.cwd(), "public-stats.json");

const TOKEN_TTL_MS = 1000 * 60 * 60; // 1 hour
const CLEANUP_POLL_MS = 1000 * 30;   // 30 seconds

// token -> room
// room = { sender, receiver, pendingForSender: [], pendingForReceiver: [], createdAt }
const rooms = new Map();

// token -> metric (internal state)
const metrics = new Map();

function now() { return Date.now(); }

function formatBytesFromBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B","KB","MB","GB","TB","PB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const dec = v >= 100 || i === 0 ? 0 : (v >= 10 ? 1 : 2);
  return `${v.toFixed(dec)} ${units[i]}`;
}




function loadPublicStats() {
  try {
    const raw = fs.readFileSync(STATS_FILE, "utf-8");
    const j = JSON.parse(raw || "{}");
    return {
      successfulTransfers: typeof j.successfulTransfers === "number" ? j.successfulTransfers : 0,
      totalBytesTransferred: typeof j.totalBytesTransferred === "number" ? j.totalBytesTransferred : 0,
      filesTransferred: typeof j.filesTransferred === "number" ? j.filesTransferred : 0
    };
  } catch {
    return { successfulTransfers: 0, totalBytesTransferred: 0, filesTransferred: 0 };
  }
}

let publicStats = loadPublicStats();

function savePublicStats() {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(publicStats, null, 2));
  } catch {
    // ignore
  }
}

function renderPage(fileName) {
  const filePath = path.join(PUBLIC_DIR, fileName);
  let html = fs.readFileSync(filePath, "utf-8");
  html = html.replace(/id="successCount">[^<]*</, `id="successCount">${publicStats.successfulTransfers}<`);
  html = html.replace(/id="filesTotal">[^<]*</, `id="filesTotal">${publicStats.filesTransferred}<`);
  html = html.replace(/id="bytesTotal">[^<]*</, `id="bytesTotal">${formatBytesFromBytes(publicStats.totalBytesTransferred)}<`);
  return html;
}

function ensureRoom(token) {
  if (!rooms.has(token)) {
    rooms.set(token, {
      sender: null,
      receiver: null,
      pendingForSender: [],
      pendingForReceiver: [],
      createdAt: now()
    });
  }
  return rooms.get(token);
}

function ensureMetric(token) {
  if (!metrics.has(token)) {
    metrics.set(token, { status: "created", createdAt: now() });
  }
  return metrics.get(token);
}

function safeSend(ws, obj) {
  if (!ws) return;
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  } catch {
    // ignore
  }
}

// Pages rendered with embedded public stats (no stats API required)
app.get("/", (_req, res) => {
  res.type("html").send(renderPage("sender.html"));
});
app.get("/sender.html", (_req, res) => {
  res.type("html").send(renderPage("sender.html"));
});

app.get("/receiver.html", (_req, res) => {
  res.type("html").send(renderPage("receiver.html"));
});

app.get("/api/create", (_req, res) => {
  const token = crypto.randomBytes(16).toString("hex");
  rooms.set(token, {
    sender: null,
    receiver: null,
    pendingForSender: [],
    pendingForReceiver: [],
    createdAt: now()
  });
  metrics.set(token, { status: "created", createdAt: now() });
  res.json({ token });
});

app.get("/t/:token", (req, res) => {
  const token = req.params.token;
  if (!rooms.has(token)) {
    res.status(404).type("text").send("Link expired or invalid.");
    return;
  }
  res.type("html").send(renderPage("receiver.html"));
});

app.post("/api/metrics/ping", express.json(), (req, res) => {
  const { token, event, bytes, files, reason } = req.body || {};
  if (!token || typeof token !== "string") {
    res.status(400).json({ ok: false });
    return;
  }

  const m = metrics.get(token);
  if (!m) {
    res.json({ ok: true });
    return;
  }

  m.lastSeenAt = now();
  if (typeof bytes === "number") m.bytes = bytes;
  if (typeof files === "number") m.files = files;

  if (event === "connected") {
    m.status = m.status === "success" ? "success" : "connected";
    if (!m.connectedAt) m.connectedAt = now();
  } else if (event === "meta_received") {
    m.status = "waiting_consent";
  } else if (event === "accepted") {
    m.status = "transferring";
    if (!m.startedAt) m.startedAt = now();
  } else if (event === "transferring") {
    m.status = "transferring";
    if (!m.startedAt) m.startedAt = now();
  } else if (event === "success") {
    if (!m.successCounted) {
      publicStats.successfulTransfers += 1;
      publicStats.totalBytesTransferred += (typeof m.bytes === "number" ? m.bytes : 0);
      publicStats.filesTransferred += (typeof m.files === "number" ? m.files : 0);
      m.successCounted = true;
      savePublicStats();
    }
    m.status = "success";
    if (!m.endedAt) m.endedAt = now();
  } else if (event === "failed") {
    if (m.status !== "success") m.status = "failed";
    m.reason = reason || m.reason;
    if (!m.endedAt) m.endedAt = now();
  } else if (event === "closed") {
    if (m.status !== "success") m.status = "closed";
    if (!m.endedAt) m.endedAt = now();
  }

  res.json({ ok: true });
});

// Static assets (JS/CSS/images)
app.use(express.static("public"));

// WebSocket signaling
wss.on("connection", (ws) => {
  let boundToken = null;
  let boundRole = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    const { token, role, type, payload } = msg || {};
    if (!token || typeof token !== "string") return;
    if (role !== "sender" && role !== "receiver") return;

    boundToken = token;
    boundRole = role;

    const room = ensureRoom(token);
    const m = ensureMetric(token);

    // TTL check (do not expire active transfers; only block very old unused tokens)
    if (m && m.createdAt && now() - m.createdAt > TOKEN_TTL_MS && !m.endedAt && m.status === "created") {
      rooms.delete(token);
      metrics.delete(token);
      safeSend(ws, { type: "error", payload: { message: "expired" } });
      return;
    }

    // Enforce a single sender and a single receiver per token
    if (type === "join") {
      if (role === "sender") {
        if (room.sender && room.sender !== ws) { try { room.sender.close(); } catch {} }
        room.sender = ws;
      } else {
        if (room.receiver && room.receiver !== ws) { try { room.receiver.close(); } catch {} }
        room.receiver = ws;
      }

      // Notify both sides of presence
      safeSend(room.sender, { type: "peer", payload: { present: !!room.receiver } });
      safeSend(room.receiver, { type: "peer", payload: { present: !!room.sender } });

      // Flush any pending messages
      if (role === "sender") {
        while (room.pendingForSender.length) safeSend(ws, room.pendingForSender.shift());
      } else {
        while (room.pendingForReceiver.length) safeSend(ws, room.pendingForReceiver.shift());
      }
      return;
    }

    // Forward signal messages to the other peer (queue if missing)
    const out = { type, payload };

    if (role === "sender") {
      if (room.receiver) safeSend(room.receiver, out);
      else room.pendingForReceiver.push(out);
    } else {
      if (room.sender) safeSend(room.sender, out);
      else room.pendingForSender.push(out);
    }
  });

  ws.on("close", () => {
    if (!boundToken || !boundRole) return;
    const room = rooms.get(boundToken);
    if (!room) return;

    if (boundRole === "sender" && room.sender === ws) room.sender = null;
    if (boundRole === "receiver" && room.receiver === ws) room.receiver = null;

    // Notify remaining peer so it can reset/retry
    safeSend(room.sender, { type: "peer", payload: { present: !!room.receiver } });
    safeSend(room.receiver, { type: "peer", payload: { present: !!room.sender } });
  });
});

// Cleanup expired rooms / metrics
setInterval(() => {
  const t = now();

  for (const [token, m] of metrics.entries()) {
    const ended = !!m.endedAt;
    const last = m.lastSeenAt || m.createdAt || t;
    const age = t - (m.createdAt || t);
    const idle = t - last;

    // Keep success metrics longer for visibility, but still clean eventually
    const ttl = ended ? 1000 * 60 * 30 : TOKEN_TTL_MS; // 30 min after end, else token ttl

    if (age > ttl && idle > 1000 * 60 * 10) {
      metrics.delete(token);
      rooms.delete(token);
    }
  }

  // Rooms without metrics should be removed
  for (const [token] of rooms.entries()) {
    if (!metrics.has(token)) rooms.delete(token);
  }
}, CLEANUP_POLL_MS);

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on http://0.0.0.0:${PORT}`);
});
