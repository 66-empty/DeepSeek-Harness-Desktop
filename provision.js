/**
 * DSH runtime provisioning engine (pure Node, no Electron import).
 *
 * Installs everything a regular user needs to run the DeepSeek Harness Web
 * GUI into one self-contained directory under the app's userData folder:
 *
 *   1. a portable Node.js (downloaded from the official dist or a mirror),
 *   2. the deepseek-harness checkout at a pinned git ref (GitHub archive zip,
 *      optionally via a GitHub proxy mirror),
 *   3. pnpm (installed into the portable Node), then `pnpm install`, then
 *      `pnpm run build` inside the checkout.
 *
 * The engine is idempotent: every step probes its own success marker and
 * resumes after interruptions (a cancelled or crashed run simply re-runs the
 * unfinished steps; downloads resume from the partial file when the server
 * supports ranges). Nothing here talks to Electron; `main.js` drives it and
 * forwards events to the wizard window.
 *
 * External sources are picked from an ordered candidate chain decided by the
 * mirror mode: 'direct' (official sources only), 'cn' (Chinese mirrors and
 * GitHub proxies first), 'auto' (probe reachability once: 'cn' when the
 * npmmirror registry answers, otherwise 'direct'). Every candidate URL may
 * also be a `file://` URL or a plain local path, which keeps the engine fully
 * testable offline.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const http = require('node:http')
const https = require('node:https')
const { spawn, spawnSync } = require('node:child_process')

const ENGINE_VERSION = 1
/** Minimum Node accepted by the harness repo: "^22.19.0 || >=24.0.0". */
const NODE_MIN = [22, 19, 0]
const DEFAULT_PROXIES = ['https://ghfast.top', 'https://gh-proxy.com']
const DEFAULT_NODE_MIRROR = 'https://npmmirror.com'
const CONNECT_TIMEOUT_MS = 15_000
const STALL_TIMEOUT_MS = 60_000
const MAX_REDIRECTS = 5

class ProvisionError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'ProvisionError'
    this.code = code || 'provision'
  }
}

class CancelledError extends Error {
  constructor() {
    super('已取消')
    this.name = 'CancelledError'
  }
}

/* ------------------------------------------------------------ small utils */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

function sha256File(file) {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(1024 * 1024)
    let read = 0
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, read))
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

function cmpVersion(a, b) {
  const toParts = (v) => {
    if (Array.isArray(v)) return v.map((n) => parseInt(n, 10) || 0)
    return String(v).split('.').map((n) => parseInt(n, 10) || 0)
  }
  const pa = toParts(a)
  const pb = toParts(b)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1
  }
  return 0
}

/** Harness engines gate: "^22.19.0 || >=24.0.0". */
function atLeastNode(nodeVersion) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(String(nodeVersion).trim())
  if (!m) return false
  const parts = [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)]
  return (parts[0] === 22 && cmpVersion(parts, NODE_MIN) >= 0) || parts[0] >= 24
}

/** Kill a child process tree (Windows taskkill, POSIX fallback). */
function killTree(proc) {
  if (!proc || proc.exitCode !== null) return
  const pid = proc.pid
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 8_000 })
    } else {
      try { process.kill(-pid, 'SIGKILL') } catch { proc.kill('SIGKILL') }
    }
  } catch { /* best effort */ }
}

/* ------------------------------------------------- mirror URL transforms */

/** nodejs.org dist URL → npmmirror mirrors/node URL. */
function nodeMirrorUrlOf(url, mirrorBase) {
  const base = String(mirrorBase || '').replace(/\/+$/u, '')
  const m = /^https:\/\/nodejs\.org\/dist\/(.+)$/u.exec(url)
  if (!m || !/npmmirror\.com/u.test(base)) return null
  return `${base}/mirrors/node/${m[1]}`
}

/** GitHub URL behind a proxy host that prefixes the full URL as a path. */
function githubProxyUrlOf(url, proxy) {
  const p = String(proxy || '').replace(/\/+$/u, '')
  if (!/^https?:\/\//u.test(url) || !p) return null
  return `${p}/${url}`
}

function isRemoteUrl(u) {
  return /^https?:\/\//u.test(u)
}

/* --------------------------------------------------------------- requests */

/**
 * One HTTP(S) request. Follows redirects. Accepts `file://` URLs and plain
 * local paths (used by tests and offline mirror configs).
 */
function request(opts) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(opts.url)
    } catch {
      u = null
    }
    if (!u || u.protocol === 'file:') {
      let file = u ? decodeURIComponent(u.pathname) : path.resolve(opts.url)
      // Windows drive-letter file URLs parse as "/C:/…"; drop the leading "/".
      if (process.platform === 'win32' && /^\/[A-Za-z]:\//u.test(file)) file = file.slice(1)
      let stat
      try { stat = fs.statSync(file) } catch {
        reject(new ProvisionError(`本地文件不存在:${file}`, 'source'))
        return
      }
      let start = 0
      if (opts.headers && opts.headers.Range) {
        const m = /bytes=(\d+)-/u.exec(opts.headers.Range)
        if (m) start = Math.max(0, Math.min(Number(m[1]) || 0, stat.size))
      }
      resolve({
        status: start > 0 ? 206 : 200,
        headers: { 'content-length': String(stat.size - start) },
        body: fs.createReadStream(file, { start }),
      })
      return
    }
    const lib = u.protocol === 'https:' ? https : http
    const req = lib.request(u, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
    }, (res) => {
      const code = res.statusCode || 0
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume()
        if ((opts.redirects || 0) >= (opts.maxRedirects ?? MAX_REDIRECTS)) {
          reject(new ProvisionError('重定向次数过多', 'http'))
          return
        }
        const next = new URL(res.headers.location, u).toString()
        request({ ...opts, url: next, redirects: (opts.redirects || 0) + 1 })
          .then(resolve, reject)
        return
      }
      resolve({ status: code, headers: res.headers, body: res })
    })
    req.setTimeout(opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS, () => {
      req.destroy(new ProvisionError(`连接超时:${opts.url}`, 'timeout'))
    })
    req.on('error', (err) => {
      reject(err instanceof ProvisionError ? err : new ProvisionError(`网络错误:${err.message}`, 'network'))
    })
    req.end()
  })
}

/** Probe reachability of a URL (used by mirror mode 'auto'). */
function probe(url, timeoutMs) {
  return new Promise((resolvePromise) => {
    let done = false
    const finish = (ok) => { if (!done) { done = true; resolvePromise(ok) } }
    request({ url, method: 'GET', connectTimeoutMs: timeoutMs, maxRedirects: 3 })
      .then((res) => {
        try { res.body.resume() } catch { /* ignore */ }
        finish(res.status >= 200 && res.status < 500)
      })
      .catch(() => finish(false))
    setTimeout(() => finish(false), (timeoutMs || 6000) + 2000)
  })
}

