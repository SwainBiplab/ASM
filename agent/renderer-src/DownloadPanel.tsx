import { useState } from 'react'
import type { OfflineLeaseView } from '@shared/api'
import { Alert, Button, Panel, SelectField, TextField } from '../../web/src/components/ui'

/**
 * Lost in the W9.6 rewrite (replaced the old renderer's own sign-in/list/download controls with
 * the real `AssetsPage`, but never re-added a trigger for the one thing only this screen can do:
 * actually call the cloud to list/download a leased work package). Re-added here, now styled with
 * the same `ui.tsx` components as the rest of the app instead of the original plain HTML inputs.
 */
export function DownloadPanel({ onDownloaded }: { onDownloaded: () => void }) {
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:3000')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [leases, setLeases] = useState<OfflineLeaseView[]>([])
  const [leaseId, setLeaseId] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const credentials = () => ({ baseUrl, username, password })

  // Only an active/expired lease with an asset scope can ever be downloaded (`leases.getScopedAssets`
  // rejects anything else) -- filtering here, not just labeling status in the dropdown, is what
  // actually stops a released/reclaimed/code-range lease from being selected (even by default) and
  // producing a confusing "does not have an asset scope" error for what's really a spent lease.
  const downloadable = (l: OfflineLeaseView) => l.scopeType === 'asset' && (l.status === 'active' || l.status === 'expired')

  const listLeases = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const result = await window.agent.cloud.listLeases(credentials())
      const usable = result.filter(downloadable)
      setLeases(usable)
      setLeaseId(usable[0]?.id ?? '')
      if (usable.length) {
        setStatus(`${usable.length} work package(s) available to download.`)
      } else if (result.length) {
        setStatus(`You hold ${result.length} lease(s), but none are currently downloadable (released, reclaimed, or an asset-code-range scope). Ask an administrator to grant a new one under "Offline agents" with scope "Specific assets".`)
      } else {
        setStatus('You hold no leases at all. Ask an administrator to grant one under "Offline agents" (scope: "Specific assets").')
      }
    } catch (err) {
      setStatus(`Could not list work packages: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const download = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const result = await window.agent.cloud.downloadLeaseAssets({ ...credentials(), leaseId })
      setStatus(`Downloaded ${result.downloaded} asset(s) for work package ${result.leaseId}.`)
      onDownloaded()
    } catch (err) {
      setStatus(`Download failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title="Sign in and download a work package (requires network)">
      <div className="form-grid">
        <TextField label="Server URL" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        <TextField label="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
        <TextField label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <Button disabled={busy || !username || !password} onClick={() => void listLeases()}>
        List my work packages
      </Button>{' '}
      {leases.length ? (
        <>
          <SelectField label="Work package" value={leaseId} onChange={setLeaseId} options={leases.map((l) => ({ value: l.id, label: `${l.id} (${l.status}, ${l.assetIds.length} asset(s))` }))} />
          <Button variant="primary" disabled={busy} onClick={() => void download()}>
            Download selected work package
          </Button>
        </>
      ) : null}
      {status ? <Alert tone="info">{status}</Alert> : null}
    </Panel>
  )
}
