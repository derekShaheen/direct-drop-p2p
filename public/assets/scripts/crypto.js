function b64FromBytes(bytes){
  let bin = "";
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin);
}
function bytesFromB64(b64){
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function hasCrypto(){
  return typeof window !== "undefined" && !!(window.crypto && crypto.subtle);
}
export function hasFSAccess(){
  return typeof window !== "undefined" && typeof window.showSaveFilePicker === "function";
}

export function randomSaltB64(){
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return b64FromBytes(salt);
}

export async function deriveKey(passphrase, saltB64, iterations=200_000){
  const salt = bytesFromB64(saltB64);
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt","decrypt"]
  );
}

export function randomNonce(){
  const n = new Uint8Array(12);
  crypto.getRandomValues(n);
  return n;
}

export async function encryptChunk(key, plainU8){
  const nonce = randomNonce();
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plainU8);
  const ctU8 = new Uint8Array(ct);
  const out = new Uint8Array(12 + ctU8.byteLength);
  out.set(nonce, 0);
  out.set(ctU8, 12);
  return out.buffer;
}

export async function decryptChunk(key, buf){
  const u8 = new Uint8Array(buf);
  const nonce = u8.slice(0,12);
  const ct = u8.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ct);
  return new Uint8Array(pt);
}

export function bytesFromB64Public(b64){ return bytesFromB64(b64); }
export function b64FromBytesPublic(u8){ return b64FromBytes(u8); }
