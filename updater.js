/**
 * Self-update engine for the DeepSeek Harness Desktop shell.
 *
 * Pure Node (no Electron imports, no runtime dependencies) so it can be
 * exercised headlessly: `node updater.js --selftest` runs the full drill
 * against a local fixture HTTP server.
 *
 * The app is distributed as an electron-builder NSIS installer on GitHub
 * Releases, so "updating" means:
 *
 *   1. ask the GitHub Releases API for the newest release (a custom mirror
 *      prefix and the built-in GitHub proxies from provision.js are used as
 *      fallbacks, matching the runtime installer's China-friendly behavior),
 *   2. compare its tag against app.getVersion() with full semver rules
 *      (pre-release identifiers included),
 *   3. download `DeepSeek-Harness-Desktop-Setup-<version>.exe` next to the
 *      user's data with resume + optional-mirror support,
 *   4. verify the file (GitHub asset digest, or a `<asset>.sha256` sidecar,
 *      plus size and PE-header sanity checks),
 *   5. hand it to the NSIS installer in silent mode and quit, so the
 *      installer can replace the app and relaunch it.
 *
 * Nothing here touches the file system layout of the installed app: the
 * installer reuses its own registry-recorded install directory.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const {
  request,
  downloadCandidates,
  sha256File,
  githubProxyUrlOf,
  ProvisionError,
  CancelledError,
} = require('./provision.js')

const UPDATER_VERSION = 1
const DEFAULT_REPO = '66-empty/DeepSeek-Harness-Desktop'
const DEFAULT_API_BASE = 'https://api.github.com'
const USER_AGENT = 'DeepSeek-Harness-Desktop-Updater'
const SETUP_ASSET_RE = /^DeepSeek-Harness-Desktop-Setup-.+\.exe$/iu
const PORTABLE_ASSET_RE = /^DeepSeek-Harness-Desktop-Portable-.+\.exe$/iu
/** Release notes are only shown in a small window; keep them bounded. */
const MAX_NOTES_CHARS = 4000
const API_TIMEOUT_MS = 15_000

/* ------------------------------------------------------------- errors */

/** Error with a stable machine code so the UI can localize it. */
function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/* ------------------------------------------------------- semver helpers */

/**
 * Parse a tag/version string. Accepts an optional leading `v`, the three
 * numeric fields, and optional pre-release / build metadata.
 * @param {string} text - e.g. `v0.4.0`, `1.2.3-beta.1`.
 * @returns {{major:number,minor:number,patch:number,pre:string[],raw:string}|null}
 */
function parseVersion(text) {
  const raw = String(text == null ? '' : text).trim()
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(raw)
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
    raw,
  }
}

/** semver §11 pre-release ordering: `1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0`. */
function comparePre(a, b) {
  if (a.length === 0 || b.length === 0) {
    if (a.length === b.length) return 0
    return a.length === 0 ? 1 : -1 // a release outranks any pre-release
  }
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/u.test(x)
    const ny = /^\d+$/u.test(y)
    if (nx && ny) {
      const diff = Number(x) - Number(y)
      if (diff !== 0) return diff > 0 ? 1 : -1
      continue
    }
    if (nx !== ny) return nx ? -1 : 1 // numeric identifiers rank lower
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/**
 * Compare two version strings.
 * @returns {number|null} 1 / 0 / -1, or null when either side is unparsable.
 */
function compareSemver(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return null
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] > pb[key] ? 1 : -1
  }
  return comparePre(pa.pre, pb.pre)
}

/** True when `candidate` is a strictly newer version than `current`. */
function isNewer(candidate, current) {
  return compareSemver(candidate, current) === 1
}

/* ------------------------------------------------------------ release IO */

/** Strip a leading `v` from a release tag: `v0.4.0` → `0.4.0`. */
function versionOfTag(tag) {
  return String(tag || '').trim().replace(/^v/iu, '')
}

/** `sha256:<hex>` (GitHub asset digest) → `<hex>`; anything else → null. */
function digestToSha(digest) {
  const m = /^sha256:([0-9a-f]{64})$/iu.exec(String(digest || '').trim())
  return m ? m[1].toLowerCase() : null
}

