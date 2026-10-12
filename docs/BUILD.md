# Build, Test and Package

Requirements: Windows 10/11 x64, Node.js 24.x, npm 11.x. No C++ build tools are needed (better-sqlite3 ships N-API prebuilds).

```powershell
npm ci                 # install exact locked versions
npm run dev            # run with hot reload (data: %APPDATA%\BPO Asset Management (development)\data)
npm run typecheck      # strict TypeScript, main + renderer
npm test               # unit + integration tests against real SQLite files
npm run test:e2e       # builds, then drives the Electron app with Playwright (temporary data folder)
npm run package:dir    # unpacked build in release\win-unpacked
npm run package:win    # NSIS installer in release\
npm run smoke:packaged # runs the packaged exe in --smoke-test mode against a throwaway data folder
```

> VS Code terminals set `ELECTRON_RUN_AS_NODE=1`. Always use the npm scripts above; they remove it.

## Release verification checklist (current state)
1. `npm run verify` passes.
2. `npm run test:e2e` passes.
3. `npm run package:win` succeeds; then `npm run smoke:packaged` reports all checks PASS. The smoke test proves: native SQLite loads, migrations run, first-run setup, login, payload validation, backup create + validate, the renderer is sandboxed with only the preload API, and data persists across reopen.
4. Manual on a clean Windows machine (not yet done — KNOWN_ISSUES K3): install, launch, create data, close/reopen, install the next version over it, confirm data retained, uninstall and confirm `%APPDATA%\BPO Asset Management\data` is kept.

## Data locations
| Environment | Folder |
|---|---|
| Production (installed) | `%APPDATA%\BPO Asset Management\data` |
| Development (`npm run dev`) | `%APPDATA%\BPO Asset Management (development)\data` |
| Tests / smoke | temporary folder via `BPOAM_DATA_DIR` |

Each contains `database\`, `documents\`, `backups\`, `logs\`. The installer never contains user data, and uninstalling keeps the data folder.

## Packaged-binary hardening
Electron fuses (see `electron-builder.yml`) disable RunAsNode, NODE_OPTIONS and inspector flags and enforce asar integrity. The installer is currently **unsigned** (KNOWN_ISSUES K1).
