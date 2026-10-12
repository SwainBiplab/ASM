import { useCallback, useEffect, useState } from 'react'
import type { AssetListItem, OfflineLeaseView, SessionInfo, SyncDeviceView } from '@shared/api'
import { ApiError, call, formatDateTime } from '../../api'
import { Alert, Button, Dialog, ErrorAlert, PageHeader, Panel, ReasonDialog, SelectField, TextAreaField, TextField } from '../../components/ui'

/**
 * Minimal admin UI for the W9 offline-agent machinery (device enrollment/trust, exclusive leases).
 * Server-only since W9.2; this is the first screen for it. Deliberately thin: it exposes exactly
 * the existing `devices.*`/`leases.*` commands, with no new business rules -- the server still
 * enforces every check (ownership, trust, scope, fencing) exactly as it does for any other caller.
 */

type DialogState =
  | { kind: 'none' }
  | { kind: 'enrollDevice' }
  | { kind: 'approveDevice'; device: SyncDeviceView }
  | { kind: 'revokeDevice'; device: SyncDeviceView }
  | { kind: 'requestLease' }
  | { kind: 'forceReclaim'; lease: OfflineLeaseView }

const DEVICE_STATUS_TONE: Record<SyncDeviceView['status'], string> = { pending: 'badge--warn', active: 'badge--ok', revoked: 'badge--off' }
const LEASE_STATUS_TONE: Record<OfflineLeaseView['status'], string> = { active: 'badge--ok', expired: 'badge--warn', released: 'badge--off', reclaimed: 'badge--off' }

