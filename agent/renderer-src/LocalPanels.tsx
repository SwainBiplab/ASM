import { useEffect, useState } from 'react'
import { CONDITIONS, type AssetCondition } from '@shared/assets'
import { FAULT_CATEGORIES, MAINTENANCE_PRIORITIES, type FaultCategory, type MaintenancePriority } from '@shared/maintenance'
import { Alert, Button, Panel, SelectField, TextAreaField } from '../../web/src/components/ui'
import type { LocalMaintenanceRequestResult, LocalObservationResult } from '../ipcContract'

/**
 * W9.6: the agent's own local-only audit-observation and maintenance-request UI (W9.5), rebuilt
 * here with the same styled components the cloud UI uses (`web/src/components/ui.tsx`) instead of
 * `window.prompt`. There is no cloud equivalent of this panel to "reuse" -- `verifyItem`/`flagMissing`
 * and local maintenance requests only exist in the offline agent -- so this is new, not duplicated,
 * UI, and it is the only place that surfaces `syncStatus: 'local_pending'` records: every row here is
 * explicitly labeled "local, pending" and, once a scope switch has moved past it, "from a previous
 * work package" -- never shown as if it were a server-confirmed audit item or maintenance ticket.
 */

const snapshotLabel = (isCurrentSnapshot: boolean) => (isCurrentSnapshot ? 'current work package' : 'previous work package (kept as history)')

export function LocalPanels({ selectedAssetId, currentSnapshotId }: { selectedAssetId: string | null; currentSnapshotId: string | null }) {
  const [observations, setObservations] = useState<LocalObservationResult[]>([])
  const [requests, setRequests] = useState<LocalMaintenanceRequestResult[]>([])
  const [observedCondition, setObservedCondition] = useState<AssetCondition>('good')
  const [observationNotes, setObservationNotes] = useState('')
  const [missingNotes, setMissingNotes] = useState('')
  const [faultCategory, setFaultCategory] = useState<FaultCategory>('hardware')
  const [priority, setPriority] = useState<MaintenancePriority>('medium')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState<string | null>(null)

  const refresh = () => {
    window.agent.observations.listLocal().then(setObservations).catch(() => undefined)
    window.agent.maintenance.listLocal().then(setRequests).catch(() => undefined)
  }
  useEffect(refresh, [])

  const noScope = !currentSnapshotId
  const noSelection = !selectedAssetId

  async function recordVerify() {
    if (!selectedAssetId || !currentSnapshotId) return
    try {
      await window.agent.observations.verifyItem({ assetId: selectedAssetId, snapshotId: currentSnapshotId, observedCondition, notes: observationNotes || null })
      setStatus('Observation recorded locally (pending -- not yet a server audit record).')
      setObservationNotes('')
      refresh()
    } catch (err) {
      setStatus(`Could not record observation: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function recordMissing() {
    if (!selectedAssetId || !currentSnapshotId || !missingNotes.trim()) return
    try {
      await window.agent.observations.flagMissing({ assetId: selectedAssetId, snapshotId: currentSnapshotId, notes: missingNotes })
      setStatus('Missing-item observation recorded locally (pending -- not yet a server audit record).')
      setMissingNotes('')
      refresh()
    } catch (err) {
      setStatus(`Could not record observation: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function recordRequest() {
    if (!selectedAssetId || !currentSnapshotId || !description.trim()) return
    try {
      await window.agent.maintenance.createLocalRequest({ assetId: selectedAssetId, snapshotId: currentSnapshotId, faultCategory, priority, description })
      setStatus('Maintenance request recorded locally (pending -- not yet a server ticket).')
      setDescription('')
      refresh()
    } catch (err) {
      setStatus(`Could not record maintenance request: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <Panel title="Local observations and maintenance requests (offline, pending -- never a server record)">
      {status ? <Alert tone="info">{status}</Alert> : null}
      {noScope ? (
        <Alert tone="warn">No work package has been downloaded yet.</Alert>
      ) : noSelection ? (
        <Alert tone="info">Select an asset above to record an observation or maintenance request against it.</Alert>
      ) : (
        <div className="grid">
          <div>
            <SelectField label="Observed condition" value={observedCondition} onChange={(v) => setObservedCondition(v as AssetCondition)} options={CONDITIONS.map((c) => ({ value: c, label: c }))} />
            <TextAreaField label="Notes (optional)" value={observationNotes} onChange={setObservationNotes} />
            <Button onClick={recordVerify}>Record verification</Button>
          </div>
          <div>
            <TextAreaField label="Why is this asset missing?" value={missingNotes} onChange={setMissingNotes} />
            <Button variant="danger" onClick={recordMissing} disabled={!missingNotes.trim()}>
              Flag missing
            </Button>
          </div>
          <div>
            <SelectField label="Fault category" value={faultCategory} onChange={(v) => setFaultCategory(v as FaultCategory)} options={FAULT_CATEGORIES.map((c) => ({ value: c, label: c }))} />
            <SelectField label="Priority" value={priority} onChange={(v) => setPriority(v as MaintenancePriority)} options={MAINTENANCE_PRIORITIES.map((p) => ({ value: p, label: p }))} />
            <TextAreaField label="Describe the fault" value={description} onChange={setDescription} />
            <Button onClick={recordRequest} disabled={!description.trim()}>
              Request maintenance
            </Button>
          </div>
        </div>
      )}

      <h3>Local observations</h3>
      <table className="table">
        <thead>
          <tr>
            <th>Asset</th>
            <th>Result</th>
            <th>Notes</th>
            <th>Observed</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {observations.map((o) => (
            <tr key={o.id}>
              <td>{o.assetCode}</td>
              <td>{o.observationType === 'missing' ? 'Missing' : `Verified (${o.observedCondition}${o.matchesCachedCondition === false ? ', mismatch vs. cache' : ''})`}</td>
              <td>{o.notes ?? '—'}</td>
              <td>{new Date(o.observedAt).toLocaleString()}</td>
              <td>
                local, pending &middot; {snapshotLabel(o.isCurrentSnapshot)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Local maintenance requests</h3>
      <table className="table">
        <thead>
          <tr>
            <th>Asset</th>
            <th>Category</th>
            <th>Priority</th>
            <th>Description</th>
            <th>Requested</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {requests.map((r) => (
            <tr key={r.id}>
              <td>{r.assetCode}</td>
              <td>{r.faultCategory}</td>
              <td>{r.priority}</td>
              <td>{r.description}</td>
              <td>{new Date(r.requestedAt).toLocaleString()}</td>
              <td>
                local, pending &middot; {snapshotLabel(r.isCurrentSnapshot)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  )
}
