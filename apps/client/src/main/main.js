import { app, BrowserWindow, ipcMain, clipboard, nativeImage } from "electron";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { randomUUID, generateKeyPairSync } from "crypto";
import initSqlJs from "sql.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const USER_DATA_DIR = app.getPath("userData");
const DB_PATH = path.join(USER_DATA_DIR, "clipboard.db");
const MAIN_LOG = path.join(USER_DATA_DIR, "main.log");

let mainWindow = null;
let lastAppliedId = null;
let lastClipboardSignature = "";
let syncEnabled = true;
let syncTextEnabled = true;
let historyLimit = 50;
let maxItemSizeKb = 10240;
let db = null;
let saveTimer = null;
const RENDERER_LOG = path.join(USER_DATA_DIR, "renderer.log");

function logMain(message) {
  try {
    fs.appendFileSync(MAIN_LOG, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // ignore
  }
}

process.on("uncaughtException", (err) => {
  logMain(`uncaughtException: ${err?.stack || err}`);
});

process.on("unhandledRejection", (reason) => {
  logMain(`unhandledRejection: ${reason}`);
});

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
      device_name TEXT,
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

  // Add device_name column if upgrading from older DB
  const cols = database.exec("PRAGMA table_info(clipboard_items)");
  if (cols && cols[0] && cols[0].values) {
    const hasDeviceName = cols[0].values.some((row) => row[1] === "device_name");
    if (!hasDeviceName) {
      database.exec("ALTER TABLE clipboard_items ADD COLUMN device_name TEXT;");
    }
  }

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
  if (!getSetting("max_item_size_kb")) setSetting("max_item_size_kb", "10240");

  return { deviceId, deviceName, publicKey, privateKey };
}

function loadSettings() {
  const getSetting = (key) => dbGet("SELECT value FROM settings WHERE key = ?", [key])?.value;
  syncEnabled = getSetting("sync_enabled") !== "false";
  syncTextEnabled = getSetting("sync_text") !== "false";
  historyLimit = Number(getSetting("history_limit") || "50");
  maxItemSizeKb = 10240;
  dbRun("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", ["max_item_size_kb", "10240"]);
}

