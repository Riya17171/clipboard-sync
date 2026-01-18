const SIGNALING_URL = "wss://untransmissive-carmelia-tomial.ngrok-free.dev";
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" }
];

if (typeof process !== "undefined" && process.env) {
  const turnUrl = process.env.TURN_URL;
  const turnUser = process.env.TURN_USER;
  const turnPass = process.env.TURN_PASS;
  if (turnUrl && turnUser && turnPass) {
    ICE_SERVERS.push({
      urls: turnUrl,
      username: turnUser,
      credential: turnPass
    });
  }
}

let ws = null;
let identity = null;
const peers = new Map(); // peerId -> { pc, dc }
const incomingChunks = new Map(); // item_id -> { total, received, chunks, meta }

if (!window.clipboardApp && typeof require === "function") {
  const { ipcRenderer } = require("electron");
  const crypto = require("crypto");
  window.clipboardApp = {
    getIdentity: () => ipcRenderer.invoke("get-identity"),
    listHistory: () => ipcRenderer.invoke("list-history"),
    listDevices: () => ipcRenderer.invoke("list-devices"),
    getPendingItems: (peerId) => ipcRenderer.invoke("get-pending-items", peerId),
    markAcked: (peerId, itemId) => ipcRenderer.invoke("mark-acked", peerId, itemId),
    setDeviceName: (name) => ipcRenderer.invoke("set-device-name", name),
    getSettings: () => ipcRenderer.invoke("get-settings"),
    setSetting: (key, value) => ipcRenderer.invoke("set-setting", key, value),
    removeDevice: (deviceId) => ipcRenderer.invoke("remove-device", deviceId),
    onLocalClipboard: (cb) => ipcRenderer.on("clipboard-local-change", (_, item) => cb(item)),
    onPresenceUpdate: (cb) => ipcRenderer.on("presence-update", (_, payload) => cb(payload)),
    onPairSuccess: (cb) => ipcRenderer.on("pair-success", (_, peer) => cb(peer)),
    onDeviceInfo: (cb) => ipcRenderer.on("device-info", (_, peer) => cb(peer)),
    applyRemoteClipboard: (item) => ipcRenderer.send("apply-remote-clipboard", item),
    notifyPairSuccess: (peer) => ipcRenderer.send("pair-success", peer),
    notifyPresence: (payload) => ipcRenderer.send("presence-update", payload),
    notifyDeviceInfo: (peer) => ipcRenderer.send("device-info", peer),
    log: (msg) => ipcRenderer.send("renderer-log", msg),
    pairing: {
      encrypt: (token, plaintext) => {
        const key = crypto.hkdfSync("sha256", Buffer.from(token), Buffer.alloc(0), Buffer.from("pairing"), 32);
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
        const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
        const tag = cipher.getAuthTag();
        return {
          iv: iv.toString("base64"),
          data: ciphertext.toString("base64"),
          tag: tag.toString("base64")
        };
      },
      decrypt: (token, payload) => {
        const key = crypto.hkdfSync("sha256", Buffer.from(token), Buffer.alloc(0), Buffer.from("pairing"), 32);
        const iv = Buffer.from(payload.iv, "base64");
        const data = Buffer.from(payload.data, "base64");
        const tag = Buffer.from(payload.tag, "base64");
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
        return plaintext;
      }
    }
  };
}

const statusEl = document.getElementById("status");
const devicesEl = document.getElementById("devices");
const devicesManageEl = document.getElementById("devices-manage");
const historyEl = document.getElementById("history");
const tokenDisplayEl = document.getElementById("token-display");
const tokenInputEl = document.getElementById("pair-token");
const deviceNameEl = document.getElementById("device-name");
const syncEnabledEl = document.getElementById("sync-enabled");
const syncTextEl = document.getElementById("sync-text");
const historyLimitEl = document.getElementById("history-limit");
const pairStatusEl = document.getElementById("pair-status");
const maxItemSizeEl = document.getElementById("max-item-size");
const onlineCountEl = document.getElementById("online-count");
const offlineCountEl = document.getElementById("offline-count");
const clockEl = document.getElementById("clock");
const navButtons = document.querySelectorAll(".nav-item");
const historySearchEl = document.getElementById("history-search");

