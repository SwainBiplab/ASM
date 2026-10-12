import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { SessionInfo } from '@shared/api'
import { Alert, PageHeader } from '../../web/src/components/ui'
import { ErrorBoundary } from '../../web/src/features/shell/ErrorBoundary'
import { AssetsPage } from '../../web/src/features/assets/AssetsPage'
import { setCallTransport } from '../../web/src/api'
import '../../web/src/styles/app.css'
import { desktopCallTransport } from './desktopApiAdapter'
import { DownloadPanel } from './DownloadPanel'
import { LocalPanels } from './LocalPanels'

/**
 * W9.6: the same `AssetsPage` the cloud UI runs, hosted here instead of rebuilt. The only wiring
 * this file does is (1) install the offline `CallTransport` once, before anything renders, and (2)
 * construct a synthetic, read-only `SessionInfo` carrying only `assets.view` -- `AssetsPage`'s own
 * existing `has('assets.update')`/`has('assets.create')`/etc. checks are what actually hide every
 * mutation control; no component code was changed to make this work.
 */
setCallTransport(desktopCallTransport)

const OFFLINE_SESSION: SessionInfo = {
  user: { id: 'local-offline', username: 'offline', displayName: 'Offline (local cache)', mustChangePassword: false },
  permissions: ['assets.view'],
  roles: [],
  idleTimeoutMinutes: 0,
  locked: false
}

const STALE_AFTER_MS = 24 * 60 * 60 * 1000

function SyncBanner({ lastSyncedAt, scopeLeaseId }: { lastSyncedAt: string | null; scopeLeaseId: string | null }) {
  if (!lastSyncedAt) return <Alert tone="warn">No inventory has been downloaded yet. Connect to the network to download a work package.</Alert>
  const stale = Date.now() - new Date(lastSyncedAt).getTime() > STALE_AFTER_MS
  return (
    <Alert tone={stale ? 'warn' : 'info'}>
      Offline mode &middot; work package {scopeLeaseId} &middot; last synchronized {new Date(lastSyncedAt).toLocaleString()}
      {stale ? ' -- STALE: this may not reflect current cloud data.' : ''}
    </Alert>
  )
}

function DeviceIdNotice({ deviceId }: { deviceId: string | null }) {
  if (!deviceId) return null
  return (
    <Alert tone="info">
      This device's id is <code>{deviceId}</code>. Enroll it once under "Offline agents" in the web app (an administrator must then approve it) before you can request a lease.
    </Alert>
  )
}

function AgentShell() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sync, setSync] = useState<{ lastSyncedAt: string | null; scopeLeaseId: string | null; snapshotId: string | null }>({ lastSyncedAt: null, scopeLeaseId: null, snapshotId: null })
  const [deviceId, setDeviceId] = useState<string | null>(null)

  useEffect(() => {
    window.agent.assets.listLocal().then((r) => setSync({ lastSyncedAt: r.lastSyncedAt, scopeLeaseId: r.scopeLeaseId, snapshotId: r.snapshotId }))
  }, [selectedId])

  useEffect(() => {
    window.agent.device.getLocalDevice().then((d) => setDeviceId(d.id))
  }, [])

  const navigate = (route: string) => setSelectedId(route.startsWith('assets/') ? route.slice('assets/'.length) : null)
  const refreshSync = () => window.agent.assets.listLocal().then((r) => setSync({ lastSyncedAt: r.lastSyncedAt, scopeLeaseId: r.scopeLeaseId, snapshotId: r.snapshotId }))

  return (
    <div className="app-shell">
      <PageHeader title="BPO Offline Agent" description="Read-only cached asset browsing, plus local-only audit observations and maintenance requests. No offline create, edit, allocation, transfer, or return." />
      {!sync.lastSyncedAt ? <DeviceIdNotice deviceId={deviceId} /> : null}
      <SyncBanner lastSyncedAt={sync.lastSyncedAt} scopeLeaseId={sync.scopeLeaseId} />
      <DownloadPanel onDownloaded={refreshSync} />
      <ErrorBoundary>
        <AssetsPage session={OFFLINE_SESSION} selectedId={selectedId} navigate={navigate} />
      </ErrorBoundary>
      <ErrorBoundary>
        <LocalPanels selectedAssetId={selectedId} currentSnapshotId={sync.snapshotId} />
      </ErrorBoundary>
    </div>
  )
}

window.addEventListener('error', (e) => console.error('[agent-ui] uncaught error', e.error ?? e.message))
window.addEventListener('unhandledrejection', (e) => console.error('[agent-ui] unhandled rejection', e.reason))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AgentShell />
  </StrictMode>
)
console.log('[agent-ui] root render call completed')
