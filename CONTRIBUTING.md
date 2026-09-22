# Contributing

Thanks for helping with **DeepSeek Harness Desktop**, an Electron shell around
the [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) Web
GUI. It lives **outside** that repository: it never modifies the checkout (the
only optional, separately distributed change is the start-at-login settings
row in `share/dsh-settings-autostart-row.patch`).

## Development quick start

Prerequisites: Windows 10/11, Node.js ≥ 22.19, and a sibling
`deepseek-harness` checkout that has run `pnpm install && pnpm run build`.

```powershell
npm install                 # installs Electron (needs network, ~200 MB)
npm run smoke               # headless boot check against the real service
npm run e2e                 # real-window regression
npm run provision:selftest  # provisioning engine offline self-test
npm run update:selftest     # self-update engine offline drill (local fixture server)
npm run update:probe        # update window + preload bridge + one live release check
npm start                   # run the app
```

Common tasks:

```powershell
npm run dist        # NSIS installer + portable exe (win x64)
npm run dist:cn     # same, downloads via npmmirror (CN-friendly)
npm run pack:runtime  # build the optional prebuilt runtime pack
```

## UI text / i18n

All shell-owned strings live in `locales.js` (`zh` / `en` dictionaries).
Add or change text there — do not hardcode user-facing copy in `main.js`,
`provision.html`, `build/installer.nsh`, or PowerShell scripts. Language
resolution is `settings.language` (`auto` follows the OS) with English as the
fallback dictionary. Run a quick dictionary smoke with:

```powershell
node -e "const l=require('./locales.js'); console.log(l.makeDictionary('en','en-US').t('tray.quit'))"
```

## Provisioning engine

`provision.js` is pure Node (no Electron import) and stays runnable offline:

```powershell
node provision.js --selftest
```

Engine behaviors worth preserving:

- idempotent, resumable steps (every stage probes its own success marker);
- extraction chain: tar.exe first, then the built-in zip reader whenever tar
  fails (Windows machines without symlink privileges);
- child commands pin the portable Node directory first on `PATH`; build runs
  get a ref-derived `DSH_CLIENT_COMMIT_HASH` when the checkout has no `.git`;
- prebuilt packs record node_modules aliases in `pack.json`; the engine
  re-materializes them as junctions/copies after extraction.

## Repository hygiene

- Never commit: `settings.json`, `release/`, `node_modules/`, logs, or any
  machine-specific absolute path in docs or code comments.
- Version bumps: `package.json` `version` drives the artifact names; bump it
  together with the release and update the README history table.
- License: MIT (see `LICENSE`). Third-party components keep their own licenses.
