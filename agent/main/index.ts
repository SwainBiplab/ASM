import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { createLocalAssetRepository } from './db/assetsRepository'
import { createLocalDeviceStore, openAgentDatabase } from './db/connection'
import { createLocalMaintenanceRequestRepository } from './db/maintenanceRepository'
import { createLocalObservationRepository } from './db/observationsRepository'
import { createAgentDispatcher } from './dispatcher'
import { registerAgentIpcHandlers } from './ipcRegister'
import { AGENT_APP_ORIGIN, buildWebPreferences, hardenApplication, registerAppProtocol, registerPrivilegedScheme } from './security'

/**
 * W9.3-W9.5 entry point: a secure shell with a local SQLite database, a lease-scoped local asset
 * snapshot, a controlled cloud download, and purely local/unsynced audit observations and
 * maintenance requests against that snapshot -- no offline create/edit/delete of business data, no
 * sync, no outbox (hard boundary, DECISIONS.md D48/D49/D50). Runnable via `npm run agent:dev`
 * (bundles with esbuild, since the renderer is static/unbundled and doesn't need electron-vite).
 */

const PRODUCT_NAME = 'BPO Offline Agent'
app.setName(PRODUCT_NAME)

registerPrivilegedScheme()
app.enableSandbox()

if (!app.requestSingleInstanceLock()) app.exit(1)

app.whenReady().then(async () => {
  const dataDir = join(app.getPath('userData'), 'BPOAM-Agent')
  const db = openAgentDatabase(join(dataDir, 'agent.sqlite'))
  const store = createLocalDeviceStore(db)
  const assets = createLocalAssetRepository(db)
  const observations = createLocalObservationRepository(db, assets)
  const maintenance = createLocalMaintenanceRequestRepository(db, assets)
  const dispatch = createAgentDispatcher(store, assets, observations, maintenance)

  const rendererDir = join(__dirname, '../renderer')
  registerAppProtocol(rendererDir)
  const allowedOrigins = new Set([AGENT_APP_ORIGIN])
  hardenApplication(allowedOrigins)
  registerAgentIpcHandlers(dispatch, allowedOrigins, { warn: (obj, msg) => console.warn(msg, obj) })

  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    title: PRODUCT_NAME,
    autoHideMenuBar: true,
    webPreferences: buildWebPreferences(join(__dirname, '../preload/index.js'), !app.isPackaged)
  })
  win.once('ready-to-show', () => win.show())
  // Forwards the renderer's own console (including an uncaught React error) to this process's
  // stdout -- without it, nothing from the renderer is visible at all since devTools stay closed by
  // default; this is what actually made it possible to verify the real UI loads without a crash.
  win.webContents.on('console-message', (_event, _level, message) => console.log('[renderer]', message))
  await win.loadURL(`${AGENT_APP_ORIGIN}/index.html`)
})

app.on('window-all-closed', () => app.quit())
