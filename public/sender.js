import { makePc } from "./webrtc.js";
import QRCode from "https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm";
import { $, setStatus, setProgress, fmtBytes, fmtRate, fmtETA } from "./ui.js";

function safeText(el, value){ if (el) el.textContent = value; }





const drop = $("drop");
const fileInput = $("file");
const createBtn = $("createBtn");
const clearBtn = $("clearBtn");
const queueEl = $("queue");
const queueControlsRow = $("queueControlsRow");
const shareOut = document.getElementById("shareOut");
const transferCard = document.getElementById("transferCard");

const linkEl = $("link");
const qrEl = $("qr");
const qrPlaceholder = $("qrPlaceholder");

const passEl = $("pass");
const togglePassBtn = $("togglePass");
const shareBtn = $("shareBtn");
const copyBtn = $("copyBtn");
const kofiInline = document.getElementById("kofiInline");
let kofiInitDone = false;
const connStateEl = $("connState");
const netEl = $("net");

const statusTextEl = $("status");
const statusWrapEl = $("statusWrap");

const xferStatusEl = $("xferStatus");
const xferWrapEl = $("xferWrap");
const barEl = $("bar");
const progressTextEl = $("progressText");
const rateTextEl = $("rateText");
const etaTotalEl = $("etaTotal");
const etaFileEl = $("etaFile");
const etaFileStatEl = $("etaFileStat");
const currentFileEl = $("currentFile");
const resetBtn = $("resetBtn");


function teardownPeer(){
  try { if (dc) dc.close(); } catch {}
  try { if (pc) pc.close(); } catch {}
  dc = null;
  pc = null;
}

function setConnDisplay(text){
  safeText(connStateEl, text);
}

function resetForReceiverRetry(){
  // Allow a receiver to reopen the same link without requiring a new token.
  teardownPeer();
  startedNegotiation = false;
  setTopStatus("Waiting for receiver", "warn");
  setXferStatus("Waiting", "warn");
  setConnDisplay("Not connected");
}

let token, ws, pc, dc;
let receiverPresent = false;
const rowBars = new Map();
let transferCompleted = false;
let startedNegotiation = false;
let locked = false;
let wsReconnectTimer = null;
let pendingSignals = [];
let rebuildPeerSession = null;

let passRequired = false;
let passSalt = null;
let passDigest = null;
let authed = false;
let shareUrl = null;

let queue = []; // { id, file }
let nextId = 1;

drop.addEventListener("click", () => fileInput.click());
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") fileInput.click(); });
drop.addEventListener("dragover", (e) => { e.preventDefault(); });
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  if (locked) return;
  addFiles(e.dataTransfer.files);
});
fileInput.addEventListener("change", () => {
  if (locked) return;
  addFiles(fileInput.files);
  fileInput.value = "";
});

clearBtn.addEventListener("click", () => {
  if (locked) return;
  queue = [];
  renderQueue();
});

createBtn.addEventListener("click", async () => {
  if (locked) return;
  if (!queue.length) return;
  await createShareLink();
});

resetBtn.addEventListener("click", () => location.reload());

togglePassBtn?.addEventListener("click", () => {
  if (!passEl) return;
  const show = passEl.type === "password";
  passEl.type = show ? "text" : "password";
  togglePassBtn.textContent = show ? "Hide" : "Show";
});

copyBtn?.addEventListener("click", async () => {
  if (!shareUrl) return;
  try {
    await navigator.clipboard.writeText(shareUrl);
    setTopStatus("Link copied", "ok");
  } catch {
    setTopStatus("Copy failed", "bad");
  }
});

shareBtn?.addEventListener("click", async () => {
  if (!shareUrl) return;
  if (!navigator.share) return;
  try {
    await navigator.share({ title: "DirectDrop", text: "Open this link to receive the files", url: shareUrl });
  } catch {
    // user canceled
  }
});

function setTopStatus(label, kind){
  setStatus(statusTextEl, label, kind);
  statusWrapEl.classList.remove("ok","warn","bad");
  if (kind) statusWrapEl.classList.add(kind);
}
function setXferStatus(label, kind){
  setStatus(xferStatusEl, label, kind);
  xferWrapEl.classList.remove("ok","warn","bad");
  if (kind) xferWrapEl.classList.add(kind);
}
function setNet(s){ if (netEl) netEl.textContent = `Signaling: ${s}`; }

