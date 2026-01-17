import { WebSocketServer } from "ws";
import { randomUUID } from "crypto";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;

// In-memory state (hackathon friendly). Persist if needed later.
const devices = new Map(); // deviceId -> { ws, name, publicKey, lastSeen }
const pairs = new Map(); // deviceId -> Set<pairedDeviceId>
const pairingTokens = new Map(); // token -> { deviceId, expiresAt }

function nowMs() {
  return Date.now();
}

function send(ws, message) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function broadcastToPaired(deviceId, message) {
  const paired = pairs.get(deviceId);
  if (!paired) return;
  for (const peerId of paired) {
    const peer = devices.get(peerId);
    if (peer) send(peer.ws, message);
  }
}

function setPresence(deviceId, status) {
  broadcastToPaired(deviceId, { type: "presence", deviceId, status, ts: nowMs() });
}

function addPair(a, b) {
  if (!pairs.has(a)) pairs.set(a, new Set());
  if (!pairs.has(b)) pairs.set(b, new Set());
  pairs.get(a).add(b);
  pairs.get(b).add(a);
}

function removePair(a, b) {
  pairs.get(a)?.delete(b);
  pairs.get(b)?.delete(a);
}

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws) => {
  console.log("connection");
  let currentDeviceId = null;

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      send(ws, { type: "error", error: "invalid_json" });
      return;
    }

    console.log("recv", msg.type, msg.deviceId || currentDeviceId || "unknown");

    switch (msg.type) {
      case "register": {
        const { deviceId, name, publicKey } = msg;
        if (!deviceId || !name || !publicKey) {
          send(ws, { type: "error", error: "missing_fields" });
          return;
        }
        currentDeviceId = deviceId;
        devices.set(deviceId, { ws, name, publicKey, lastSeen: nowMs() });
        console.log("registered", deviceId);
        send(ws, { type: "registered", deviceId });
        setPresence(deviceId, "online");
        // Notify paired devices about name/key updates
        broadcastToPaired(deviceId, {
          type: "device_info",
          deviceId,
          name,
          publicKey
        });
        break;
      }
      case "heartbeat": {
        if (!currentDeviceId) return;
        const entry = devices.get(currentDeviceId);
        if (entry) entry.lastSeen = nowMs();
        break;
      }
      case "request_pair_token": {
        if (!currentDeviceId) return;
        const token = randomUUID();
        const expiresAt = nowMs() + 2 * 60 * 1000; // 2 minutes
        pairingTokens.set(token, { deviceId: currentDeviceId, expiresAt });
        console.log("send pair_token", currentDeviceId);
        send(ws, { type: "pair_token", token, expiresAt });
        break;
      }
      case "pair_with_token": {
        const { token } = msg;
        if (!currentDeviceId || !token) return;
        const record = pairingTokens.get(token);
        if (!record || record.expiresAt < nowMs()) {
          send(ws, { type: "pair_failed", error: "token_invalid_or_expired" });
          return;
        }
        const deviceA = record.deviceId;
        const deviceB = currentDeviceId;
        if (deviceA === deviceB) {
          send(ws, { type: "pair_failed", error: "cannot_pair_self" });
          return;
        }
        pairingTokens.delete(token);

        addPair(deviceA, deviceB);
        const a = devices.get(deviceA);
        const b = devices.get(deviceB);

        if (a) {
          send(a.ws, {
            type: "pair_success",
            peer: { deviceId: deviceB, name: b?.name, publicKey: b?.publicKey }
          });
        }
        if (b) {
          send(b.ws, {
            type: "pair_success",
            peer: { deviceId: deviceA, name: a?.name, publicKey: a?.publicKey }
          });
        }
        break;
      }
      case "signal": {
        // Relay WebRTC signaling messages
        const { to, payload } = msg;
        if (!currentDeviceId || !to || !payload) return;
        const target = devices.get(to);
        if (!target) {
          send(ws, { type: "signal_failed", error: "peer_offline", to });
          return;
        }
        send(target.ws, { type: "signal", from: currentDeviceId, payload });
        break;
      }
      case "unpair": {
        const { peerId } = msg;
        if (!currentDeviceId || !peerId) return;
        removePair(currentDeviceId, peerId);
        send(ws, { type: "unpaired", peerId });
        const peer = devices.get(peerId);
        if (peer) send(peer.ws, { type: "unpaired", peerId: currentDeviceId });
        break;
      }
      case "request_presence": {
        if (!currentDeviceId) return;
        const paired = pairs.get(currentDeviceId) || new Set();
        const list = Array.from(paired).map((peerId) => {
          const peer = devices.get(peerId);
          return {
            deviceId: peerId,
            online: Boolean(peer),
            name: peer?.name || "Unknown",
            lastSeen: peer?.lastSeen || null,
            publicKey: peer?.publicKey || null
          };
        });
        send(ws, { type: "presence_list", devices: list });
        break;
      }
      default:
        send(ws, { type: "error", error: "unknown_message_type" });
    }
  });

  ws.on("close", () => {
    if (!currentDeviceId) return;
    devices.delete(currentDeviceId);
    setPresence(currentDeviceId, "offline");
  });
});

setInterval(() => {
  const now = nowMs();
  for (const [deviceId, entry] of devices.entries()) {
    if (now - entry.lastSeen > 60_000) {
      try {
        entry.ws.terminate();
      } catch {
        // ignore
      }
      devices.delete(deviceId);
      setPresence(deviceId, "offline");
    }
  }
}, 15_000);

console.log(`Signaling server listening on ws://localhost:${PORT}`);
