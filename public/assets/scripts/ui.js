export function $(id){ return document.getElementById(id); }

export function setStatus(el, label, kind){
  el.textContent = label;
  el.classList.remove("ok","warn","bad");
  if (kind) el.classList.add(kind);
}

export function setProgress(barEl, pct){
  const p = Math.max(0, Math.min(1, pct || 0));
  barEl.style.width = `${(p*100).toFixed(2)}%`;
}

export function fmtBytes(n){
  const u=["B","KB","MB","GB","TB"];
  let i=0,x=n;
  while(x>=1024&&i<u.length-1){x/=1024;i++}
  return `${x.toFixed(i===0?0:2)} ${u[i]}`;
}



export function fmtETA(seconds){
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,"0")}:${String(ss).padStart(2,"0")}`;
  return `${m}:${String(ss).padStart(2,"0")}`;
}

export function fmtRate(bytesPerSec){
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "—";
  let bitsPerSec = bytesPerSec * 8;
  const u=["b/s","Kb/s","Mb/s","Gb/s","Tb/s","Pb/s"];
  let i=0,x=bitsPerSec;
  while(x>=1000 && i<u.length-1){ x/=1000; i++; }
  const dec = x>=100 ? 0 : (x>=10 ? 1 : 2);
  return `${x.toFixed(dec)} ${u[i]}`;
}