function addFiles(fileList){
  const files = Array.from(fileList || []);
  if (!files.length) return;

  for (const f of files) {
    queue.push({ id: nextId++, file: f });
  }
  renderQueue();
}

function moveItem(fromIdx, toIdx){
  if (toIdx < 0 || toIdx >= queue.length) return;
  const [it] = queue.splice(fromIdx, 1);
  queue.splice(toIdx, 0, it);
  renderQueue();
}

function removeItem(idx){
  queue.splice(idx, 1);
  renderQueue();
}

function lockQueue(){
  locked = true;
  createBtn.disabled = true;
  clearBtn.disabled = true;

  // Hide manipulation controls for a cleaner locked view
  queueEl.querySelectorAll("button.iconbtn, input.num").forEach(el => el.style.display = "none");

  drop.style.display = "none";
  fileInput.style.display = "none";
  if (queueControlsRow) queueControlsRow.style.display = "none";
  if (passEl) passEl.readOnly = true;

  if (shareOut) shareOut.style.display = "block";
  if (transferCard) transferCard.style.display = "block";
  setTopStatus("Link created. Waiting for receiver", "warn");
}

function renderQueue(){
  queueEl.innerHTML = "";
  if (!queue.length){
    queueEl.style.display = "none";
    createBtn.disabled = true;
    clearBtn.disabled = true;
    setTopStatus("Add files to begin", "warn");
    return;
  }

  queueEl.style.display = "block";
  createBtn.disabled = locked ? true : false;
  clearBtn.disabled = locked ? true : false;

  setTopStatus(locked ? "Queue locked" : "Ready to create share link", locked ? "ok" : "warn");

  queue.forEach((q, idx) => {
    const row = document.createElement("div");
    row.className = "list-row";
    row.innerHTML = `
      <span class="badge">${idx+1}</span>
      <div class="grow">
        <div style="font-weight:650; overflow-wrap:anywhere;">${escapeHtml(q.file.name)}</div>
        <div class="small">${fmtBytes(q.file.size)}</div>
      </div>
      <input class="num" type="number" min="1" max="${queue.length}" value="${idx+1}" title="Position"/>
      <button class="iconbtn" title="Up">↑</button>
      <button class="iconbtn" title="Down">↓</button>
      <button class="iconbtn" title="Remove">✕</button>
    `;
    const posInput = row.querySelector("input");
    const upBtn = row.querySelectorAll("button")[0];
    const downBtn = row.querySelectorAll("button")[1];
    const rmBtn = row.querySelectorAll("button")[2];

    posInput.addEventListener("change", () => {
      if (locked) return;
      const to = Math.max(1, Math.min(queue.length, parseInt(posInput.value || (idx+1), 10))) - 1;
      moveItem(idx, to);
    });
    upBtn.addEventListener("click", () => { if (!locked) moveItem(idx, idx-1); });
    downBtn.addEventListener("click", () => { if (!locked) moveItem(idx, idx+1); });
    rmBtn.addEventListener("click", () => { if (!locked) removeItem(idx); });

    if (locked) {
      posInput.disabled = true; upBtn.disabled = true; downBtn.disabled = true; rmBtn.disabled = true;
    }

    queueEl.appendChild(row);
  });
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function bufToHex(buf){
  if (!buf) return "";
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text){
  const data = new TextEncoder().encode(text);

  // WebCrypto digest requires a secure context (https or localhost). If unavailable,
  // fall back to a tiny in-page SHA-256 implementation so passphrases still work.
  if (globalThis.crypto && crypto.subtle && typeof crypto.subtle.digest === "function") {
    try {
      const hash = await crypto.subtle.digest("SHA-256", data);
      return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
    } catch (_) { /* fall through */ }
  }

  return sha256HexFallback(data);
}

function sha256HexFallback(dataBytes){
  // Minimal SHA-256 implementation (UTF-8 bytes in, hex out).
  const K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ]);

  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  const ch   = (x, y, z) => (x & y) ^ (~x & z);
  const maj  = (x, y, z) => (x & y) ^ (x & z) ^ (y & z);
  const s0   = x => rotr(x, 2) ^ rotr(x, 13) ^ rotr(x, 22);
  const s1   = x => rotr(x, 6) ^ rotr(x, 11) ^ rotr(x, 25);
  const g0   = x => rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
  const g1   = x => rotr(x, 17) ^ rotr(x, 19) ^ (x >>> 10);

  const ml = dataBytes.length * 8;
  const withOne = new Uint8Array(dataBytes.length + 1);
  withOne.set(dataBytes, 0);
  withOne[dataBytes.length] = 0x80;

  let zeroPadLen = (64 - ((withOne.length + 8) % 64)) % 64;
  const padded = new Uint8Array(withOne.length + zeroPadLen + 8);
  padded.set(withOne, 0);

  // Append length (big-endian 64-bit)
  const dv = new DataView(padded.buffer);
  const hi = Math.floor(ml / 0x100000000);
  const lo = ml >>> 0;
  dv.setUint32(padded.length - 8, hi, false);
  dv.setUint32(padded.length - 4, lo, false);

  let h0=0x6a09e667, h1=0xbb67ae85, h2=0x3c6ef372, h3=0xa54ff53a;
  let h4=0x510e527f, h5=0x9b05688c, h6=0x1f83d9ab, h7=0x5be0cd19;

  const w = new Uint32Array(64);

  for (let i = 0; i < padded.length; i += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] = dv.getUint32(i + t*4, false);
    }
    for (let t = 16; t < 64; t++) {
      w[t] = (g1(w[t-2]) + w[t-7] + g0(w[t-15]) + w[t-16]) >>> 0;
    }

    let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;

    for (let t = 0; t < 64; t++) {
      const t1 = (h + s1(e) + ch(e,f,g) + K[t] + w[t]) >>> 0;
      const t2 = (s0(a) + maj(a,b,c)) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outDv = new DataView(out.buffer);
  outDv.setUint32(0,  h0, false);
  outDv.setUint32(4,  h1, false);
  outDv.setUint32(8,  h2, false);
  outDv.setUint32(12, h3, false);
  outDv.setUint32(16, h4, false);
  outDv.setUint32(20, h5, false);
  outDv.setUint32(24, h6, false);
  outDv.setUint32(28, h7, false);

  return [...out].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function ping(event, extra = {}) {
  if (!token) return;
  await fetch("/api/metrics/ping", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, event, ...extra }),
  }).catch(() => {});
}

