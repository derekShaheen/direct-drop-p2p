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

export function fmtRate(bps){
  return `${fmtBytes(bps)}/s`;
}
