# Universal Clipboard Sync (Windows + macOS) Plan

## 1) Goals and non-negotiables
- Internet-only sync (no LAN-only assumptions).
- Peer-to-peer clipboard data transfer (no server storage of clipboard data).
- WebRTC DataChannel for data path; WebSocket signaling only.
- Windows + macOS clients.
- Offline queueing and automatic catch-up on reconnect.
- Secure pairing and encryption end-to-end.
- Local storage uses SQLite only.

## 2) Architecture overview
- Desktop client (Windows/macOS): Electron app with native clipboard access.
- Signaling server: WebSocket (WSS) for pairing, presence, and WebRTC offer/answer/ICE exchange.
- P2P transport: WebRTC DataChannel (SCTP over DTLS over ICE/UDP).
- STUN-only for NAT traversal (no TURN). Note: this may fail on strict NATs/firewalls.

Data flow:
1) Device registers with signaling server and advertises presence.
2) Pairing flow uses QR code: device A displays a QR code, device B scans it, then the server pairs them.
3) Devices establish WebRTC connection via signaling server.
4) Clipboard events are sent directly via DataChannel.
5) If a peer is offline, events are queued locally and replayed when it reconnects.

## 3) Standards-aligned best practices to follow
- Use ICE with STUN + TURN for real-world NAT traversal reliability.
- Use STUN per RFC 8489 and TURN per RFC 8656; ICE per RFC 8445.
- Use WebRTC DataChannels per RFC 8831, with reliable delivery for clipboard data.
- Enforce message size limits and chunk large payloads; if message interleaving is unavailable, keep messages <= 16 KB per RFC 8831 guidance.
- WebSocket signaling per RFC 6455 over TLS (wss://), with origin checks and auth.
- WebRTC security model per RFC 8826: authentication, consent, and privacy considerations (including IP address exposure unless TURN is forced).
- Use PAKE for pairing with short codes (e.g., SPAKE2) to derive strong keys from low-entropy codes.
- SQLite best practices: WAL mode for concurrency, explicit transactions, foreign_keys=ON, periodic checkpoints.

## 4) Technology choices
- Electron (Windows + macOS) with a shared codebase.
- WebRTC: Node WebRTC implementation (e.g., wrtc) or a native WebRTC wrapper.
- Signaling: Node.js WebSocket server (ws) with TLS termination.
- Storage: SQLite (better concurrency with WAL).

## 5) Security model
- Pairing is required before any clipboard data exchange.
- Short-lived pairing code is used to establish a shared secret via PAKE.
- After pairing, devices pin each other’s public keys and store a device trust record.
- All clipboard data travels only via DataChannel (DTLS-encrypted).
- Signaling server never stores clipboard payloads.
- User can revoke/unpair a device locally; revocation removes its keys.
Best-practice additions:
- Pairing tokens are single-use, time-limited (e.g., 2–5 minutes), and rate-limited per device to reduce abuse.
- Signaling requests require device auth tokens; enforce origin checks and basic abuse protection.
- Optional local-at-rest encryption for clipboard history using OS keychain/credential store.

## 6) Data model (SQLite)
Tables:
- devices
  - device_id (PK)
  - name
  - public_key
  - paired_at
  - last_seen
  - status (online/offline)

- clipboard_items
  - item_id (PK, UUID)
  - device_id (FK -> devices.device_id)
  - ts (client timestamp)
  - hlc (hybrid logical clock string or numeric)
  - type (text/rtf/other)
  - payload (blob/text)
  - size_bytes

- pending_queue
  - queue_id (PK)
  - item_id (FK -> clipboard_items.item_id)
  - target_device_id
  - status (pending/sent/acked)
  - retries

Pragmas on each connection:
- PRAGMA journal_mode=WAL;
- PRAGMA foreign_keys=ON;
- PRAGMA synchronous=NORMAL; (tradeoff: performance vs durability)
- Periodic WAL checkpoint.

## 7) Clipboard sync logic
- Clipboard watcher detects changes and creates a ClipboardItem.
- Ignore changes applied by the app itself (loop-prevention using last_applied_id).
- Serialize items (text/rtf initially; extendable to files later).
- Use reliable ordered DataChannel for clipboard items.
- Enforce payload size limits; chunk large items and reassemble, or skip with user-visible warning.
- For each peer:
  - If connected: send immediately.
  - If offline: enqueue item in pending_queue.
- On reconnect:
  - Send any queued items since last ACKed item.
- Conflict resolution:
  - Use HLC or LWW (timestamp + device_id) to ensure deterministic resolution.
  - Store all received items in history; apply latest to system clipboard.
 - Use ACKs per item to mark delivery and to retry with exponential backoff.

## 8) Pairing flow (secure, cross-network, QR-based)
1) Device A requests a short-lived pairing token from the signaling server.
2) Device A displays a QR code embedding the token + A’s device_id.
3) Device B scans the QR code and sends the token to the signaling server over WebSocket.
4) The server validates the token and notifies both devices to exchange identity keys.
5) Both run PAKE (e.g., SPAKE2) to derive a shared key from the pairing token.
6) Exchange and pin each other’s public keys over the PAKE-protected channel.
7) Store paired device records locally and mark them paired.
8) Establish WebRTC P2P session.
Best-practice additions:
- QR payload includes a version field to allow future changes (v1).
- Pairing tokens are invalidated on success or timeout.
- If pairing fails, server returns a clear error and devices do not store partial state.