export function OfflineAgentsPage({ session }: { session: SessionInfo }) {
  const canManageDevices = session.permissions.includes('devices.manage')
  const canForceReclaim = session.permissions.includes('leases.force_reclaim')
  const canUseLeases = session.permissions.includes('leases.manage')

  const [myDevices, setMyDevices] = useState<SyncDeviceView[]>([])
  const [allDevices, setAllDevices] = useState<SyncDeviceView[]>([])
  const [myLeases, setMyLeases] = useState<OfflineLeaseView[]>([])
  const [allLeases, setAllLeases] = useState<OfflineLeaseView[]>([])
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dialog, setDialog] = useState<DialogState>({ kind: 'none' })

  const load = useCallback(async () => {
    try {
      setMyDevices(await call('devices.list', { mine: true }))
      setMyLeases(await call('leases.list', { mine: true }))
      if (canManageDevices) setAllDevices(await call('devices.list', { mine: false }))
      if (canManageDevices || canForceReclaim) setAllLeases(await call('leases.list', { mine: false }))
    } catch (err) {
      setError(err)
    }
  }, [canManageDevices, canForceReclaim])

  useEffect(() => {
    void load()
  }, [load])

  const close = useCallback(() => setDialog({ kind: 'none' }), [])
  const done = (message: string) => {
    setDialog({ kind: 'none' })
    setNotice(message)
    void load()
  }

  const releaseLease = async (lease: OfflineLeaseView) => {
    try {
      await call('leases.release', { leaseId: lease.id })
      done(`Lease for work package ${lease.id} released.`)
    } catch (err) {
      setError(err)
    }
  }

  const approvedOwnDevices = myDevices.filter((d) => d.status === 'active')

  return (
    <div className="stack">
      <PageHeader
        title="Offline agents"
        description="Device enrollment, trust, and exclusive work-package leases for the desktop offline agent (W9). The server enforces every check shown here; this page only surfaces it."
      />
      <ErrorAlert error={error} />
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      {canUseLeases ? (
        <Panel title="My devices" actions={<Button small variant="primary" onClick={() => setDialog({ kind: 'enrollDevice' })}>Enroll a device</Button>} flush>
          <DeviceTable devices={myDevices} showOwner={false} />
        </Panel>
      ) : null}

      {canManageDevices ? (
        <Panel title="All devices" flush>
          <DeviceTable
            devices={allDevices}
            showOwner
            renderActions={(d) => (
              <>
                {d.status === 'pending' ? (
                  <Button small variant="quiet" onClick={() => setDialog({ kind: 'approveDevice', device: d })}>Approve</Button>
                ) : null}
                {d.status !== 'revoked' ? (
                  <Button small variant="danger" onClick={() => setDialog({ kind: 'revokeDevice', device: d })}>Revoke</Button>
                ) : null}
              </>
            )}
          />
        </Panel>
      ) : null}

      {canUseLeases ? (
        <Panel
          title="My leases"
          actions={
            <Button small variant="primary" disabled={!approvedOwnDevices.length} onClick={() => setDialog({ kind: 'requestLease' })}>
              Request a lease
            </Button>
          }
          flush
        >
          {!approvedOwnDevices.length ? <p className="muted">Enroll and have a device approved before requesting a lease.</p> : null}
          <LeaseTable
            leases={myLeases}
            showOwner={false}
            renderActions={(l) => (l.status === 'active' || l.status === 'expired' ? <Button small variant="quiet" onClick={() => void releaseLease(l)}>Release</Button> : null)}
          />
        </Panel>
      ) : null}

      {canManageDevices || canForceReclaim ? (
        <Panel title="All leases" flush>
          <LeaseTable
            leases={allLeases}
            showOwner
            renderActions={(l) =>
              canForceReclaim && l.userId !== session.user.id && (l.status === 'active' || l.status === 'expired') ? (
                <Button small variant="danger" onClick={() => setDialog({ kind: 'forceReclaim', lease: l })}>
                  Force-reclaim
                </Button>
              ) : null
            }
          />
        </Panel>
      ) : null}

      {dialog.kind === 'enrollDevice' ? (
        <EnrollDeviceDialog onClose={close} onSaved={(d) => done(`"${d.deviceName}" enrolled. Awaiting administrator approval before it can hold a lease.`)} />
      ) : null}
      {dialog.kind === 'approveDevice' ? (
        <ApproveDeviceDialog device={dialog.device} onClose={close} onSaved={(d) => done(`"${d.deviceName}" approved.`)} />
      ) : null}
      {dialog.kind === 'revokeDevice' ? (
        <ReasonDialog
          title={`Revoke "${dialog.device.deviceName}"`}
          description="Revoking immediately force-reclaims any lease this device holds, since there is no way to push a signal to a disconnected device."
          confirmLabel="Revoke device"
          danger
          onConfirm={async (reason) => {
            await call('devices.revoke', { deviceId: dialog.device.id, reason })
            done(`"${dialog.device.deviceName}" revoked.`)
          }}
          onClose={close}
        />
      ) : null}
      {dialog.kind === 'requestLease' ? (
        <RequestLeaseDialog devices={approvedOwnDevices} onClose={close} onSaved={(l) => done(`Lease granted for work package ${l.id}.`)} />
      ) : null}
      {dialog.kind === 'forceReclaim' ? (
        <ReasonDialog
          title="Force-reclaim this lease"
          description="Use this only when the device's own user cannot release it themselves (lost device, unavailable staff, etc.). This is audited."
          confirmLabel="Force-reclaim"
          danger
          onConfirm={async (reason) => {
            await call('leases.forceReclaim', { leaseId: dialog.lease.id, reason })
            done(`Lease for work package ${dialog.lease.id} force-reclaimed.`)
          }}
          onClose={close}
        />
      ) : null}
    </div>
  )
}

