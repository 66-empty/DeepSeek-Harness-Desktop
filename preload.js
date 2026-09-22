/**
 * Preload for the DeepSeek Harness Desktop shell.
 *
 * Exposes the start-at-login bridge to the GUI page as
 * `window.__dshDesktopShell`. The GUI registers its Settings → General
 * "Start at login" row only while this bridge is present, so the same page in
 * a plain browser keeps the stock General section.
 */

'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__dshDesktopShell', {
  getAutoStart: () => ipcRenderer.invoke('dsh-desktop:auto-start:get'),
  setAutoStart: (enabled) => ipcRenderer.invoke('dsh-desktop:auto-start:set', enabled === true),
})

/**
 * Runtime-provisioning bridge consumed by the standalone provision.html
 * wizard (also preloaded only in this shell's windows).
 */
contextBridge.exposeInMainWorld('__dshProvision', {
  getMeta: () => ipcRenderer.invoke('dsh-desktop:provision:get-meta'),
  getState: () => ipcRenderer.invoke('dsh-desktop:provision:get-state'),
  start: () => ipcRenderer.invoke('dsh-desktop:provision:start'),
  cancel: () => ipcRenderer.invoke('dsh-desktop:provision:cancel'),
  chooseRepo: () => ipcRenderer.invoke('dsh-desktop:provision:choose-repo'),
  quit: () => ipcRenderer.invoke('dsh-desktop:provision:quit'),
  setMirrorMode: (mode) => ipcRenderer.invoke('dsh-desktop:provision:set-mirror-mode', mode),
  onEvent: (cb) => {
    const listener = (_event, payload) => { try { cb(payload) } catch { /* renderer errors must not break IPC */ } }
    ipcRenderer.on('dsh-desktop:provision:event', listener)
    return () => ipcRenderer.removeListener('dsh-desktop:provision:event', listener)
  },
})

/**
 * Self-update bridge consumed by the standalone update.html window: version
 * checks against GitHub Releases, download with verification, and handing the
 * installer to Windows.
 */
contextBridge.exposeInMainWorld('__dshUpdate', {
  getMeta: () => ipcRenderer.invoke('dsh-desktop:update:get-meta'),
  getState: () => ipcRenderer.invoke('dsh-desktop:update:get-state'),
  check: () => ipcRenderer.invoke('dsh-desktop:update:check'),
  download: () => ipcRenderer.invoke('dsh-desktop:update:download'),
  cancel: () => ipcRenderer.invoke('dsh-desktop:update:cancel'),
  install: () => ipcRenderer.invoke('dsh-desktop:update:install'),
  skip: () => ipcRenderer.invoke('dsh-desktop:update:skip'),
  openReleasePage: () => ipcRenderer.invoke('dsh-desktop:update:open-release-page'),
  revealFile: () => ipcRenderer.invoke('dsh-desktop:update:reveal-file'),
  openRuntimeWizard: () => ipcRenderer.invoke('dsh-desktop:update:open-runtime-wizard'),
  close: () => ipcRenderer.invoke('dsh-desktop:update:close'),
  setOptions: (patch) => ipcRenderer.invoke('dsh-desktop:update:set-options', patch || {}),
  onEvent: (cb) => {
    const listener = (_event, payload) => { try { cb(payload) } catch { /* renderer errors must not break IPC */ } }
    ipcRenderer.on('dsh-desktop:update:event', listener)
    return () => ipcRenderer.removeListener('dsh-desktop:update:event', listener)
  },
})