let currentPairToken = null;
let pendingPairTokenRequest = false;
let pairTokenTimeout = null;
let historyQuery = "";

function setPairStatus(text) {
  if (pairStatusEl) pairStatusEl.textContent = text || "";
}

function updateClock() {
  if (!clockEl) return;
  const now = new Date();
  clockEl.textContent = now.toLocaleTimeString();
}

function showPage(page) {
  document.querySelectorAll(".page").forEach((section) => {
    section.classList.toggle("active", section.id === `page-${page}`);
  });
  navButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.page === page);
  });
}

async function init() {
  identity = await window.clipboardApp.getIdentity();
  window.clipboardApp.log(`init identity ${identity?.deviceId || "null"}`);
  const settings = await window.clipboardApp.getSettings();
  deviceNameEl.value = identity.deviceName;
  syncEnabledEl.checked = settings.syncEnabled;
  syncTextEl.checked = settings.syncTextEnabled;
  historyLimitEl.value = settings.historyLimit;
  maxItemSizeEl.value = settings.maxItemSizeKb || 1024;
  statusEl.textContent = "Connecting…";
  window.clipboardApp.log("using signaling url");
  connectSignaling();
  renderDevices();
  renderHistory();

  updateClock();
  setInterval(updateClock, 1000);

  navButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const page = btn.dataset.page;
      showPage(page);
    });
  });

  window.clipboardApp.onLocalClipboard((item) => {
    broadcastClipboard(item);
    renderHistory();
  });

  window.clipboardApp.onDeviceInfo((peer) => {
    renderDevices();
  });

  setInterval(() => {
    for (const peerId of peers.keys()) {
      flushPending(peerId);
    }
  }, 10_000);

  if (historySearchEl) {
    historySearchEl.addEventListener("input", () => {
      historyQuery = historySearchEl.value.trim().toLowerCase();
      renderHistory();
    });
  }
}

function connectSignaling() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  statusEl.textContent = `Connecting…`;
  ws = new WebSocket(SIGNALING_URL);

  ws.addEventListener("open", () => {
    statusEl.textContent = "Connected";
    window.clipboardApp.log("ws open");
    safeSend({
      type: "register",
      deviceId: identity.deviceId,
      name: identity.deviceName,
      publicKey: identity.publicKey
    });
    window.clipboardApp.log("register sent");
    safeSend({ type: "request_presence" });
    startHeartbeat();
    if (pendingPairTokenRequest) {
      pendingPairTokenRequest = false;
      safeSend({ type: "request_pair_token" });
      setPairStatus("Requesting pairing token…");
    }
  });

  ws.addEventListener("message", async (event) => {
    const msg = JSON.parse(event.data);
    window.clipboardApp.log(`ws message ${msg.type}`);

    switch (msg.type) {
      case "pair_token":
        tokenDisplayEl.textContent = msg.token;
        currentPairToken = msg.token;
        setPairStatus("Pair code received.");
        if (pairTokenTimeout) clearTimeout(pairTokenTimeout);
        break;
      case "pair_success":
        if (currentPairToken) {
          window.clipboardApp.notifyPairSuccess({
            deviceId: msg.peer.deviceId,
            name: msg.peer.name,
            publicKey: ""
          });
        } else {
          window.clipboardApp.notifyPairSuccess(msg.peer);
        }
        await renderDevices();
        if (currentPairToken) {
          sendPairKey(msg.peer.deviceId, currentPairToken);
        }
        await ensurePeerConnection(msg.peer.deviceId);
        break;
      case "pair_failed":
        if (msg.error === "already_paired") {
          statusEl.textContent = "Already paired";
          setPairStatus("Already paired with this device.");
        } else if (msg.error === "cannot_pair_self") {
          statusEl.textContent = "Cannot pair to self";
          setPairStatus("This device cannot pair with itself.");
        } else {
          statusEl.textContent = "Pair failed";
          setPairStatus(msg.error ? `Pair failed: ${msg.error}` : "Pair failed.");
        }
        break;
      case "presence":
        window.clipboardApp.notifyPresence(msg);
        await renderDevices();
        if (msg.status === "online") {
          await ensurePeerConnection(msg.deviceId);
        }
        break;
      case "presence_list":
        for (const d of msg.devices || []) {
          window.clipboardApp.notifyDeviceInfo({
            deviceId: d.deviceId,
            name: d.name,
            publicKey: ""
          });
          window.clipboardApp.notifyPresence({
            deviceId: d.deviceId,
            status: d.online ? "online" : "offline",
            ts: d.lastSeen || Date.now()
          });
          if (d.online) {
            await ensurePeerConnection(d.deviceId);
          }
        }
        await renderDevices();
        break;
      case "device_info":
        window.clipboardApp.notifyDeviceInfo?.({
          deviceId: msg.deviceId,
          name: msg.name,
          publicKey: ""
        });
        await renderDevices();
        break;
      case "signal":
        await handleSignal(msg.from, msg.payload);
        break;
      case "signal_failed":
        statusEl.textContent = `Signal failed: ${msg.error || "unknown"}`;
        break;
      case "unpaired":
        await window.clipboardApp.removeDevice(msg.peerId);
        peers.delete(msg.peerId);
        await renderDevices();
        break;
      default:
        break;
    }
  });

  ws.addEventListener("close", () => {
    statusEl.textContent = "Disconnected";
  });

  ws.addEventListener("error", () => {
    statusEl.textContent = "Connect error";
  });
}

