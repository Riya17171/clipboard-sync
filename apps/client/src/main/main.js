import { app, BrowserWindow, ipcMain, clipboard } from "electron";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { randomUUID, generateKeyPairSync } from "crypto";
import initSqlJs from "sql.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const USER_DATA_DIR = app.getPath("userData");
const DB_PATH = path.join(USER_DATA_DIR, "clipboard.db");

let mainWindow = null;
let lastAppliedId = null;
let lastClipboardText = "";
let syncEnabled = true;
let syncTextEnabled = true;
let historyLimit = 50;
let db = null;
let saveTimer = null;
const RENDERER_LOG = path.join(USER_DATA_DIR, "renderer.log");

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.cjs"),
      contextIsolation: false,
      nodeIntegration: true
    }
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_, permission, callback) => {
    if (permission === "media") {
      callback(true);
    } else {
      callback(false);
    }
  });
  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!db) return;
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  }, 500);
}

async function initDb() {
  const locateFile = (file) => {
    return path.join(__dirname, "../../node_modules/sql.js/dist", file);
  };

  const SQL = await initSqlJs({ locateFile });
  let database;
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    database = new SQL.Database(new Uint8Array(fileBuffer));
  } else {
    database = new SQL.Database();
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS devices (
      device_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      public_key TEXT NOT NULL,
      paired_at INTEGER NOT NULL,
      last_seen INTEGER,
      status TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clipboard_items (
      item_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      hlc TEXT,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      FOREIGN KEY (device_id) REFERENCES devices(device_id)
    );

    CREATE TABLE IF NOT EXISTS pending_queue (
      queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL,
      target_device_id TEXT NOT NULL,
      status TEXT NOT NULL,
      retries INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (item_id) REFERENCES clipboard_items(item_id)
    );
  `);

  return database;
}

function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function dbRun(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();
  scheduleSave();
}

function getOrCreateDeviceIdentity() {
  const getSetting = (key) => dbGet("SELECT value FROM settings WHERE key = ?", [key])?.value;
  const setSetting = (key, value) => dbRun("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [key, value]);

  let deviceId = getSetting("device_id");
  let deviceName = getSetting("device_name");
  let publicKey = getSetting("public_key");
  let privateKey = getSetting("private_key");

  if (!deviceId) {
    deviceId = randomUUID();
    setSetting("device_id", deviceId);
  }
  if (!deviceName) {
    deviceName = `Device-${deviceId.slice(0, 6)}`;
    setSetting("device_name", deviceName);
  }
  if (!publicKey || !privateKey) {
    const { publicKey: pub, privateKey: priv } = generateKeyPairSync("ed25519");
    publicKey = pub.export({ type: "spki", format: "pem" }).toString();
    privateKey = priv.export({ type: "pkcs8", format: "pem" }).toString();
    setSetting("public_key", publicKey);
    setSetting("private_key", privateKey);
  }

  if (!getSetting("sync_enabled")) setSetting("sync_enabled", "true");
  if (!getSetting("sync_text")) setSetting("sync_text", "true");
  if (!getSetting("history_limit")) setSetting("history_limit", "50");

  return { deviceId, deviceName, publicKey, privateKey };
}

function loadSettings() {
  const getSetting = (key) => dbGet("SELECT value FROM settings WHERE key = ?", [key])?.value;
  syncEnabled = getSetting("sync_enabled") !== "false";
  syncTextEnabled = getSetting("sync_text") !== "false";
  historyLimit = Number(getSetting("history_limit") || "50");
}

function storeClipboardItem(item) {
  dbRun(
    `INSERT OR REPLACE INTO clipboard_items (item_id, device_id, ts, hlc, type, payload, size_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  , [item.item_id, item.device_id, item.ts, item.hlc, item.type, item.payload, item.size_bytes]);

  dbRun(
    `DELETE FROM clipboard_items
     WHERE item_id NOT IN (
       SELECT item_id FROM clipboard_items ORDER BY ts DESC LIMIT ?
     )`,
    [historyLimit]
  );
}

function enqueueForAllPeers(itemId) {
  const peers = dbAll("SELECT device_id FROM devices");
  for (const peer of peers) {
    dbRun(
      `INSERT INTO pending_queue (item_id, target_device_id, status, retries)
       VALUES (?, ?, 'pending', 0)`
    , [itemId, peer.device_id]);
  }
}

function listPendingForPeer(peerId, limit = 50) {
  return dbAll(
    `SELECT pq.item_id, ci.device_id, ci.ts, ci.type, ci.payload, ci.size_bytes
     FROM pending_queue pq
     JOIN clipboard_items ci ON ci.item_id = pq.item_id
     WHERE pq.target_device_id = ? AND pq.status = 'pending'
     ORDER BY ci.ts ASC
     LIMIT ?`,
    [peerId, limit]
  );
}

function markPendingAcked(peerId, itemId) {
  dbRun(
    `UPDATE pending_queue SET status = 'acked'
     WHERE target_device_id = ? AND item_id = ?`,
    [peerId, itemId]
  );
}

function listHistory(limit = 50) {
  return dbAll(
    `SELECT item_id, device_id, ts, type, payload
     FROM clipboard_items
     ORDER BY ts DESC
     LIMIT ?`,
    [limit]
  );
}

function setDeviceStatus(deviceId, status, lastSeen) {
  dbRun(
    `UPDATE devices SET status = ?, last_seen = ? WHERE device_id = ?`,
    [status, lastSeen ?? null, deviceId]
  );
}

function upsertDevice(device) {
  dbRun(
    `INSERT INTO devices (device_id, name, public_key, paired_at, last_seen, status)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET
       name=excluded.name,
       public_key=CASE
         WHEN excluded.public_key IS NOT NULL AND excluded.public_key != '' THEN excluded.public_key
         ELSE devices.public_key
       END,
       last_seen=excluded.last_seen,
       status=excluded.status`,
    [device.device_id, device.name, device.public_key, device.paired_at, device.last_seen, device.status]
  );
}

function listDevices() {
  return dbAll(
    `SELECT device_id, name, last_seen, status FROM devices
     ORDER BY name ASC`
  );
}

function removeDevice(deviceId) {
  dbRun("DELETE FROM pending_queue WHERE target_device_id = ?", [deviceId]);
  dbRun("DELETE FROM devices WHERE device_id = ?", [deviceId]);
}

function startClipboardWatcher(deviceId) {
  setInterval(() => {
    if (!syncEnabled || !syncTextEnabled) return;
    const text = clipboard.readText();
    if (!text) return;
    if (text === lastClipboardText) return;

    lastClipboardText = text;
    const itemId = randomUUID();
    const item = {
      item_id: itemId,
      device_id: deviceId,
      ts: Date.now(),
      hlc: null,
      type: "text",
      payload: text,
      size_bytes: Buffer.byteLength(text, "utf8")
    };

    storeClipboardItem(item);
    enqueueForAllPeers(item.item_id);
    if (mainWindow) {
      mainWindow.webContents.send("clipboard-local-change", item);
    }
  }, 750);
}

app.whenReady().then(async () => {
  db = await initDb();
  const identity = getOrCreateDeviceIdentity();
  loadSettings();

  createWindow();
  startClipboardWatcher(identity.deviceId);

  ipcMain.handle("get-identity", () => identity);
  ipcMain.handle("list-history", () => listHistory(historyLimit));
  ipcMain.handle("list-devices", () => listDevices());
  ipcMain.handle("get-pending-items", (_, peerId) => listPendingForPeer(peerId));
  ipcMain.handle("mark-acked", (_, peerId, itemId) => markPendingAcked(peerId, itemId));
  ipcMain.handle("set-device-name", (_, name) => {
    dbRun("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", ["device_name", name]);
    return true;
  });
  ipcMain.handle("get-settings", () => ({
    syncEnabled,
    syncTextEnabled,
    historyLimit
  }));
  ipcMain.handle("set-setting", (_, key, value) => {
    dbRun("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [key, String(value)]);
    loadSettings();
    return true;
  });
  ipcMain.handle("remove-device", (_, deviceId) => {
    removeDevice(deviceId);
    return true;
  });

  ipcMain.on("apply-remote-clipboard", (_, item) => {
    if (!syncEnabled) return;
    if (item.type === "text" && !syncTextEnabled) return;
    lastAppliedId = item.item_id;
    const text = item.payload || "";
    lastClipboardText = text;
    clipboard.writeText(text);
    storeClipboardItem(item);
  });

  ipcMain.on("pair-success", (_, peer) => {
    const device = {
      device_id: peer.deviceId,
      name: peer.name || "Unknown",
      public_key: peer.publicKey || "",
      paired_at: Date.now(),
      last_seen: Date.now(),
      status: "online"
    };
    upsertDevice(device);
  });

  ipcMain.on("presence-update", (_, payload) => {
    setDeviceStatus(payload.deviceId, payload.status, payload.ts);
  });

  ipcMain.on("device-info", (_, peer) => {
    const device = {
      device_id: peer.deviceId,
      name: peer.name || "Unknown",
      public_key: peer.publicKey || "",
      paired_at: Date.now(),
      last_seen: Date.now(),
      status: "online"
    };
    upsertDevice(device);
  });

  ipcMain.on("renderer-log", (_, msg) => {
    try {
      fs.appendFileSync(RENDERER_LOG, `${new Date().toISOString()} ${msg}\n`);
    } catch {
      // ignore
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  if (db) {
    try {
      const data = db.export();
      fs.writeFileSync(DB_PATH, Buffer.from(data));
    } catch {
      // ignore
    }
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