/** Parse the `  <hash>  <name>` sidecar format produced by `Get-FileHash`. */
function parseShaFile(text) {
  const m = /([0-9a-f]{64})/iu.exec(String(text || ''))
  return m ? m[1].toLowerCase() : null
}

/**
 * Normalize one GitHub release object into the shape the UI consumes.
 * @param {object} json - raw API object.
 */
function normalizeRelease(json) {
  const assets = Array.isArray(json && json.assets) ? json.assets : []
  return {
    tag: String((json && json.tag_name) || ''),
    version: versionOfTag(json && json.tag_name),
    name: String((json && json.name) || ''),
    notes: String((json && json.body) || '').slice(0, MAX_NOTES_CHARS),
    url: String((json && json.html_url) || ''),
    publishedAt: String((json && (json.published_at || json.created_at)) || ''),
    prerelease: Boolean(json && json.prerelease),
    draft: Boolean(json && json.draft),
    assets: assets.map((asset) => ({
      name: String(asset.name || ''),
      size: Number(asset.size) || 0,
      url: String(asset.browser_download_url || ''),
      digest: String(asset.digest || ''),
      sha256: digestToSha(asset.digest),
    })),
  }
}

/**
 * Pick the installer asset to download.
 * @param {object} release - normalized release.
 * @param {{portable?:boolean}} [opts] - portable builds prefer the portable exe.
 * @returns {object|null} the chosen asset.
 */
function pickAsset(release, opts) {
  const assets = (release && release.assets) || []
  const setup = assets.filter((a) => SETUP_ASSET_RE.test(a.name) && !/\.sha256$/iu.test(a.name))
  const portable = assets.filter((a) => PORTABLE_ASSET_RE.test(a.name) && !/\.sha256$/iu.test(a.name))
  const order = opts && opts.portable ? [...portable, ...setup] : [...setup, ...portable]
  return order[0] || null
}

/** The `<asset>.sha256` sidecar published next to an installer, if any. */
function sidecarAssetOf(release, assetName) {
  const assets = (release && release.assets) || []
  return assets.find((a) => a.name.toLowerCase() === `${String(assetName).toLowerCase()}.sha256`) || null
}

/**
 * Candidate URLs for one remote URL: the user's mirror prefix first, then the
 * direct URL, then the built-in GitHub proxies. With `proxiesFirst` (China
 * mirror mode) the proxies are tried before the direct URL.
 */
function candidateUrls(url, opts) {
  const options = opts || {}
  const out = []
  const push = (value) => {
    if (value && !out.includes(value)) out.push(value)
  }
  const mirror = String(options.mirror || '').trim().replace(/\/+$/u, '')
  if (/^https?:\/\//u.test(mirror)) push(`${mirror}/${url}`)
  const proxies = (options.proxies || []).map((p) => githubProxyUrlOf(url, p)).filter(Boolean)
  if (options.proxiesFirst) proxies.forEach(push)
  push(url)
  if (!options.proxiesFirst) proxies.forEach(push)
  return out
}

/** GET a URL and parse the JSON body; non-2xx responses carry `.status`. */
async function getJson(url, opts) {
  const options = opts || {}
  const res = await request({
    url,
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': USER_AGENT,
      'x-github-api-version': '2022-11-28',
    },
    connectTimeoutMs: options.timeoutMs || API_TIMEOUT_MS,
  })
  const chunks = []
  await new Promise((resolve, reject) => {
    res.body.on('data', (chunk) => chunks.push(chunk))
    res.body.on('end', resolve)
    res.body.on('error', reject)
  })
  const text = Buffer.concat(chunks).toString('utf8')
  if (res.status < 200 || res.status >= 300) {
    const error = fail(res.status === 404 ? 'api404' : 'api', `GitHub API returned HTTP ${res.status}`)
    error.status = res.status
    throw error
  }
  try {
    return JSON.parse(text)
  } catch {
    throw fail('api', 'GitHub API returned a non-JSON body')
  }
}