function safeSend(obj) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  } catch {
    statusEl.textContent = "Send failed";
  }
}

function requestPairToken() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    safeSend({ type: "request_pair_token" });
    setPairStatus("Requesting pairing token…");
    if (pairTokenTimeout) clearTimeout(pairTokenTimeout);
    pairTokenTimeout = setTimeout(() => {
      setPairStatus("No token received. Check Signaling URL.");
    }, 4000);
    return;
  }
  pendingPairTokenRequest = true;
  statusEl.textContent = "Connecting…";
  connectSignaling();
}

function startHeartbeat() {
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "heartbeat" }));
    }
  }, 20_000);
}

async function ensurePeerConnection(peerId) {
  if (peers.has(peerId)) {
    const existing = peers.get(peerId);
    if (existing?.pc && ["failed", "disconnected", "closed"].includes(existing.pc.connectionState)) {
      try { existing.pc.close(); } catch {}
      peers.delete(peerId);
    } else {
      return;
    }
  }
  const isInitiator = identity.deviceId < peerId;
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(JSON.stringify({
        type: "signal",
        to: peerId,
        payload: { type: "ice", candidate: event.candidate }
      }));
    }
  };

  pc.ondatachannel = (event) => {
    const dc = event.channel;
    setupDataChannel(peerId, dc);
  };

  pc.onconnectionstatechange = () => {
    if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
      try { pc.close(); } catch {}
      peers.delete(peerId);
    }
  };

  let dc = null;
  if (isInitiator) {
    dc = pc.createDataChannel("clipboard-sync", { ordered: true });
    setupDataChannel(peerId, dc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: "signal", to: peerId, payload: { type: "offer", sdp: offer } }));
  }

  peers.set(peerId, { pc, dc });
}

function sendPairKey(peerId, token) {
  const encrypted = window.clipboardApp.pairing.encrypt(token, identity.publicKey);
  ws.send(JSON.stringify({
    type: "signal",
    to: peerId,
    payload: { type: "pair_key", data: encrypted }
  }));
}

function setupDataChannel(peerId, dc) {
  dc.onopen = () => {
    flushPending(peerId);
    try {
      dc.send(JSON.stringify({ kind: "sync_request" }));
    } catch {}
  };
  dc.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.kind === "clipboard") {
        window.clipboardApp.applyRemoteClipboard(msg.item);
        renderHistory();
        dc.send(JSON.stringify({ kind: "ack", item_id: msg.item.item_id }));
      } else if (msg.kind === "sync_request") {
        flushPending(peerId);
      } else if (msg.kind === "chunk") {
        handleChunkMessage(peerId, dc, msg);
      } else if (msg.kind === "ack") {
        window.clipboardApp.markAcked(peerId, msg.item_id);
      }
    } catch {
      // ignore invalid
    }
  };

  const peer = peers.get(peerId);
  if (peer) peer.dc = dc;
}