/**
 * Download one file (with resume via Range when a partial file exists). On
 * sha mismatch the partial file is removed and the download starts over once.
 */
async function downloadOne({ url, dest, sha256, label, signal, onProgress }) {
  const part = `${dest}.part`
  let startBytes = 0
  try { startBytes = fs.statSync(part).size } catch { /* no partial yet */ }
  const headers = startBytes > 0 ? { Range: `bytes=${startBytes}-` } : {}
  let res
  try {
    res = await request({ url, headers })
  } catch (err) {
    if (startBytes > 0) {
      try { fs.rmSync(part, { force: true }) } catch { /* ignore */ }
      res = await request({ url })
    } else {
      throw err
    }
  }
  if (res.status === 416) {
    try { fs.rmSync(part, { force: true }) } catch { /* ignore */ }
    startBytes = 0
    res = await request({ url })
  }
  if (res.status !== 200 && res.status !== 206) {
    try { res.body.resume() } catch { /* ignore */ }
    throw new ProvisionError(`${label || '下载'}失败:HTTP ${res.status}(${url})`, 'http')
  }
  const resumed = res.status === 206 ? startBytes : 0
  const total = (parseInt(res.headers['content-length'] || '0', 10) || 0) + resumed
  fs.mkdirSync(path.dirname(part), { recursive: true })
  const out = fs.createWriteStream(part, { flags: resumed > 0 ? 'a' : 'w' })
  const hash = crypto.createHash('sha256')
  let written = resumed
  let lastEmit = 0
  let lastChunk = Date.now()
  const stall = setInterval(() => {
    if (Date.now() - lastChunk > STALL_TIMEOUT_MS) {
      out.destroy(new ProvisionError(`${label || '下载'}停滞超过 ${STALL_TIMEOUT_MS / 1000} 秒`, 'stall'))
    }
  }, 10_000)
  await new Promise((resolvePromise, rejectPromise) => {
    const fail = (err) => {
      clearInterval(stall)
      try { out.destroy() } catch { /* ignore */ }
      try { if (res.body.destroy) res.body.destroy(); else res.body.resume() } catch { /* ignore */ }
      rejectPromise(err instanceof ProvisionError ? err : new ProvisionError(`下载失败:${err.message}`, 'network'))
    }
    out.on('error', fail)
    res.body.on('error', fail)
    res.body.on('data', (chunk) => {
      if (signal && signal.cancelled) { fail(new CancelledError()); return }
      lastChunk = Date.now()
      hash.update(chunk)
      written += chunk.length
      if (!out.write(chunk)) res.body.pause()
      const now = Date.now()
      if (now - lastEmit > 250) {
        lastEmit = now
        if (onProgress) onProgress(written, total || 0)
      }
    })
    out.on('drain', () => { try { res.body.resume() } catch { /* ignore */ } })
    res.body.on('end', () => { clearInterval(stall); out.end() })
    out.on('finish', () => {
      if (onProgress) onProgress(written, total || 0)
      resolvePromise()
    })
  })
  if (sha256) {
    const actual = sha256File(part)
    if (actual.toLowerCase() !== sha256.toLowerCase()) {
      fs.rmSync(part, { force: true })
      throw new ProvisionError(
        `${label || '文件'}校验和不匹配(期望 ${sha256.slice(0, 12)}…,实际 ${actual.slice(0, 12)}…)`,
        'sha'
      )
    }
  }
  fs.renameSync(part, dest)
  return written
}

/** Try candidate URLs in order until one succeeds. sha mismatches abort. */
async function downloadCandidates(candidates, opts) {
  let lastErr = null
  for (const url of candidates) {
    if (opts.signal && opts.signal.cancelled) throw new CancelledError()
    try {
      await downloadOne({ ...opts, url })
      return
    } catch (err) {
      if (err instanceof CancelledError) throw err
      if (err instanceof ProvisionError && err.code === 'sha') throw err
      lastErr = err
      if (opts.log) opts.log(`${opts.label || '下载'}源不可用,换下一个源:${err.message}`)
    }
  }
  throw lastErr || new ProvisionError('没有可用的下载源', 'source')
}

/* -------------------------------------------------------------- extraction */

/** Extract a zip with tar.exe (Windows bsdtar); falls back to `tar`. */
function extractZip(zipFile, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  const tar = process.platform === 'win32' && fs.existsSync('C:\\Windows\\System32\\tar.exe')
    ? 'C:\\Windows\\System32\\tar.exe'
    : 'tar'
  const res = spawnSync(tar, ['-xf', zipFile, '-C', destDir], { stdio: 'pipe', timeout: 10 * 60_000, encoding: 'utf8' })
  if (res.status !== 0 || res.error) {
    throw new ProvisionError(
      `解压失败(${res.error ? res.error.message : res.stderr || `tar 退出码 ${res.status}`}):${path.basename(zipFile)}`,
      'extract'
    )
  }
}

/**
 * Pure-Node zip extractor (store + deflate). Windows tar.exe cannot create
 * symlinks without admin rights / Developer Mode, which fails whole archives
 * that contain symlink entries (deepseek-harness ships CLAUDE.md → AGENTS.md
 * links). This extractor needs no privileges and handles long paths (Node
 * runs long-path aware): symlink entries degrade to empty placeholders —
 * harmless for source trees, and prebuilt packs rebuild their aliases from
 * pack.json afterwards anyway.
 */
