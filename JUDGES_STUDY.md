# Universal Clipboard Sync – Judge Q&A Study Guide

This file lists likely judge questions and short, accurate answers explaining *why* we chose each tech and design decision.

## Architecture choices

Q: Why WebRTC for clipboard sync?
A: The problem requires direct device‑to‑device transfer over the internet with no server‑stored clipboard data. WebRTC DataChannels give encrypted P2P transport (DTLS) and handle NAT traversal, so we meet the requirement without building custom networking.

Q: Why not send clipboard data via the WebSocket server?
A: That would violate the requirement: clipboard data must not be stored or routed through central servers. The WebSocket server is only for signaling, presence, and pairing.

Q: Why WebSockets for signaling?
A: WebSockets are lightweight, real‑time, and simple for exchanging WebRTC offers/answers/ICE between devices. The server only relays signaling messages.

Q: Why Electron for the client?
A: We need a cross‑platform desktop app that can access the OS clipboard on Windows/macOS/Linux. Electron gives that with one codebase and quick iteration for a hackathon.

Q: Why SQLite (sql.js) for history?
A: History and offline queue must persist locally and never touch a server. SQLite is embedded, reliable, and cross‑platform. It supports structured queries for history search and device metadata.

Q: Why not Firebase / Postgres / cloud DB?
A: Central storage of clipboard data is explicitly disallowed. Local‑only storage is required for privacy and offline support.

Q: Why a 6‑digit pairing code instead of QR?
A: It’s simpler for a demo, quick to read/copy across devices, and works across OSes without camera access or extra permissions. It still provides a secure pairing flow when combined with encryption.

Q: How do you handle devices on different networks?
A: WebRTC handles NAT traversal via STUN by default. If strict NATs block direct P2P, TURN can be enabled via env vars, but we keep TURN off by default to align with “direct P2P” requirements.

Q: Why not LAN/Bluetooth clipboard sharing?
A: The problem explicitly says LAN or Bluetooth‑only solutions don’t qualify. The system must work across the public internet.

## Security and privacy

Q: Is clipboard data encrypted in transit?
A: Yes. WebRTC DataChannels are encrypted by DTLS end‑to‑end. The signaling server never sees clipboard data.

Q: How do you ensure only paired devices connect?
A: Devices must be paired via a short‑lived pairing token. Once paired, the device IDs are stored locally and only paired devices exchange signaling and data.

Q: What does the pairing encryption do?
A: During pairing, we encrypt a device’s public key using AES‑GCM with a key derived from the pairing token (HKDF). This prevents token reuse or tampering and binds the pairing step to the correct device.

Q: Do you store clipboard data on any server?
A: No. Clipboard items are stored only in local SQLite on each device. The signaling server stores only transient presence/pairing state in memory.

## Reliability and offline behavior

Q: How do you handle offline devices?
A: Every clipboard item is stored in a local `pending_queue` for each paired device. When a peer reconnects, the sender flushes pending items and waits for ACKs.

Q: How do you know a device received the item?
A: The receiver sends an ACK per item; once ACKed, the sender marks it delivered in `pending_queue`.

Q: How do you prevent echo loops?
A: We track a clipboard signature (`type:payload`) and ignore duplicates. We also set `lastAppliedId` to avoid re‑broadcasting items we just applied.

Q: How do you handle conflicts (two devices copy at the same time)?
A: We use “last write wins” based on timestamp, and both items still appear in history. The latest clipboard item becomes active on each device.

## Data handling

Q: What clipboard types are supported?
A: Text, images, and file paths. Images are read via native clipboard APIs, encoded as data URLs, and sent via DataChannel (chunked when large). File paths are sent as path strings.

Q: Why chunking for large payloads?
A: DataChannels have message size limits. We split large base64 payloads into 12KB chunks, reassemble on the receiver, then apply to clipboard.

Q: Why max file size is fixed to 10MB?
A: It avoids memory blow‑ups and keeps sync responsive. The limit prevents huge data blobs from stalling the channel. It’s enforced both in settings and at runtime.

## Presence and device management

Q: How do you show online/offline status?
A: The signaling server tracks active WebSocket connections and broadcasts presence to paired devices. The UI renders each device’s last seen state.

Q: How does unpairing work?
A: The client sends an `unpair` message to the server, which removes the relationship for both devices. Locally, the device is removed from SQLite.

## Implementation notes judges might ask about

Q: Where is history stored?
A: In `clipboard.db` under the Electron user data directory, table `clipboard_items` with fields `item_id, device_id, device_name, ts, type, payload, size_bytes`.

Q: What if the device name changes?
A: The device name is stored in settings and updated in the `devices` table; new history items are written with the latest name, so history shows who copied the item.

Q: Why not use a central server for clipboard history?
A: The requirement explicitly forbids storing clipboard data on servers. Local history preserves privacy and meets the spec.

## Quick tech list summary

Client:
- Electron (cross‑platform desktop)
- WebRTC DataChannel (P2P encrypted clipboard sync)
- sql.js (SQLite local storage)

Server:
- ws (WebSocket signaling server)

Built‑ins:
- Node crypto (pairing key derivation + encryption)
- Electron clipboard/nativeImage (OS clipboard access)

