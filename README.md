# DirectDrop (WebRTC)

DirectDrop is a simple **browser-to-browser** file sender/receiver that uses **WebRTC data channels** for the bytes and a tiny **Node/Express** server for signaling and link (token) management.

The server **never receives file data**.

## Features

- **Peer-to-peer transfer** over WebRTC data channels (encrypted in transit by WebRTC)
- **Multi-file queue** with receiver review/consent before downloading
- **Share link + QR** using a short-lived token
- **Optional passphrase gate** (sender will not reveal the manifest until the receiver enters the correct passphrase)
- **Sequential downloads** (one file at a time) with **smoothed speed + ETA**
- **Public counters** rendered into the UI:
  - Successful Transfers
  - Files Transferred
  - Data Transferred

## Run locally

```bash
npm install
npm start
```

Then open:

- Sender UI: `http://localhost:3000/` (falls back to `sender.html`)
- Receiver UI (when you have a token): `http://localhost:3000/t/<token>`

### Configuration

- `PORT`  
  Port to listen on. Default: `3000`

- `PUBLIC_STATS_FILE`  
  Where to store public counters as JSON. Default: `./public-stats.json`

Example:

```bash
PORT=3000 PUBLIC_STATS_FILE="./public-stats.json" npm start
```

## Typical flow

### Sender

1. Add one or more files to the queue
2. (Optional) set a passphrase
3. Create a share link (and QR)
4. Wait for the receiver to connect and accept
5. Transfer runs **sequentially** across the queued files

### Receiver

1. Open the share link (`/t/<token>`)
2. If a passphrase is required, enter it to unlock the file list
3. Review the queue, then start the download
4. Use **Save all** (above the queued list) or save files individually

## How it works

### Signaling vs data

- The server hosts a WebSocket signaling endpoint (`/signal`) used only to exchange WebRTC offers/answers and ICE candidates.
- Once the peer connection is established, file bytes stream **directly** between browsers via a WebRTC data channel.

### Chunking + backpressure

- Files are sent in ~64KB slices.
- The sender throttles when the data channel buffer grows too large (simple backpressure loop) to keep the UI responsive.

### Transfer rate + ETA

Speed/ETA are intentionally smoothed to avoid “jumping”:
- a short rolling sample window rejects spikes (median)
- an exponential moving average stabilizes the displayed rate
- ETA is computed from the smoothed rate

### Optional passphrase

Passphrase is used as an **access gate**:
- Sender advertises whether a passphrase is required and provides a salt.
- Receiver submits a derived digest to prove knowledge of the passphrase.
- Sender only sends the file manifest after the receiver is authenticated.

This is separate from WebRTC transport encryption (which is always present for data channels).

### Public counters

Public totals are persisted in `PUBLIC_STATS_FILE` and injected into `sender.html` and `receiver.html` at request time.

They increment when a transfer completes successfully (clients post a `success` event to `/api/metrics/ping`).

## Token lifecycle

- Tokens have a TTL of **1 hour** while still in the initial `created` state (no completed transfer).
- Cleanup runs every **30 seconds**.
- After a token reaches an end state, it is retained for about **30 minutes** before being removed from memory.

## Notes / limitations

- Receiver builds downloadable blobs in memory (large files require RAM). Disk streaming mode has been removed from the receiver UI.
- If you’re testing passphrases, `https://` (or `http://localhost`) is recommended for full WebCrypto support; a small in-page SHA-256 fallback is used when WebCrypto isn’t available.
- STUN is configured by default. For restrictive networks, add TURN servers in `public/webrtc.js`.