function extractZipNode(zipFile, destDir) {
  const fd = fs.openSync(zipFile, 'r')
  const readAt = (pos, len) => {
    const buf = Buffer.alloc(len)
    let off = 0
    while (off < len) {
      const n = fs.readSync(fd, buf, off, len - off, pos + off)
      if (n <= 0) throw new ProvisionError('zip 数据读取中断', 'extract')
      off += n
    }
    return buf
  }
  try {
    const size = fs.fstatSync(fd).size
    const tailLen = Math.min(size, 65_557)
    const tail = readAt(size - tailLen, tailLen)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
    }
    if (eocd < 0) throw new ProvisionError('不是有效的 zip(找不到中央目录)', 'extract')
    let totalEntries = tail.readUInt16LE(eocd + 10)
    let cdOffset = tail.readUInt32LE(eocd + 16)
    const u64 = (buf, off) => Number(buf.readBigUInt64LE(off))
    if (totalEntries === 0xffff || cdOffset === 0xffffffff) {
      // Zip64: locate the zip64 EOCD record through the locator that sits
      // 20 bytes before the classic EOCD.
      const locPos = size - tailLen + eocd - 20
      if (locPos < 0) throw new ProvisionError('zip64 定位记录缺失', 'extract')
      const loc = readAt(locPos, 20)
      if (loc.readUInt32LE(0) !== 0x07064b50) throw new ProvisionError('zip64 定位记录损坏', 'extract')
      const z64Pos = u64(loc, 8)
      const z64 = readAt(z64Pos, 56)
      if (z64.readUInt32LE(0) !== 0x06064b50) throw new ProvisionError('zip64 记录损坏', 'extract')
      totalEntries = u64(z64, 32)
      cdOffset = u64(z64, 48)
    }
    fs.mkdirSync(destDir, { recursive: true })
    let pos = cdOffset
    for (let i = 0; i < totalEntries; i++) {
      const h = readAt(pos, 46)
      if (h.readUInt32LE(0) !== 0x02014b50) throw new ProvisionError('zip 中央目录损坏', 'extract')
      const method = h.readUInt16LE(10)
      let compSize = h.readUInt32LE(20)
      let uncompSize = h.readUInt32LE(24)
      const nameLen = h.readUInt16LE(28)
      const extraLen = h.readUInt16LE(30)
      const commentLen = h.readUInt16LE(32)
      const extAttr = h.readUInt32LE(38)
      let localOff = h.readUInt32LE(42)
      const name = readAt(pos + 46, nameLen).toString('utf8')
      // Zip64 per-entry extra field (id 0x0001) carries 8-byte values for
      // whichever of uncompressed/compressed/localOffset/diskStart overflowed.
      if (extraLen > 0) {
        const extra = readAt(pos + 46 + nameLen, extraLen)
        let p = 0
        while (p + 4 <= extra.length) {
          const id = extra.readUInt16LE(p)
          const len = extra.readUInt16LE(p + 2)
          if (id === 0x0001) {
            let q = p + 4
            if (uncompSize === 0xffffffff) { uncompSize = u64(extra, q); q += 8 }
            if (compSize === 0xffffffff) { compSize = u64(extra, q); q += 8 }
            if (localOff === 0xffffffff) { localOff = u64(extra, q); q += 8 }
            break
          }
          p += 4 + len
        }
      }
      pos += 46 + nameLen + extraLen + commentLen
      const unixType = (extAttr >>> 16) & 0xf000
      const isDirEntry = name.endsWith('/') || unixType === 0x4000
      const isLink = unixType === 0xa000
      const clean = name.replace(/\\/gu, '/').replace(/\/+$/u, '')
      const out = path.join(destDir, ...clean.split('/').filter(Boolean))
      if (out !== destDir && !out.startsWith(destDir + path.sep)) throw new ProvisionError('zip 路径越界', 'extract')
      if (isDirEntry) {
        fs.mkdirSync(out, { recursive: true })
        continue
      }
      if (isLink || clean === '') {
        // Symlink (or a bare marker) without a trailing slash: create an
        // empty placeholder — directory symlinks and file symlinks both land
        // here since their name carries no "/". Alias-based layouts repair
        // themselves from pack.json afterwards.
        fs.mkdirSync(path.dirname(out), { recursive: true })
        try { fs.writeFileSync(out, '') } catch { /* keep going */ }
        continue
      }
      fs.mkdirSync(path.dirname(out), { recursive: true })
      const lh = readAt(localOff, 30)
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new ProvisionError('zip 本地头损坏', 'extract')
      const lName = lh.readUInt16LE(26)
      const lExtra = lh.readUInt16LE(28)
      const comp = readAt(localOff + 30 + lName + lExtra, compSize)
      if (method === 0) {
        fs.writeFileSync(out, comp)
      } else if (method === 8) {
        fs.writeFileSync(out, zlib.inflateRawSync(comp))
      } else {
        throw new ProvisionError(`zip 压缩方式 ${method} 暂不支持内置解压`, 'extract')
      }
    }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Extraction chain: tar.exe first (fast), then — whenever tar fails (typical
 * on machines without symlink privileges) — wipe and re-extract with the
 * pure-Node extractor. DSH_FORCE_NODE_UNZIP=1 skips tar entirely (tests).
 */
function extractZipPortable(zipFile, destDir, logFn) {
  fs.mkdirSync(destDir, { recursive: true })
  if (process.env.DSH_FORCE_NODE_UNZIP === '1') {
    extractZipNode(zipFile, destDir)
    return
  }
  try {
    extractZip(zipFile, destDir)
  } catch (err) {
    if (logFn) {
      try { logFn(`tar 解压不可用(${String(err && err.message ? err.message : err).split('\n')[0].slice(0, 180)}),改用内置解压器…`) } catch { /* ignore */ }
    }
    fs.rmSync(destDir, { recursive: true, force: true })
    fs.mkdirSync(destDir, { recursive: true })
    extractZipNode(zipFile, destDir)
  }
}

/**
 * extractSingleTopDir variant that uses the tolerant extraction chain.
 */
function extractSingleTopDirPortable(zipFile, finalDir, logFn) {
  const tmp = fs.mkdtempSync(path.join(path.dirname(zipFile), '.extract-'))
  try {
    extractZipPortable(zipFile, tmp, logFn)
    const entries = fs.readdirSync(tmp)
    let src = tmp
    if (entries.length === 1 && fs.statSync(path.join(tmp, entries[0])).isDirectory()) {
      src = path.join(tmp, entries[0])
    }
    if (fs.existsSync(finalDir)) fs.rmSync(finalDir, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(finalDir), { recursive: true })
    fs.renameSync(src, finalDir)
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

/**
 * Extract a zip whose archive root is a single folder (GitHub archives and
 * Node.js dist archives both behave this way), then relocate that folder to
 * finalDir without predicting its name.
 */
function extractSingleTopDir(zipFile, finalDir) {
  const tmp = fs.mkdtempSync(path.join(path.dirname(zipFile), '.extract-'))
  try {
    extractZip(zipFile, tmp)
    const entries = fs.readdirSync(tmp)
    let src = tmp
    if (entries.length === 1 && fs.statSync(path.join(tmp, entries[0])).isDirectory()) {
      src = path.join(tmp, entries[0])
    }
    if (fs.existsSync(finalDir)) fs.rmSync(finalDir, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(finalDir), { recursive: true })
    fs.renameSync(src, finalDir)
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

/* ---------------------------------------------------------- child process */

/**
 * Spawn a child; with captureLines, stdout+stderr lines are fed to onLine and
 * the last 80 lines are kept for the failure detail. Returns exit code 0 or
 * throws ProvisionError / CancelledError.
 */
function runChild(file, args, opts) {
  const { cwd, env, captureLines, onLine, signal, label } = opts || {}
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(file, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: captureLines ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    })
    const holder = { child }
    let tail = []
    let outBuf = ''
    const feed = (chunk) => {
      outBuf += chunk.toString('utf8')
      let idx
      while ((idx = outBuf.indexOf('\n')) >= 0) {
        const line = outBuf.slice(0, idx).replace(/\r$/u, '').replace(/\u001b\[[0-9;]*m/gu, '').trimEnd()
        outBuf = outBuf.slice(idx + 1)
        if (!line) continue
        tail.push(line)
        if (tail.length > 80) tail.shift()
        if (onLine) onLine(line)
      }
    }
    if (captureLines) {
      child.stdout.on('data', feed)
      child.stderr.on('data', feed)
    }
    const killByCancel = () => killTree(child)
    if (signal && typeof signal.onCancel === 'function') signal.onCancel(killByCancel)
    child.on('error', (err) => {
      rejectPromise(new ProvisionError(`无法启动 ${label || file}:${err.message}`, 'spawn'))
    })
    child.on('exit', (code, sig) => {
      if (signal && signal.cancelled) {
        rejectPromise(new CancelledError())
        return
      }
      if (code === 0) {
        resolvePromise(0)
        return
      }
      const detail = (tail.slice(-15).join('\n') || '(无输出)').slice(-3000)
      rejectPromise(new ProvisionError(`${label || '命令'}失败(退出码 ${code ?? sig})\n${detail}`, 'child'))
    })
  })
}

/* -------------------------------------------------------------- provision */

function createProvisioner(opts) {
  const runtimeDir = opts.runtimeDir
  const emit = opts.emit || (() => {})
  const state = {
    running: false,
    cancelled: false,
    done: false,
    error: null,
    note: '',
    stages: [],
    logs: [],
    result: null,
    planInfo: null,
  }

  const fire = (event) => emit(event)

  const stageState = (id) => state.stages.find((s) => s.id === id) || null

  function trimLogs() {
    if (state.logs.length > 600) state.logs = state.logs.slice(-600)
  }

  async function beginStage(id, title, skipReason) {
    let s = stageState(id)
    if (!s) {
      s = { id, title, status: skipReason ? 'skipped' : 'running', skipReason: skipReason || '', note: '' }
      state.stages.push(s)
    } else {
      s.status = skipReason ? 'skipped' : 'running'
      s.skipReason = skipReason || ''
      s.note = ''
    }
    state.logs.push(`→ ${title}${skipReason ? `(${skipReason})` : ''}`)
    trimLogs()
    fire({ type: 'stage', stage: { ...s } })
  }

  async function endStage(id, ok, noteText) {
    const s = stageState(id)
    if (s) {
      s.status = ok ? 'done' : 'error'
      s.note = noteText || ''
    }
    if (ok && noteText) state.logs.push(`✓ ${noteText}`)
    trimLogs()
    fire({ type: 'stage', stage: s ? { ...s } : null })
  }

  function note(text) {
    state.note = text || ''
    fire({ type: 'note', text: state.note })
  }

  function pushLog(text) {
    state.logs.push(String(text))
    trimLogs()
    fire({ type: 'log', text: String(text) })
  }

  function throwIfCancelled() {
    if (state.cancelled) throw new CancelledError()
  }

  async function resolvePlan(cfg) {
    const manifest = cfg.manifest
    const dshRef = cfg.dshRef || (manifest.dsh && manifest.dsh.ref) || 'runtime'
    const dshUrl = manifest.dsh && manifest.dsh.url
    const nodeUrl = manifest.node && manifest.node.url
    const nodeMirror = cfg.nodeMirrorBase || DEFAULT_NODE_MIRROR
    const registryOfficial = manifest.registry
    const registryMirror = cfg.registryMirror || manifest.registryMirror
    const proxies = (cfg.githubProxies && cfg.githubProxies.length ? cfg.githubProxies : DEFAULT_PROXIES)

    // Optional prebuilt runtime pack: a single archive produced by
    // scripts/make-runtime-pack.js on the release machine (portable Node +
    // installed-and-built harness). When configured it replaces the whole
    // source pipeline: download → verify → extract → done.
    const pack = manifest.pack && manifest.pack.url ? manifest.pack : null

    const remoteOf = (u) => !!u && isRemoteUrl(u)
    const allLocal = !remoteOf(dshUrl) && !remoteOf(nodeUrl) && !remoteOf(pack && pack.url)
    let mode = cfg.mirrorMode || 'auto'
    if (allLocal) {
      mode = 'direct'
    } else if (mode === 'auto') {
      note('正在探测网络,选择下载源…')
      const [mirrorOk, githubOk] = await Promise.all([
        probe(`${registryMirror.replace(/\/+$/u, '')}/-/ping`, 6000),
        probe('https://github.com', 8000),
      ])
      pushLog(`网络探测:registry 镜像可达=${mirrorOk},GitHub 可达=${githubOk}`)
      if (!mirrorOk && !githubOk) {
        throw new ProvisionError(
          '无法连接网络(官方源与镜像均不可达)。请检查网络后重试,或改用「选择已有仓库」。',
          'offline'
        )
      }
      mode = mirrorOk ? 'cn' : 'direct'
      pushLog(`下载源模式:${mode}`)
    }

    const cn = mode === 'cn'
    const nodeChain = cn
      ? [nodeMirrorUrlOf(nodeUrl, nodeMirror), nodeUrl].filter(Boolean)
      : [nodeUrl]
    const dshChain = []
    if (cn) for (const p of proxies) dshChain.push(githubProxyUrlOf(dshUrl, p))
    dshChain.push(dshUrl)
    const registry = cn ? registryMirror : registryOfficial

    const packChain = []
    if (pack) {
      if (cn) for (const p of proxies) packChain.push(githubProxyUrlOf(pack.url, p))
      packChain.push(pack.url)
    }

    return {
      mode,
      registry,
      manifest,
      dshRef,
      nodeUrl,
      dshUrl,
      nodeChain: nodeChain.filter(Boolean),
      dshChain: dshChain.filter(Boolean),
      usePack: !!pack,
      packChain: packChain.filter(Boolean),
      packSha: pack ? (pack.sha256 || '') : '',
      packUrl: pack ? pack.url : null,
    }
  }

  /** Move a tree, replacing an existing destination (same-volume rename). */
  function moveReplace(src, dest) {
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.renameSync(src, dest)
  }

  /** Poll until every file exists (huge extractions can lag behind tar's exit
   *  on slow disks / antivirus scans). Throws after the timeout. */
  async function waitForFiles(files, label, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 300_000)
    let lastReport = 0
    while (Date.now() < deadline) {
      const missing = files.filter((f) => !fs.existsSync(f))
      if (missing.length === 0) {
        // Short settle so late directory entries settle before relocating.
        await new Promise((r) => { setTimeout(r, 1200) })
        return
      }
      if (process.env.DSH_PACK_DEBUG === '1' && Date.now() - lastReport > 5000) {
        lastReport = Date.now()
        pushLog(`DEBUG 等待解压文件(${missing.length}/${files.length} 缺):${missing[0]}`)
      }
      await new Promise((r) => { setTimeout(r, 700) })
    }
    throw new ProvisionError(`解压未完成(${label}):等待超时`, 'pack')
  }

  /**
   * Rebuild every alias entry from pack.json that is not already a working
   * link. Extraction may deliver placeholders instead of links (tar without
   * symlink privileges fails silently per entry; the pure-Node fallback
   * writes empty placeholders), so "exists" is not enough: only a real
   * reparse link (lstat isSymbolicLink) counts as healthy. Directory aliases
   * become junctions (no admin needed), file aliases become copies of their
   * extracted target.
   * @param staging - extracted pack root.
   * @param aliases - [{ rel, target, type }] from pack.json.
   */
  function repairAliases(staging, aliases) {
    if (!Array.isArray(aliases) || aliases.length === 0) {
      pushLog('运行包无链接别名需要修复')
      return
    }
    let ok = 0
    let skip = 0
    let fail = 0
    for (const a of aliases) {
      if (!a || !a.rel || !/^harness\//u.test(String(a.rel))) { skip++; continue }
      const full = path.join(staging, ...String(a.rel).split('/'))
      let isLink = false
      try { isLink = fs.lstatSync(full).isSymbolicLink() } catch { /* missing or not a link */ }
      if (isLink) { ok++; continue } // healthy: tar already made the link
      const parent = path.dirname(full)
      if (!fs.existsSync(parent)) { skip++; continue } // parent tree missing
      let targetAbs
      try { targetAbs = path.resolve(parent, String(a.target || '')) } catch { skip++; continue }
      if (!fs.existsSync(targetAbs)) { skip++; continue } // target not materialized
      try {
        fs.rmSync(full, { recursive: true, force: true }) // drop placeholder/dangling link
        if (a.type === 'dir') {
          fs.symlinkSync(targetAbs, full, 'junction')
        } else {
          fs.copyFileSync(targetAbs, full)
        }
        ok++
      } catch { fail++ }
    }
    pushLog(`链接别名修复:成功 ${ok},跳过 ${skip},失败 ${fail}(共 ${aliases.length})`)
  }

  /**
   * Install a prebuilt runtime pack. The pack is a zip whose root holds
   * pack.json plus `node/…` and `harness/<ref>/…` trees laid out relative to
   * the runtime directory; each tree is relocated into the canonical
   * runtimeDir location (same place the source pipeline would produce), so
   * boots and future resumes behave identically.
   */
  async function ensureRuntimePack(plan, signal) {
    await beginStage('pack', `安装预构建运行包(${plan.dshRef})`, null)
    const refSafe = String(plan.dshRef).replace(/[^A-Za-z0-9._-]/gu, '_')
    const zip = path.join(runtimeDir, '.downloads', `dsh-runtime-${refSafe}-win-x64.zip`)
    try {
      if (fs.existsSync(zip)) {
        pushLog(`复用已下载的运行包:${path.basename(zip)}`)
      } else {
        note(`正在下载预构建运行包(模式:${plan.mode},源:${plan.packUrl})…`)
        pushLog(`下载运行包:${plan.packChain.join(' → ')}`)
        await downloadCandidates(plan.packChain, {
          dest: zip,
          label: '预构建运行包',
          sha256: plan.packSha,
          signal,
          log: pushLog,
          onProgress: (bytes, total) => fire({ type: 'progress', label: 'deepseek-harness 运行包', bytes, total }),
        })
      }
      note('正在解压运行包(可能需要几分钟)…')
      const staging = path.join(runtimeDir, '.staging', `pack-${refSafe}`)
      if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true })
      extractSingleTopDirPortable(zip, staging, pushLog)
      const meta = readJson(path.join(staging, 'pack.json'), null)
      if (!meta || meta.format !== 1) throw new ProvisionError('运行包缺少有效的 pack.json(format 1)', 'pack')
      // nodeRel points at the node.exe FILE; relocations work on directories.
      const nodeDirRel = String(meta.nodeRel || '').replace(/\\/gu, '/').split('/').slice(0, -1).join('/')
      const harnessRel = String(meta.harnessRel || '').replace(/\\/gu, '/')
      if (!/^node\//u.test(nodeDirRel) || !/^harness\//u.test(harnessRel) || /(^|\/)\.\.(\/|$)/u.test(nodeDirRel) || /(^|\/)\.\.(\/|$)/u.test(harnessRel)) {
        throw new ProvisionError('运行包 pack.json 路径异常', 'pack')
      }
      repairAliases(staging, meta.aliases)
      const nodeSrcDir = path.join(staging, ...nodeDirRel.split('/'))
      const nodeExeFile = path.join(nodeSrcDir, 'node.exe')
      const harnessSrcDir = path.join(staging, ...harnessRel.split('/'))
      await waitForFiles([
        nodeExeFile,
        path.join(harnessSrcDir, 'apps', 'cli', 'src', 'bin.ts'),
        path.join(harnessSrcDir, 'node_modules', 'tsx'),
        path.join(harnessSrcDir, 'apps', 'web', 'dist', 'index.html'),
      ], '关键文件')
      if (!fs.existsSync(nodeExeFile)) throw new ProvisionError('运行包缺少 node.exe', 'pack')
      if (!fs.existsSync(path.join(harnessSrcDir, 'apps', 'cli', 'src', 'bin.ts'))) throw new ProvisionError('运行包缺少 apps/cli/src/bin.ts', 'pack')
      if (!fs.existsSync(path.join(harnessSrcDir, 'node_modules', 'tsx'))) throw new ProvisionError('运行包缺少 node_modules/tsx(依赖未安装?)', 'pack')
      if (!fs.existsSync(path.join(harnessSrcDir, 'apps', 'web', 'dist', 'index.html'))) throw new ProvisionError('运行包缺少前端产物 apps/web/dist(未构建?)', 'pack')
      const nodeDestDir = path.join(runtimeDir, ...nodeDirRel.split('/'))
      const harnessDestDir = path.join(runtimeDir, ...harnessRel.split('/'))
      pushLog(`落位 Node.js:${nodeDestDir}`)
      moveReplace(nodeSrcDir, nodeDestDir)
      pushLog(`落位仓库:${harnessDestDir}`)
      moveReplace(harnessSrcDir, harnessDestDir)
      const nodeExe = path.join(nodeDestDir, 'node.exe')
      if (!fs.existsSync(nodeExe)) throw new ProvisionError('运行包落位后未找到 node.exe', 'pack')
      if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true })
      await endStage('pack', true, '预构建运行包就绪(无需安装依赖与构建)')
      return { nodeExe, repoDir: harnessDestDir, ref: meta.ref || plan.dshRef }
    } catch (err) {
      await endStage('pack', false, String(err && err.message ? err.message : err))
      throw err
    }
  }

  async function ensureNode(plan, signal) {
    await beginStage('node', '安装 Node.js 运行时', null)
    try {
      const nodeParent = path.join(runtimeDir, 'node')
      let nodeExe = null
      if (fs.existsSync(nodeParent)) {
        for (const dir of fs.readdirSync(nodeParent)) {
          const cand = path.join(nodeParent, dir, 'node.exe')
          if (!fs.existsSync(cand)) continue
          const run = spawnSync(cand, ['-v'], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
          const ver = (run.stdout || '').trim()
          if (atLeastNode(ver)) {
            nodeExe = cand
            pushLog(`复用已有 Node.js:${ver}`)
            break
          }
          if (ver) pushLog(`已有 Node.js 版本过低或不匹配(${ver}),重新安装`)
        }
      }
      if (!nodeExe) {
        const zipName = path.basename(plan.nodeUrl) || `node-${plan.manifest.node.version}-win-x64.zip`
        const zip = path.join(runtimeDir, '.downloads', zipName)
        if (fs.existsSync(zip)) {
          pushLog(`复用已下载的 Node.js 压缩包:${path.basename(zip)}`)
        } else {
          note(`正在下载 Node.js ${plan.manifest.node.version}(约 35 MB,模式:${plan.mode})…`)
          pushLog(`下载 Node.js:${plan.nodeChain.join(' → ')}`)
          await downloadCandidates(plan.nodeChain, {
            dest: zip,
            label: 'Node.js',
            signal,
            log: pushLog,
            onProgress: (bytes, total) => fire({ type: 'progress', label: 'Node.js', bytes, total }),
          })
        }
        note('正在解压 Node.js…')
        const target = path.join(nodeParent, `node-v${plan.manifest.node.version}-win-x64`)
        extractSingleTopDir(zip, target)
        nodeExe = path.join(target, 'node.exe')
        if (!fs.existsSync(nodeExe)) throw new ProvisionError('Node.js 压缩包结构异常:未找到 node.exe', 'extract')
        const run = spawnSync(nodeExe, ['-v'], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
        const ver = (run.stdout || '').trim()
        if (!atLeastNode(ver)) throw new ProvisionError(`Node.js 版本校验失败:${ver || '(无输出)'}`, 'node')
        pushLog(`Node.js 就绪:${ver}`)
      }
      await endStage('node', true, 'Node.js 就绪')
      return nodeExe
    } catch (err) {
      await endStage('node', false, String(err && err.message ? err.message : err))
      throw err
    }
  }

  async function ensureHarness(plan, signal) {
    const refSafe = String(plan.dshRef).replace(/[^A-Za-z0-9._-]/gu, '_')
    const repoDir = path.join(runtimeDir, 'harness', refSafe)
    await beginStage('harness', `安装 deepseek-harness ${plan.dshRef}`, null)
    try {
      if (fs.existsSync(path.join(repoDir, 'apps', 'cli', 'src', 'bin.ts'))) {
        pushLog(`复用已有仓库:${repoDir}`)
        await endStage('harness', true, '仓库已就绪')
        return repoDir
      }
      const zip = path.join(runtimeDir, '.downloads', `harness-${refSafe}.zip`)
      if (fs.existsSync(zip)) {
        pushLog(`复用已下载的源码包:${path.basename(zip)}`)
      } else {
        note(`正在下载 deepseek-harness ${plan.dshRef}(源码包约 60–150 MB,模式:${plan.mode})…`)
        pushLog(`下载仓库源码:${plan.dshChain.join(' → ')}`)
        await downloadCandidates(plan.dshChain, {
          dest: zip,
          label: 'deepseek-harness 源码',
          sha256: plan.manifest.dsh.sha256 || '',
          signal,
          log: pushLog,
          onProgress: (bytes, total) => fire({ type: 'progress', label: 'deepseek-harness', bytes, total }),
        })
      }
      note('正在解压仓库…')
      try {
        extractSingleTopDirPortable(zip, repoDir, pushLog)
      } catch (err) {
        // A corrupted archive would otherwise fail forever; drop it for redownload.
        try { fs.rmSync(zip, { force: true }) } catch { /* ignore */ }
        throw err
      }
      if (!fs.existsSync(path.join(repoDir, 'apps', 'cli', 'src', 'bin.ts'))) {
        throw new ProvisionError('源码包结构异常:缺少 apps/cli/src/bin.ts', 'extract')
      }
      await endStage('harness', true, '仓库就绪')
      return repoDir
    } catch (err) {
      await endStage('harness', false, String(err && err.message ? err.message : err))
      throw err
    }
  }

  async function ensurePnpm(nodeExe, plan, signal) {
    await beginStage('pnpm', `准备 pnpm ${plan.manifest.pnpm.version}`, null)
    try {
      const nodeDir = path.dirname(nodeExe)
      const pnpmCjs = path.join(nodeDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
      if (fs.existsSync(pnpmCjs)) {
        await endStage('pnpm', true, 'pnpm 已就绪')
        return pnpmCjs
      }
      const npmCli = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      if (!fs.existsSync(npmCli)) throw new ProvisionError('便携 Node 缺少 npm,结构异常', 'node')
      note(`正在安装 pnpm ${plan.manifest.pnpm.version}(registry:${plan.registry})…`)
      pushLog(`registry:${plan.registry}`)
      // --prefix pins the global install to the portable Node itself: without
      // an npmrc, npm's default Windows global prefix is %APPDATA%\npm, which
      // would silently install pnpm somewhere the engine never looks.
      await runChild(nodeExe, [npmCli, 'install', '-g', `pnpm@${plan.manifest.pnpm.version}`, '--prefix', nodeDir, '--no-fund', '--no-audit'], {
        env: { ...scriptEnv(plan, nodeExe), npm_config_prefix: nodeDir },
        captureLines: true,
        onLine: pushLog,
        signal,
        label: 'npm install -g pnpm',
      })
      if (!fs.existsSync(pnpmCjs)) throw new ProvisionError('pnpm 安装后未找到 pnpm.cjs(已使用 --prefix 固定安装位置;仍复现请查看向导日志)', 'pnpm')
      await endStage('pnpm', true, 'pnpm 就绪')
      return pnpmCjs
    } catch (err) {
      await endStage('pnpm', false, String(err && err.message ? err.message : err))
      throw err
    }
  }

  function baseEnv(plan) {
    return {
      ...process.env,
      NO_COLOR: '1',
      npm_config_registry: plan.registry,
      npm_config_cache: path.join(runtimeDir, '.cache', 'npm'),
      npm_config_store_dir: path.join(runtimeDir, '.cache', 'pnpm-store'),
      npm_config_loglevel: 'warn',
      npm_config_update_notifier: 'false',
    }
  }

  /**
   * Environment for child commands that (directly or via .bin shims) resolve
   * `node` from PATH. npm/pnpm lifecycle scripts run through cmd shims on
   * Windows, so a machine-installed old Node.js would otherwise hijack the
   * build. Putting the portable Node directory first on PATH pins every
   * nested `node` call to the provisioned runtime.
   */
  function scriptEnv(plan, nodeExe) {
    const env = baseEnv(plan)
    const nodeDir = path.dirname(nodeExe)
    const existing = env.PATH !== undefined ? env.PATH : env.Path
    delete env.Path
    env.PATH = existing ? `${nodeDir};${existing}` : nodeDir
    return env
  }

  /**
   * Environment for the build step. The repo's client build embeds the
   * source commit (DSH_CLIENT_COMMIT_HASH) and refuses to run `git` when the
   * checkout has no .git (a source zip). A deterministic pseudo-hash derived
   * from the pinned ref stands in, keeping zip checkouts buildable; an
   * explicit caller-provided value always wins.
   */
  function buildEnv(plan, env) {
    const e = env || baseEnv(plan)
    if (!e.DSH_CLIENT_COMMIT_HASH) {
      const hash = crypto.createHash('sha256').update(`dsh-desktop-source:${plan.dshRef}`).digest('hex')
      e.DSH_CLIENT_COMMIT_HASH = hash.slice(0, 12)
      pushLog(`无 Git 元数据,DSH_CLIENT_COMMIT_HASH 使用 ref 派生值 ${e.DSH_CLIENT_COMMIT_HASH}(构建元数据用)`)
    }
    return e
  }

  async function installDeps(nodeExe, pnpmCjs, repoDir, plan, signal) {
    await beginStage('deps', '安装依赖(pnpm install)', null)
    try {
      if (fs.existsSync(path.join(repoDir, 'node_modules', 'tsx'))) {
        pushLog('node_modules 已存在,跳过依赖安装')
        await endStage('deps', true, '依赖已就绪')
        return
      }
      note('正在安装依赖,需下载约 1.4 GB,请耐心等待…')
      await runChild(nodeExe, [pnpmCjs, 'install', '--reporter', 'append-only'], {
        cwd: repoDir,
        env: scriptEnv(plan, nodeExe),
        captureLines: true,
        onLine: pushLog,
        signal,
        label: 'pnpm install',
      })
      if (!fs.existsSync(path.join(repoDir, 'node_modules', 'tsx'))) {
        throw new ProvisionError('依赖安装结束但缺少 node_modules/tsx', 'deps')
      }
      await endStage('deps', true, '依赖就绪')
    } catch (err) {
      await endStage('deps', false, String(err && err.message ? err.message : err))
      throw err
    }
  }

  async function runBuild(nodeExe, pnpmCjs, repoDir, plan, signal) {
    await beginStage('build', '构建前端与库(pnpm run build)', null)
    try {
      const marker = path.join(repoDir, '.dsh-desktop-built')
      if (fs.existsSync(marker)) {
        pushLog('检测到已构建标记,跳过构建')
        await endStage('build', true, '构建产物已存在')
        return
      }
      note('正在构建,通常需要 3–10 分钟…')
      await runChild(nodeExe, [pnpmCjs, 'run', 'build'], {
        cwd: repoDir,
        env: buildEnv(plan, scriptEnv(plan, nodeExe)),
        captureLines: true,
        onLine: pushLog,
        signal,
        label: 'pnpm run build',
      })
      if (!fs.existsSync(path.join(repoDir, 'apps', 'web', 'dist', 'index.html'))) {
        throw new ProvisionError('构建结束但缺少前端产物 apps/web/dist/index.html', 'build')
      }
      writeJson(marker, { engine: ENGINE_VERSION, at: new Date().toISOString() })
      await endStage('build', true, '构建完成')
    } catch (err) {
      await endStage('build', false, String(err && err.message ? err.message : err))
      throw err
    }
  }

  async function start(cfg) {
    if (state.running) return
    state.running = true
    state.cancelled = false
    state.done = false
    state.error = null
    state.note = ''
    state.result = null
    state.stages = []
    state.logs = []
    state.planInfo = null
    fire({ type: 'start' })

    const signal = {
      cancelled: false,
      handlers: [],
      onCancel(fn) { this.handlers.push(fn) },
      cancel() {
        this.cancelled = true
        state.cancelled = true
        for (const fn of this.handlers) { try { fn() } catch { /* ignore */ } }
      },
    }
    api._cancelSignal = signal
    try {
      const plan = await resolvePlan(cfg)
      state.planInfo = {
        mode: plan.usePack ? 'pack' : plan.mode,
        registry: plan.registry,
        dshRef: plan.dshRef,
      }
      fire({ type: 'plan', plan: state.planInfo })
      let nodeExe
      let repoDir
      if (plan.usePack) {
        const installed = await ensureRuntimePack(plan, signal)
        nodeExe = installed.nodeExe
        repoDir = installed.repoDir
      } else {
        nodeExe = await ensureNode(plan, signal)
        throwIfCancelled()
        repoDir = await ensureHarness(plan, signal)
        throwIfCancelled()
        const pnpmCjs = await ensurePnpm(nodeExe, plan, signal)
        throwIfCancelled()
        await installDeps(nodeExe, pnpmCjs, repoDir, plan, signal)
        throwIfCancelled()
        await runBuild(nodeExe, pnpmCjs, repoDir, plan, signal)
        throwIfCancelled()
      }
      throwIfCancelled()

      writeJson(path.join(runtimeDir, 'provisioned.json'), {
        engine: ENGINE_VERSION,
        mode: plan.usePack ? 'pack' : 'source',
        ref: plan.dshRef,
        repoDir,
        nodeExe,
        registry: plan.registry,
        installedAt: new Date().toISOString(),
      })
      state.result = { nodeExe, repoDir, ref: plan.dshRef, mode: plan.usePack ? 'pack' : 'source' }
      state.done = true
      state.note = ''
      pushLog(`运行环境装配完成(方式:${plan.usePack ? '预构建运行包' : '在线源码构建'})。`)
      fire({ type: 'done', result: state.result })
    } catch (err) {
      if (err instanceof CancelledError) {
        state.error = null
        pushLog('已取消。已完成的步骤会自动跳过,随时可以重试。')
        fire({ type: 'cancelled' })
      } else {
        state.error = String(err && err.message ? err.message : err)
        pushLog(`失败:${state.error}`)
        fire({ type: 'error', message: state.error })
      }
    } finally {
      state.running = false
      fire({ type: 'state' })
    }
  }

  const api = {
    start,
    cancel() {
      if (api._cancelSignal) api._cancelSignal.cancel()
      else state.cancelled = true
    },
    snapshot() {
      return {
        running: state.running,
        done: state.done,
        cancelled: state.cancelled,
        error: state.error,
        note: state.note,
        stages: state.stages.map((s) => ({ ...s })),
        logs: state.logs.slice(-120),
        result: state.result ? { ...state.result } : null,
        planInfo: state.planInfo ? { ...state.planInfo } : null,
      }
    },
    _cancelSignal: null,
  }
  return api
}

/* ---------------------------------------------------------------- selftest */

function runSelfTest() {
  const results = []
  const check = (name, cond) => {
    results.push({ name, ok: !!cond })
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-provision-selftest-'))
  try {
    check('atLeastNode gate', atLeastNode('v22.19.0') && atLeastNode('v24.3.1') && !atLeastNode('v22.18.0') && !atLeastNode('v20.19.0'))

    const nodeUrl = 'https://nodejs.org/dist/v22.23.2/node-v22.23.2-win-x64.zip'
    const dshUrl = 'https://github.com/deepseek-ai/deepseek-harness/archive/refs/tags/dsh-v0.1.2-alpha.5.zip'
    check('node npmmirror URL transform', nodeMirrorUrlOf(nodeUrl, 'https://npmmirror.com') === 'https://npmmirror.com/mirrors/node/v22.23.2/node-v22.23.2-win-x64.zip')
    check('github proxy URL transform', githubProxyUrlOf(dshUrl, 'https://ghfast.top') === `https://ghfast.top/${dshUrl}`)
    check('local path not treated as remote', !isRemoteUrl('C:\\tmp\\x.zip') && !isRemoteUrl('file:///c:/x.zip'))

    // file:// download + sha verify + sha mismatch rejection.
    const src = path.join(tmp, 'sample.bin')
    fs.writeFileSync(src, crypto.randomBytes(4 * 1024 * 1024))
    const sha = sha256File(src)
    const fileUrl = `file:///${src.replace(/\\/gu, '/')}`

    ;(async () => {
      try {
        const dest = path.join(tmp, 'sample-copy.bin')
        await downloadCandidates([fileUrl], { dest, sha256: sha, label: 'sample' })
        check('file:// download + sha verify', fs.readFileSync(dest).length === fs.readFileSync(src).length)

        const bad = path.join(tmp, 'bad.bin')
        let threw = false
        try {
          await downloadCandidates([fileUrl], { dest: bad, sha256: '0'.repeat(64), label: 'bad' })
        } catch { threw = true }
        check('sha mismatch raises', threw)

        const missing = path.join(tmp, 'missing.bin')
        let threwMissing = false
        try {
          await downloadCandidates([path.join(tmp, 'no-such-file.zip')], { dest: missing, label: 'missing' })
        } catch { threwMissing = true }
        check('missing local source raises', threwMissing)

        // Zip extraction + single-top-dir relocation (via Windows tar.exe).
        const zipDir = path.join(tmp, 'zips')
        fs.mkdirSync(zipDir, { recursive: true })
        const innerSrc = path.join(tmp, 'inner-src', 'top-dir')
        fs.mkdirSync(innerSrc, { recursive: true })
        fs.writeFileSync(path.join(innerSrc, 'hello.txt'), 'hello')
        const zipFile = path.join(zipDir, 'test.zip')
        const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -Path '${path.join(tmp, 'inner-src', '*')}' -DestinationPath '${zipFile}' -Force`], { encoding: 'utf8' })
        check('powershell created test zip', r.status === 0 && fs.existsSync(zipFile))
        if (fs.existsSync(zipFile)) {
          const outDir = path.join(tmp, 'out')
          extractSingleTopDir(zipFile, outDir)
          check('extractSingleTopDir relocates top dir', fs.existsSync(path.join(outDir, 'hello.txt')))

          // Pure-Node extractor must produce identical trees (no tar needed).
          const nodeOut = path.join(tmp, 'out-node')
          extractZipNode(zipFile, nodeOut)
          check('extractZipNode extracts tree', fs.readFileSync(path.join(nodeOut, 'top-dir', 'hello.txt'), 'utf8') === 'hello')

          // portable chain with tar forced off must still work.
          const forcedOut = path.join(tmp, 'out-forced')
          const savedForce = process.env.DSH_FORCE_NODE_UNZIP
          process.env.DSH_FORCE_NODE_UNZIP = '1'
          try {
            extractSingleTopDirPortable(zipFile, forcedOut, () => {})
            check('extractSingleTopDirPortable (forced node unzip)', fs.existsSync(path.join(forcedOut, 'hello.txt')))
          } finally {
            if (savedForce === undefined) delete process.env.DSH_FORCE_NODE_UNZIP
            else process.env.DSH_FORCE_NODE_UNZIP = savedForce
          }
        }

        // Engine API shape + snapshot lifecycle with an offline error path.
        const engine = createProvisioner({ runtimeDir: path.join(tmp, 'engine') })
        check('createProvisioner api surface', typeof engine.start === 'function' && typeof engine.cancel === 'function' && typeof engine.snapshot === 'function')
        const idle = engine.snapshot()
        check('initial snapshot idle', idle.running === false && idle.stages.length === 0 && idle.done === false)
        engine.cancel()
        check('cancel without start is harmless', true)

        console.log(results.every((x) => x.ok) ? '\nSELFTEST OK' : '\nSELFTEST FAILED')
        process.exit(results.every((x) => x.ok) ? 0 : 1)
      } catch (err) {
        console.error('SELFTEST ERROR', err)
        process.exit(2)
      }
    })()
  } catch (err) {
    console.error('SELFTEST ERROR', err)
    process.exit(2)
  }
}

if (require.main === module && process.argv.includes('--selftest')) {
  runSelfTest()
}

module.exports = {
  createProvisioner,
  atLeastNode,
  downloadCandidates,
  extractSingleTopDir,
  extractSingleTopDirPortable,
  extractZip,
  extractZipNode,
  extractZipPortable,
  sha256File,
  writeJson,
  nodeMirrorUrlOf,
  githubProxyUrlOf,
  isRemoteUrl,
  probe,
  ProvisionError,
  CancelledError,
  ENGINE_VERSION,
  NODE_MIN,
}
