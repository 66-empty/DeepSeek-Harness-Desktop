/**
 * DeepSeek Harness Desktop — Electron shell around `dsh web`.
 *
 * The DeepSeek Harness Web GUI is not a static page: only the `dsh web`
 * process serves it, injecting `window.__DSH_BOOT__` and owning the /api and
 * RPC endpoints. This shell therefore:
 *
 *   1. spawns `node --import tsx/esm apps/cli/src/bin.ts web --no-open --port <p>`
 *      inside the deepseek-harness checkout (same recipe as `pnpm dsh web`),
 *   2. waits for the readiness line `dsh web: http://127.0.0.1:<port>/?token=...`,
 *   3. loads that authenticated URL in a standalone BrowserWindow,
 *   4. keeps the backend alive while the app dwells in the tray, and
 *   5. terminates the backend process tree on real quit.
 *
 * Nothing in the harness repository is modified. Port 0 lets the OS pick a
 * free port so this instance never collides with another `dsh web`.
 */

'use strict'

const { app, BrowserWindow, Tray, Menu, dialog, shell, session, nativeImage, ipcMain } = require('electron')
const { spawn, spawnSync } = require('child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createProvisioner, DEFAULT_PROXIES } = require('./provision.js')
const { checkForUpdate, downloadUpdate, launchInstaller, DEFAULT_REPO: DEFAULT_UPDATE_REPO, CancelledError } = require('./updater.js')
const { makeDictionary } = require('./locales.js')

const APP_DIR = __dirname
const APP_NAME = 'DeepSeek Harness Desktop'
const LOG_DIR = path.join(os.homedir(), '.dsh-desktop-logs')
const LOG_PATH = path.join(LOG_DIR, 'desktop.log')
const ICON_PATH = path.join(APP_DIR, 'assets', 'icon.ico')
const PRELOAD_PATH = path.join(APP_DIR, 'preload.js')
const MANIFEST_PATH = path.join(APP_DIR, 'runtime.manifest.json')
const PROVISION_HTML = path.join(APP_DIR, 'provision.html')
const UPDATE_HTML = path.join(APP_DIR, 'update.html')
const PROVISION_IPC = 'dsh-desktop:provision'
const UPDATE_IPC = 'dsh-desktop:update'
const STARTUP_TIMEOUT_MS = 90_000
const SHUTDOWN_GRACE_MS = 4_000
const MAX_LOG_BYTES = 2 * 1024 * 1024
/** How long to let the launch of an in-place upgrade settle before quitting. */
const UPDATE_INSTALL_DELAY_MS = 1_200
/** Delay before the silent startup update check (the GUI must be usable first). */
const UPDATE_CHECK_DELAY_MS = 8_000

/**
 * Window/tray icon, decoded lazily (nativeImage needs no window but avoids
 * surprises before ready). Returns null when the ico cannot be read — window
 * creation then omits `icon`, so Windows falls back to the icon embedded in
 * the executable instead of painting a blank taskbar button.
 */
let _appIcon // undefined = not probed yet
function appIcon() {
  if (_appIcon === undefined) {
    try {
      const image = nativeImage.createFromPath(ICON_PATH)
      _appIcon = image && !image.isEmpty() ? image : null
      if (!_appIcon) console.warn(`[dsh-desktop] icon unreadable: ${ICON_PATH} (falling back to exe icon)`)
    } catch {
      _appIcon = null
    }
  }
  return _appIcon
}

const SMOKE_MODE = process.argv.includes('--smoke')
const E2E_MODE = process.argv.includes('--e2e')
const PROBE_MODE = process.argv.includes('--probe')
const UPDATE_PROBE_MODE = process.argv.includes('--update-probe')
const HIDDEN_MODE = process.argv.includes('--hidden')
/** Automated modes must never block on a modal dialog. */
const NONINTERACTIVE = SMOKE_MODE || E2E_MODE || PROBE_MODE || UPDATE_PROBE_MODE
/** electron-builder portable target runs from a throwaway extraction dir. */
const RUNNING_PORTABLE = Boolean(process.env.PORTABLE_EXECUTABLE_DIR || process.env.PORTABLE_EXECUTABLE_FILE)
/** Internal test hook: exercise the real installer hand-off from a dev run. */
const FORCE_UPDATE_INSTALL = process.env.DSH_DESKTOP_FORCE_UPDATE_INSTALL === '1'

/* ------------------------------------------------- global error reporting */

/**
 * Write a bootstrap crash record before/independent of the normal log()
 * machinery so silent startup failures on end-user machines are diagnosable
 * (desktop.log may only exist after the first log() call).
 */
function crashRecord(kind, error) {
  const text = `${new Date().toISOString()} FATAL[${kind}] ${error && error.stack ? error.stack : String(error)}\n`
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(LOG_PATH, text)
    fs.appendFileSync(path.join(LOG_DIR, 'crashes.log'), text)
  } catch { /* nothing else we can do */ }
  try { console.error(text) } catch { /* ignore */ }
}

process.on('uncaughtException', (error) => {
  crashRecord('uncaughtException', error)
  showFatalError(uiT().t('fatal.title'), error)
})
process.on('unhandledRejection', (reason) => {
  crashRecord('unhandledRejection', reason)
})

/** Surface an otherwise silent main-process failure to the user. */
let fatalShown = false
function showFatalError(title, error) {
  if (fatalShown) return
  fatalShown = true
  const message = String(error && error.message ? error.message : error)
  const detail = `${message}\n\n${uiT().t('fatal.detailPre')}:\n${LOG_PATH}\n${path.join(LOG_DIR, 'crashes.log')}`
  try {
    if (NONINTERACTIVE) {
      // Automated modes must never block on a modal dialog.
    } else if (app.isReady()) {
      dialog.showMessageBoxSync({ type: 'error', title, message, detail, buttons: [uiT().t('dialog.exit')], defaultId: 0 })
    } else {
      dialog.showErrorBox(title, detail)
    }
  } catch { /* never recurse into the dialog machinery */ }
  try { app.exit(1) } catch { process.exit(1) }
}

/** Default sibling location of the deepseek-harness checkout. */
const DEFAULT_REPO = path.join(path.dirname(APP_DIR), 'deepseek-harness')
const NODE_CANDIDATES = [
  process.env.DSH_DESKTOP_NODE,
  'C:\\Program Files\\nodejs\\node.exe',
  'C:\\Program Files (x86)\\nodejs\\node.exe',
  process.execPath.replace(/\\electron\.exe$/i, '\\node.exe'), // electron.exe sits next to node.exe in the dist
].filter(Boolean)

/**
 * Settings live next to the app in the dev/zip layout (editable, portable
 * across machines) but move to the user-data directory when the app dir is
 * not stable or writable: the portable single-exe target runs from a
 * throwaway extraction directory, and packaged apps run from inside the
 * read-only app.asar (fs.accessSync on the asar file cannot tell that
 * "writable" — writes to a path under the archive fail silently).
 * @returns the settings file path.
 */
function settingsFile() {
  const userData = path.join(app.getPath('userData'), 'settings.json')
  const insideAsar = /(^|[\\/])app\.asar([\\/]|$)/u.test(APP_DIR)
  if (RUNNING_PORTABLE || insideAsar) return userData
  try {
    fs.accessSync(APP_DIR, fs.constants.W_OK)
    return path.join(APP_DIR, 'settings.json')
  } catch {
    return userData
  }
}

/* -------------------------------------------------- provisioning helpers */

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Provisioning manifest: the shipped runtime.manifest.json (next to the app,
 * inside the asar when packaged) merged with an optional override file named
 * runtime.manifest.json next to settings.json — a release channel can pin a
 * different dsh ref / mirror without rebuilding the app.
 */
function loadManifest() {
  const base = readJsonFile(MANIFEST_PATH) || {}
  const over = readJsonFile(path.join(settingsFileDir(), 'runtime.manifest.json')) || {}
  const mergeObj = (a, b) => ({ ...(a || {}), ...(b || {}) })
  return {
    ...base,
    ...over,
    dsh: mergeObj(base.dsh, over.dsh),
    node: mergeObj(base.node, over.node),
    pnpm: mergeObj(base.pnpm, over.pnpm),
  }
}