async function createShareLink(){
  setTopStatus("Creating link", "warn");

  // Reset link/qr UI
  linkEl.textContent = "—";
  linkEl.href = "#";
  qrPlaceholder.style.display = "block";
  qrEl.style.display = "none";

  if (kofiInline) kofiInline.style.display = "none";

  const totalBytes = queue.reduce((a, q) => a + (q.file.size || 0), 0);

  const r = await fetch("/api/create");
  token = (await r.json()).token;

  authed = false;
  passRequired = !!(passEl && (passEl.value || "").trim().length);
  passSalt = passRequired ? crypto.getRandomValues(new Uint8Array(16)) : null;
  passDigest = passRequired ? await sha256Hex(`${bufToHex(passSalt)}:${(passEl.value || "").trim()}`) : null;

  const url = `${location.origin}/t/${token}`;
  shareUrl = url;
  linkEl.href = url;
  linkEl.textContent = url;

  if (shareBtn) shareBtn.style.display = navigator.share ? "inline-flex" : "none";

  const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 220 });
  qrPlaceholder.style.display = "none";
  qrEl.style.display = "block";
  qrEl.src = dataUrl;

  lockQueue();
  resetBtn.disabled = true;

  setConnDisplay("Not connected");
  safeText(connStateEl, "—");
  setNet("connecting");

  // Start signaling and WebRTC
  connectSignaling();

  const manifest = queue.map((q, i) => ({ index: i+1, name: q.file.name, size: q.file.size, mime: q.file.type || "application/octet-stream" }));

  function initPeerSession(){
    teardownPeer();
    pc = makePc();

    pc.onconnectionstatechange = () => {
    // Single connection indicator:
    // - If the receiver has opened the link but WebRTC isn't connected yet, show that.
    // - Otherwise show the current peer connection state.
    if (pc.connectionState === "connected") {
      setConnDisplay("Connected");
      ping("connected", { bytes: totalBytes });
      return;
    }

    if (receiverPresent && pc.connectionState !== "failed") {
      setConnDisplay("Receiver opened link");
    } else {
      setConnDisplay(pc.connectionState || "Not connected");
    }

    if (pc.connectionState === "failed") {
      setTopStatus("Connection problem", "bad");
      resetBtn.disabled = false;
      ping("failed", { reason: pc.connectionState });
      if (!transferCompleted) resetForReceiverRetry();
    }
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate) signalSend({ token, role: "sender", type: "ice", payload: ev.candidate });
    };

    dc = pc.createDataChannel("file", { ordered: true });
    dc.binaryType = "arraybuffer";

    let receiverReady = false;
    let selectedIndexes = null;
    dc.onmessage = async (ev) => {
    if (typeof ev.data !== "string") return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === "auth") {
      if (!passRequired) {
        safeSendJson({ type: "auth_result", ok: true });
        authed = true;
        await sendManifest();
        return;
      }
      const ok = typeof msg.digest === "string" && msg.digest === passDigest;
      safeSendJson({ type: "auth_result", ok });
      authed = ok;
      if (ok) {
        setTopStatus("Receiver unlocked", "ok");
        await sendManifest();
      } else {
        setXferStatus("Waiting for correct passphrase", "warn");
      }
      return;
    }

    if (msg.type === "ready") {
      if (Array.isArray(msg.selected)) {
        const allowed = new Set(manifest.map((f) => f.index));
        const uniq = [];
        for (const raw of msg.selected) {
          const idx = Number(raw);
          if (!Number.isInteger(idx) || !allowed.has(idx) || uniq.includes(idx)) continue;
          uniq.push(idx);
        }
        selectedIndexes = uniq;
      }
      receiverReady = true;
      return;
    }
    };

  async function safeSendJson(o){
    try { dc.send(JSON.stringify(o)); } catch {}
  }

  async function sha256Hex(text){
    const data = new TextEncoder().encode(text);

    // WebCrypto digest requires a secure context (https or localhost). If unavailable,
    // fall back to a tiny in-page SHA-256 implementation so passphrases still work.
    if (globalThis.crypto && crypto.subtle && typeof crypto.subtle.digest === "function") {
      try {
        const hash = await crypto.subtle.digest("SHA-256", data);
        return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
      } catch (_) { /* fall through */ }
    }

    return sha256HexFallback(data);
  }

  function sha256HexFallback(dataBytes){
    // Minimal SHA-256 implementation (UTF-8 bytes in, hex out).
    const K = new Uint32Array([
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
    ]);

    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    const ch   = (x, y, z) => (x & y) ^ (~x & z);
    const maj  = (x, y, z) => (x & y) ^ (x & z) ^ (y & z);
    const s0   = x => rotr(x, 2) ^ rotr(x, 13) ^ rotr(x, 22);
    const s1   = x => rotr(x, 6) ^ rotr(x, 11) ^ rotr(x, 25);
    const g0   = x => rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
    const g1   = x => rotr(x, 17) ^ rotr(x, 19) ^ (x >>> 10);

    const ml = dataBytes.length * 8;
    const withOne = new Uint8Array(dataBytes.length + 1);
    withOne.set(dataBytes, 0);
    withOne[dataBytes.length] = 0x80;

    let zeroPadLen = (64 - ((withOne.length + 8) % 64)) % 64;
    const padded = new Uint8Array(withOne.length + zeroPadLen + 8);
    padded.set(withOne, 0);

    // Append length (big-endian 64-bit)
    const dv = new DataView(padded.buffer);
    const hi = Math.floor(ml / 0x100000000);
    const lo = ml >>> 0;
    dv.setUint32(padded.length - 8, hi, false);
    dv.setUint32(padded.length - 4, lo, false);

    let h0=0x6a09e667, h1=0xbb67ae85, h2=0x3c6ef372, h3=0xa54ff53a;
    let h4=0x510e527f, h5=0x9b05688c, h6=0x1f83d9ab, h7=0x5be0cd19;

    const w = new Uint32Array(64);

    for (let i = 0; i < padded.length; i += 64) {
      for (let t = 0; t < 16; t++) {
        w[t] = dv.getUint32(i + t*4, false);
      }
      for (let t = 16; t < 64; t++) {
        w[t] = (g1(w[t-2]) + w[t-7] + g0(w[t-15]) + w[t-16]) >>> 0;
      }

      let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;

      for (let t = 0; t < 64; t++) {
        const t1 = (h + s1(e) + ch(e,f,g) + K[t] + w[t]) >>> 0;
        const t2 = (s0(a) + maj(a,b,c)) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }

      h0 = (h0 + a) >>> 0;
      h1 = (h1 + b) >>> 0;
      h2 = (h2 + c) >>> 0;
      h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0;
      h5 = (h5 + f) >>> 0;
      h6 = (h6 + g) >>> 0;
      h7 = (h7 + h) >>> 0;
    }

    const out = new Uint8Array(32);
    const outDv = new DataView(out.buffer);
    outDv.setUint32(0,  h0, false);
    outDv.setUint32(4,  h1, false);
    outDv.setUint32(8,  h2, false);
    outDv.setUint32(12, h3, false);
    outDv.setUint32(16, h4, false);
    outDv.setUint32(20, h5, false);
    outDv.setUint32(24, h6, false);
    outDv.setUint32(28, h7, false);

    return [...out].map(b => b.toString(16).padStart(2, "0")).join("");
  }

    async function sendManifest(){
    safeSendJson({ type: "manifest", files: manifest, totalBytes });
    setXferStatus("Waiting for receiver consent", "warn");
    await ping("waiting_consent", { bytes: totalBytes });
    }

  function getSelectionStats(){
    const selectedSet = new Set(Array.isArray(selectedIndexes) && selectedIndexes.length
      ? selectedIndexes
      : manifest.map((f) => f.index));
    const selectedFiles = manifest.filter((f) => selectedSet.has(f.index));
    return {
      files: selectedFiles.length,
      bytes: selectedFiles.reduce((a, f) => a + (f.size || 0), 0),
    };
  }

    dc.onopen = async () => {
    const saltHex = passSalt ? bufToHex(passSalt) : "";
    safeSendJson({ type: "hello", passRequired, salt: saltHex });
    if (passRequired) {
      setXferStatus("Waiting for passphrase", "warn");
      setTopStatus("Receiver must enter passphrase", "warn");
    } else {
      authed = true;
      await sendManifest();
    }

    const start = performance.now();
    while (!receiverReady) {
      if (performance.now() - start > 5 * 60 * 1000) {
        setXferStatus("Timed out waiting for consent", "bad");
        await ping("failed", { reason: "consent_timeout" });
        resetBtn.disabled = false;
        return;
      }
      await new Promise(r => setTimeout(r, 200));
    }

    setTopStatus("Receiver accepted", "ok");
    const selectionStats = getSelectionStats();
    await ping("accepted", { bytes: selectionStats.bytes });

    setXferStatus("Transferring", "warn");
    await sendQueueSequential(manifest, totalBytes, selectedIndexes);

    setXferStatus("Complete", "ok");
    transferCompleted = true;
    const selectionStatsDone = getSelectionStats();
    await ping("success", {
      bytes: selectionStatsDone.bytes,
      files: selectionStatsDone.files
    }); 
    
    resetBtn.disabled = false;
    };

    dc.onclose = () => {
      if (!transferCompleted) {
        setXferStatus("Connection lost. Waiting for reconnect", "warn");
        resetForReceiverRetry();
      } else {
        setXferStatus("Channel closed", "bad");
      }
      resetBtn.disabled = false;
      ping("closed");
    };
    dc.onerror = () => { setXferStatus("Transfer error", "bad"); resetBtn.disabled = false; ping("failed", { reason: "datachannel_error" }); };
  }

  rebuildPeerSession = initPeerSession;
  initPeerSession();
}