/** Fetch the sha256 recorded in an asset's `.sha256` sidecar, if published. */
async function fetchSidecarSha(release, asset, opts) {
  const sidecar = sidecarAssetOf(release, asset.name)
  if (!sidecar || !sidecar.url) return null
  const dest = path.join(opts.tmpDir, `${asset.name}.sha256`)
  const urls = candidateUrls(sidecar.url, opts)
  await downloadCandidates(urls, { dest, label: `${asset.name}.sha256`, signal: opts.signal, log: opts.log })
  const sha = parseShaFile(fs.readFileSync(dest, 'utf8'))
  try { fs.rmSync(dest, { force: true }) } catch { /* cache file, best effort */ }
  if (!sha) throw fail('sha', `Malformed .sha256 sidecar for ${asset.name}`)
  return sha
}

/**
 * Ask GitHub for the newest release and decide whether it is worth installing.
 *
 * @param {object} opts
 * @param {string} [opts.repo] - `owner/name`, defaults to the upstream repo.
 * @param {string} opts.currentVersion - `app.getVersion()`.
 * @param {boolean} [opts.includePrerelease] - also consider pre-releases.
 * @param {string} [opts.mirror] - mirror prefix (e.g. `https://ghfast.top`).
 * @param {string[]} [opts.proxies] - built-in GitHub proxy fallbacks.
 * @param {boolean} [opts.proxiesFirst] - China mode: proxies before direct.
 * @param {boolean} [opts.portable] - running from the portable exe.
 * @param {string} [opts.apiBase] - API root (tests / GitHub Enterprise).
 * @param {string} [opts.tmpDir] - scratch dir for the sidecar download.
 * @param {(line:string)=>void} [opts.log]
 * @returns {Promise<object>} `{ status, current, latest, release, asset, notes, url }`
 *   with status `update-available` | `up-to-date` | `no-releases`.
 */
async function checkForUpdate(opts) {
  const options = opts || {}
  const repo = options.repo || DEFAULT_REPO
  const apiBase = String(options.apiBase || DEFAULT_API_BASE).replace(/\/+$/u, '')
  const current = String(options.currentVersion || '0.0.0')
  const listUrl = `${apiBase}/repos/${repo}/releases?per_page=30`
  const latestUrl = `${apiBase}/repos/${repo}/releases/latest`
  const urls = candidateUrls(options.includePrerelease ? listUrl : latestUrl, options)

  let lastError = null
  for (const url of urls) {
    if (options.signal && options.signal.cancelled) throw new CancelledError()
    let json
    try {
      json = await getJson(url, options)
    } catch (error) {
      if (error instanceof CancelledError) throw error
      lastError = error
      // A missing release list is a definitive answer, not a mirror problem.
      if (error.status === 404) return { status: 'no-releases', current, latest: '', release: null, asset: null, notes: '', url: repoTagsUrl(repo) }
      if (options.log) options.log(`release lookup failed via ${url}: ${error.message}`)
      continue
    }
    const list = Array.isArray(json) ? json : [json]
    const releases = list
      .map(normalizeRelease)
      .filter((release) => release.version && !release.draft)
      .filter((release) => (options.includePrerelease ? true : !release.prerelease))
      .filter((release) => parseVersion(release.version) !== null)
      .sort((a, b) => compareSemver(b.version, a.version))
    if (releases.length === 0) {
      return { status: 'no-releases', current, latest: '', release: null, asset: null, notes: '', url: repoTagsUrl(repo) }
    }
    const newest = releases[0]
    const base = {
      current,
      latest: newest.version,
      release: newest,
      asset: pickAsset(newest, { portable: options.portable === true }),
      notes: newest.notes,
      url: newest.url || repoTagsUrl(repo),
    }
    if (!isNewer(newest.version, current)) return { status: 'up-to-date', ...base }
    if (!base.asset) {
      // A release without a Windows installer (e.g. sources only) is not
      // installable by this updater; report it as up-to-date rather than
      // offering a download that cannot be verified.
      if (options.log) options.log(`release ${newest.tag} has no installer asset`)
      return { status: 'up-to-date', ...base, asset: null, notes: newest.notes }
    }
    return { status: 'update-available', ...base }
  }
  throw lastError || fail('network', 'No usable release endpoint')
}

