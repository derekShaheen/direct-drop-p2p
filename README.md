# DirectDrop (WebRTC)
## Why DirectDrop
Typical paid file transfer platforms often upload your file to their servers first, then provide a link for the recipient to download later.

DirectDrop is different:
- **Peer-to-peer transfer:** your file bytes travel directly between browsers.
- **No file storage:** the server only does connection signaling and basic metrics.
- **Receiver consent:** the recipient reviews the queue before starting.
- **Short-lived links:** tokens expire automatically if not closed.

WebRTC data channels are encrypted in transit.

## Run
```bash
npm install
npm run start
```

Sender:
- http://localhost:3000/sender.html

For LAN/mobile testing:
- http://192.168.x.x:3000/sender.html

Receiver:
- http://<host>:3000/t/<token>

## Multi-file queue
The sender can queue multiple files, reorder them, and remove items. The share link is created only when the sender clicks **Create share link**. After that, the queue is locked.

The receiver sees the queue first and must click **Start download**. Files transfer sequentially and a **Save** link appears for each file as it completes.

## Stats (in-memory, token-hidden)
Admin endpoints never reveal transfer tokens.

- HTML dashboard: `/stats`
- JSON: `/api/stats`

They are protected with HTTP Basic Auth and are disabled unless credentials are set.

### Configure stats credentials
Windows PowerShell:
```powershell
$env:STATS_USER="admin"
$env:STATS_PASS="change-me"
$env:STATS_SALT="some-random-long-string"
npm run start
```

macOS/Linux:
```bash
export STATS_USER="admin"
export STATS_PASS="change-me"
export STATS_SALT="some-random-long-string"
npm run start
```

## Token cleanup / expiration
- Tokens expire after **48 hours** if not closed.
- If the uploader disconnects before the receiver connects, the transfer is marked failed and cleaned up shortly.
- Closed/failed transfers are retained briefly for metrics, then removed from memory.

## Notes
- The server does signaling and tracks statuses; it does not receive file bytes.
- STUN is configured by default. Add TURN in `public/webrtc.js` for restrictive networks.
- Metrics reset on server restart.