async function handleSignal(peerId, payload) {
  if (!peers.has(peerId)) {
    await ensurePeerConnection(peerId);
  }
  const { pc } = peers.get(peerId);

  if (payload.type === "pair_key") {
    if (!currentPairToken) return;
    try {
      const pub = window.clipboardApp.pairing.decrypt(currentPairToken, payload.data);
      window.clipboardApp.notifyDeviceInfo({
        deviceId: peerId,
        name: "Unknown",
        publicKey: pub
      });
      currentPairToken = null;
    } catch {
      // ignore invalid pairing payload
    }
    return;
  }
  if (payload.type === "offer") {
    if (pc.signalingState !== "stable") {
      return;
    }
    await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send(JSON.stringify({ type: "signal", to: peerId, payload: { type: "answer", sdp: answer } }));
  } else if (payload.type === "answer") {
    if (pc.signalingState !== "have-local-offer") return;
    await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
  } else if (payload.type === "ice") {
    try {
      if (!pc.remoteDescription) return;
      await pc.addIceCandidate(payload.candidate);
    } catch {
      // ignore
    }
  }
}

function broadcastClipboard(item) {
  for (const { dc } of peers.values()) {
    if (dc && dc.readyState === "open") {
      sendClipboardItem(dc, item);
    }
  }
}

async function flushPending(peerId) {
  const pending = await window.clipboardApp.getPendingItems(peerId);
  const peer = peers.get(peerId);
  if (!peer || !peer.dc || peer.dc.readyState !== "open") return;
  for (const item of pending) {
    sendClipboardItem(peer.dc, item);
  }
}

function sendClipboardItem(dc, item) {
  const payload = item.payload || "";
  const payloadB64 = Buffer.from(payload, "utf8").toString("base64");
  const maxChunk = 12 * 1024; // 12KB
  if (payloadB64.length <= maxChunk) {
    dc.send(JSON.stringify({ kind: "clipboard", item }));
    return;
  }
  const total = Math.ceil(payloadB64.length / maxChunk);
  for (let i = 0; i < total; i++) {
    const chunk = payloadB64.slice(i * maxChunk, (i + 1) * maxChunk);
    dc.send(JSON.stringify({
      kind: "chunk",
      item_id: item.item_id,
      index: i,
      total,
      data: chunk,
      meta: {
        device_id: item.device_id,
        ts: item.ts,
        type: item.type,
        size_bytes: item.size_bytes || payload.length
      }
    }));
  }
}

function handleChunkMessage(peerId, dc, msg) {
  if (!msg.item_id || typeof msg.index !== "number" || typeof msg.total !== "number") return;
  const key = msg.item_id;
  let entry = incomingChunks.get(key);
  if (!entry) {
    entry = {
      total: msg.total,
      received: 0,
      chunks: new Array(msg.total),
      meta: msg.meta || {}
    };
    incomingChunks.set(key, entry);
  }
  if (msg.index < 0 || msg.index >= entry.total) return;
  if (!entry.chunks[msg.index]) {
    entry.chunks[msg.index] = msg.data || "";
    entry.received += 1;
  }
  if (entry.received === entry.total) {
    const joined = entry.chunks.join("");
    const payload = Buffer.from(joined, "base64").toString("utf8");
    const item = {
      item_id: key,
      device_id: entry.meta.device_id || "peer",
      ts: entry.meta.ts || Date.now(),
      hlc: null,
      type: entry.meta.type || "text",
      payload,
      size_bytes: entry.meta.size_bytes || payload.length
    };
    incomingChunks.delete(key);
    window.clipboardApp.applyRemoteClipboard(item);
    renderHistory();
    dc.send(JSON.stringify({ kind: "ack", item_id: key }));
  }
}

