/**
 * Release-machine packer for the "prebuilt runtime" distribution channel.
 *
 * Produces a single zip that the desktop shell can install offline without
 * pnpm install / pnpm run build on the target machine:
 *
 *   dsh-runtime-<ref>-win-x64.zip
 *     └─ dsh-runtime/
 *        ├─ pack.json                     format/rel layout metadata
 *        ├─ node/node-v<ver>-win-x64/…    portable Node.js
 *        └─ harness/<ref>/…               deepseek-harness checkout (deps
 *                                         installed AND frontend built)
 *
 * Run on the machine that has the built repo (the release machine):
 *
 *   node scripts/make-runtime-pack.js [--repo <path>] [--ref <tag>]
 *                                     [--node-version <ver>] [--out <dir>]
 *
 * Defaults: repo = sibling "deepseek-harness" of dsh-desktop-app, ref and
 * node version from runtime.manifest.json, out = release/runtime.
 *
 * The engine consumes the pack when the manifest (or its override file) adds:
 *
 *   "pack": { "url": "<download url>", "sha256": "<from the .sha256 file>" }
 *
 * Windows-only (x64) for now; archives compress with System32 tar (deflate);
 * if 7-Zip is installed it is used instead (also deflate zip, faster).
 */

'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const prov = require('../provision.js')

