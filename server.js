import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import crypto from "crypto";
import { createHash, timingSafeEqual } from "crypto";

const app = express();
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/signal" });

// token -> room
// room = { sender, receiver, pendingForSender: [], pendingForReceiver: [], createdAt }
const rooms = new Map();

// In-memory metrics keyed by token (never exposed through admin endpoints)
const metrics = new Map();

// Public aggregate stats (in-memory)
let successfulTransfers = 0;

// Cleanup policy
const TOKEN_TTL_MS = 48 * 60 * 60 * 1000;        // 48 hours
const CLEANUP_POLL_MS = 5 * 60 * 1000;           // every 5 minutes
const ORPHAN_GRACE_MS = 2 * 60 * 1000;           // 2 minutes after sender disconnects before cleanup if no receiver
const CLOSED_RETENTION_MS = 30 * 60 * 1000;      // keep closed transfers 30 minutes then delete

function now() { return Date.now(); }

function safeSend(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
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

// --- Admin auth (Basic Auth) ---
const STATS_USER = process.env.STATS_USER || "";
const STATS_PASS = process.env.STATS_PASS || "";

// Used to generate non-reversible IDs for admin views
const STATS_SALT = process.env.STATS_SALT || "";

function constantEq(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function statsAuth(req, res, next) {
  // Deny unless configured
  if (!STATS_USER || !STATS_PASS) {
    res.status(403).json({ error: "stats authentication is not configured" });
    return;
  }

  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="stats"');
    res.status(401).end("Authentication required");
    return;
  }

  let decoded = "";
  try { decoded = Buffer.from(h.slice(6), "base64").toString("utf8"); }
  catch { res.status(401).end("Invalid authorization header"); return; }

  const idx = decoded.indexOf(":");
  const user = idx >= 0 ? decoded.slice(0, idx) : decoded;
  const pass = idx >= 0 ? decoded.slice(idx + 1) : "";

  const ok = constantEq(user, STATS_USER) && constantEq(pass, STATS_PASS);
  if (!ok) {
    res.setHeader("WWW-Authenticate", 'Basic realm="stats"');
    res.status(401).end("Unauthorized");
    return;
  }

  next();
}

function adminIdFromToken(token) {
  // Salt is required to avoid predictable IDs across deployments.
  const salt = STATS_SALT || "local-dev-salt";
  return createHash("sha256").update(token + ":" + salt).digest("hex").slice(0, 12);
}

// --- Public endpoints ---
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
  // allow receiver page only for active token
  if (!rooms.has(token)) {
    res.status(404).type("text").send("Link expired or invalid.");
    return;
  }
  res.sendFile(process.cwd() + "/public/receiver.html");
});

app.post("/api/metrics/ping", express.json(), (req, res) => {
  const { token, event, bytes, reason } = req.body || {};
  if (!token || typeof token !== "string") {
    res.status(400).json({ ok: false });
    return;
  }
  const m = metrics.get(token);
  if (!m) {
    // token might be expired/cleaned; ignore
    res.json({ ok: true });
    return;
  }

  // Update metric fields without ever exposing token in admin views
  m.lastSeenAt = now();
  if (typeof bytes === "number") m.bytes = bytes;

  // event-driven state machine
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
    if (!m.successCounted) { successfulTransfers += 1; m.successCounted = true; }
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


// Public aggregate stats (no auth)
app.get("/api/public-stats", (_req, res) => {
  res.json({ successfulTransfers });
});

// --- Admin endpoints (token-hidden) ---
app.get("/api/stats", statsAuth, (_req, res) => {
  const rows = [...metrics.entries()].map(([token, m]) => ({
    id: adminIdFromToken(token),
    status: m.status,
    bytes: m.bytes,
    createdAt: m.createdAt,
    connectedAt: m.connectedAt,
    startedAt: m.startedAt,
    endedAt: m.endedAt,
    lastSeenAt: m.lastSeenAt,
    reason: m.reason
  }));

  const summary = rows.reduce(
    (acc, r) => {
      acc.total += 1;
      const s = r.status || "unknown";
      acc.byStatus[s] = (acc.byStatus[s] || 0) + 1;
      if (s === "success") acc.success += 1;
      if (s === "failed") acc.failed += 1;
      if (s === "expired") acc.expired += 1;
      return acc;
    },
    { total: 0, success: 0, failed: 0, expired: 0, byStatus: {} }
  );

  res.json({ summary, rows: rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)) });
});