async function renderDevices() {
  const devices = await window.clipboardApp.listDevices();
  let onlineCount = 0;
  let offlineCount = 0;
  devicesEl.innerHTML = "";
  if (devicesManageEl) devicesManageEl.innerHTML = "";

  for (const d of devices) {
    const status = d.status || "unknown";
    if (status === "online") onlineCount += 1;
    if (status === "offline") offlineCount += 1;
    const lastSeen = d.last_seen ? new Date(d.last_seen).toLocaleString() : "never";

    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${d.name} (${status}) · last seen ${lastSeen}`;
    li.appendChild(label);
    devicesEl.appendChild(li);

    if (devicesManageEl) {
      const liManage = document.createElement("li");
      const labelManage = document.createElement("span");
      labelManage.textContent = `${d.name} (${status})`;
      const btn = document.createElement("button");
      btn.textContent = "Unpair";
      btn.addEventListener("click", () => unpairDevice(d.device_id));
      liManage.appendChild(labelManage);
      liManage.appendChild(btn);
      devicesManageEl.appendChild(liManage);
    }
  }

  if (onlineCountEl) onlineCountEl.textContent = `Online: ${onlineCount}`;
  if (offlineCountEl) offlineCountEl.textContent = `Offline: ${offlineCount}`;
}

async function renderHistory() {
  const history = await window.clipboardApp.listHistory();
  historyEl.innerHTML = "";
  const filtered = history.filter((h) => {
    if (!historyQuery) return true;
    const timeStr = new Date(h.ts).toLocaleString().toLowerCase();
    const deviceName = (h.device_name || "").toLowerCase();
    const payload = (h.payload || "").toLowerCase();
    const type = (h.type || "").toLowerCase();
    return (
      timeStr.includes(historyQuery) ||
      deviceName.includes(historyQuery) ||
      payload.includes(historyQuery) ||
      type.includes(historyQuery)
    );
  });
  for (const h of filtered) {
    const li = document.createElement("li");
    const time = new Date(h.ts).toLocaleTimeString();
    const deviceName = h.device_name || "Unknown";
    if (h.type === "image") {
      const wrap = document.createElement("div");
      wrap.className = "history-item";
      const img = document.createElement("img");
      img.src = h.payload;
      img.alt = "clipboard image";
      img.className = "history-image";
      const meta = document.createElement("div");
      meta.className = "history-meta";
      meta.textContent = `${time} · ${deviceName} · image`;
      wrap.appendChild(img);
      wrap.appendChild(meta);
      li.appendChild(wrap);
    } else if (h.type === "file") {
      const wrap = document.createElement("div");
      wrap.className = "history-item";
      const name = h.payload.split(/[/\\\\]/).pop();
      const title = document.createElement("div");
      title.textContent = `${name}`;
      const meta = document.createElement("div");
      meta.className = "history-meta";
      meta.textContent = `${time} · ${deviceName} · file · ${h.payload}`;
      wrap.appendChild(title);
      wrap.appendChild(meta);
      li.appendChild(wrap);
    } else {
      li.textContent = `${time} · ${deviceName} · ${h.payload}`;
    }
    historyEl.appendChild(li);
  }
}

// UI actions

document.getElementById("btn-generate-code").addEventListener("click", () => {
  requestPairToken();
});

document.getElementById("btn-pair").addEventListener("click", () => {
  const token = tokenInputEl.value.trim();
  if (!token) return;
  currentPairToken = token;
  ws.send(JSON.stringify({ type: "pair_with_token", token }));
});

document.getElementById("btn-save-name").addEventListener("click", async () => {
  const name = deviceNameEl.value.trim();
  if (!name) return;
  await window.clipboardApp.setDeviceName(name);
  identity.deviceName = name;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "register",
      deviceId: identity.deviceId,
      name: identity.deviceName,
      publicKey: identity.publicKey
    }));
  }
});

document.getElementById("btn-save-settings").addEventListener("click", async () => {
  const limit = Math.max(10, Math.min(500, Number(historyLimitEl.value || 50)));
  const maxSize = Math.max(1, Math.min(10240, Number(maxItemSizeEl.value || 1024)));
  await window.clipboardApp.setSetting("sync_enabled", syncEnabledEl.checked);
  await window.clipboardApp.setSetting("sync_text", syncTextEl.checked);
  await window.clipboardApp.setSetting("history_limit", limit);
  await window.clipboardApp.setSetting("max_item_size_kb", maxSize);
  historyLimitEl.value = limit;
  maxItemSizeEl.value = maxSize;
  renderHistory();
});

const unpairAllBtn = document.getElementById("btn-unpair-all");
if (unpairAllBtn) {
  unpairAllBtn.addEventListener("click", async () => {
    const devices = await window.clipboardApp.listDevices();
    for (const d of devices) {
      await unpairDevice(d.device_id);
    }
  });
}

async function unpairDevice(deviceId) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "unpair", peerId: deviceId }));
  await window.clipboardApp.removeDevice(deviceId);
  peers.delete(deviceId);
  renderDevices();
}

init();