/** Directory where the provisioned runtime (node + harness) is kept. */
function runtimeDir() {
  return path.join(app.getPath('userData'), 'runtime')
}

/** Directory that settings.json lives in (writable copy rules above). */
function settingsFileDir() {
  return path.dirname(settingsFile())
}

/** Pages this shell owns (loading screen or provision wizard) — replaceable. */
function isShellPage(win) {
  try {
    if (!win || win.isDestroyed()) return false
    const url = win.webContents.getURL()
    return url.startsWith('data:') || /provision\.html$/u.test(url)
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ state */

let backend = null // { proc, url, lines }
let state = 'stopped' // stopped | starting | ready | stopping
let isQuitting = false
let mainWindow = null
let windowRole = null // null | loading | provision | gui
let tray = null
let startRequestSeq = 0 // invalidates stale async startup flows
let provisioning = false // runtime wizard owns the app until done/cancelled
let provisioner = null
let updateWindow = null // separate window so the GUI keeps its session
let updateSignal = null // cancellation token of an in-flight download

function settings() {
  return {
    repoPath: '', // '' = resolve DSH_DESKTOP_REPO / sibling / first-run picker
    nodePath: null, // null = auto-detect
    port: 0, // 0 = let the OS pick a free port each boot
    closeToTray: true,
    autoStart: true,
    extraArgs: [],
    autoProvision: true, // first-run wizard auto-installs the runtime when no repo
    mirrorMode: 'auto', // 'auto' | 'cn' | 'direct'
    language: 'auto', // UI language: 'auto' (follow OS) | 'zh' | 'en'
    dshRef: null, // null = runtime.manifest.json ref
    nodeMirrorBase: null, // null = npmmirror
    registryMirror: null, // null = manifest registryMirror
    githubProxies: null, // null = built-in proxy list
    checkUpdates: true, // silent release check on startup
    skipVersion: '', // version the user asked to skip
    updateIncludePrerelease: false, // consider pre-releases
    updateMirror: '', // optional download mirror prefix (e.g. https://ghfast.top)
    updateRepo: '', // '' = built-in repository (owner/name)
    ...loadSettings(),
  }
}

function loadSettings() {
  try {
    const file = settingsFile()
    if (!fs.existsSync(file)) return {}
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    log(`settings.json unreadable: ${String(error)}`)
    return {}
  }
}

function saveSettings(patch) {
  const next = { ...settings(), ...patch }
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2) + '\n')
  } catch (error) {
    log(`could not write settings: ${String(error)}`)
  }
  return next
}

/* ---------------------------------------------------------- UI language */

let uiCache = null
/** Current UI dictionary (settings.language + OS locale), memoized. */
function uiT() {
  const key = `${settings().language || 'auto'}|${app.getLocale()}`
  if (!uiCache || uiCache.key !== key) {
    uiCache = { key, dict: makeDictionary(settings().language, app.getLocale()) }
  }
  return uiCache.dict
}

/** Language code currently active ('zh' | 'en') for the provision wizard. */
function uiLanguageCode() {
  return uiT().lang
}

function log(line) {
  const stamp = new Date().toISOString()
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    const entry = `${stamp} ${line}\n`
    fs.appendFileSync(LOG_PATH, entry)
    const size = fs.statSync(LOG_PATH).size
    if (size > MAX_LOG_BYTES) fs.writeFileSync(LOG_PATH, entry) // truncate, keep newest line
  } catch { /* logging must never take the app down */ }
  console.log(`[dsh-desktop] ${line}`)
}

/* ------------------------------------------------------------- resolution */

function resolveNodePath(cfg) {
  if (cfg.nodePath && fs.existsSync(cfg.nodePath)) return cfg.nodePath
  for (const candidate of NODE_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }
  const where = spawnSync('where.exe', ['node'], { encoding: 'utf8' })
  if (where.status === 0 && where.stdout) {
    const hit = where.stdout.split(/\r?\n/u).find((line) => line && line.endsWith('.exe'))
    if (hit) return hit.trim()
  }
  return null
}

/**
 * Resolve the repository path: an explicit settings value wins; otherwise the
 * `DSH_DESKTOP_REPO` environment variable, then the sibling folder (the dev/
 * zip layout). Returns null when none of them is a valid checkout, which
 * routes first-run users to the interactive picker.
 * @param cfg - current settings.
 * @returns the checkout path, or null.
 */
function effectiveRepoPath(cfg) {
  if (cfg.repoPath) return cfg.repoPath
  for (const candidate of [process.env.DSH_DESKTOP_REPO, DEFAULT_REPO]) {
    if (candidate && fs.existsSync(path.join(candidate, 'apps', 'cli', 'src', 'bin.ts'))) return candidate
  }
  return null
}

function validateRepo(cfg) {
  const repo = effectiveRepoPath(cfg)
  if (repo === null) return uiT().t('err.repoNotFound')
  const bin = path.join(repo, 'apps', 'cli', 'src', 'bin.ts')
  if (!fs.existsSync(bin)) {
    return uiT().t('err.repoBadBin', repo)
  }
  if (!fs.existsSync(path.join(repo, 'node_modules', 'tsx'))) {
    return uiT().t('err.repoNoDeps', repo)
  }
  return null
}

/* ------------------------------------------------------------- backend */

function stopBackend() {
  const current = backend
  backend = null
  state = 'stopped'
  if (!current || !current.proc || current.proc.exitCode !== null) return
  const proc = current.proc
  const pid = proc.pid
  log(`stopping backend pid=${pid}`)
  try { proc.kill() } catch { /* may already be gone */ }
  // On Windows process.kill() terminates abruptly without a console signal;
  // kill the whole tree so tool subprocesses do not survive as orphans.
  try {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 8_000 })
  } catch { /* best effort */ }
}

/**
 * Boot the backend and resolve with its authenticated URL, or reject.
 * Concurrent calls share one boot via {@link bootPromise}.
 */
let bootPromise = null
function ensureBackend() {
  if (backend && backend.url) return Promise.resolve(backend.url)
  if (bootPromise) return bootPromise
  bootPromise = startBackend().finally(() => { bootPromise = null })
  return bootPromise
}

function startBackend() {
  const seq = ++startRequestSeq
  const cfg = settings()
  const repoError = validateRepo(cfg)
  if (repoError) return Promise.reject(new Error(repoError))
  const repoPath = effectiveRepoPath(cfg)
  const nodePath = resolveNodePath(cfg)
  if (!nodePath) {
    return Promise.reject(new Error(uiT().t('err.noNode')))
  }

  const bin = path.join(repoPath, 'apps', 'cli', 'src', 'bin.ts')
  const args = [
    '--import', 'tsx/esm',
    bin,
    'web',
    '--no-open',
    '--port', String(Number.isInteger(cfg.port) ? cfg.port : 0),
    ...(cfg.extraArgs || []),
  ]
  const env = { ...process.env }
  if (!env.DSH_HOME) env.DSH_HOME = path.join(os.homedir(), '.dsh')
  // Nested `node` lookups (tool subprocesses, .bin shims) resolve through
  // PATH; pin it to the same runtime that launches the backend so an old
  // machine-installed Node cannot hijack child processes.
  const nodeDir = path.dirname(nodePath)
  const oldPath = env.PATH !== undefined ? env.PATH : env.Path
  delete env.Path
  env.PATH = oldPath ? `${nodeDir};${oldPath}` : nodeDir

  log(`spawning: ${JSON.stringify(nodePath)} ${JSON.stringify(args)}  cwd=${repoPath}  DSH_HOME=${env.DSH_HOME}`)
  state = 'starting'
  const proc = spawn(nodePath, args, {
    cwd: repoPath,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const handle = { proc, url: null, stderrTail: [] }
  backend = handle
  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')

  const urlPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(uiT().t('err.startTimeout', STARTUP_TIMEOUT_MS / 1000, tail(handle.stderrTail))))
    }, STARTUP_TIMEOUT_MS)

    const onData = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/u)) {
        if (!line) continue
        log(`dsh: ${line}`)
        const match = /^dsh web:\s*(http:\/\/\S+)/u.exec(line)
        if (match) {
          const url = match[1].trim()
          clearTimeout(timer)
          handle.url = url
          state = 'ready'
          log(`backend ready at ${url}`)
          resolve(url)
        }
      }
    }
    const onErr = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/u)) {
        if (!line) continue
        handle.stderrTail.push(line)
        if (handle.stderrTail.length > 40) handle.stderrTail.shift()
      }
    }
    const onExit = (code, signal) => {
      clearTimeout(timer)
      const unexpected = backend === handle && !isQuitting && code !== 0
      if (unexpected) {
        log(`backend exited unexpectedly code=${code} signal=${signal}`)
        backend = null
        state = 'stopped'
      }
      if (seq !== startRequestSeq) return // superseded by a restart
      if (!handle.url) {
        reject(new Error(uiT().t('err.webStartFailed', code ?? signal, tail(handle.stderrTail))))
        return
      }
      if (unexpected) onBackendDied(handle.url)
    }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onErr)
    proc.on('exit', onExit)
    proc.on('error', (error) => {
      clearTimeout(timer)
      if (!handle.url) reject(new Error(uiT().t('err.cannotStartWeb', String(error))))
    })
  })

  return urlPromise
}