async function beginNegotiationIfReady() {
  if (startedNegotiation) return;
  if (!receiverPresent) return;
  if (!pc || !dc || pc.connectionState === "closed" || dc.readyState === "closed") {
    setXferStatus("Reconnecting session", "warn");
    if (typeof rebuildPeerSession === "function") rebuildPeerSession();
    if (!pc) return;
  }

  startedNegotiation = true;
  setTopStatus("Negotiating", "warn");

  const offer = await pc.createOffer({ iceRestart: true });
  await pc.setLocalDescription(offer);
  signalSend({ token, role: "sender", type: "offer", payload: offer });
}

function signalSend(msg){
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return;
  }
  pendingSignals.push(msg);
}

function connectSignaling(){
  if (!token || transferCompleted) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/signal`);
  ws.onmessage = async (e) => onSignal(JSON.parse(e.data));
  ws.onopen = () => {
    setNet("connected");
    ws.send(JSON.stringify({ token, role: "sender", type: "join" }));
    while (pendingSignals.length && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(pendingSignals.shift()));
    }
  };
  ws.onclose = () => {
    if (transferCompleted) {
      setNet("closed");
      resetBtn.disabled = false;
      return;
    }
    setNet("reconnecting");
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(() => connectSignaling(), 1000);
  };
  ws.onerror = () => { setNet("error"); };
}

async function onSignal(msg) {
  if (msg.type === "peer") {
  const wasPresent = receiverPresent;
  receiverPresent = !!msg.payload?.present;

  setConnDisplay(receiverPresent ? "Receiver opened link" : "Not connected");

  // If a receiver closes the page before starting/finishing, allow them to retry with the same link.
  if (wasPresent && !receiverPresent && !transferCompleted) {
    resetForReceiverRetry();
  }

  if (receiverPresent) await beginNegotiationIfReady();
  return;
}
  if (!pc) return;

  if (msg.type === "answer") {
    await pc.setRemoteDescription(msg.payload);
    return;
  }

  if (msg.type === "ice") {
    try { await pc.addIceCandidate(msg.payload); }
    catch (e) { console.log("[sender] addIceCandidate error", e); }
  }
}

async function sendQueueSequential(manifest, totalBytes, selectedIndexes){
  // Overall progress is total bytes sent across all files.
  let totalSent = 0;
  let lastSent = 0;
  let lastT = performance.now();

  let fileSent = 0;
  let fileSize = 0;

  // Smooth transfer rate and derived ETA to reduce jitter.
  const rateSamples = [];
  const maxRateSamples = 9;
  let rateEma = 0;
  let rateEmaInit = false;
  let rateEmaLastT = performance.now();
  const rateTau = 3.0; // seconds
  function smoothRate(rawBps, now){
    const raw = Math.max(0, rawBps || 0);
    rateSamples.push(raw);
    if (rateSamples.length > maxRateSamples) rateSamples.shift();
    const sorted = [...rateSamples].sort((a,b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 0;
    if (!rateEmaInit){
      rateEmaInit = true;
      rateEma = median;
      rateEmaLastT = now || performance.now();
      return rateEma;
    }
    const tNow = now || performance.now();
    const dt = Math.max(0.001, (tNow - rateEmaLastT) / 1000);
    rateEmaLastT = tNow;
    const alpha = 1 - Math.exp(-dt / rateTau);
    rateEma = rateEma + alpha * (median - rateEma);
    return rateEma;
  }


  const selectedSet = new Set(Array.isArray(selectedIndexes) && selectedIndexes.length
    ? selectedIndexes
    : manifest.map((f) => f.index));

  const filesToSend = manifest.filter((f) => selectedSet.has(f.index));
  const selectedTotalBytes = filesToSend.reduce((a, f) => a + (f.size || 0), 0);

  
  function updateOverall(rateBps, now){
    setProgress(barEl, selectedTotalBytes ? (totalSent / selectedTotalBytes) : 0);
    const filePart = fileSize ? `File: ${fmtBytes(fileSent)} / ${fmtBytes(fileSize)}` : "File: —";
    const totalPart = `Total: ${fmtBytes(totalSent)} / ${fmtBytes(selectedTotalBytes)}`;
    progressTextEl.textContent = `${filePart} • ${totalPart}`;
    const smooth = smoothRate(rateBps, now);
    rateTextEl.textContent = fmtRate(smooth);

    const rate = smooth;
    if (etaTotalEl) {
      const remaining = Math.max(0, selectedTotalBytes - totalSent);
      etaTotalEl.textContent = rate > 0 ? fmtETA(remaining / rate) : "—";
    }
    if (etaFileEl) {
      const fRemaining = Math.max(0, fileSize - fileSent);
      etaFileEl.textContent = rate > 0 ? fmtETA(fRemaining / rate) : "—";
    }
  }


  for (let i = 0; i < filesToSend.length; i++) {
    const mf = filesToSend[i];
    const q = queue[mf.index - 1];
    if (!q?.file) continue;
    const f = q.file;
    fileSent = 0;
    fileSize = f.size || 0;
    currentFileEl.textContent = `${i+1}/${filesToSend.length} ${f.name}`;
    dc.send(JSON.stringify({ type: "meta", index: mf.index, name: f.name, size: f.size, mime: f.type || "application/octet-stream" }));

    // DataChannel backpressure + message sizing
    // RTCDataChannel max message size varies by browser/transport; cap conservatively and
    // use SCTP's reported maxMessageSize when available.
    const sctpMax = (pc && pc.sctp && Number.isFinite(pc.sctp.maxMessageSize) && pc.sctp.maxMessageSize > 0)
      ? pc.sctp.maxMessageSize
      : 262144; // 256 KB fallback

    const chunkSize = Math.max(16384, Math.min(256 * 1024, Math.floor(sctpMax - 1024))); // keep headroom

    // Keep bufferedAmount under a safe ceiling to avoid silent send-queue stalls on some stacks.
    const HIGH_WATER = 16 * 1024 * 1024; // 16 MB
    const LOW_WATER  = 4 * 1024 * 1024;  // 4 MB

    if (typeof dc.bufferedAmountLowThreshold === "number") {
      dc.bufferedAmountLowThreshold = LOW_WATER;
    }

    function waitForDrain(){
      if (dc.bufferedAmount <= LOW_WATER) return Promise.resolve();
      return new Promise((resolve) => {
        const onLow = () => {
          dc.removeEventListener("bufferedamountlow", onLow);
          clearInterval(fallback);
          resolve();
        };
        dc.addEventListener("bufferedamountlow", onLow);

        // Fallback polling for browsers that don't reliably emit bufferedamountlow.
        const fallback = setInterval(() => {
          if (dc.bufferedAmount <= LOW_WATER) {
            dc.removeEventListener("bufferedamountlow", onLow);
            clearInterval(fallback);
            resolve();
          }
        }, 40);
      });
    }

    async function sendWithBackpressure(payload){
      while (dc.bufferedAmount > HIGH_WATER) {
        await waitForDrain();
      }

      try {
        dc.send(payload);
        return;
      } catch (e) {
        // Often indicates the internal send queue is saturated.
        await waitForDrain();
        while (dc.bufferedAmount > HIGH_WATER) {
          await waitForDrain();
        }

        try {
          dc.send(payload);
          return;
        } catch (e2) {
          // Last resort: split to smaller pieces and send them through the same backpressure gate.
          const u8 = payload instanceof ArrayBuffer
            ? new Uint8Array(payload)
            : new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);

          const sub = 64 * 1024;
          for (let off = 0; off < u8.byteLength; off += sub) {
            const end2 = Math.min(u8.byteLength, off + sub);
            const slice = u8.subarray(off, end2);

            while (dc.bufferedAmount > HIGH_WATER) {
              await waitForDrain();
            }

            let ok = false;
            for (let attempt = 0; attempt < 5 && !ok; attempt++) {
              try {
                dc.send(slice);
                ok = true;
              } catch (e3) {
                await waitForDrain();
                await new Promise(r => setTimeout(r, 0));
              }
            }
            if (!ok) throw e2;
          }
        }
      }
    }

    // Pipeline disk reads with sending.
    let offset = 0;
    let nextBufPromise = fileSize ? f.slice(0, Math.min(fileSize, chunkSize)).arrayBuffer() : Promise.resolve(new ArrayBuffer(0));

    while (offset < fileSize) {
      const buf = await nextBufPromise;
      const len = buf.byteLength;

      // Advance and kick off the next read as early as possible.
      offset += len;
      if (offset < fileSize) {
        const end = Math.min(fileSize, offset + chunkSize);
        nextBufPromise = f.slice(offset, end).arrayBuffer();
      }

      // Send (respects backpressure and handles transient queue saturation).
      await sendWithBackpressure(buf);

      fileSent += len;
      totalSent += len;

      const now = performance.now();
      const dt = (now - lastT) / 1000;
      if (dt > 0.4) {
        const rate = (totalSent - lastSent) / dt;
        updateOverall(rate, now);
        lastSent = totalSent;
        lastT = now;
      }
    }
    dc.send(JSON.stringify({ type: "file_done", index: mf.index }));
  }

  // Final overall update
  setProgress(barEl, 1);
  progressTextEl.textContent = `File: — • Total: ${fmtBytes(selectedTotalBytes)} / ${fmtBytes(selectedTotalBytes)}`;
  rateTextEl.textContent = "done";
  currentFileEl.textContent = "—";
  dc.send(JSON.stringify({ type: "done" }));
}

renderQueue();
