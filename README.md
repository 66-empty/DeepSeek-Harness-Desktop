# DeepSeek Harness Desktop

**English** | [中文](README.zh-CN.md)

An Electron shell that turns the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI into a real Windows desktop app: double-click an icon and the GUI opens in its own window while the checkout's `dsh web` service starts in the background. This directory is the **out-of-repo** shell — it never modifies the deepseek-harness checkout (the only optional, separately distributed change is the start-at-login row in `share/`, see [Optional checkout patch](#optional-checkout-patch)).

Current version: **0.4.1** (Windows x64; NSIS installer + portable exe under `release/`). UI language: English / 中文 (follows the OS by default, switchable from the tray). Installed builds update themselves from GitHub Releases (see [App updates](#app-updates-self-update)).

## Features

- **Automatic runtime setup (two channels)** — regular users no longer install Node.js or deepseek-harness manually. First run guides them through:
  - *online source build*: portable Node.js + a pinned source zip of the checkout → pnpm install → build, or
  - *prebuilt runtime pack*: a zip produced on the release machine, downloaded and extracted as-is (no pnpm/build on the user's side; see [Packaging](#packaging)).
  Mirrors for CN networks, live progress + logs, cancel and resume included.
- **Works without admin rights** — no Administrator or Windows Developer Mode needed: when `tar.exe` cannot create symlinks the engine falls back to a built-in zip reader, pack aliases are rebuilt as junctions, and git-less source zips get a ref-derived build commit. A machine-installed old Node.js cannot hijack the build (portable Node is pinned first on `PATH`).
- **Self-update** — installed builds check GitHub Releases on startup (and on demand from the tray), download the new installer with resume, verify it (asset digest / published `.sha256` + size + PE sanity), then upgrade in place silently and relaunch. Portable builds get the verified file instead, since they cannot replace their own exe.
- **Standalone window** — no browser tabs/chrome; window is the app.
- **Tray resident** — closing the window hides to the tray and keeps the service running; tray menu can reopen the window, open the GUI in the system browser, restart the service, switch language, or quit (stop service).
- **Start at login** — runs `--hidden` in the background after sign-in; the tray checkbox and the GUI's Settings → General row share one setting.
- **Single instance** — a second launch focuses the existing window instead of duplicating.
- **Automatic port** — default `port: 0` lets the OS pick a free port; never collides with other `dsh web` instances.
- **Hardened shell** — `contextIsolation` + `sandbox`, no `nodeIntegration`; external http(s) links open in the system browser; navigation is locked to the GUI origin.
- **Visible failures** — main-process crashes are written to `desktop.log` + `crashes.log` and shown in an error dialog (0.2.1+); a failing window icon falls back to the exe icon so the taskbar never shows a blank button (0.2.6+).
- **Self-tests** — `smoke` / `e2e` / `probe` / `provision:selftest` / `update:selftest` / `update:probe` (see [Automated checks](#automated-checks)).

## How it works

The harness GUI is not a static page — only the `dsh web` process serves it (injecting `window.__DSH_BOOT__` and owning /api and RPC). The shell therefore:

1. **Resolves resources** — reads `settings.json`/environment for the checkout and node.exe and validates the checkout (`apps/cli/src/bin.ts`, `node_modules/tsx`). No checkout at all → opens the **setup wizard** (`autoProvision`, default on) or the legacy directory picker (`autoProvision: false`).
2. **Starts the backend** in the checkout directory (hidden window, PATH pinned to the resolved Node dir so a machine-wide old Node cannot interfere):

   ```text
   node --import tsx/esm apps/cli/src/bin.ts web --no-open --port <port> [extraArgs…]
   ```

   Same launch path as `pnpm dsh web`; `--no-open` keeps the CLI from opening a browser; `--port 0` asks the OS for a free port.
3. **Waits for readiness** — parses `dsh web: http://127.0.0.1:<port>/?token=...` from stdout (90 s timeout, recent log tail on failure).
4. **Loads the GUI** — the main window loads the authenticated URL; the preload exposes `window.__dshDesktopShell` (get/setAutoStart) so the GUI registers the "Start at login" row only inside the shell; the wizard window uses a separate `window.__dshProvision` bridge.
5. **Lifecycle** — closing the window hides to the tray (service keeps running); real quit (tray → Quit or Ctrl+Q) terminates the backend process tree with `taskkill /T /F`. Session data is persisted per event, so quitting is safe. An unexpected backend exit offers "Restart service / Quit" (tray balloon when the window is hidden).

## First-run automatic setup

When no usable checkout is found (no `settings.json` `repoPath`, no `DSH_DESKTOP_REPO`, no sibling `deepseek-harness` folder), the shell opens the **runtime setup wizard** and provisions:

| Step | Content | Size |
|---|---|---|
| Node.js | portable Node (official dist or npmmirror mirror) | ≈35 MB |
| deepseek-harness | pinned tag source zip (GitHub or proxy) | ≈20–150 MB |
| pnpm + deps | pnpm installed into the portable Node, then `pnpm install` | ≈1.4 GB download |
| Build | `pnpm run build` (web client + packages, ~3–10 min) | — |

On success the shell writes `settings.json` (`repoPath`/`nodePath` pointing at the provisioned runtime) and boots the GUI. The wizard offers:

- three source modes — Automatic (probes the network), China mirrors (preferred), Direct official — switchable at any time;
- live progress and logs (collapsible); closing the window continues in the background;
- cancel + resume: interrupted runs skip finished steps; downloads resume from partial files;
- "Choose an existing checkout…" for developers/intranet setups;
- Quit (cancels and stops).

Artifacts live under the user-data directory (survive app upgrades/uninstalls):

```text
%APPDATA%\DeepSeek Harness Desktop\
├─ settings.json                   runtime config
├─ runtime.manifest.json           (optional) manifest override
└─ runtime\
   ├─ node\…                       portable Node.js
   ├─ harness\<ref>\               checkout (deps installed + built)
   ├─ provisioned.json             provisioning record
   ├─ .downloads\                  downloaded zips (reusable, deletable)
   └─ .cache\                      npm / pnpm caches
```

Roughly **3 GB** disk and **10–40 minutes** depending on the network. Notes:

- network required; fully offline machines should use "Choose an existing checkout…";
- the pinned source is the upstream tag (default `dsh-v0.1.2-alpha.5`) and does **not** contain the local optional patch — tray start-at-login always works regardless;
- newer refs install into separate directories (isolated by ref); old ones can be deleted manually.

## Configuration

### Where `settings.json` lives

- Packaged builds (installer / portable / win-unpacked) run from the read-only `app.asar`: settings always live at `%APPDATA%\DeepSeek Harness Desktop\settings.json`.
- Source/zip layout: beside the app folder when it is writable, else `%APPDATA%\DeepSeek Harness Desktop\settings.json`.

### Fields

| Field | Default | Meaning |
|---|---|---|
| `repoPath` | `""` (auto) | deepseek-harness checkout path; empty → try `DSH_DESKTOP_REPO`, sibling `../deepseek-harness`, then wizard/picker |
| `nodePath` | `null` (auto) | absolute node.exe; detection order: `DSH_DESKTOP_NODE` → Program Files nodejs → sibling of Electron → PATH `node` |
| `port` | `0` | `0` = free port each boot; a fixed port (e.g. `3080`) must be free |
| `closeToTray` | `true` | closing the window keeps the app in the tray |
| `autoStart` | `true` | start at login (tray + GUI General row share this field) |
| `extraArgs` | `[]` | extra arguments passed to `dsh web` (e.g. `["--patch","xxx.yml"]`) |
| `autoProvision` | `true` | first-run auto-install wizard when no checkout exists; `false` restores the legacy picker |
| `mirrorMode` | `"auto"` | provisioning source: `auto` / `cn` / `direct` (switchable in the wizard) |
| `language` | `"auto"` | UI language: `auto` (OS) / `zh` / `en` (0.3.0+; also switchable from the tray) |
| `dshRef` | `null` | override the deepseek-harness ref (default from manifest) |
| `nodeMirrorBase` / `registryMirror` / `githubProxies` | `null` | advanced mirror overrides (npmmirror + built-in proxies by default) |
| `checkUpdates` | `true` | silent release check on startup (tray checkbox mirrors it) |
| `skipVersion` | `""` | version the user chose to skip (e.g. `0.4.1`) |
| `updateIncludePrerelease` | `false` | also consider pre-releases |
| `updateMirror` | `""` | optional prefix for GitHub download URLs (e.g. `https://ghfast.top`); empty = direct, then built-in accelerators |
| `updateRepo` | `""` (built-in) | `owner/name` of the release repository, for forks |

Changes to `port`/`extraArgs`/`repoPath` apply after tray → Restart service.

### Manifest overrides (`runtime.manifest.json`)

The default manifest ships inside the app; placing a `runtime.manifest.json` next to `settings.json` merges over it (top-level and `dsh`/`node`/`pnpm` nodes). Commonly edited fields: `dsh.ref`/`dsh.url`/`dsh.sha256`, `node.version`/`node.url`/`node.sha256`, `pnpm.version`, `registry`/`registryMirror`, optional `pack.url`/`pack.sha256` (prebuilt runtime pack channel).

> Dev testing: start with `DSH_DESKTOP_FORCE_PROVISION=1` to open the wizard even when a checkout exists.

### Switching the provisioned Node.js version

Constraint: the harness engines accept **`^22.19.0 || >=24.0.0`** only (20/23 are rejected). The portable Node is independent of any system Node/nvm.

- Edit the manifest override (`node.version`, `node.url`, `node.sha256` from the SHASUMS file on nodejs.org/npmmirror);
- **delete `%APPDATA%\DeepSeek Harness Desktop\runtime\node`** — the engine reuses any existing Node that passes the version gate, so removal forces a re-download;
- restart the wizard: it resumes and only redoes "new Node → build";
- prebuilt packs embed their Node: rebuild with `npm run pack:runtime -- --node-version 24.8.0` and switch `pack.url`;
- dev/zip layout: point `settings.json` `nodePath` or `DSH_DESKTOP_NODE` at any node.exe, then Restart service (provisioning always uses its own portable Node — use "Choose an existing checkout…" to run your own).

## App updates (self-update)

The shell updates **itself** from this repository's GitHub Releases; the harness **runtime** is versioned separately and is still installed/updated by the setup wizard (the wizard offers a shortcut whenever an app upgrade pins a newer dsh ref — see `runtimeOutdated` in the update window footer).

How it works (`updater.js`, pure Node + `--selftest`):

1. **Check** — `GET /repos/<repo>/releases/latest` (or `/releases` when pre-releases are enabled), semver comparison including pre-release identifiers against `app.getVersion()`.
2. **Download** — `DeepSeek-Harness-Desktop-Setup-<version>.exe` into `%APPDATA%\DeepSeek Harness Desktop\updates`, resumable (`Range`) and mirror-aware: `updateMirror` prefix → direct GitHub → built-in accelerators (`mirrorMode: cn` tries the accelerators first).
3. **Verify** — GitHub's asset `digest`, else the published `.sha256` sidecar; then size and PE-header checks. Any mismatch deletes the file.
4. **Install** — `Setup-<version>.exe --updated /S --force-run`: electron-builder's NSIS installer skips its pages, upgrades the registry-recorded install directory in place, and relaunches the app.

Where it surfaces:

| Entry point | Behavior |
|---|---|
| Startup (8 s after launch) | silent check; a newer version shows a dialog — *Update now* / *Later* / *Skip this version* |
| Autostart (`--hidden`) | tray balloon only, never a modal dialog |
| Tray → Check for updates… | opens the update window (version, release notes, progress, options) |
| Tray → ⬆ Update available | appears while an update is pending |
| App menu → Check for updates… | same window |

Notes and limits:

- The app currently installed must be ≥ 0.4.0 — earlier builds have no updater, so the first hop is a manual install. Afterwards upgrades are one click.
- The update window is a separate window: **closing it does not stop the download** (it resumes/picks up from disk when reopened); quit or *Cancel* stops it, keeping the partial file for resume.
- Portable builds cannot replace their own exe: they download + verify the installer and offer *Show file*. Unpackaged dev runs behave the same way (`DSH_DESKTOP_FORCE_UPDATE_INSTALL=1` forces the real hand-off for testing).
- Behind a proxy/CDN that blocks GitHub, set `updateMirror` (e.g. `https://ghfast.top`) or switch `mirrorMode` to `cn`.
- The installer is not code-signed, so Windows SmartScreen may warn on the very first install; in-place upgrades are silent.

## Quick start (dev / zip layout)

Prerequisites: Windows 10/11, Node.js ≥ 22.19, and a sibling `deepseek-harness` checkout that has run `pnpm install && pnpm run build`.

```powershell
cd <repo>\dsh-desktop-app
npm install                          # installs Electron (~200 MB, needs network)
npm run smoke                        # optional headless boot check
npm run e2e                          # optional real-window regression
npm run probe                        # optional UI probe of the autostart row
powershell -ExecutionPolicy Bypass -File scripts\make-icon.ps1
powershell -ExecutionPolicy Bypass -File scripts\create-shortcuts.ps1
```

Then launch the **DeepSeek Harness** shortcut. If the checkout is not the sibling folder, write `settings.json` or set `DSH_DESKTOP_REPO`.

### Daily use

| Action | Effect |
|---|---|
| Double-click icon | start (or focus) the app, start `dsh web`, open the GUI |
| Window close button | hide to tray by default (service keeps running) |
| Click tray icon | open the main window |
| Tray → Open in system browser | open the current GUI URL in the default browser |
| Tray → Restart service | restart the backend (re-reads settings.json) |
| Tray → Check for updates… | open the update window (version check + release notes) |
| Tray → Language | switch UI language immediately |
| Tray → Quit (stop service) | kill the backend process tree and exit |
| Ctrl+R / F12 / Ctrl+Q | reload / devtools / quit |

Logs: main process + `dsh web` output go to `%USERPROFILE%\.dsh-desktop-logs\desktop.log` (2 MB cap); tray → Open log folder.

## Automated checks

| Command | Verifies |
|---|---|
| `npm run smoke` | headless: boot the real service → parse URL → HTTP probe → exit |
| `npm run e2e` | real window: GUI page loads → auto-exit |
| `npm run probe` | real window DOM: opens Settings → General, asserts the "Start at login" row + bridge (`DSH_PROBE_TOGGLE=1` toggles twice) |
| `npm run provision:selftest` | engine offline self-test (no network/Electron) |
| `npm run update:selftest` | updater offline drill: semver, release parsing, asset picking, download/resume/verify against a local fixture server |
| `npm run update:probe` | real window: loads update.html through the preload bridge, runs one live release check, fails on renderer console errors |

> `probe` expects the optional checkout patch + rebuilt web client; without it the row does not exist and probe exits 1 by design.

### Debug environment variables

`DSH_DESKTOP_REPO`, `DSH_DESKTOP_NODE`, `DSH_DESKTOP_FORCE_PROVISION=1`, `DSH_PROVISION_FILELOG=1`, `DSH_FORCE_NODE_UNZIP=1`, `DSH_PACK_DEBUG=1`, `DSH_DESKTOP_SKIP_UPDATE_CHECK=1` (never touch the update server), `DSH_DESKTOP_FORCE_UPDATE_INSTALL=1` (let a dev run hand the installer to Windows), `ELECTRON_MIRROR`/`ELECTRON_BUILDER_BINARIES_MIRROR`.

## Optional checkout patch

To show a "Start at login" switch inside the GUI (Settings → General), the checkout needs a small feature in `packages/client/ui-settings-general` (row component + controller + bridge contract + tests; registered only when `window.__dshDesktopShell` exists — plain browsers are untouched). The checkout contains no OS login logic; the shell owns it.

```powershell
git apply <repo>\dsh-desktop-app\share\dsh-settings-autostart-row.patch
pnpm run build:lib:client
pnpm run build:web
```

Without the patch everything works; only that row is missing (the tray toggle is equivalent). Want to upstream it? See `share/PR-INSTRUCTIONS.md`.

## Packaging

```powershell
npm run dist        # NSIS installer + portable exe (win x64)
npm run dist:cn     # same, downloads Electron/tools via npmmirror
npm run dist:dir    # only release/win-unpacked
```

Outputs (installer flow: welcome → license → per-user/all-users → folder → options → done; silent `/S` keeps both options on; uninstall removes program, shortcuts and the autostart entry but keeps `%APPDATA%` data):

- `DeepSeek-Harness-Desktop-Setup-<version>.exe` — assisted installer;
- `DeepSeek-Harness-Desktop-Portable-<version>.exe` — portable single exe;
- `win-unpacked/` — unpacked layout.

Version comes from `package.json`; artifacts use `${version}`. Build scripts pass `--publish never` (electron-builder would otherwise demand a `GH_TOKEN` and try to publish implicitly on tag pushes); the [build workflow](.github/workflows/build.yml) runs both engine self-tests, packages every push, attaches a `.sha256` checksum next to each exe on tag builds, and publishes the GitHub Release for `v*` tags — that release is what the in-app updater consumes.

**Releasing an update**: bump `package.json` version → commit → `git tag vX.Y.Z && git push origin vX.Y.Z` → wait for the workflow → verify the release lists `DeepSeek-Harness-Desktop-Setup-X.Y.Z.exe` (+ `.sha256`, `.blockmap`, portable). Installed apps then see the new version within one startup check.

### Prebuilt runtime pack (optional channel)

On a release machine with a built checkout:

```powershell
npm run pack:runtime   # options: --repo <path> --ref <tag> --node-version <v> --out <dir>
```

Produces `dsh-runtime-<ref>-win-x64.zip` (portable Node + full checkout with deps and built frontend, no `.git`) plus a `.sha256` file. Publish both, then enable the channel via the manifest override:

```json
{ "pack": { "url": "<zip download url>", "sha256": "<from .sha256>" } }
```

Users then only download → verify → extract (minutes), no pnpm/build on their machine. Remove the entry to fall back to the online source build. Notes: the archive is large (≈500 MB+ deflate; 7-Zip compresses faster/smaller), one pack per ref, and it ships the official sources (no `share/` patch). node_modules symlinks are recorded as an alias manifest in `pack.json` and rebuilt as junctions after extraction — no admin required.

## Sharing with others

- **Regular users (recommended)**: hand out the installer/portable from `npm run dist`; first run auto-provisions (needs network, 10–40 min).
- **Developers/intranet (Node + built checkout available)**: share the source zip (no `node_modules/`, `release/`, `settings.json`) and have them run `setup.ps1 -RepoPath <checkout>`.
- **Network-restricted machines**: switch the wizard to "China mirrors", or ship the prebuilt runtime pack.

## Troubleshooting

- **Double-click does nothing / no window**: usually an older instance still holds the single-instance lock (e.g. started at login with `--hidden`). End all `DeepSeek Harness Desktop` processes, uninstall the old version, then run the new one.
- **Old Node on PATH broke the build** (`Node.js v20.x … globSync`): fixed since 0.2.5 (portable Node pinned on PATH) — upgrade.
- **Extraction fails with `Can't create …` / tar errors**: machines without symlink privileges — fixed since 0.2.3 (built-in zip fallback); upgrade.
- **Blank taskbar icon**: 0.2.6+ falls back to the exe icon when the window icon cannot be read; if it is still blank, refresh the Windows icon cache (restart explorer.exe) or unpin/repin the taskbar icon.
- **Startup timeout / backend failure**: check `%USERPROFILE%\.dsh-desktop-logs\desktop.log`.
- **Two instances share session data**: don't run the shell while another `dsh web` (browser GUI) uses the same `~/.dsh`.
- **Antivirus/firewall**: first-run provisioning downloads and runs node/pnpm — allow `%APPDATA%\DeepSeek Harness Desktop\runtime` if blocked.
- **Uninstall residue**: the installer keeps `%APPDATA%\DeepSeek Harness Desktop` (settings + runtime, ≈3 GB). Uninstall first, then delete the folder for a full cleanup.
- **Update check fails**: the update window names the reason (HTTP 404, unreachable, checksum mismatch). CN networks and corporate proxies usually need an `updateMirror` prefix or `mirrorMode: cn`; "no published releases yet" means the tag's Release has not been built (see [Packaging](#packaging)).
- **Update download interrupted**: closing the window does not stop it — reopen to see progress. The partial file stays in `%APPDATA%\DeepSeek Harness Desktop\updates` and the next *Download update* resumes it.
- **The app did not restart after upgrading**: `--force-run` only applies to a silent install. If SmartScreen blocked the installer, run the Setup manually once; settings and data are untouched (they live in `%APPDATA%`).
- **Still on the old version after upgrading**: the NSIS installer upgrades the directory recorded in the registry — if the install folder was moved by hand, reinstall once with the new Setup.

## Version history

| Version | Highlights |
|---|---|
| 0.1.x | Shell basics: standalone window, tray, start-at-login, first-run checkout picker, smoke/e2e/probe |
| 0.2.0 | First-run automatic runtime provisioning (wizard, mirrors, resume) |
| 0.2.1 | Fixed packaged settings silently writing into app.asar; crash logging + error dialogs |
| 0.2.2 | Prebuilt runtime pack channel; node_modules alias manifest + junction rebuild |
| 0.2.3 | Built-in zip fallback (zip64, symlink placeholders); git-less source builds |
| 0.2.4 | pnpm global install pinned with `--prefix` |
| 0.2.5 | Portable Node pinned on PATH for provisioning and backend children |
| 0.2.6 | Window icon fallback to exe icon (blank taskbar fix) |
| 0.3.0 | i18n (zh/en UI + docs), language switch in tray, GitHub CI + Release, MIT |
| 0.4.0 | Self-update from GitHub Releases: startup check with skip-version, update window (notes/progress/options), resumable verified download, silent in-place NSIS upgrade; CI `--publish never` fix + `.sha256` assets |
| 0.4.1 | Probe the direct GitHub host before downloading (accelerators straight away on networks that block `github.com`); richer Release body shown in the update window |

## License

[MIT](LICENSE) © 2026 DeepSeek Harness Desktop contributors. Third-party components keep their own licenses.