app.get("/stats", statsAuth, (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Transfer Stats</title>
  <link rel="stylesheet" href="/app.css" />
  <style>
    .wrap{ max-width: 1200px; margin: 0 auto; padding: 26px 16px 60px; }
    .panel{ margin-top: 14px; }
    .summary{ display:flex; gap:10px; flex-wrap: wrap; }
    .pill{ border:1px solid var(--border); background: rgba(255,255,255,.03); border-radius: 999px; padding: 8px 10px; font-size: 12px; color: rgba(255,255,255,.85); }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="topbar">
      <div class="brand">
        <h1>Transfer Stats</h1>
        <p>In-memory metrics (reset on server restart). Tokens are hidden.</p>
      </div>
      <div class="nav">
        <span class="chip"><span class="dot"></span><span id="auto">Auto-refresh: 2s</span></span>
      </div>
    </div>

    <div class="card panel">
      <div class="card-header">
        <h2>Summary</h2>
        <div class="status" id="statusWrap"><span class="dot"></span><span id="status">Loading</span></div>
      </div>
      <div class="card-body">
        <div class="summary" id="summary"></div>
        <div class="mono" id="byStatus" style="margin-top:10px; color: var(--muted);"></div>
      </div>
    </div>

    <div class="card panel">
      <div class="card-header">
        <h2>Transfers</h2>
        <div class="chip"><span class="dot"></span><span id="count">0</span></div>
      </div>
      <div class="card-body">
        <table class="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Status</th>
              <th>Bytes</th>
              <th>Created</th>
              <th>Connected</th>
              <th>Started</th>
              <th>Ended</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody id="rows"></tbody>
        </table>
      </div>
    </div>
  </div>

<script>
  const fmtTime = (t) => t ? new Date(t).toLocaleString() : "";
  const fmtBytes = (n) => {
    if (typeof n !== "number") return "";
    const u=["B","KB","MB","GB","TB"]; let i=0,x=n;
    while(x>=1024&&i<u.length-1){x/=1024;i++}
    return (i===0?x.toFixed(0):x.toFixed(2))+" "+u[i];
  };

  async function refresh(){
    const r = await fetch("/api/stats");
    const data = await r.json();

    document.getElementById("count").textContent = String(data.rows.length);

    const s = data.summary;
    document.getElementById("summary").innerHTML = [
      \`<span class="pill"><b>Total</b>: \${s.total}</span>\`,
      \`<span class="pill"><b>Success</b>: \${s.success}</span>\`,
      \`<span class="pill"><b>Failed</b>: \${s.failed}</span>\`,
      \`<span class="pill"><b>Expired</b>: \${s.expired}</span>\`
    ].join("");

    document.getElementById("byStatus").textContent = "byStatus: " + JSON.stringify(s.byStatus);

    const tbody = document.getElementById("rows");
    tbody.innerHTML = data.rows.map(row => \`
      <tr>
        <td class="mono">\${row.id}</td>
        <td>\${row.status || ""}</td>
        <td>\${fmtBytes(row.bytes)}</td>
        <td>\${fmtTime(row.createdAt)}</td>
        <td>\${fmtTime(row.connectedAt)}</td>
        <td>\${fmtTime(row.startedAt)}</td>
        <td>\${fmtTime(row.endedAt)}</td>
        <td class="mono">\${row.reason || ""}</td>
      </tr>\`
    ).join("");
  }

  refresh();
  setInterval(refresh, 2000);
</script>
</body>
</html>`);
});

// --- WebSocket signaling ---
function markDisconnect(token, role) {
  const m = metrics.get(token);
  if (!m) return;

  if (m.status === "success") return;

  const reason = role === "sender" ? "sender_disconnected" : "receiver_disconnected";
  m.status = m.status === "transferring" ? "failed" : (m.status || "failed");
  m.reason = m.reason || reason;
  m.endedAt = m.endedAt || now();
  m.lastSeenAt = now();
}

wss.on("connection", (ws) => {
  let boundToken = null;
  let boundRole = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    const { token, role, type, payload } = msg;
    if (!token) return;

    boundToken = token;
    boundRole = role;

    const room = ensureRoom(token);
    ensureMetric(token);

    // Token expiry check
    const m = metrics.get(token);
    if (m && m.createdAt && now() - m.createdAt > TOKEN_TTL_MS && !m.endedAt) {
      m.status = "expired";
      m.endedAt = now();
      // cleanup will remove room shortly
      safeSend(ws, { type: "expired" });
      return;
    }

    
if (type === "join") {
  // Enforce a single sender and single receiver per token.
  if (role === "sender") {
    if (room.sender && room.sender !== ws) { try { room.sender.close(); } catch {} }
    room.sender = ws;
  }
  if (role === "receiver") {
    if (room.receiver && room.receiver !== ws) { try { room.receiver.close(); } catch {} }
    room.receiver = ws;
  }

      const met = metrics.get(token);
      if (met) {
        if (role === "sender" && !met.senderConnectedAt) met.senderConnectedAt = now();
        if (role === "receiver" && !met.receiverConnectedAt) met.receiverConnectedAt = now();
        met.status = met.status === "success" ? "success" : "connected";
        met.connectedAt = met.connectedAt || now();
        met.lastSeenAt = now();
      }

      safeSend(ws, { type: "joined" });

      // Flush buffered signaling messages
      if (role === "receiver" && room.pendingForReceiver.length) {
        for (const m of room.pendingForReceiver) safeSend(room.receiver, m);
        room.pendingForReceiver = [];
      }
      if (role === "sender" && room.pendingForSender.length) {
        for (const m of room.pendingForSender) safeSend(room.sender, m);
        room.pendingForSender = [];
      }

      safeSend(room.sender, { type: "peer", payload: { present: !!room.receiver } });
      safeSend(room.receiver, { type: "peer", payload: { present: !!room.sender } });
      return;
    }

    const forward = { type, payload };
    const target = role === "sender" ? room.receiver : room.sender;

    if (target) {
      safeSend(target, forward);
    } else {
      if (role === "sender") room.pendingForReceiver.push(forward);
      else room.pendingForSender.push(forward);
    }
  });

  ws.on("close", () => {
    if (!boundToken || !boundRole) return;

    const token = boundToken;
    const role = boundRole;
    const room = rooms.get(token);

    
if (room) {
  if (role === "sender" && room.sender === ws) room.sender = null;
  if (role === "receiver" && room.receiver === ws) room.receiver = null;

  // Notify the remaining peer that the other side is gone so it can retry.
  safeSend(room.sender, { type: "peer", payload: { present: !!room.receiver } });
  safeSend(room.receiver, { type: "peer", payload: { present: !!room.sender } });
}

    markDisconnect(token, role);

    // If sender dropped and no receiver is connected, schedule orphan cleanup
    const m = metrics.get(token);
    if (m && role === "sender") {
      m.orphanAt = now();
    }
  });
});

