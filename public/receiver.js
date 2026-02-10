import { makePc } from "./webrtc.js";
import { $, setStatus, setProgress, fmtBytes, fmtRate } from "./ui.js";

function safeText(el, value){ if (el) el.textContent = value; }




const statusTextEl = $("status");
const statusWrapEl = $("statusWrap");
const xferStatusEl = $("xferStatus");
const xferWrapEl = $("xferWrap");

const connStateEl = $("connState");
const dcStateEl = $("dcState");
const netEl = $("net");

const queueEl = $("queue");
const startBtn = $("startBtn");
const saveAllBtn = $("saveAllBtn");

const authBox = $("authBox");
const passIn = $("passIn");
const passGo = $("passGo");
const authMsg = $("authMsg");

const saveOpts = $("saveOpts");
const streamToggle = $("streamToggle");
const chooseFolderBtn = $("chooseFolder");
const folderLabel = $("folderLabel");

const barEl = $("bar");
const progressTextEl = $("progressText");
const rateTextEl = $("rateText");
const currentFileEl = $("currentFile");

const token = location.pathname.split("/").pop();

let ws, pc, dc;

let manifest = null;  // { files: [{index,name,size,mime}], totalBytes }
let accepted = false;

let hello = null;     // { passRequired, salt }
let authOk = false;

const supportsDirPicker = typeof window.showDirectoryPicker === "function";
let streamEnabled = false;
let dirHandle = null;
let writable = null;
let writeChain = Promise.resolve();

let receiving = null; // current file meta
let buffers = [];
let receivedForFile = 0;

let totalBytes = 0;
let totalReceived = 0;

let lastBytes = 0;
let lastT = performance.now();

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