const APP_DIR = path.join(__dirname, '..')

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`)
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback
}
const hasFlag = (name) => process.argv.includes(`--${name}`)

function fail(message) {
  console.error(`ERROR: ${message}`)
  process.exit(1)
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function findTar() {
  if (process.platform === 'win32' && fs.existsSync('C:\\Windows\\System32\\tar.exe')) {
    return 'C:\\Windows\\System32\\tar.exe'
  }
  return 'tar'
}

function findSevenZip() {
  for (const cand of [
    process.env.SEVENZIP || '',
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  ]) {
    if (cand && fs.existsSync(cand)) return cand
  }
  return null
}

function main() {
  if (process.platform !== 'win32') {
    console.warn('WARNING: packer targets Windows x64; on other platforms the layout name would be wrong.')
  }

  const manifest = readJsonSafe(path.join(APP_DIR, 'runtime.manifest.json')) || {}
  const ref = arg('ref', (manifest.dsh && manifest.dsh.ref) || null)
  const nodeVersion = arg('node-version', (manifest.node && manifest.node.version) || '22.19.0')
  const repoArg = arg('repo', '')
  const defaultRepo = path.join(path.dirname(APP_DIR), 'deepseek-harness')
  const repo = repoArg || process.env.DSH_DESKTOP_REPO || defaultRepo
  const outDir = path.resolve(arg('out', path.join(APP_DIR, 'release', 'runtime')))
  if (!ref) fail('缺少 ref(--ref 或 runtime.manifest.json 的 dsh.ref)')
  const refSafe = ref.replace(/[^A-Za-z0-9._-]/gu, '_')

  console.log(`ref        : ${ref}`)
  console.log(`node       : v${nodeVersion}`)
  console.log(`repo       : ${repo}`)
  console.log(`out        : ${outDir}`)

  // 1) Validate the source repo (installed + built).
  if (!fs.existsSync(path.join(repo, 'apps', 'cli', 'src', 'bin.ts'))) fail(`仓库缺少 apps/cli/src/bin.ts:${repo}`)
  if (!fs.existsSync(path.join(repo, 'node_modules', 'tsx'))) fail(`仓库缺少 node_modules/tsx —— 先执行 pnpm install:${repo}`)
  if (!fs.existsSync(path.join(repo, 'apps', 'web', 'dist', 'index.html'))) fail(`仓库缺少 apps/web/dist/index.html —— 先执行 pnpm run build:${repo}`)
  const repoPkg = readJsonSafe(path.join(repo, 'package.json')) || {}
  console.log(`repo ver  : ${repoPkg.version || '(unknown)'}`)

  // 2) Work dir.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pack-'))
  const keepWork = hasFlag('keep-work')
  const packRoot = path.join(work, 'dsh-runtime')
  fs.mkdirSync(packRoot, { recursive: true })
  const cleanup = () => { if (!keepWork) try { fs.rmSync(work, { recursive: true, force: true }) } catch { /* ignore */ } }

  try {
    // 3) Portable Node: download (mirror first, official fallback), verify, extract.
    const nodeDirName = `node-v${nodeVersion}-win-x64`
    const nodeZip = path.join(work, `${nodeDirName}.zip`)
    const nodeUrl = `https://nodejs.org/dist/v${nodeVersion}/${nodeDirName}.zip`
    const mirrorUrl = `https://npmmirror.com/mirrors/node/v${nodeVersion}/${nodeDirName}.zip`
    const nodeSha = (manifest.node && manifest.node.sha256) || ''
    console.log(`下载 Node.js v${nodeVersion}(npmmirror → nodejs.org)…`)
    // eslint-disable-next-line no-async-promise-executor
    ;(async () => {
      await prov.downloadCandidates([mirrorUrl, nodeUrl], {
        dest: nodeZip,
        sha256: nodeSha,
        label: 'Node.js',
        log: (line) => console.log(`  ${line}`),
        onProgress: (bytes, total) => {
          const mb = (v) => (v / 1048576).toFixed(0)
          process.stdout.write(`\r  ${mb(bytes)}/${total ? mb(total) : '?'} MB   `)
        },
      })
      console.log('')
      console.log(`解压 Node.js…`)
      const nodeFinal = path.join(packRoot, 'node', nodeDirName)
      prov.extractSingleTopDir(nodeZip, nodeFinal)
      if (!fs.existsSync(path.join(nodeFinal, 'node.exe'))) throw new Error('Node.js 压缩包结构异常')
      const run = spawnSync(path.join(nodeFinal, 'node.exe'), ['-v'], { encoding: 'utf8', timeout: 20_000 })
      const ver = (run.stdout || '').trim()
      if (!prov.atLeastNode(ver)) throw new Error(`Node.js 校验失败:${ver || '(无输出)'}`)
      console.log(`Node.js   : ${ver}`)

      // 4) Harness copy (minus .git) + built marker.
      const harnessDir = path.join(packRoot, 'harness', refSafe)
      console.log('复制仓库(不含 .git)…')
      fs.cpSync(repo, harnessDir, {
        recursive: true,
        filter: (src) => !/(^|[\\/])\.git([\\/]|$)/u.test(src),
      })
      prov.writeJson(path.join(harnessDir, '.dsh-desktop-built'), {
        builder: 'make-runtime-pack.js',
        engine: prov.ENGINE_VERSION,
        ref,
        repoVersion: repoPkg.version || '',
        at: new Date().toISOString(),
      })
      console.log('仓库就绪(含依赖与构建产物)')

      // 4b) Record every symlink alias under the pack root. Windows tar.exe
      // recreates symlinks unreliably, so the engine re-materializes aliases
      // itself (directory junctions + file copies) from this list.
      const aliases = []
      const walk = (dir, rel) => {
        let ents
        try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const e of ents) {
          const full = path.join(dir, e.name)
          const childRel = rel ? `${rel}/${e.name}` : e.name
          if (e.isSymbolicLink()) {
            let target = ''
            try { target = fs.readlinkSync(full) } catch { continue }
            let type = 'file'
            try { type = fs.statSync(full).isDirectory() ? 'dir' : 'file' } catch { /* broken locally */ }
            aliases.push({ rel: childRel.replace(/\\/gu, '/'), target, type })
            continue // never descend into a link
          }
          if (e.isDirectory()) walk(full, childRel)
        }
      }
      walk(packRoot, '')
      console.log(`记录符号链接别名:${aliases.length} 个`)

      // 5) pack.json
      prov.writeJson(path.join(packRoot, 'pack.json'), {
        format: 1,
        engine: prov.ENGINE_VERSION,
        ref,
        repoVersion: repoPkg.version || '',
        nodeRel: `node/${nodeDirName}/node.exe`.replace(/\\/gu, '/'),
        harnessRel: `harness/${refSafe}`.replace(/\\/gu, '/'),
        aliases,
        createdAt: new Date().toISOString(),
      })

      // 6) Compress: prefer 7-Zip (deflate zip), fall back to System32 tar.
      fs.mkdirSync(outDir, { recursive: true })
      const zipOut = path.join(outDir, `dsh-runtime-${refSafe}-win-x64.zip`)
      const sevenZip = findSevenZip()
      let res
      if (sevenZip) {
        console.log(`压缩(7-Zip):${sevenZip}`)
        res = spawnSync(sevenZip, ['a', '-tzip', '-mx=9', '-mmt=on', zipOut, 'dsh-runtime'], { cwd: work, stdio: 'pipe', encoding: 'utf8', timeout: 60 * 60_000 })
      } else {
        console.log('压缩(tar deflate;安装 7-Zip 可加快并减小体积)')
        res = spawnSync(findTar(), ['-a', '-cf', zipOut, 'dsh-runtime'], { cwd: work, stdio: 'pipe', encoding: 'utf8', timeout: 60 * 60_000 })
      }
      if (res.status !== 0 || res.error) {
        throw new Error(`压缩失败:${res.error ? res.error.message : (res.stderr || res.stdout || '').slice(-1200)}`)
      }
      if (!fs.existsSync(zipOut)) throw new Error('压缩后未找到产物')

      // 7) Checksum + summary.
      const sha = prov.sha256File(zipOut)
      fs.writeFileSync(`${zipOut}.sha256`, `${sha}  ${path.basename(zipOut)}\n`)
      const sizeMb = (fs.statSync(zipOut).size / 1048576).toFixed(0)
      console.log('')
      console.log('完成:')
      console.log(`  包    : ${zipOut}(${sizeMb} MB)`)
      console.log(`  校验和: ${zipOut}.sha256`)
      console.log('')
      console.log('发布后在 runtime.manifest.json(或 %APPDATA% 同名覆盖文件)加入:')
      console.log(`  "pack": { "url": "<上传后的下载地址>", "sha256": "${sha}" }`)
    })().then(() => cleanup()).catch((err) => {
      console.error('打包失败:', err && err.stack ? err.stack : err)
      cleanup()
      process.exit(1)
    })
  } catch (err) {
    console.error('打包失败:', err && err.stack ? err.stack : err)
    cleanup()
    process.exit(1)
  }
}

main()