function DeviceTable({ devices, showOwner, renderActions }: { devices: SyncDeviceView[]; showOwner: boolean; renderActions?: (d: SyncDeviceView) => React.ReactNode }) {
  if (!devices.length) return <p className="muted">No devices.</p>
  return (
    <div className="table-wrap">
      <table className="grid">
        <thead>
          <tr>
            <th>Device</th>
            {showOwner ? <th>Owner</th> : null}
            <th>Status</th>
            <th>Trust notes</th>
            <th>Requested</th>
            {renderActions ? <th className="actions" aria-label="Actions" /> : null}
          </tr>
        </thead>
        <tbody>
          {devices.map((d) => (
            <tr key={d.id}>
              <td>
                {d.deviceName}
                <br />
                <span className="faint ident">{d.deviceUuid}</span>
              </td>
              {showOwner ? <td>{d.ownerName ?? '—'}</td> : null}
              <td>
                <span className={`badge ${DEVICE_STATUS_TONE[d.status]}`}>{d.status}</span>
              </td>
              <td className="muted">{d.status === 'revoked' ? d.revokeReason : d.trustNotes}</td>
              <td className="num">{formatDateTime(d.requestedAt)}</td>
              {renderActions ? <td className="actions">{renderActions(d)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function LeaseTable({ leases, showOwner, renderActions }: { leases: OfflineLeaseView[]; showOwner: boolean; renderActions?: (l: OfflineLeaseView) => React.ReactNode }) {
  if (!leases.length) return <p className="muted">No leases.</p>
  return (
    <div className="table-wrap">
      <table className="grid">
        <thead>
          <tr>
            <th>Device</th>
            {showOwner ? <th>User</th> : null}
            <th>Scope</th>
            <th>Status</th>
            <th>Granted</th>
            <th>Expires</th>
            {renderActions ? <th className="actions" aria-label="Actions" /> : null}
          </tr>
        </thead>
        <tbody>
          {leases.map((l) => (
            <tr key={l.id}>
              <td>{l.deviceName}</td>
              {showOwner ? <td>{l.userName ?? '—'}</td> : null}
              <td>{l.scopeType === 'asset' ? `${l.assetIds.length} asset(s)` : l.assetCodeRange ? `Code range ${l.assetCodeRange.rangeStart}–${l.assetCodeRange.rangeEnd}` : 'Asset-code range'}</td>
              <td>
                <span className={`badge ${LEASE_STATUS_TONE[l.status]}`}>{l.status}</span>
              </td>
              <td className="num">{formatDateTime(l.grantedAt)}</td>
              <td className="num">{formatDateTime(l.expiresAt)}</td>
              {renderActions ? <td className="actions">{renderActions(l)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function EnrollDeviceDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (d: SyncDeviceView) => void }) {
  const [deviceUuid, setDeviceUuid] = useState('')
  const [deviceName, setDeviceName] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      onSaved(await call('devices.requestEnrollment', { deviceUuid, deviceName }))
    } catch (err) {
      setError(err)
      if (err instanceof ApiError) setFields(err.fieldErrors)
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Enroll a device"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !deviceUuid.trim() || !deviceName.trim()} onClick={() => void save()}>Request enrollment</Button>
        </>
      }
    >
      <div className="stack">
        <ErrorAlert error={error} />
        <p className="muted">The device ID comes from the desktop agent itself (shown in its own window). This only registers the device as pending; an administrator must still approve it before it can hold a lease.</p>
        <TextField label="Device ID" value={deviceUuid} onChange={(e) => setDeviceUuid(e.target.value)} error={fields['deviceUuid']} hint="Copy this from the desktop agent" />
        <TextField label="Device name" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} error={fields['deviceName']} hint="Something recognizable, e.g. &quot;Ravi's field laptop&quot;" />
      </div>
    </Dialog>
  )
}

function ApproveDeviceDialog({ device, onClose, onSaved }: { device: SyncDeviceView; onClose: () => void; onSaved: (d: SyncDeviceView) => void }) {
  const [trustNotes, setTrustNotes] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      onSaved(await call('devices.approve', { deviceId: device.id, trustNotes }))
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={`Approve "${device.deviceName}"`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !trustNotes.trim()} onClick={() => void save()}>Approve device</Button>
        </>
      }
    >
      <div className="stack">
        <ErrorAlert error={error} />
        <p className="muted">Record what was actually verified (e.g. managed device, full-disk encryption confirmed). This is an attestation, not an automated check (KNOWN_ISSUES W-45).</p>
        <TextAreaField label="Trust notes" value={trustNotes} onChange={setTrustNotes} hint="Required; recorded against this device" />
      </div>
    </Dialog>
  )
}

function AssetPicker({ selected, onChange }: { selected: AssetListItem[]; onChange: (items: AssetListItem[]) => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<AssetListItem[]>([])
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    if (!query.trim()) {
      setResults([])
      return
    }
    const timer = setTimeout(() => {
      call('assets.search', { query, lifecycle: 'active', page: 1, pageSize: 10 })
        .then((page) => setResults(page.items.filter((a) => !selected.some((s) => s.id === a.id))))
        .catch(setError)
    }, 250)
    return () => clearTimeout(timer)
  }, [query, selected])

  return (
    <div className="stack">
      <ErrorAlert error={error} />
      <TextField label="Find assets by code, serial, or make/model" value={query} onChange={(e) => setQuery(e.target.value)} />
      {results.length ? (
        <ul>
          {results.map((a) => (
            <li key={a.id}>
              <button type="button" className="link-btn" onClick={() => { onChange([...selected, a]); setQuery('') }}>
                {a.assetCode} — {a.categoryName} {[a.manufacturer, a.modelName].filter(Boolean).join(' ')}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {selected.length ? (
        <div className="chips">
          {selected.map((a) => (
            <span className="badge" key={a.id}>
              {a.assetCode}{' '}
              <button type="button" className="link-btn" aria-label={`Remove ${a.assetCode}`} onClick={() => onChange(selected.filter((s) => s.id !== a.id))}>
                ×
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="muted">No assets selected yet.</p>
      )}
    </div>
  )
}

function RequestLeaseDialog({ devices, onClose, onSaved }: { devices: SyncDeviceView[]; onClose: () => void; onSaved: (l: OfflineLeaseView) => void }) {
  const [deviceId, setDeviceId] = useState(devices[0]?.id ?? '')
  const [scopeKind, setScopeKind] = useState<'asset' | 'asset_code_range'>('asset')
  const [assets, setAssets] = useState<AssetListItem[]>([])
  const [rangeCount, setRangeCount] = useState(5)
  const [durationHours, setDurationHours] = useState(8)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const canSave = deviceId && durationHours >= 1 && durationHours <= 8 && (scopeKind === 'asset' ? assets.length > 0 : rangeCount >= 1)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const scope = scopeKind === 'asset' ? { kind: 'asset' as const, assetIds: assets.map((a) => a.id) } : { kind: 'asset_code_range' as const, count: rangeCount }
      onSaved(await call('leases.request', { deviceId, scope, durationHours }))
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Request a lease"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !canSave} onClick={() => void save()}>Request lease</Button>
        </>
      }
    >
      <div className="stack">
        <ErrorAlert error={error} />
        <SelectField label="Device" value={deviceId} onChange={setDeviceId} options={devices.map((d) => ({ value: d.id, label: d.deviceName }))} />
        <SelectField
          label="Scope"
          value={scopeKind}
          onChange={(v) => setScopeKind(v as 'asset' | 'asset_code_range')}
          options={[
            { value: 'asset', label: 'Specific assets' },
            { value: 'asset_code_range', label: 'Reserve a range of new asset codes' }
          ]}
        />
        {scopeKind === 'asset' ? (
          <AssetPicker selected={assets} onChange={setAssets} />
        ) : (
          <TextField label="How many codes to reserve" type="number" min={1} max={10000} value={String(rangeCount)} onChange={(e) => setRangeCount(Number(e.target.value) || 1)} />
        )}
        <TextField label="Duration (hours, max 8)" type="number" min={1} max={8} value={String(durationHours)} onChange={(e) => setDurationHours(Number(e.target.value) || 1)} />
      </div>
    </Dialog>
  )
}