function storeClipboardItem(item, localDeviceId, localDeviceName) {
  if (!item.device_id) item.device_id = "peer";
  if (!item.type) item.type = "text";
  if (item.payload === undefined || item.payload === null) item.payload = "";
  if (!item.size_bytes) {
    item.size_bytes = Buffer.byteLength(String(item.payload), "utf8");
  }
  const deviceName =
    item.device_name ||
    (item.device_id === localDeviceId ? localDeviceName : undefined) ||
    dbGet("SELECT name FROM devices WHERE device_id = ?", [item.device_id])?.name ||
    "Unknown";

  dbRun(
    `INSERT OR REPLACE INTO clipboard_items (item_id, device_id, device_name, ts, hlc, type, payload, size_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  , [item.item_id, item.device_id, deviceName, item.ts, item.hlc, item.type, item.payload, item.size_bytes]);

  dbRun(
    `DELETE FROM clipboard_items
     WHERE item_id NOT IN (
       SELECT item_id FROM clipboard_items ORDER BY ts DESC LIMIT ?
     )`,
    [historyLimit]
  );
}

function encodeImageForClipboard(image, maxBytes) {
  const png = image.toPNG();
  if (png.length <= maxBytes) {
    return { payload: `data:image/png;base64,${png.toString("base64")}`, sizeBytes: png.length };
  }

  const resized = image.resize({ width: 800 });
  const jpg = resized.toJPEG(70);
  if (jpg.length <= maxBytes) {
    return { payload: `data:image/jpeg;base64,${jpg.toString("base64")}`, sizeBytes: jpg.length };
  }

  const smaller = image.resize({ width: 500 });
  const jpgSmall = smaller.toJPEG(60);
  return { payload: `data:image/jpeg;base64,${jpgSmall.toString("base64")}`, sizeBytes: jpgSmall.length };
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
    `SELECT pq.item_id, ci.device_id, ci.device_name, ci.ts, ci.type, ci.payload, ci.size_bytes
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

function listHistory(limit = 50, localDeviceId, localDeviceName) {
  const rows = dbAll(
    `SELECT item_id, device_id, device_name, ts, type, payload
     FROM clipboard_items
     ORDER BY ts DESC
     LIMIT ?`,
    [limit]
  );
  return rows.map((row) => {
    let name = row.device_name;
    if (!name) {
      if (row.device_id === localDeviceId) {
        name = localDeviceName || "This device";
      } else {
        name = dbGet("SELECT name FROM devices WHERE device_id = ?", [row.device_id])?.name || "Unknown";
      }
    }
    return { ...row, device_name: name };
  });
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

function startClipboardWatcher(deviceId, deviceName) {
  setInterval(() => {
    if (!syncEnabled) return;
    let type = "text";
    let payload = "";
    let sizeBytes = 0;

    const formats = clipboard.availableFormats().map((f) => f.toLowerCase());
    const hasFormat = (name) => formats.includes(name.toLowerCase());

    const image = clipboard.readImage();
    if (image && !image.isEmpty()) {
      type = "image";
      const encoded = encodeImageForClipboard(image, maxItemSizeKb * 1024);
      payload = encoded.payload;
      sizeBytes = encoded.sizeBytes;
    } else if (hasFormat("image/png") || hasFormat("image/jpeg") || hasFormat("image/jpg")) {
      const fmt = hasFormat("image/png") ? "image/png" : "image/jpeg";
      const buf = clipboard.readBuffer(fmt);
      if (buf && buf.length > 0) {
        type = "image";
        sizeBytes = buf.length;
        payload = `data:${fmt};base64,${buf.toString("base64")}`;
      }
    }

    if (type !== "image") {
      // Try HTML image fallback (e.g., copied from browser)
      try {
        const html = clipboard.readHTML();
        const match = html.match(/<img[^>]+src=['"]([^'"]+)['"]/i);
        if (match && match[1] && match[1].startsWith("data:image/")) {
          type = "image";
          payload = match[1];
          sizeBytes = Buffer.byteLength(payload, "utf8");
        }
      } catch {
        // ignore
      }
    }

    if (type !== "image") {
      let filePath = "";
      if (hasFormat("x-special/gnome-copied-files")) {
        const buf = clipboard.readBuffer("x-special/gnome-copied-files");
        filePath = buf.toString("utf8");
      } else if (hasFormat("application/x-gnome-copied-files")) {
        const buf = clipboard.readBuffer("application/x-gnome-copied-files");
        filePath = buf.toString("utf8");
      } else if (hasFormat("text/uri-list")) {
        const buf = clipboard.readBuffer("text/uri-list");
        filePath = buf.toString("utf8");
      } else if (hasFormat("public.file-url")) {
        const buf = clipboard.readBuffer("public.file-url");
        filePath = buf.toString("utf8");
      }

      if (filePath) {
        const lines = filePath.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const first = lines.find((line) => line.startsWith("file://")) || lines.find(Boolean) || "";
        const cleaned = first.replace(/^(copy|cut)$/i, "").trim();
        const url = cleaned.startsWith("file://") ? cleaned : first;
        let decoded = url.replace(/^file:\/\//i, "");
        decoded = decodeURIComponent(decoded);
        if (/^\/[A-Za-z]:\//.test(decoded)) decoded = decoded.slice(1);
        payload = decoded;
        type = "file";
        sizeBytes = Buffer.byteLength(payload, "utf8");
      } else {
        const text = clipboard.readText();
        if (!text) return;
        if (!syncTextEnabled) return;
        payload = text;
        sizeBytes = Buffer.byteLength(payload, "utf8");
        if (fs.existsSync(text) && fs.statSync(text).isFile()) {
          type = "file";
        }
      }
    }

    const signature = `${type}:${payload}`;
    if (signature === lastClipboardSignature) return;
    lastClipboardSignature = signature;
    if (sizeBytes > maxItemSizeKb * 1024) {
      return;
    }
    const itemId = randomUUID();
    const item = {
      item_id: itemId,
      device_id: deviceId,
      ts: Date.now(),
      hlc: null,
      type,
      payload,
      size_bytes: sizeBytes
    };

    storeClipboardItem(item, deviceId, deviceName);
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
  startClipboardWatcher(identity.deviceId, identity.deviceName);

  ipcMain.handle("get-identity", () => identity);
  ipcMain.handle("list-history", () => listHistory(historyLimit, identity.deviceId, identity.deviceName));
  ipcMain.handle("list-devices", () => listDevices());
  ipcMain.handle("get-pending-items", (_, peerId) => listPendingForPeer(peerId));
  ipcMain.handle("mark-acked", (_, peerId, itemId) => markPendingAcked(peerId, itemId));
  ipcMain.handle("set-device-name", (_, name) => {
    dbRun("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", ["device_name", name]);
    identity.deviceName = name;
    return true;
  });
  ipcMain.handle("get-settings", () => ({
    syncEnabled,
    syncTextEnabled,
    historyLimit,
    maxItemSizeKb: 10240
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
    if (item.size_bytes && item.size_bytes > maxItemSizeKb * 1024) return;
    lastAppliedId = item.item_id;
    const payload = item.payload || "";
    lastClipboardSignature = `${item.type}:${payload}`;
    if (item.type === "image") {
      const image = nativeImage.createFromDataURL(payload);
      clipboard.writeImage(image);
    } else if (item.type === "file") {
      clipboard.writeText(payload);
    } else {
      clipboard.writeText(payload);
    }
    storeClipboardItem(item, identity.deviceId, identity.deviceName);
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