function tail(lines) {
  return lines.slice(-25).join('\n') || uiT().t('err.noOutput')
}

function onBackendDied(url) {
  const showRestart = () => {
    const t = uiT().t
    const choice = dialog.showMessageBoxSync(mainWindow ?? undefined, {
      type: 'error',
      title: APP_NAME,
      message: t('backendDied.title'),
      detail: t('backendDied.detail'),
      buttons: [t('backendDied.restart'), t('backendDied.quit')],
      defaultId: 0,
      cancelId: 1,
    })
    if (choice === 0) restartBackend()
    else quitApp()
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isVisible()) showRestart()
    else {
      mainWindow.once('show', showRestart)
      mainWindow.show()
    }
  } else {
    if (tray) tray.displayBalloon({ title: APP_NAME, content: uiT().t('backendDied.balloon') })
  }
}

function restartBackend() {
  if (provisioning) {
    ensureProvisionWindow()
    return
  }
  stopBackend()
  showLoadingWindow(uiT().t('loading.restarting'))
  ensureBackend().then((url) => {
    openMainWindow(url)
  }).catch((error) => {
    dialog.showMessageBoxSync(mainWindow ?? undefined, {
      type: 'error',
      title: APP_NAME,
      message: uiT().t('failStart.title'),
      detail: String(error && error.message ? error.message : error),
    })
    state = 'stopped'
  })
}

/* --------------------------------------------------------------- windows */

function showLoadingWindow(text) {
  // A window pointing at a dead backend must go; an existing loading page is reused.
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.webContents.getURL().startsWith('data:')) return mainWindow
    mainWindow.destroy()
  }
  // Loading windows are plain pages; the real GUI window is created on ready.
  const win = new BrowserWindow({
    width: 900,
    height: 640,
    title: APP_NAME,
    icon: appIcon() || undefined,
    show: false,
    backgroundColor: '#0d1526',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: PRELOAD_PATH,
    },
  })
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => { if (mainWindow === win) { mainWindow = null; windowRole = null } })
  win.setMenu(null)
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(loadingHtml(text)))
  mainWindow = win
  windowRole = 'loading'
  return win
}