// --- Cleanup loop ---
setInterval(() => {
  const t = now();
  for (const [token, m] of metrics.entries()) {
    const age = t - (m.createdAt || t);
    const endedAge = m.endedAt ? (t - m.endedAt) : 0;

    // Expire tokens after TTL if not ended
    if (!m.endedAt && age > TOKEN_TTL_MS) {
      m.status = "expired";
      m.endedAt = t;
    }

    // Orphan: sender disconnected and receiver never connected
    if (m.orphanAt && !m.receiverConnectedAt && (t - m.orphanAt) > ORPHAN_GRACE_MS) {
      m.status = m.status === "success" ? "success" : "failed";
      m.reason = m.reason || "sender_disconnected";
      m.endedAt = m.endedAt || t;
    }

    // Delete rooms/metrics after retention
    if (m.endedAt && endedAge > CLOSED_RETENTION_MS) {
      metrics.delete(token);
      rooms.delete(token);
      continue;
    }

    // Also delete expired tokens after short retention
    if (m.status === "expired" && m.endedAt && endedAge > 10 * 60 * 1000) {
      metrics.delete(token);
      rooms.delete(token);
    }
  }

  // Rooms without metrics (should not happen often)
  for (const [token, room] of rooms.entries()) {
    if (!metrics.has(token)) {
      rooms.delete(token);
      continue;
    }
    // If both peers gone and nothing pending, allow cleanup once metric ends
    if (!room.sender && !room.receiver && room.pendingForSender.length === 0 && room.pendingForReceiver.length === 0) {
      // keep until metrics cleanup
    }
  }
}, CLEANUP_POLL_MS);

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on http://0.0.0.0:${PORT}`);
  if (!STATS_USER || !STATS_PASS) console.log("Stats disabled until STATS_USER and STATS_PASS are set.");
  if (!STATS_SALT) console.log("Set STATS_SALT for stable, non-reversible admin IDs.");
});
