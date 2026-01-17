# Universal Clipboard Sync (Hackathon MVP)

## Structure
- `apps/server`: WebSocket signaling server (pairing, presence, signaling relay)
- `apps/client`: Electron desktop client (Windows/macOS)

## Requirements
- Node.js 18+
- npm
- Camera access (for QR scan)

## Install

Server:
```bash
cd /Users/riyaaggarwal/Desktop/hackathon_clipboard/apps/server
npm install
npm start
```

Client:
```bash
cd /Users/riyaaggarwal/Desktop/hackathon_clipboard/apps/client
npm install
npm start
```

## Internet testing with ngrok (no VPS)
1) Create a free ngrok account and get your authtoken.
2) On the Mac (server host), run:
```bash
ngrok config add-authtoken YOUR_TOKEN
ngrok http 8787
```
3) ngrok will print a public `https://...` URL. Use it as the signaling URL:
```
wss://YOUR_NGROK_URL
```
4) Set that URL in **Settings → Signaling URL** on both devices.

## How it works
- The server handles device registration, QR pairing tokens, presence, and WebRTC signaling.
- Clipboard data is sent P2P over WebRTC DataChannels (DTLS encrypted).
- STUN-only is used for NAT traversal (no TURN). Some networks may block direct P2P.
- Pairing uses a short-lived QR token and encrypts public-key exchange with a token-derived key.
- Devices can be unpaired from the device list UI.

## Next steps
Optional hardening:
- Replace token-derived key exchange with a true PAKE (SPAKE2) implementation.
- Add explicit retry backoff limits and delivery metrics.