function openMainWindow(url) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (isShellPage(mainWindow)) {
      loadGuiUrl(mainWindow, url)
    }
    mainWindow.show()
    mainWindow.focus()
    windowRole = 'gui'
    return mainWindow
  }
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    title: APP_NAME,
    icon: appIcon() || undefined,
    show: false,
    backgroundColor: '#0d1526',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      preload: PRELOAD_PATH,
    },
  })
  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('http://127.0.0.1:') || target.startsWith('http://localhost:')) {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } }
    }
    if (target.startsWith('http://') || target.startsWith('https://')) shell.openExternal(target)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, target) => {
    const current = win.webContents.getURL()
    const sameOrigin = (a, b) => {
      try { return new URL(a).origin === new URL(b).origin } catch { return false }
    }
    if (!sameOrigin(current, target) && !target.startsWith('data:')) {
      event.preventDefault()
      if (target.startsWith('http://') || target.startsWith('https://')) shell.openExternal(target)
    }
  })
  win.on('close', (event) => {
    if (!isQuitting && settings().closeToTray) {
      event.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => { if (mainWindow === win) { mainWindow = null; windowRole = null } })
  mainWindow = win
  windowRole = 'gui'
  loadGuiUrl(win, url)
  return win
}

/** Load the authenticated GUI URL into a window, hooking the E2E verdict. */
function loadGuiUrl(win, url) {
  if (E2E_MODE) armE2E(win)
  win.loadURL(url)
}

/* ----------------------------------------------------------- provisioning */

function provisionSnapshot() {
  return provisioner ? provisioner.snapshot() : {
    running: false,
    done: false,
    cancelled: false,
    error: null,
    note: '',
    stages: [],
    logs: [],
    result: null,
    planInfo: null,
  }
}

function sendProvisionEvent(evt) {
  try {
    if (mainWindow && !mainWindow.isDestroyed() && windowRole === 'provision' && !mainWindow.webContents.isLoading()) {
      mainWindow.webContents.send(`${PROVISION_IPC}:event`, evt)
    }
  } catch { /* window may vanish mid-send */ }
}

/** Engine config: shipped manifest merged with runtime manifest + settings. */
function provisionEngineConfig() {
  const s = settings()
  const manifest = loadManifest()
  return {
    runtimeDir: runtimeDir(),
    manifest,
    mirrorMode: s.mirrorMode || 'auto',
    dshRef: s.dshRef || null,
    registryMirror: s.registryMirror || null,
    nodeMirrorBase: s.nodeMirrorBase || null,
    githubProxies: s.githubProxies || null,
  }
}

function ensureProvisionWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (windowRole === 'provision') {
      mainWindow.show()
      mainWindow.focus()
      return mainWindow
    }
    mainWindow.destroy()
  }
  const win = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 780,
    minHeight: 560,
    title: `${uiT().t('provision.windowTitle')} — ${APP_NAME}`,
    icon: appIcon() || undefined,
    show: false,
    backgroundColor: '#0d1526',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: PRELOAD_PATH,
    },
  })
  win.once('ready-to-show', () => win.show())
  win.on('close', (event) => {
    // Closing the wizard keeps the installation running in the background.
    if (!isQuitting && settings().closeToTray) {
      event.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => { if (mainWindow === win) { mainWindow = null; windowRole = null } })
  win.setMenu(null)
  win.loadFile(PROVISION_HTML)
  mainWindow = win
  windowRole = 'provision'
  return win
}

/**
 * Enter the provisioning flow: open the wizard (which auto-starts the engine
 * on arrival when autoProvision is on). Manual pickers remain for users who
 * disabled autoProvision.
 */
function startProvisioningFlow(reason) {
  log(`provisioning flow: ${reason}`)
  if (settings().autoProvision === false) {
    pickRepoAndStart(reason)
    return
  }
  provisioning = true
  ensureProvisionWindow()
}

/** IPC start: run the engine (idempotent; re-runs resume unfinished steps). */
function beginProvision() {
  if (!provisioner) {
    provisioner = createProvisioner({ runtimeDir: runtimeDir(), emit: onProvisionEvent })
  }
  provisioner.start(provisionEngineConfig())
  return provisioner.snapshot()
}

function onProvisionEvent(evt) {
  if (!evt) return
  try {
    if (evt.type === 'log') {
      if (process.env.DSH_PROVISION_FILELOG === '1') log(`prov: ${evt.text}`)
    } else {
      const detail = evt.message || (evt.stage && evt.stage.title) || ''
      log(`prov[${evt.type}] ${String(detail).split('\n')[0].slice(0, 400)}`)
    }
  } catch { /* logging must never break provisioning */ }
  if (evt.type === 'done') void onProvisionDone(evt.result)
  sendProvisionEvent(evt)
}

async function onProvisionDone(result) {
  provisioning = false
  if (!result) return
  saveSettings({ repoPath: result.repoDir, nodePath: result.nodeExe })
  log(`provision done: ref=${result.ref} repo=${result.repoDir} node=${result.nodeExe}`)
  sendProvisionEvent({ type: 'boot' })
  try {
    const url = await ensureBackend()
    openMainWindow(url)
  } catch (error) {
    state = 'stopped'
    const message = String(error && error.message ? error.message : error)
    log(`provision boot failed: ${message}`)
    const t = uiT().t
    const choice = dialog.showMessageBoxSync(mainWindow ?? undefined, {
      type: 'error',
      title: APP_NAME,
      message: t('failStart.title'),
      detail: message,
      buttons: [t('failStart.openLogs'), t('failStart.close')],
      defaultId: 0,
      cancelId: 1,
    })
    if (choice === 0) shell.openPath(LOG_DIR)
    sendProvisionEvent({ type: 'boot-error', message })
  }
}

function cancelProvision() {
  provisioning = false
  if (provisioner) provisioner.cancel()
}

/* ----------------------------------------------------------- self-update */

/**
 * Update lifecycle. The heavy lifting (release lookup, download, checksum
 * verification, installer hand-off) lives in updater.js; this section owns the
 * UI-facing state machine, the tray/dialog prompts and the window.
 *
 * Phases: idle → checking → (available → downloading → ready → installing)
 *         with `current` / `none` / `error` as terminal states of a check.
 */
const updateState = {
  phase: 'idle',
  latest: '',
  release: null,
  asset: null,
  notes: '',
  releaseUrl: '',
  error: null, // { code, message }
  progress: { received: 0, total: 0 },
  file: '',
  cached: false,
  checkedAt: 0,
}

/** Where installers are downloaded (survives restarts, unlike temp dirs). */
function updateDownloadDir() {
  return path.join(app.getPath('userData'), 'updates')
}

/**
 * GitHub accelerators used when the direct URL fails. Mirror mode `cn` tries
 * them first (same policy as the runtime installer), `direct` disables them.
 */
function updateProxies() {
  if ((settings().mirrorMode || 'auto') === 'direct') return []
  const configured = settings().githubProxies
  if (Array.isArray(configured) && configured.length > 0) return configured
  return DEFAULT_PROXIES
}

/**
 * Update transport options derived from settings.
 * @returns {{repo:string, mirror:string, proxies:string[], proxiesFirst:boolean}}
 */
function updateTransport() {
  const cfg = settings()
  return {
    repo: cfg.updateRepo || DEFAULT_UPDATE_REPO,
    mirror: cfg.updateMirror || '',
    proxies: updateProxies(),
    proxiesFirst: (cfg.mirrorMode || 'auto') === 'cn',
  }
}

/**
 * Detect a runtime (dsh) that lags behind the manifest pinned by this build:
 * an app upgrade usually ships a newer harness ref, which only the runtime
 * wizard installs.
 */
function runtimeStaleness() {
  const provisioned = readJsonFile(path.join(runtimeDir(), 'provisioned.json'))
  const installedRef = provisioned && provisioned.ref ? String(provisioned.ref) : ''
  const wantedRef = (loadManifest().dsh || {}).ref || ''
  return {
    runtimeRef: installedRef,
    manifestRef: wantedRef,
    runtimeOutdated: Boolean(installedRef && wantedRef && installedRef !== wantedRef),
  }
}

/** Immutable view of everything update.html renders. */
function updateSnapshot() {
  const cfg = settings()
  const runtime = runtimeStaleness()
  return {
    phase: updateState.phase,
    currentVersion: app.getVersion(),
    latest: updateState.latest,
    release: updateState.release,
    asset: updateState.asset,
    notes: updateState.notes,
    releaseUrl: updateState.releaseUrl || `https://github.com/${cfg.updateRepo || DEFAULT_UPDATE_REPO}/releases`,
    error: updateState.error,
    progress: { ...updateState.progress },
    file: updateState.file,
    cached: updateState.cached,
    checkedAt: updateState.checkedAt,
    portable: RUNNING_PORTABLE,
    packaged: app.isPackaged,
    repo: cfg.updateRepo || DEFAULT_UPDATE_REPO,
    runtimeRef: runtime.runtimeRef,
    manifestRef: runtime.manifestRef,
    runtimeOutdated: runtime.runtimeOutdated,
    options: {
      autoCheck: cfg.checkUpdates !== false,
      includePrerelease: cfg.updateIncludePrerelease === true,
      mirror: cfg.updateMirror || '',
      skipVersion: cfg.skipVersion || '',
    },
  }
}

function sendUpdateEvent(evt) {
  try {
    if (updateWindow && !updateWindow.isDestroyed() && !updateWindow.webContents.isLoading()) {
      updateWindow.webContents.send(`${UPDATE_IPC}:event`, evt)
    }
  } catch { /* window may vanish mid-send */ }
}

function pushUpdateState() {
  const snapshot = updateSnapshot()
  sendUpdateEvent({ type: 'state', state: snapshot })
  return snapshot
}

/** Normalize any thrown value into the `{ code, message }` shape the UI expects. */
function updateError(error) {
  if (error instanceof CancelledError || (error && error.name === 'CancelledError')) {
    return { code: 'cancelled', message: String(error.message || 'cancelled') }
  }
  return {
    code: error && error.code ? String(error.code) : 'api',
    message: String(error && error.message ? error.message : error),
  }
}

/**
 * Look for a newer release.
 * @param {string} reason - for the log line (startup | window | tray | test).
 * @returns {Promise<object>} the resulting snapshot.
 */
async function checkUpdates(reason) {
  if (['checking', 'downloading', 'installing'].includes(updateState.phase)) return updateSnapshot()
  const transport = updateTransport()
  updateState.phase = 'checking'
  updateState.error = null
  pushUpdateState()
  log(`update: checking releases (${reason}) repo=${transport.repo}`)
  try {
    const result = await checkForUpdate({
      repo: transport.repo,
      currentVersion: app.getVersion(),
      includePrerelease: settings().updateIncludePrerelease === true,
      mirror: transport.mirror,
      proxies: transport.proxies,
      proxiesFirst: transport.proxiesFirst,
      portable: RUNNING_PORTABLE,
      log: (line) => log(`update: ${line}`),
    })
    updateState.checkedAt = Date.now()
    updateState.latest = result.latest || ''
    updateState.release = result.release || null
    updateState.asset = result.asset || null
    updateState.notes = result.notes || ''
    updateState.releaseUrl = result.url || updateState.releaseUrl
    updateState.progress = { received: 0, total: (result.asset && result.asset.size) || 0 }
    updateState.file = ''
    updateState.cached = false
    updateState.phase = result.status === 'update-available'
      ? 'available'
      : (result.status === 'up-to-date' ? 'current' : 'none')
    log(`update: ${result.status}${result.latest ? ` latest=${result.latest}` : ''} (current ${app.getVersion()})`)
  } catch (error) {
    updateState.phase = 'error'
    updateState.error = updateError(error)
    log(`update: check failed ${updateState.error.message}`)
  }
  refreshTrayMenu()
  return pushUpdateState()
}

/** Download (or resume) the installer of the available release. */
async function startUpdateDownload() {
  if (updateState.phase === 'downloading' || !updateState.asset) return updateSnapshot()
  const transport = updateTransport()
  updateState.phase = 'downloading'
  updateState.error = null
  updateState.progress = { received: 0, total: updateState.asset.size || 0 }
  updateSignal = { cancelled: false }
  const signal = updateSignal
  pushUpdateState()
  try {
    const result = await downloadUpdate({
      asset: updateState.asset,
      release: updateState.release,
      destDir: updateDownloadDir(),
      tmpDir: updateDownloadDir(),
      mirror: transport.mirror,
      proxies: transport.proxies,
      proxiesFirst: transport.proxiesFirst,
      signal,
      log: (line) => log(`update: ${line}`),
      onProgress: (received, total) => {
        updateState.progress = {
          received,
          total: total || (updateState.asset && updateState.asset.size) || 0,
        }
        sendUpdateEvent({ type: 'progress', ...updateState.progress })
      },
    })
    updateState.file = result.file
    updateState.cached = result.cached === true
    updateState.progress = { received: result.bytes, total: result.bytes }
    updateState.phase = 'ready'
    log(`update: ready ${result.file}${result.cached ? ' (already verified)' : ''}`)
  } catch (error) {
    updateState.error = updateError(error)
    updateState.phase = updateState.error.code === 'cancelled' ? 'available' : 'error'
    log(`update: download stopped ${updateState.error.message}`)
  } finally {
    updateSignal = null
  }
  refreshTrayMenu()
  return pushUpdateState()
}

/** Abort an in-flight download (the partial file is kept for resume). */
function cancelUpdateDownload() {
  if (updateSignal) updateSignal.cancelled = true
  return updateSnapshot()
}

/**
 * Hand the verified installer to Windows and quit. The NSIS installer was
 * built by electron-builder, so `--updated /S --force-run` upgrades in place
 * (same directory, per-user) and relaunches the app afterwards.
 */
function installUpdate() {
  const t = uiT().t
  const file = updateState.file
  if (!file || !fs.existsSync(file)) {
    updateState.phase = 'error'
    updateState.error = { code: 'io', message: `installer missing: ${file || '(none)'}` }
    return pushUpdateState()
  }
  if (!FORCE_UPDATE_INSTALL && (RUNNING_PORTABLE || !app.isPackaged)) {
    // Self-replacement is impossible (unpacked dir) or unsafe (portable exe):
    // keep the verified file and point the user at it instead.
    const detail = RUNNING_PORTABLE ? t('update.install.portable') : t('update.install.dev')
    const choice = dialog.showMessageBoxSync(updateWindow ?? mainWindow ?? undefined, {
      type: 'info',
      title: APP_NAME,
      message: detail,
      detail: file,
      buttons: [t('update.install.reveal'), t('update.install.close')],
      defaultId: 0,
      cancelId: 1,
    })
    if (choice === 0) shell.showItemInFolder(file)
    return pushUpdateState()
  }
  updateState.phase = 'installing'
  pushUpdateState()
  try {
    const pid = launchInstaller(file, { log: (line) => log(`update: ${line}`) })
    log(`update: installer started (pid=${pid}), quitting for the upgrade`)
  } catch (error) {
    updateState.phase = 'error'
    updateState.error = updateError(error)
    log(`update: installer launch failed ${updateState.error.message}`)
    dialog.showMessageBoxSync(updateWindow ?? mainWindow ?? undefined, {
      type: 'error',
      title: t('update.fail.title'),
      message: t('update.install.failed', updateState.error.message),
      buttons: [t('update.install.close')],
    })
    return pushUpdateState()
  }
  setTimeout(() => quitApp(), UPDATE_INSTALL_DELAY_MS).unref()
  return updateSnapshot()
}

/** Open (or focus) the update window. Kept out of `mainWindow` on purpose. */
function ensureUpdateWindow() {
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.show()
    updateWindow.focus()
    return updateWindow
  }
  const width = 760
  const height = 680
  const parentBounds = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()
    ? mainWindow.getBounds()
    : null
  const win = new BrowserWindow({
    width,
    height,
    minWidth: 620,
    minHeight: 520,
    title: `${uiT().t('update.windowTitle')} — ${APP_NAME}`,
    icon: appIcon() || undefined,
    show: false,
    backgroundColor: '#0d1526',
    autoHideMenuBar: true,
    ...(parentBounds
      ? {
        x: Math.round(parentBounds.x + Math.max(0, (parentBounds.width - width) / 2)),
        y: Math.round(parentBounds.y + Math.max(0, (parentBounds.height - height) / 2)),
      }
      : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: PRELOAD_PATH,
    },
  })
  win.once('ready-to-show', () => win.show())
  win.on('close', (event) => {
    // Closing hides the window; a running download continues in the background.
    if (!isQuitting && settings().closeToTray) {
      event.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => { if (updateWindow === win) updateWindow = null })
  win.setMenu(null)
  win.loadFile(UPDATE_HTML)
  updateWindow = win
  return win
}

/** Tray/GUI entry point: show the window and refresh the release state. */
function openUpdateWindow(reason) {
  ensureUpdateWindow()
  void checkUpdates(reason)
  return updateWindow
}

/**
 * Silent startup check: never interrupts a running setup, respects the
 * "skip this version" choice, and stays non-modal when the GUI is hidden
 * (autostart) by falling back to a tray balloon.
 */
async function autoCheckUpdates() {
  if (provisioning) {
    log('update: startup check skipped (runtime setup in progress)')
    return
  }
  const snapshot = await checkUpdates('startup')
  if (snapshot.phase !== 'available') return
  const cfg = settings()
  if (cfg.skipVersion && cfg.skipVersion === snapshot.latest) {
    log(`update: ${snapshot.latest} skipped by settings`)
    refreshTrayMenu()
    return
  }
  const t = uiT().t
  const guiVisible = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()
  if (HIDDEN_MODE || !guiVisible || updateWindow) {
    if (tray && !tray.isDestroyed()) {
      tray.displayBalloon({
        title: APP_NAME,
        content: t('update.balloon.available', snapshot.latest, snapshot.currentVersion),
      })
    }
    refreshTrayMenu()
    return
  }
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: 'info',
    title: APP_NAME,
    message: t('update.dialog.title', snapshot.latest),
    detail: t('update.dialog.detail', snapshot.latest, snapshot.currentVersion),
    buttons: [t('update.dialog.now'), t('update.dialog.later'), t('update.dialog.skip')],
    defaultId: 0,
    cancelId: 1,
  })
  if (choice === 0) {
    ensureUpdateWindow()
    void startUpdateDownload()
  } else if (choice === 2) {
    saveSettings({ skipVersion: snapshot.latest })
    log(`update: user skipped ${snapshot.latest}`)
  }
  refreshTrayMenu()
}

