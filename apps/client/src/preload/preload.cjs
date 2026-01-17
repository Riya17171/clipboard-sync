const { contextBridge, ipcRenderer } = require('electron');
const { hkdfSync, randomBytes, createCipheriv, createDecipheriv } = require('crypto');

contextBridge.exposeInMainWorld('clipboardApp', {
  getIdentity: () => ipcRenderer.invoke('get-identity'),
  listHistory: () => ipcRenderer.invoke('list-history'),
  listDevices: () => ipcRenderer.invoke('list-devices'),
  getPendingItems: (peerId) => ipcRenderer.invoke('get-pending-items', peerId),
  markAcked: (peerId, itemId) => ipcRenderer.invoke('mark-acked', peerId, itemId),
  setDeviceName: (name) => ipcRenderer.invoke('set-device-name', name),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  removeDevice: (deviceId) => ipcRenderer.invoke('remove-device', deviceId),

  onLocalClipboard: (cb) => ipcRenderer.on('clipboard-local-change', (_, item) => cb(item)),
  onPresenceUpdate: (cb) => ipcRenderer.on('presence-update', (_, payload) => cb(payload)),
  onPairSuccess: (cb) => ipcRenderer.on('pair-success', (_, peer) => cb(peer)),
  onDeviceInfo: (cb) => ipcRenderer.on('device-info', (_, peer) => cb(peer)),

  applyRemoteClipboard: (item) => ipcRenderer.send('apply-remote-clipboard', item),
  notifyPairSuccess: (peer) => ipcRenderer.send('pair-success', peer),
  notifyPresence: (payload) => ipcRenderer.send('presence-update', payload),
  notifyDeviceInfo: (peer) => ipcRenderer.send('device-info', peer),
  log: (msg) => ipcRenderer.send('renderer-log', msg),
  pairing: {
    encrypt: (token, plaintext) => {
      const key = hkdfSync('sha256', Buffer.from(token), Buffer.alloc(0), Buffer.from('pairing'), 32);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return {
        iv: iv.toString('base64'),
        data: ciphertext.toString('base64'),
        tag: tag.toString('base64')
      };
    },
    decrypt: (token, payload) => {
      const key = hkdfSync('sha256', Buffer.from(token), Buffer.alloc(0), Buffer.from('pairing'), 32);
      const iv = Buffer.from(payload.iv, 'base64');
      const data = Buffer.from(payload.data, 'base64');
      const tag = Buffer.from(payload.tag, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
      return plaintext;
    }
  }
});