async function ping(event, extra = {}) {
  await fetch("/api/metrics/ping", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, event, ...extra }),
  }).catch(() => {});
}

ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/signal`);
ws.onmessage = async (e) => onSignal(JSON.parse(e.data));
ws.onopen = () => { setNet("connected"); ws.send(JSON.stringify({ token, role: "receiver", type: "join" })); };
ws.onclose = () => setNet("closed");
ws.onerror = () => setNet("error");

pc = makePc();

pc.onconnectionstatechange = () => {
  safeText(connStateEl, pc.connectionState);
  if (pc.connectionState === "connected") setTopStatus("Connected", "ok");
  if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
    setTopStatus("Connection problem", "bad");
    setXferStatus("Failed", "bad");
    ping("failed", { reason: pc.connectionState });
  }
};

pc.onicecandidate = (ev) => {
  if (ev.candidate) ws.send(JSON.stringify({ token, role: "receiver", type: "ice", payload: ev.candidate }));
};

pc.ondatachannel = (ev) => {
  dc = ev.channel;
  dc.binaryType = "arraybuffer";
  setupChannel();
};


saveAllBtn.addEventListener("click", async () => {
  if (!manifest) return;
  // Trigger downloads in sequence. Many browsers may still show prompts; this stays within a user gesture.
  for (const f of manifest.files) {
    const a = document.getElementById(`dl_${f.index}`);
    if (a && a.style.display !== "none") {
      a.click();
      await new Promise(r => setTimeout(r, 350));
    }
  }
});

streamToggle?.addEventListener("change", () => {
  streamEnabled = !!streamToggle.checked;
  if (streamEnabled && !supportsDirPicker) {
    streamEnabled = false;
    streamToggle.checked = false;
  }
  updateSaveAllState();
});

chooseFolderBtn?.addEventListener("click", async () => {
  if (!supportsDirPicker) return;
  try {
    dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    folderLabel.textContent = dirHandle?.name || "";
  } catch {
    // user canceled
  }
});

passGo?.addEventListener("click", async () => {
  if (!dc || !hello?.passRequired) return;
  const pass = (passIn.value || "").trim();
  if (!pass) {
    authMsg.textContent = "Enter the passphrase.";
    return;
  }
  authMsg.textContent = "Checking…";
  const digest = await sha256Hex(`${hello.salt}:${pass}`);
  dc.send(JSON.stringify({ type: "auth", digest }));
});
startBtn.addEventListener("click", async () => {
  if (!dc || !manifest) return;
  if (hello?.passRequired && !authOk) return;
  if (streamEnabled && supportsDirPicker && !dirHandle) {
    setTopStatus("Pick a folder to stream saves", "warn");
    return;
  }
  accepted = true;
  startBtn.disabled = true;
  startBtn.textContent = "Downloading…";
  setTopStatus("Downloading", "warn");
  setXferStatus("Receiving", "warn");
  setProgress(barEl, 0);
  progressTextEl.textContent = `0 / ${fmtBytes(totalBytes)}`;
  rateTextEl.textContent = "—";
  dc.send(JSON.stringify({ type: "ready" }));
  await ping("accepted", { bytes: totalBytes });
});

function renderManifest(){
  if (!manifest) return;
  queueEl.style.display = "block";
  queueEl.innerHTML = "";

  manifest.files.forEach((f) => {
    const row = document.createElement("div");
    row.className = "list-row";
    row.id = `row_${f.index}`;
    row.innerHTML = `
      <span class="badge">${f.index}</span>
      <div class="grow">
        <div style="font-weight:650; overflow-wrap:anywhere;">${escapeHtml(f.name)}</div>
        <div class="small">${fmtBytes(f.size)}</div>
      </div>
      <div class="mini-progress" title="File progress"><div id="fp_${f.index}"></div></div>
      <span class="badge" id="st_${f.index}">queued</span>
      <a class="btn" id="dl_${f.index}" style="display:none; padding:8px 10px; border-radius: 10px;" href="#" download>Save</a>
    `;
    queueEl.appendChild(row);
  });
}

function setRowStatus(index, text){
  const el = document.getElementById(`st_${index}`);
  if (el) el.textContent = text;
}

function setRowProgress(index, pct){
  const el = document.getElementById(`fp_${index}`);
  if (!el) return;
  const p = Math.max(0, Math.min(1, pct || 0));
  el.style.width = `${(p * 100).toFixed(2)}%`;
}

function showSaveLink(index, url, filename){
  const a = document.getElementById(`dl_${index}`);
  if (!a) return;
  a.href = url;
  a.download = filename;
  a.style.display = "inline-flex";
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
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


function updateSaveAllState(){
  if (!manifest || manifest.files.length <= 1) {
    saveAllBtn.style.display = "none";
    return;
  }
  if (streamEnabled) {
    saveAllBtn.style.display = "none";
    return;
  }
  saveAllBtn.style.display = "inline-flex";
  // enable only when all files have Save links visible
  const allReady = manifest.files.every(f => {
    const a = document.getElementById(`dl_${f.index}`);
    return a && a.style.display !== "none";
  });
  saveAllBtn.disabled = !allReady;
}

function setupChannel() {
  safeText(dcStateEl, "created");
  setXferStatus("Waiting", null);
  setTopStatus("Connected", "ok");

  dc.onopen = () => {
    safeText(dcStateEl, "open");
    setTopStatus("Ready", "ok");
  };

  dc.onmessage = async (ev) => {
    if (typeof ev.data === "string") {
      const msg = JSON.parse(ev.data);

      if (msg.type === "hello") {
        hello = msg;
        authOk = !msg.passRequired;
        if (msg.passRequired) {
          authBox.style.display = "block";
          authMsg.textContent = "";
          setTopStatus("Passphrase required", "warn");
          setXferStatus("Locked", "warn");
        }
        return;
      }

      if (msg.type === "auth_result") {
        if (msg.ok) {
          authOk = true;
          authBox.style.display = "none";
          setTopStatus("Unlocked", "ok");
          setXferStatus("Waiting for consent", "warn");
        } else {
          authOk = false;
          authMsg.textContent = "Incorrect passphrase.";
          setTopStatus("Passphrase incorrect", "bad");
          setXferStatus("Locked", "warn");
        }
        return;
      }

      if (msg.type === "manifest") {
        manifest = msg;
        totalBytes = msg.totalBytes || msg.files.reduce((a, f) => a + (f.size||0), 0);
        totalReceived = 0;
        lastBytes = 0;
        lastT = performance.now();

        renderManifest();
        updateSaveAllState();
        saveOpts.style.display = "block";
        if (!supportsDirPicker) {
          streamToggle.checked = false;
          streamToggle.disabled = true;
          chooseFolderBtn.disabled = true;
          folderLabel.textContent = "";
        }

        setTopStatus("Review queue", "warn");
        setXferStatus("Waiting for consent", "warn");
        startBtn.style.display = "inline-flex";
        startBtn.disabled = false;
        startBtn.textContent = "Start download";

        ping("meta_received", { bytes: totalBytes });
        return;
      }

      if (msg.type === "meta") {
        receiving = msg; // {index,name,size,mime}
        buffers = [];
        receivedForFile = 0;
        writable = null;
        writeChain = Promise.resolve();
        currentFileEl.textContent = `${msg.index}/${manifest.files.length} ${msg.name}`;
        setRowStatus(msg.index, "receiving");
        setRowProgress(msg.index, 0);

        if (streamEnabled && supportsDirPicker && dirHandle) {
          try {
            const fh = await dirHandle.getFileHandle(msg.name, { create: true });
            writable = await fh.createWritable();
          } catch {
            writable = null;
          }
        }
        return;
      }

      if (msg.type === "file_done") {
        await finalizeFile(msg.index);
        return;
      }

      if (msg.type === "done") {
        finalizeAll();
        return;
      }

      return;
    }

    // Binary
    if (!accepted || !receiving) return;

    const chunk = ev.data;
    if (writable) {
      writeChain = writeChain.then(() => writable.write(chunk));
    } else {
      buffers.push(chunk);
    }
    receivedForFile += chunk.byteLength;
    totalReceived += chunk.byteLength;

    if (receiving?.size) {
      setRowProgress(receiving.index, receivedForFile / receiving.size);
      setRowStatus(receiving.index, `${Math.floor((receivedForFile / receiving.size) * 100)}%`);
    }

    const now = performance.now();
    const dt = (now - lastT) / 1000;
    if (dt > 0.4) {
      const rate = (totalReceived - lastBytes) / dt;
      setProgress(barEl, totalBytes ? (totalReceived / totalBytes) : 0);
      progressTextEl.textContent = `${fmtBytes(totalReceived)} / ${fmtBytes(totalBytes)}`;
      rateTextEl.textContent = fmtRate(rate);
      lastBytes = totalReceived;
      lastT = now;
    }
  };

  dc.onclose = () => {
    safeText(dcStateEl, "closed");
    if (accepted) {
      setXferStatus("Channel closed", "bad");
      ping("failed", { reason: "datachannel_closed" });
    }
  };

  dc.onerror = () => {
    safeText(dcStateEl, "error");
    setXferStatus("Transfer error", "bad");
    ping("failed", { reason: "datachannel_error" });
  };
}

async function finalizeFile(index){
  if (!receiving || receiving.index !== index) {
    // still finalize with whatever buffers are present
  }
  const name = receiving?.name || `file_${index}`;
  const mime = receiving?.mime || "application/octet-stream";

  if (writable) {
    try { await writeChain; } catch {}
    try { await writable.close(); } catch {}
    setRowStatus(index, "saved");
  } else {
    const blob = new Blob(buffers, { type: mime });
    const url = URL.createObjectURL(blob);
    showSaveLink(index, url, name);
    setRowStatus(index, "ready");
  }

  setRowProgress(index, 1);
  updateSaveAllState();
  receiving = null;
  buffers = [];
  receivedForFile = 0;
  writable = null;

  if (manifest && index === manifest.files.length) {
    // last file
  }
}

function finalizeAll(){
  setProgress(barEl, 1);
  setXferStatus("Complete", "ok");
  rateTextEl.textContent = "done";
  progressTextEl.textContent = `${fmtBytes(totalBytes)} / ${fmtBytes(totalBytes)}`;
  currentFileEl.textContent = "—";
  startBtn.style.display = "none";
  ping("success", { bytes: totalBytes });
}

async function onSignal(msg) {
  if (msg.type === "offer") {
    setTopStatus("Negotiating", "warn");
    await pc.setRemoteDescription(msg.payload);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send(JSON.stringify({ token, role: "receiver", type: "answer", payload: answer }));
    return;
  }

  if (msg.type === "ice") {
    try { await pc.addIceCandidate(msg.payload); }
    catch (e) { console.log("[receiver] addIceCandidate error", e); }
  }

  if (msg.type === "expired") {
    setTopStatus("Link expired", "bad");
    setXferStatus("Expired", "bad");
  }
}

setTopStatus("Connecting", "warn");
setXferStatus("Idle", null);