/**
 * Queue the silent startup check. Automated modes (smoke/e2e/probe) and the
 * `DSH_DESKTOP_SKIP_UPDATE_CHECK=1` test hook never touch the network.
 */
function scheduleStartupUpdateCheck() {
  if (NONINTERACTIVE || process.env.DSH_DESKTOP_SKIP_UPDATE_CHECK === '1') return
  if (settings().checkUpdates === false) {
    log('update: startup check disabled in settings')
    return
  }
  setTimeout(() => { void autoCheckUpdates() }, UPDATE_CHECK_DELAY_MS).unref()
}

/**
 * Keep the download cache bounded: drop installers of the running version
 * (useless leftovers of a finished upgrade) and anything older than a week,
 * while preserving a pending download for resume.
 */
function pruneUpdateCache() {
  const dir = updateDownloadDir()
  let names = []
  try { names = fs.readdirSync(dir) } catch { return }
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
  for (const name of names) {
    if (!/\.(exe|part|sha256)$/iu.test(name)) continue
    const file = path.join(dir, name)
    if (file === updateState.file) continue
    try {
      const stale = fs.statSync(file).mtimeMs < cutoff
      if (stale || name.includes(app.getVersion())) {
        fs.rmSync(file, { force: true })
        log(`update: pruned cached ${name}${stale ? ' (older than 7 days)' : ''}`)
      }
    } catch { /* locked or already gone */ }
  }
}

/* ------------------------------------------------------------ E2E verdict */

let e2eSettled = false
function settleE2E(pass, extra) {
  if (e2eSettled) return
  e2eSettled = true
  log(`E2E: ${pass ? 'PASS' : 'FAIL'} ${extra}`)
  stopBackend()
  setTimeout(() => app.exit(pass ? 0 : 1), 250)
}

/** Watch one window's navigation to the real GUI page and report the verdict. */
function armE2E(win) {
  const wc = win.webContents
  const onFinish = () => {
    const url = wc.getURL()
    if (url.startsWith('http://127.0.0.1:')) settleE2E(true, `page ${url.split('?')[0]}`)
  }
  const onFail = (_event, code, description, failedUrl) => {
    if (String(failedUrl).startsWith('http://127.0.0.1:')) {
      settleE2E(false, `load failed (${code} ${description})`)
    }
  }
  wc.once('did-finish-load', onFinish)
  wc.once('did-fail-load', onFail)
}