function repoTagsUrl(repo) {
  return `https://github.com/${repo}/releases`
}

/**
 * Download (or reuse) an installer asset and verify it.
 *
 * @param {object} opts
 * @param {object} opts.asset - from {@link checkForUpdate}.
 * @param {object} opts.release - from {@link checkForUpdate}.
 * @param {string} opts.destDir - download directory (created when missing).
 * @param {string} [opts.mirror] / [opts.proxies] / [opts.proxiesFirst]
 * @param {string} [opts.tmpDir] - defaults to `destDir`.
 * @param {object} [opts.signal] - `{ cancelled }` token.
 * @param {(received:number,total:number)=>void} [opts.onProgress]
 * @param {(line:string)=>void} [opts.log]
 * @param {boolean} [opts.force] - re-download even when the file looks cached.
 * @returns {Promise<{file:string,bytes:number,sha256:string|null,cached:boolean}>}
 */
async function downloadUpdate(opts) {
  const options = opts || {}
  const asset = options.asset
  if (!asset || !asset.url) throw fail('norelease', 'No installer asset to download')
  const destDir = options.destDir
  fs.mkdirSync(destDir, { recursive: true })
  const dest = path.join(destDir, asset.name)
  const tmpDir = options.tmpDir || destDir

  let expected = asset.sha256 || null
  if (!expected) expected = await fetchSidecarSha(options.release, asset, { ...options, tmpDir })

  // Reuse a previously downloaded, still-valid installer (idempotent restarts).
  if (!options.force && fs.existsSync(dest)) {
    const size = fs.statSync(dest).size
    const sizeOk = !asset.size || size === asset.size
    if (sizeOk && (!expected || sha256File(dest) === expected)) {
      if (options.log) options.log(`reusing verified download ${dest}`)
      return { file: dest, bytes: size, sha256: expected, cached: true }
    }
    if (options.log) options.log('cached download failed verification, downloading again')
    fs.rmSync(dest, { force: true })
  }

  const urls = candidateUrls(asset.url, options)
  if (options.log) options.log(`downloading ${asset.name} (${asset.size || 0} bytes)`)
  await downloadCandidates(urls, {
    dest,
    sha256: expected || undefined,
    label: asset.name,
    signal: options.signal,
    log: options.log,
    onProgress: options.onProgress,
  })

  const bytes = fs.statSync(dest).size
  const cleanup = (error) => {
    try { fs.rmSync(dest, { force: true }) } catch { /* best effort */ }
    return error
  }
  if (asset.size && bytes !== asset.size) {
    throw cleanup(fail('size', `Downloaded ${bytes} bytes, expected ${asset.size}`))
  }
  // Cheap sanity gate: an NSIS installer is a PE executable. This catches
  // captive-portal HTML pages and truncated proxies that got a 200.
  const head = Buffer.alloc(2)
  const fd = fs.openSync(dest, 'r')
  try { fs.readSync(fd, head, 0, 2, 0) } finally { fs.closeSync(fd) }
  if (head.toString('latin1') !== 'MZ') {
    throw cleanup(fail('pe', 'Downloaded file is not a Windows executable'))
  }
  return { file: dest, bytes, sha256: expected, cached: false }
}

/** Arguments that make the electron-builder NSIS installer upgrade in place. */
function installerArgs(opts) {
  const options = opts || {}
  return ['--updated', '/S', ...(options.forceRun === false ? [] : ['--force-run'])]
}

/**
 * Launch the downloaded installer detached, so it survives this process.
 * The caller is expected to quit immediately afterwards: the installer waits
 * for the app to exit before replacing files.
 * @returns {number|null} the installer pid.
 */
