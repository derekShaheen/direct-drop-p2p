export function makePc() {
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      // Add TURN here for higher success rate on restrictive networks:
      // { urls: "turn:turn.yourdomain.com:3478", username: "user", credential: "pass" },
    ],
  });
  return pc;
}

export function fmtBytes(n) {
  const u = ["B","KB","MB","GB","TB"];
  let i = 0, x = n;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(i === 0 ? 0 : 2)} ${u[i]}`;
}

export function fmtRate(bps) {
  return `${fmtBytes(bps)}/s`;
}