function showMainOrStart() {
  if (provisioning) {
    ensureProvisionWindow()
    return
  }
  const url = backend && backend.url
  if (url) {
    openMainWindow(url)
    return
  }
  const forcedProvision = !NONINTERACTIVE && process.env.DSH_DESKTOP_FORCE_PROVISION === '1'
  const repoError = validateRepo(settings())
  if (repoError !== null || forcedProvision) {
    if (NONINTERACTIVE) {
      log(`repo unavailable: ${repoError}`)
      return
    }
    const reason = forcedProvision ? `DSH_DESKTOP_FORCE_PROVISION (${uiT().t('picker.reasonForced')})` : repoError
    log(`no usable repo: ${reason}`)
    // A user-configured repo that is merely incomplete (missing deps/build)
    // keeps the legacy directory picker; only when no repo hint exists at all
    // does the first-run auto-install wizard take over.
    const anyRepoHint = effectiveRepoPath(settings()) !== null
    if (forcedProvision || !anyRepoHint) startProvisioningFlow(reason)
    else pickRepoAndStart(reason)
    return
  }
  showLoadingWindow(uiT().t('loading.boot'))
  ensureBackend().then((readyUrl) => {
    openMainWindow(readyUrl)
  }).catch((error) => {
    state = 'stopped'
    const message = String(error && error.message ? error.message : error)
    if (NONINTERACTIVE) {
      log(`start failed: ${message}`)
      return
    }
    const t = uiT().t
    const choice = dialog.showMessageBoxSync(mainWindow ?? undefined, {
      type: 'error',
      title: APP_NAME,
      message: t('failStart.title'),
      detail: message,
      buttons: [t('failStart.openLogs'), t('failStart.close')],
      defaultId: 0,
      cancelId: 1,
    })
    if (choice === 0) shell.openPath(LOG_DIR)
  })
}

/**
 * First-run repository selection: loop a directory picker until the user
 * chooses a valid deepseek-harness checkout or quits.
 * @param reason - why the current configuration cannot boot.
 */
function pickRepoAndStart(reason) {
  const t = () => uiT().t
  const ask = () => {
    const proceed = dialog.showMessageBoxSync(mainWindow ?? undefined, {
      type: 'warning',
      title: APP_NAME,
      message: t()('picker.title'),
      detail: t()('picker.detail', reason),
      buttons: [t()('picker.choose'), t()('picker.quit')],
      defaultId: 0,
      cancelId: 1,
    })
    return proceed === 0
  }
  if (!ask()) { stopBackend(); app.exit(0); return }
  const picked = dialog.showOpenDialogSync(mainWindow ?? undefined, {
    title: t()('picker.windowTitle'),
    properties: ['openDirectory'],
    defaultPath: os.homedir(),
  })
  if (!picked || picked.length === 0) { stopBackend(); app.exit(0); return }
  const repoPath = picked[0]
  const probe = path.join(repoPath, 'apps', 'cli', 'src', 'bin.ts')
  if (!fs.existsSync(probe)) {
    const retry = dialog.showMessageBoxSync(mainWindow ?? undefined, {
      type: 'error',
      title: APP_NAME,
      message: t()('picker.notRepo'),
      detail: t()('picker.badDetail', repoPath),
      buttons: [t()('picker.retry'), t()('picker.quit')],
      defaultId: 0,
      cancelId: 1,
    })
    if (retry === 0) { pickRepoAndStart(t()('picker.reasonNotRepo')); return }
    stopBackend()
    app.exit(0)
    return
  }
  log(`first-run repo picked: ${repoPath}`)
  saveSettings({ repoPath })
  showMainOrStart()
}