function launchInstaller(file, opts) {
  const options = opts || {}
  if (!file || !fs.existsSync(file)) throw fail('io', `Installer not found: ${file}`)
  const child = spawn(file, installerArgs(options), {
    cwd: path.dirname(file),
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.unref()
  if (options.log) options.log(`launched installer ${path.basename(file)} (pid=${child.pid})`)
  return child.pid === undefined ? null : child.pid
}

/* --------------------------------------------------------------- selftest */

function runSelfTest() {
  const results = []
  const check = (name, cond) => {
    results.push({ name, ok: !!cond })
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  }
  const http = require('node:http')

  /** Fixture server: exact-path bodies with Range support + request capture. */
  function startServer(routes) {
    const seen = []
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      seen.push({ path: url.pathname, headers: req.headers })
      const route = routes[url.pathname]
      if (!route) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found')
        return
      }
      // `__PORT__` lets fixtures reference the ephemeral port they listen on.
      const body = Buffer.isBuffer(route.body)
        ? route.body
        : Buffer.from(String(route.body).replace(/__PORT__/gu, `http://127.0.0.1:${server.address().port}`))
      const range = /bytes=(\d+)-/u.exec(req.headers.range || '')
      if (range) {
        const start = Math.min(Number(range[1]), body.length)
        const slice = body.subarray(start)
        res.writeHead(206, {
          'content-type': route.type || 'application/octet-stream',
          'content-length': String(slice.length),
          'content-range': `bytes ${start}-${body.length - 1}/${body.length}`,
        })
        res.end(slice)
        return
      }
      res.writeHead(route.status || 200, {
        'content-type': route.type || 'application/octet-stream',
        'content-length': String(body.length),
      })
      res.end(body)
    })
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }))
    })
  }

  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dsh-updater-selftest-'))
  const installerBytes = Buffer.concat([
    Buffer.from('MZ'),
    Buffer.alloc(64, 0x90),
    Buffer.from('fixture-installer-payload'),
  ])
  const installerSha = require('node:crypto').createHash('sha256').update(installerBytes).digest('hex')
  const notExeBytes = Buffer.from('<html>captive portal</html>')

  const releaseJson = (assetOverrides) => JSON.stringify({
    tag_name: 'v0.4.0',
    name: '0.4.0',
    body: '# 0.4.0\n\n- auto update',
    html_url: 'https://github.com/66-empty/DeepSeek-Harness-Desktop/releases/tag/v0.4.0',
    published_at: '2026-09-04T10:00:00Z',
    prerelease: false,
    draft: false,
    assets: [
      {
        name: 'DeepSeek-Harness-Desktop-Setup-0.4.0.exe',
        size: installerBytes.length,
        browser_download_url: '__PORT__/dl/setup.exe',
        digest: `sha256:${installerSha}`,
        ...(assetOverrides || {}),
      },
      {
        name: 'DeepSeek-Harness-Desktop-Portable-0.4.0.exe',
        size: installerBytes.length,
        browser_download_url: '__PORT__/dl/portable.exe',
        digest: `sha256:${installerSha}`,
      },
      {
        name: 'DeepSeek-Harness-Desktop-Setup-0.4.0.exe.sha256',
        size: 80,
        browser_download_url: '__PORT__/dl/setup.exe.sha256',
      },
      {
        name: 'DeepSeek-Harness-Desktop-Setup-0.4.0.exe.blockmap',
        size: 12,
        browser_download_url: '__PORT__/dl/setup.exe.blockmap',
      },
    ],
  })

  const run = async () => {
    // --- version maths ---
    check('parseVersion accepts v-prefix', parseVersion('v0.4.0') !== null && parseVersion('v0.4.0').minor === 4)
    check('parseVersion rejects junk', parseVersion('nightly') === null && parseVersion('') === null)
    check('compareSemver major/minor/patch', compareSemver('1.0.0', '0.9.9') === 1 && compareSemver('0.4.0', '0.4.1') === -1 && compareSemver('0.4.0', '0.4.0') === 0)
    check('compareSemver pre-release ranks lower', compareSemver('0.4.0-beta.1', '0.4.0') === -1)
    check('compareSemver pre-release ordering', compareSemver('0.4.0-beta.2', '0.4.0-beta.1') === 1 && compareSemver('0.4.0-alpha.10', '0.4.0-alpha.9') === 1)
    check('compareSemver unparsable → null', compareSemver('x', '1.0.0') === null)
    check('isNewer', isNewer('v0.4.0', '0.3.0') && !isNewer('0.3.0', '0.3.0') && !isNewer('0.3.0', '0.4.0'))

    // --- asset picking ---
    const release = normalizeRelease(JSON.parse(releaseJson()))
    check('normalizeRelease maps fields', release.version === '0.4.0' && release.prerelease === false && release.assets.length === 4)
    check('normalizeRelease parses digest', release.assets[0].sha256 === installerSha)
    check('pickAsset prefers Setup', pickAsset(release, {}).name === 'DeepSeek-Harness-Desktop-Setup-0.4.0.exe')
    check('pickAsset portable mode prefers Portable', pickAsset(release, { portable: true }).name === 'DeepSeek-Harness-Desktop-Portable-0.4.0.exe')
    check('pickAsset ignores sidecars', pickAsset(release, {}).name.endsWith('.exe'))
    check('parseShaFile tolerates Get-FileHash format', parseShaFile(`${installerSha}  file.exe\r\n`) === installerSha)

    // --- URL candidates ---
    const direct = 'https://github.com/o/r/releases/download/v1/x.exe'
    check('candidateUrls direct first', candidateUrls(direct, { proxies: ['https://ghfast.top'] })[0] === direct)
    check('candidateUrls proxies first in cn mode', candidateUrls(direct, { proxies: ['https://ghfast.top'], proxiesFirst: true })[0] === `https://ghfast.top/${direct}`)
    check('candidateUrls mirror prefix wins', candidateUrls(direct, { mirror: 'https://mirror.example/', proxies: [] })[0] === `https://mirror.example/${direct}`)
    check('candidateUrls dedupes', candidateUrls(direct, { mirror: '', proxies: ['https://ghfast.top', 'https://ghfast.top'] }).length === 2)

    // --- API + download drill ---
    const { server, port, seen } = await startServer({
      '/repos/o/r/releases/latest': { body: releaseJson(), type: 'application/json' },
      '/dl/setup.exe': { body: installerBytes },
      '/dl/portable.exe': { body: installerBytes },
      '/dl/setup.exe.sha256': { body: `${installerSha}  DeepSeek-Harness-Desktop-Setup-0.4.0.exe\n`, type: 'text/plain' },
    })
    try {
      const apiBase = `http://127.0.0.1:${port}`
      const found = await checkForUpdate({ apiBase, repo: 'o/r', currentVersion: '0.3.0', tmpDir: tmp })
      check('checkForUpdate finds a newer release', found.status === 'update-available' && found.latest === '0.4.0')
      check('checkForUpdate sends a User-Agent', seen.some((s) => s.headers['user-agent'] === USER_AGENT))

      const same = await checkForUpdate({ apiBase, repo: 'o/r', currentVersion: '0.4.0', tmpDir: tmp })
      check('checkForUpdate reports up-to-date', same.status === 'up-to-date')

      const destDir = path.join(tmp, 'downloads')
      let progress = null
      const first = await downloadUpdate({
        asset: found.asset,
        release: found.release,
        destDir,
        onProgress: (received, total) => { progress = { received, total } },
      })
      check('downloadUpdate writes the installer', fs.existsSync(first.file) && fs.statSync(first.file).size === installerBytes.length)
      check('downloadUpdate verifies the digest', first.sha256 === installerSha && first.cached === false)
      check('downloadUpdate reports progress', progress !== null && progress.total === installerBytes.length)

      const again = await downloadUpdate({ asset: found.asset, release: found.release, destDir })
      check('downloadUpdate reuses a verified file', again.cached === true)

      // Resume: a half-written .part must be completed, not restarted.
      const resumeDir = path.join(tmp, 'resume')
      fs.mkdirSync(resumeDir, { recursive: true })
      const partPath = path.join(resumeDir, found.asset.name)
      fs.writeFileSync(`${partPath}.part`, installerBytes.subarray(0, 20))
      const resumed = await downloadUpdate({ asset: found.asset, release: found.release, destDir: resumeDir })
      check('downloadUpdate resumes a partial file', sha256File(resumed.file) === installerSha && resumed.bytes === installerBytes.length)

      // Digest mismatch must delete the bad file.
      const badRelease = normalizeRelease(JSON.parse(releaseJson({ digest: `sha256:${'0'.repeat(64)}` }).replace(/__PORT__/gu, apiBase)))
      const badDir = path.join(tmp, 'bad')
      let mismatch = false
      try {
        await downloadUpdate({ asset: badRelease.assets[0], release: badRelease, destDir: badDir })
      } catch (error) {
        mismatch = error.code === 'sha'
      }
      check('downloadUpdate rejects a digest mismatch', mismatch)
      check('digest mismatch leaves no file', !fs.existsSync(path.join(badDir, badRelease.assets[0].name)))

      // Sidecar sha256 is used when the API has no digest.
      const sideRelease = normalizeRelease(JSON.parse(releaseJson({ digest: null }).replace(/__PORT__/gu, apiBase)))
      const sideDir = path.join(tmp, 'sidecar')
      const viaSidecar = await downloadUpdate({ asset: sideRelease.assets[0], release: sideRelease, destDir: sideDir, tmpDir: tmp })
      check('downloadUpdate falls back to the .sha256 sidecar', viaSidecar.sha256 === installerSha)

      // Size / PE sanity gates.
      const sizeRelease = normalizeRelease(JSON.parse(releaseJson({ digest: null, size: installerBytes.length + 5 }).replace(/__PORT__/gu, apiBase)))
      let sizeErr = false
      try {
        await downloadUpdate({ asset: sizeRelease.assets[0], release: sizeRelease, destDir: path.join(tmp, 'size'), tmpDir: tmp })
      } catch (error) { sizeErr = error.code === 'size' }
      check('downloadUpdate rejects a size mismatch', sizeErr)

      const { server: htmlServer, port: htmlPort } = await startServer({
        '/repos/o/r/releases/latest': { body: JSON.stringify({ message: 'Not Found' }), type: 'application/json', status: 404 },
        '/dl/notexe.exe': { body: notExeBytes },
      })
      try {
        const missing = await checkForUpdate({ apiBase: `http://127.0.0.1:${htmlPort}`, repo: 'o/r', currentVersion: '0.3.0', tmpDir: tmp })
        check('checkForUpdate handles a 404 as no releases', missing.status === 'no-releases')

        const htmlAsset = { name: 'DeepSeek-Harness-Desktop-Setup-0.4.0.exe', size: notExeBytes.length, url: `http://127.0.0.1:${htmlPort}/dl/notexe.exe`, sha256: null }
        let peErr = false
        try {
          await downloadUpdate({ asset: htmlAsset, release: { assets: [] }, destDir: path.join(tmp, 'pe'), tmpDir: tmp })
        } catch (error) { peErr = error.code === 'pe' }
        check('downloadUpdate rejects a non-PE download', peErr)
      } finally {
        htmlServer.close()
      }
    } finally {
      server.close()
    }

    check('installerArgs upgrades silently and relaunches', installerArgs({}).join(' ') === '--updated /S --force-run')
    check('launchInstaller rejects a missing file', (() => {
      try { launchInstaller(path.join(tmp, 'nope.exe')); return false } catch (error) { return error.code === 'io' }
    })())
    check('updater exposes its version', UPDATER_VERSION === 1 && DEFAULT_REPO.includes('/'))

    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* temp dir */ }
    console.log(results.every((x) => x.ok) ? '\nSELFTEST OK' : '\nSELFTEST FAILED')
    process.exit(results.every((x) => x.ok) ? 0 : 1)
  }

  run().catch((error) => {
    console.error('SELFTEST ERROR', error)
    process.exit(2)
  })
}

if (require.main === module && process.argv.includes('--selftest')) {
  runSelfTest()
}

module.exports = {
  UPDATER_VERSION,
  DEFAULT_REPO,
  parseVersion,
  compareSemver,
  isNewer,
  versionOfTag,
  digestToSha,
  parseShaFile,
  normalizeRelease,
  pickAsset,
  sidecarAssetOf,
  candidateUrls,
  checkForUpdate,
  downloadUpdate,
  installerArgs,
  launchInstaller,
  sha256File,
  ProvisionError,
  CancelledError,
}