## 9) WebRTC session setup
- Exchange SDP offer/answer and ICE candidates via signaling.
- Use STUN for server-reflexive candidates.
- No TURN relay (STUN-only); accept that some networks will block direct P2P.
- Open a single DataChannel for clipboard sync (label: "clipboard-sync").
- Validate remote device_id and pinned key before accepting messages.
Best-practice additions:
- Keep a reconnect loop for ICE failures with backoff.
- Prefer TURN for reliability in demo environments if NATs are strict.

## 10) Signaling server responsibilities
- WebSocket auth (token-based per device).
- Presence: online/offline status (drives device list UI) with heartbeat/keepalive.
- Pairing token generation and verification (QR-based flow).
- Offer/answer/ICE relay.
- Never store clipboard data.
Best-practice additions:
- Presence timeout (e.g., offline after 30–60s without heartbeat).
- Minimal, ephemeral state only; no clipboard content stored.

## 11) Client UI requirements
- Device list with status (online/offline/reachable) and device name.
- Add device (QR code scan + confirmation).
- History view with copy-back actions.
- Toggle sync, choose data types.
- Unpair device.
Note: Settings page is scoped after core functionality (pairing + sync + history) is stable.
Best-practice additions:
- Show last_seen timestamp for paired devices.
- Allow editing local device name and per-device sync enable/disable.
 - Settings: device name, sync toggle, history size, data types (text/rtf).

## 12) Testing plan
- Unit: serialization, DB writes, queue logic, HLC ordering.
- Integration: WebRTC connection across NATs (STUN/TURN), reconnection, offline queue replay.
- Manual demo script: pair devices, sync across networks, go offline/online, show history.

## 13) Delivery milestones
- M1: Signaling server + device registration + pairing skeleton.
- M2: WebRTC P2P established and data channel operational.
- M3: Clipboard watcher + send/receive + history + loop prevention.
- M4: Offline queue + reconnect sync + UI polish.

## 14) Risks and mitigations
- NAT traversal failures -> STUN-only may fail on strict NATs/firewalls; document this limitation for judges.
- Clock skew -> use HLC to avoid timestamp conflicts.
- Clipboard access restrictions -> rely on Electron clipboard API; validate on both OSes.
- Large payloads -> chunking and size limits.
 - Presence flapping -> heartbeat + debounce and conservative offline timeout.

## 15) Implementation order
1) Set up Electron app skeleton (main, preload, renderer).
2) Implement signaling server (WSS, auth, pairing endpoints).
3) Implement WebRTC session manager (offer/answer/ICE, DataChannel).
4) Implement clipboard watcher + loop prevention.
5) Implement SQLite schema + persistence + queue.
6) Implement history UI + device management UI (device list w/ online/offline + names).
7) Add reliability: reconnect logic, queue replay, retries, diagnostics.
8) Implement settings page and preferences.