function loadingHtml(text) {
  const hint = uiT().t('loading.hint')
  const lang = uiT().lang === 'zh' ? 'zh-CN' : 'en'
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><style>
    body { margin: 0; height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center;
           background: #0d1526; color: #dbe4f5; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; gap: 18px; }
    .spinner { width: 42px; height: 42px; border-radius: 50%;
               border: 4px solid #26334d; border-top-color: #4d6bfe; animation: spin 0.9s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    p { font-size: 15px; margin: 0; }
    small { color: #7d8db0; font-size: 12px; }
  </style></head><body>
    <div class="spinner"></div><p>${text}</p>
    <small>${hint}</small>
  </body></html>`
}

/* ------------------------------------------------------------------ tray */

function buildTrayMenu() {
  const cfg = settings()
  const t = uiT().t
  const updatePending = updateState.phase === 'available' || updateState.phase === 'ready'
  return Menu.buildFromTemplate([
    { label: t('tray.openMain'), click: () => showMainOrStart() },
    { label: t('tray.openBrowser'), enabled: !!(backend && backend.url), click: () => {
      if (backend && backend.url) shell.openExternal(backend.url)
    } },
    { type: 'separator' },
    ...(updatePending
      ? [{ label: t('tray.updateAvailable', updateState.latest), click: () => openUpdateWindow('tray') }]
      : []),
    { label: t('tray.checkUpdate'), click: () => openUpdateWindow('tray') },
    { label: t('tray.updateAuto'), type: 'checkbox', checked: cfg.checkUpdates !== false, click: (item) => {
      saveSettings({ checkUpdates: item.checked })
      refreshTrayMenu()
    } },
    { type: 'separator' },
    { label: t('tray.restartService'), click: () => restartBackend() },
    { label: t('tray.autostart'), type: 'checkbox', checked: cfg.autoStart, click: (item) => {
      saveSettings({ autoStart: item.checked })
      applyAutoStart()
    } },
    { label: t('tray.closeToTray'), type: 'checkbox', checked: cfg.closeToTray, click: (item) => {
      saveSettings({ closeToTray: item.checked })
    } },
    { type: 'separator' },
    { label: t('tray.language'), submenu: [
      { label: t('tray.langAuto'), type: 'radio', checked: (cfg.language || 'auto') === 'auto', click: () => {
        saveSettings({ language: 'auto' })
        refreshTrayMenu()
      } },
      { label: t('tray.langZh'), type: 'radio', checked: cfg.language === 'zh', click: () => {
        saveSettings({ language: 'zh' })
        refreshTrayMenu()
      } },
      { label: t('tray.langEn'), type: 'radio', checked: cfg.language === 'en', click: () => {
        saveSettings({ language: 'en' })
        refreshTrayMenu()
      } },
    ] },
    { type: 'separator' },
    { label: t('tray.openLogs'), click: () => shell.openPath(LOG_DIR) },
    { label: t('tray.quit'), click: () => quitApp() },
  ])
}

function createTray() {
  const icon = appIcon()
  tray = new Tray(icon ? icon : nativeImage.createEmpty())
  tray.setToolTip(APP_NAME)
  tray.setContextMenu(buildTrayMenu())
  tray.on('click', () => showMainOrStart())
}

function refreshTrayMenu() {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(buildTrayMenu())
}

/* ---------------------------------------------------------------- control */

function applyAutoStart() {
  try {
    app.setLoginItemSettings({
      openAtLogin: settings().autoStart,
      path: process.execPath,
      args: [APP_DIR, '--hidden'],
    })
  } catch (error) {
    log(`setLoginItemSettings failed: ${String(error)}`)
  }
}

function quitApp() {
  if (isQuitting) return
  isQuitting = true
  refreshTrayMenu()
  cancelProvision()
  cancelUpdateDownload()
  stopBackend()
  log('quitting')
  setTimeout(() => app.exit(0), SHUTDOWN_GRACE_MS).unref()
  try { app.quit() } catch { app.exit(0) }
}

/* ------------------------------------------------------------ app events */

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (app.isReady()) showMainOrStart()
    else app.whenReady().then(showMainOrStart)
  })

  app.whenReady().then(() => {
    log(`app ready: version=${app.getVersion()} smoke=${SMOKE_MODE} e2e=${E2E_MODE} probe=${PROBE_MODE} hidden=${HIDDEN_MODE} portable=${RUNNING_PORTABLE}`)
    app.setAppUserModelId('ai.deepseek.dsh.desktop')
    app.setName(APP_NAME)

    if (!SMOKE_MODE && !UPDATE_PROBE_MODE && fs.existsSync(ICON_PATH)) createTray()
    applyAutoStart()
    pruneUpdateCache()
    scheduleStartupUpdateCheck()

    // Start-at-login bridge consumed by the Settings → General row in the GUI.
    // Only the GUI window carries the preload, so any other sender is ignored.
    if (!SMOKE_MODE) {
      ipcMain.handle('dsh-desktop:auto-start:get', (event) => {
        if (event.sender !== mainWindow?.webContents) return false
        return settings().autoStart
      })
      ipcMain.handle('dsh-desktop:auto-start:set', (event, enabled) => {
        if (event.sender !== mainWindow?.webContents) return settings().autoStart
        saveSettings({ autoStart: enabled === true })
        applyAutoStart()
        refreshTrayMenu()
        return settings().autoStart
      })

      // Runtime-provisioning bridge consumed by the provision wizard page.
      const provisionSenderOk = (event) => event.sender === mainWindow?.webContents
      ipcMain.handle(`${PROVISION_IPC}:get-meta`, (event) => {
        if (!provisionSenderOk(event)) return null
        const manifest = loadManifest()
        return {
          runtimeDir: runtimeDir(),
          mirrorMode: settings().mirrorMode || 'auto',
          autoProvision: settings().autoProvision !== false,
          language: uiLanguageCode(),
          node: (manifest.node && manifest.node.version) || '',
          pnpm: (manifest.pnpm && manifest.pnpm.version) || '',
          dshRef: settings().dshRef || (manifest.dsh && manifest.dsh.ref) || '',
          currentRepo: settings().repoPath || '',
          currentNode: settings().nodePath || '',
          appVersion: app.getVersion(),
        }
      })
      ipcMain.handle(`${PROVISION_IPC}:get-state`, (event) => {
        if (!provisionSenderOk(event)) return null
        return provisionSnapshot()
      })
      ipcMain.handle(`${PROVISION_IPC}:start`, (event) => {
        if (!provisionSenderOk(event)) return provisionSnapshot()
        const snap = provisionSnapshot()
        if (snap.running) return snap
        provisioning = true
        log('provisioning started from wizard')
        return beginProvision()
      })
      ipcMain.handle(`${PROVISION_IPC}:cancel`, (event) => {
        if (!provisionSenderOk(event)) return provisionSnapshot()
        log('provisioning cancelled from wizard')
        cancelProvision()
        return provisionSnapshot()
      })
      ipcMain.handle(`${PROVISION_IPC}:choose-repo`, (event) => {
        if (!provisionSenderOk(event)) return
        if (provisionSnapshot().running) return
        provisioning = false
        pickRepoAndStart(uiT().t('picker.reasonNone'))
      })
      ipcMain.handle(`${PROVISION_IPC}:quit`, (event) => {
        if (!provisionSenderOk(event)) return
        quitApp()
      })
      ipcMain.handle(`${PROVISION_IPC}:set-mirror-mode`, (event, mode) => {
        if (!provisionSenderOk(event)) return settings().mirrorMode
        if (['auto', 'cn', 'direct'].includes(mode)) saveSettings({ mirrorMode: mode })
        return settings().mirrorMode
      })

      // Self-update bridge consumed by the update window only.
      const updateSenderOk = (event) => Boolean(updateWindow) && event.sender === updateWindow.webContents
      ipcMain.handle(`${UPDATE_IPC}:get-meta`, (event) => {
        if (!updateSenderOk(event)) return null
        return {
          language: uiLanguageCode(),
          repo: settings().updateRepo || DEFAULT_UPDATE_REPO,
          autoStart: false, // main decides when to check (tray/dialog/startup)
          state: updateSnapshot(),
        }
      })
      ipcMain.handle(`${UPDATE_IPC}:get-state`, (event) => (updateSenderOk(event) ? updateSnapshot() : null))
      ipcMain.handle(`${UPDATE_IPC}:check`, (event) => {
        if (!updateSenderOk(event)) return null
        return checkUpdates('window')
      })
      ipcMain.handle(`${UPDATE_IPC}:download`, (event) => {
        if (!updateSenderOk(event)) return null
        return startUpdateDownload()
      })
      ipcMain.handle(`${UPDATE_IPC}:cancel`, (event) => {
        if (!updateSenderOk(event)) return null
        return cancelUpdateDownload()
      })
      ipcMain.handle(`${UPDATE_IPC}:install`, (event) => {
        if (!updateSenderOk(event)) return null
        return installUpdate()
      })
      ipcMain.handle(`${UPDATE_IPC}:skip`, (event) => {
        if (!updateSenderOk(event)) return null
        if (updateState.latest) {
          saveSettings({ skipVersion: updateState.latest })
          log(`update: skipped ${updateState.latest} from the update window`)
        }
        refreshTrayMenu()
        return pushUpdateState()
      })
      ipcMain.handle(`${UPDATE_IPC}:open-release-page`, (event) => {
        if (!updateSenderOk(event)) return
        const url = updateState.releaseUrl || updateSnapshot().releaseUrl
        if (url) shell.openExternal(url)
      })
      ipcMain.handle(`${UPDATE_IPC}:reveal-file`, (event) => {
        if (!updateSenderOk(event)) return
        if (updateState.file && fs.existsSync(updateState.file)) shell.showItemInFolder(updateState.file)
      })
      ipcMain.handle(`${UPDATE_IPC}:open-runtime-wizard`, (event) => {
        if (!updateSenderOk(event)) return
        log('update: opening the runtime wizard from the update window')
        if (updateWindow && !updateWindow.isDestroyed()) updateWindow.close()
        startProvisioningFlow('runtime update')
      })
      ipcMain.handle(`${UPDATE_IPC}:close`, (event) => {
        if (!updateSenderOk(event)) return
        if (updateWindow && !updateWindow.isDestroyed()) updateWindow.close()
      })
      ipcMain.handle(`${UPDATE_IPC}:set-options`, (event, patch) => {
        if (!updateSenderOk(event)) return null
        const next = {}
        if (patch && typeof patch === 'object') {
          if (typeof patch.autoCheck === 'boolean') next.checkUpdates = patch.autoCheck
          if (typeof patch.includePrerelease === 'boolean') next.updateIncludePrerelease = patch.includePrerelease
          if (typeof patch.mirror === 'string') next.updateMirror = patch.mirror.trim()
        }
        if (Object.keys(next).length > 0) {
          saveSettings(next)
          log(`update: options ${JSON.stringify(next)}`)
          refreshTrayMenu()
        }
        return pushUpdateState()
      })
    }

    if (SMOKE_MODE) {
      runSmoke().then((code) => { app.exit(code) })
      return
    }
    if (UPDATE_PROBE_MODE) {
      runUpdateProbe()
      return
    }
    if (E2E_MODE) {
      // Global backstop: the per-window verdict hooks in loadGuiUrl() settle first.
      setTimeout(() => settleE2E(false, 'timed out waiting for the GUI page'), 120_000)
    }
    if (PROBE_MODE) {
      setTimeout(() => {
        log('PROBE: timed out')
        stopBackend()
        app.exit(1)
      }, 120_000)
    }

    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen'].includes(permission))
    })

    // Register menu accelerators for convenience even though the menu bar is hidden.
    const amT = uiT().t
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: amT('appMenu.app'), submenu: [
        { label: amT('appMenu.reload'), accelerator: 'CmdOrCtrl+R', click: () => { mainWindow && mainWindow.webContents.reload() } },
        { label: amT('appMenu.devtools'), accelerator: 'F12', click: () => { mainWindow && mainWindow.webContents.toggleDevTools() } },
        { type: 'separator' },
        { label: amT('appMenu.checkUpdate'), click: () => openUpdateWindow('menu') },
        { type: 'separator' },
        { label: amT('dialog.exit'), accelerator: 'CmdOrCtrl+Q', click: () => quitApp() },
      ]},
    ]))

    if (HIDDEN_MODE) {
      // Autostart at login: stay in the tray and warm the backend.
      ensureBackend().catch((error) => {
        log(`autostart backend failed: ${String(error && error.message ? error.message : error)}`)
        state = 'stopped'
        if (tray) tray.displayBalloon({ title: APP_NAME, content: uiT().t('balloon.autostartFailed') })
      })
      refreshTrayMenu()
      return
    }

    showMainOrStart()
    if (PROBE_MODE) runProbe()
  })

  app.on('window-all-closed', () => {
    // Keep the app alive in the tray; quit only through the tray menu.
    if (!isQuitting && !mainWindow) { /* tray keeps us alive */ }
  })

  app.on('before-quit', () => {
    isQuitting = true
    cancelProvision()
    stopBackend()
  })

  app.on('activate', () => {
    if (app.isReady()) showMainOrStart()
    else app.whenReady().then(showMainOrStart)
  })
}

/**
 * Windowed UI probe (`npm run probe`): boot the backend, open the real GUI,
 * open Settings → General through the DOM, and report whether the
 * start-at-login row rendered from the desktop bridge. Exits 0 on success.
 */
function runProbe() {
  const started = Date.now()
  log('PROBE: starting')
  const step = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
  const run = async () => {
    let win = null
    for (let i = 0; i < 240; i++) {
      win = mainWindow
      if (win && !win.isDestroyed()) {
        const url = win.webContents.getURL()
        if (url.startsWith('http://127.0.0.1:') && !win.webContents.isLoading()) break
      }
      await step(250)
    }
    if (!win || win.isDestroyed()) throw new Error('no main window')
    // Client boot can take a while on first paint; poll until the sidebar's
    // Settings trigger exists (or the page settles into another state).
    await step(2500)
    const script = [
      '(async () => {',
      '  const wait = ms => new Promise(r => setTimeout(r, ms))',
      '  const labelOf = el => ((el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title"))) || (el.textContent || "")).trim()',
      '  const keys = Object.keys(window).filter(k => /dsh|electron|desktop/i.test(k))',
      '  const diag = () => ({ href: location.href, title: document.title, root: !!document.getElementById("root"), keys, body: (document.body ? document.body.textContent : "").replace(/\\s+/g, " ").slice(0, 500) })',
      '  const hasBridge = typeof window.__dshDesktopShell !== "undefined"',
      '  let state = "no-bridge"',
      '  if (hasBridge) { try { state = String(await window.__dshDesktopShell.getAutoStart()) } catch (e) { state = "get-failed:" + e.message } }',
      '  const findClickable = (needle) => {',
      '    const nodes = [...document.querySelectorAll("button,[role=button],[role=tab],li,[aria-selected]")]',
      '    const hit = nodes.find(n => labelOf(n).includes(needle) || (n.getAttribute && (n.getAttribute("aria-label") || "").includes(needle)))',
      '    return hit || null',
      '  }',
      '  let settings = null',
      '  for (let i = 0; i < 120 && !settings; i++) { settings = findClickable("设置") || findClickable("Settings"); if (!settings) await wait(500) }',
      '  if (!settings) return { hasBridge, state, settings: "not-found", row: null, diag: diag() }',
      '  settings.click()',
      '  await wait(1500)',
      '  const general = findClickable("通用设置") || findClickable("General")',
      '  if (general && general !== settings) { general.click(); await wait(1200) }',
      '  let auto = null',
      '  for (let i = 0; i < 40 && !auto; i++) {',
      '    const switches = [...document.querySelectorAll("[role=switch]")]',
      '    auto = switches.find(s => /自启|Start at login/i.test((s.getAttribute("aria-label") || "") + (s.textContent || ""))) || null',
      '    if (!auto) await wait(500)',
      '  }',
      '  return { hasBridge, state, settings: "opened", row: auto ? { checked: auto.getAttribute("aria-checked"), label: auto.getAttribute("aria-label") } : null, switches: document.querySelectorAll("[role=switch]").length, diag: diag() }',
      '})()',
    ].join('\n')
    const result = await win.webContents.executeJavaScript(script)
    log('PROBE: result=' + JSON.stringify(result))
    const ok = result && result.hasBridge === true && result.row !== null
    if (ok && process.env.DSH_PROBE_TOGGLE === '1') {
      // Exercise the write path: click the switch twice and read it back.
      const toggle = await win.webContents.executeJavaScript([
        '(async () => {',
        '  const wait = ms => new Promise(r => setTimeout(r, ms))',
        '  const sw = [...document.querySelectorAll("[role=switch]")].find(s => /自启|Start at login/i.test((s.getAttribute("aria-label") || "") + (s.textContent || "")))',
        '  if (!sw) return { clicked: false }',
        '  sw.click()',
        '  await wait(1200)',
        '  const off = { checked: sw.getAttribute("aria-checked"), readback: String(await window.__dshDesktopShell.getAutoStart()) }',
        '  sw.click()',
        '  await wait(1200)',
        '  const on = { checked: sw.getAttribute("aria-checked"), readback: String(await window.__dshDesktopShell.getAutoStart()) }',
        '  return { clicked: true, off, on }',
        '})()',
      ].join('\n'))
      log('PROBE: toggle=' + JSON.stringify(toggle))
    }
    log(`PROBE: ${ok ? 'PASS' : 'FAIL'} (${Date.now() - started} ms)`)
    stopBackend()
    setTimeout(() => app.exit(ok ? 0 : 1), 250)
  }
  run().catch((error) => {
    log(`PROBE: FAIL ${String(error && error.message ? error.message : error)}`)
    stopBackend()
    setTimeout(() => app.exit(1), 250)
  })
}

/* ---------------------------------------------------------- update probe */

/**
 * Headless-ish verification used by `npm run update:probe`: load update.html
 * in a hidden window, prove the preload bridge answers, run one real release
 * check through the IPC path, and fail on any renderer console error (the
 * page's rendering bugs surface there). No backend is started.
 */
function runUpdateProbe() {
  const started = Date.now()
  log('UPDATE-PROBE: starting')
  const rendererErrors = []
  const win = ensureUpdateWindow()
  win.hide()
  win.webContents.on('console-message', (...args) => {
    const first = args[0]
    if (first && typeof first === 'object' && typeof first.level === 'string') {
      if (first.level === 'error') rendererErrors.push(String(first.message))
      return
    }
    const level = args[1]
    const levelName = typeof level === 'string' ? level : ['verbose', 'info', 'warning', 'error'][Number(level)] || ''
    if (levelName === 'error') rendererErrors.push(String(args[2]))
  })
  const finish = (pass, extra) => {
    log(`UPDATE-PROBE: ${pass ? 'PASS' : 'FAIL'} ${extra} (${Date.now() - started} ms)`)
    setTimeout(() => app.exit(pass ? 0 : 1), 250)
  }
  win.webContents.once('did-finish-load', () => {
    const pageScript = `(async () => {
      const meta = await window.__dshUpdate.getMeta()
      const state = meta && meta.state
      return {
        hasBridge: typeof window.__dshUpdate !== 'undefined',
        language: meta && meta.language,
        repo: meta && meta.repo,
        phase: state && state.phase,
        current: state && state.currentVersion,
        buttons: document.querySelectorAll('button').length,
        note: (document.getElementById('note') || {}).textContent || '',
      }
    })()`
    win.webContents.executeJavaScript(pageScript).then((page) => {
      log(`UPDATE-PROBE: page=${JSON.stringify(page)}`)
      return win.webContents.executeJavaScript(
        'window.__dshUpdate.check().then((s) => ({ phase: s && s.phase, latest: s && s.latest, error: s && s.error }))'
      ).then((checked) => {
        log(`UPDATE-PROBE: check=${JSON.stringify(checked)}`)
        const ok = Boolean(
          page && page.hasBridge === true
          && page.buttons >= 6
          && page.language
          && ['none', 'current', 'available', 'error'].includes(checked && checked.phase)
          && rendererErrors.length === 0
        )
        finish(ok, `errors=${JSON.stringify(rendererErrors)}`)
      })
    }).catch((error) => finish(false, String(error && error.message ? error.message : error)))
  })
}

/* ---------------------------------------------------------------- smoke */

/**
 * Headless verification used by `npm run smoke`: boot the real backend, wait
 * for the authenticated URL line, prove the page answers over HTTP, then stop
 * the backend and exit. No window or tray appears.
 */
function runSmoke() {
  const started = Date.now()
  log('SMOKE: starting')
  return ensureBackend().then((url) => {
    log(`SMOKE: ready in ${Date.now() - started} ms at ${url}`)
    const nodePath = resolveNodePath(settings())
    const probe = spawn(nodePath, ['-e', `
      fetch(process.argv[1], { signal: AbortSignal.timeout(10_000) })
        .then((res) => { console.log('status=' + res.status); process.exit(res.status < 500 ? 0 : 1) })
        .catch((err) => { console.error(String(err)); process.exit(1) })
    `, '--', url], { stdio: 'inherit' })
    return new Promise((resolve) => {
      probe.on('exit', (code) => {
        stopBackend()
        log(`SMOKE: probe exit=${code}`)
        resolve(code === 0 ? 0 : 1)
      })
    })
  }).catch((error) => {
    log(`SMOKE: failed ${String(error && error.message ? error.message : error)}`)
    stopBackend()
    return 1
  })
}
