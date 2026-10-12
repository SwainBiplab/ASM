import { join } from 'node:path'
import { app, BrowserWindow, Menu } from 'electron'
import { AppContainer } from './app/container'
import { resolveDataPaths, resolveDataRoot, resolveEnvironment } from './app/env'
import { APP_ORIGIN, hardenApplication, registerAppProtocol, registerPrivilegedScheme } from './app/security'
import { runSmokeTest } from './app/smoke'
import { DEMO_ADMIN, DEMO_USER_PASSWORD, seedDemoData } from './app/demoSeed'
import { buildCommands } from './ipc/commands'
import { createDispatcher } from './ipc/dispatcher'
import { registerIpcHandlers } from './ipc/register'
import { createFileLogger } from './logging/logger'
import { openWithSystem, pickCsvFile, pickDocument, pickSavePath } from './import/filePicker'

const PRODUCT_NAME = 'BPO Asset Management'

const smokeMode = process.argv.includes('--smoke-test')
// Development-only demo data (npm run seed:demo); refused in the packaged app.
const seedMode = process.argv.includes('--seed-demo') && !app.isPackaged
const smokeReport = process.argv.find((a) => a.startsWith('--smoke-report='))?.slice('--smoke-report='.length)
const devServerUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined

const environment = resolveEnvironment(app.isPackaged, process.env['BPOAM_ENV'])
const paths = resolveDataPaths(
  resolveDataRoot({
    appDataDir: app.getPath('appData'),
    productName: PRODUCT_NAME,
    environment,
    overrideDir: process.env['BPOAM_DATA_DIR']
  })
)
// Keep Chromium's own profile data next to (not inside) our business data.
app.setPath('userData', join(paths.root, '..', 'chromium'))

const logger = createFileLogger(paths.logsDir, { echo: environment === 'development' })

registerPrivilegedScheme()
app.enableSandbox()

if (!smokeMode && !app.requestSingleInstanceLock()) {
  // One process owns the SQLite database and the session.
  if (seedMode) console.error('The application is already running. Close it, then run the seed again.')
  app.exit(1)
}

process.on('uncaughtException', (err) => logger.error('process', 'Uncaught exception', { error: err }))
process.on('unhandledRejection', (reason) => logger.error('process', 'Unhandled rejection', { error: reason }))

let mainWindow: BrowserWindow | null = null
let container: AppContainer | null = null

function createMainWindow(show: boolean): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1100,
    minHeight: 680,
    show: false,
    title: PRODUCT_NAME,
    backgroundColor: '#f5f6f8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: !app.isPackaged
    }
  })
  if (show) win.once('ready-to-show', () => win.show())
  void win.loadURL(devServerUrl ?? `${APP_ORIGIN}/index.html`)
  return win
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(async () => {
  logger.info('startup', 'Application starting', { version: app.getVersion(), environment, dataDirectory: paths.root, smokeMode })
  if (app.isPackaged) Menu.setApplicationMenu(null)

  const allowedOrigins = new Set([APP_ORIGIN, ...(devServerUrl ? [new URL(devServerUrl).origin] : [])])
  registerAppProtocol(join(__dirname, '../renderer'))
  hardenApplication(allowedOrigins, devServerUrl)

  container = new AppContainer(paths, logger, {
    appVersion: app.getVersion(),
    environment,
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node }
  })
  await container.init()

  const c = container
  c.pickImportFile = () => pickCsvFile(mainWindow)
  c.pickDocumentFile = () => pickDocument(mainWindow)
  c.pickSavePath = (name) => pickSavePath(mainWindow, name)
  c.openPath = openWithSystem
  const dispatch = createDispatcher({
    commands: buildCommands(c),
    resolveSession: () => c.resolveSession(),
    touchSession: () => c.sessions.touch(),
    logger
  })
  registerIpcHandlers(dispatch, allowedOrigins, logger)

  if (seedMode) {
    let code = 0
    try {
      if (c.startup.status === 'database_error') throw new Error(c.startup.error?.message ?? 'Database error')
      const summary = await seedDemoData(c)
      console.log(`
${summary.message}`)
      if (summary.counts) console.log(summary.counts)
      console.log(`
Data folder: ${paths.root}`)
      console.log(`Sign in as ${DEMO_ADMIN.username} / ${DEMO_ADMIN.password} (Super Admin)`)
      console.log(`Role demo users: assetmgr, ittech, facilities, procurement, deptmgr, hrofficer, finance, auditor / ${DEMO_USER_PASSWORD}`)
    } catch (err) {
      console.error('Seeding failed:', (err as Error).message)
      code = 1
    }
    c.shutdown()
    app.exit(code)
    return
  }

  mainWindow = createMainWindow(!smokeMode)
  mainWindow.on('closed', () => (mainWindow = null))

  if (smokeMode) {
    const code = await runSmokeTest(c, dispatch, mainWindow, smokeReport ?? join(paths.root, 'smoke-report.json'))
    c.shutdown()
    app.exit(code)
  }
})

app.on('window-all-closed', () => {
  container?.shutdown()
  app.quit()
})
