import { useCallback, useEffect, useState, type ChangeEvent } from 'react'
import type { AssetListItem, AuditItemView, CategoryView, Page, PhysicalAuditDetail, PhysicalAuditSummary, SessionInfo } from '@shared/api'
import { ApiError, apiUrl, call, downloadFile, formatDateTime, uploadFile } from '../../api'
import { Alert, Button, Dialog, ErrorAlert, PageHeader, Panel, SelectField, TextAreaField, TextField } from '../../components/ui'
import { useLatestOnly } from '../../hooks'
import { AssetScanField } from '../maintenance/shared'
import { EmployeePicker, optionList, useOrgLookups } from '../organization/lookups'
import { conditionOptions } from '../allocations/shared'
import { AuditStatusBadge, ItemStatusBadge, discrepancyLabel, useReviewers } from './shared'

const PAGE_SIZE = 50

/** Physical audits (W5, TAS §13): list, create (freezes the expected baseline), scan/verify, discrepancies, closure. */
export function AuditsPage({ session, selectedId, navigate }: { session: SessionInfo; selectedId: string | null; navigate: (route: string) => void }) {
  const has = (p: string) => session.permissions.includes(p as never)
  const [status, setStatus] = useState<'open' | 'closed' | 'cancelled' | 'all'>('open')
  const [query, setQuery] = useState('')
  const [data, setData] = useState<Page<PhysicalAuditSummary> | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [creating, setCreating] = useState(false)

  const guard = useLatestOnly()
  const load = useCallback(() => {
    setError(null)
    guard(call('audits.list', { status, query: query.trim() || undefined, page: 1, pageSize: PAGE_SIZE })).then(setData, setError)
  }, [status, query])
  useEffect(() => {
    const t = window.setTimeout(load, 200)
    return () => window.clearTimeout(t)
  }, [load])

  if (selectedId) return <AuditDetailView auditId={selectedId} session={session} onBack={() => { navigate('audits'); load() }} />
  return (
    <div className="stack">
      <PageHeader title="Physical audits" description="Scan or look up every expected asset. The expected list is frozen when the audit opens and never changes silently." actions={has('audits.manage') ? <Button variant="primary" onClick={() => setCreating(true)}>New audit</Button> : null} />
      <ErrorAlert error={error} onRetry={load} />
      <Panel flush>
        <div className="toolbar">
          <div className="field field--grow"><TextField label="Search" placeholder="Title or audit number" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
          <SelectField label="Status" value={status} onChange={(v) => setStatus(v as typeof status)} options={[{ value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }, { value: 'cancelled', label: 'Cancelled' }, { value: 'all', label: 'All' }]} />
        </div>
        <div className="table-wrap">
          <table className="grid" aria-label="Physical audits">
            <thead><tr><th>Audit</th><th>Scope</th><th>Responsible</th><th className="num">Items</th><th className="num">Verified</th><th className="num">Unresolved</th><th>Status</th></tr></thead>
            <tbody>
              {data?.items.map((x) => (
                <tr key={x.id} className="is-clickable" onClick={() => navigate(`audits/${x.id}`)}>
                  <td className="ident"><button className="link-btn" onClick={() => navigate(`audits/${x.id}`)}>{x.auditNumber}</button><div className="faint">{x.title}</div></td>
                  <td>{x.scopeLocationPath ?? x.scopeCategoryName ?? x.scopeCustodianName ?? 'Selected assets'}</td>
                  <td>{x.responsibleUserName ?? '—'}</td>
                  <td className="num">{x.itemCount}</td>
                  <td className="num">{x.verifiedCount}</td>
                  <td className="num">{x.unresolvedCount}</td>
                  <td><AuditStatusBadge status={x.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && data.items.length === 0 ? <div className="empty">No physical audits in this view.</div> : null}
        </div>
      </Panel>
      {creating ? <CreateAuditDialog onClose={() => setCreating(false)} onDone={(x) => { setCreating(false); navigate(`audits/${x.id}`) }} /> : null}
    </div>
  )
}

type ScopeKind = 'location' | 'category' | 'custodian' | 'selected'

function CreateAuditDialog({ onClose, onDone }: { onClose: () => void; onDone: (x: PhysicalAuditDetail) => void }) {
  const { locations } = useOrgLookups()
  const [categories, setCategories] = useState<CategoryView[]>([])
  useEffect(() => {
    call('categories.list', {}).then(setCategories, () => setCategories([]))
  }, [])
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<ScopeKind>('location')
  const [locationId, setLocationId] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [custodianId, setCustodianId] = useState<string | null>(null)
  const [selected, setSelected] = useState<AssetListItem[]>([])
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const fields = error instanceof ApiError ? error.fieldErrors : {}
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      onDone(
        await call('audits.create', {
          title,
          scope: {
            locationId: kind === 'location' ? locationId || null : null,
            categoryId: kind === 'category' ? categoryId || null : null,
            custodianEmployeeId: kind === 'custodian' ? custodianId : null,
            assetIds: kind === 'selected' ? selected.map((a) => a.id) : null
          },
          responsibleUserId: null,
          notes: notes.trim() || null
        })
      )
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  const canSubmit = title.trim() && (kind === 'location' ? locationId : kind === 'category' ? categoryId : kind === 'custodian' ? custodianId : selected.length > 0)
  return (
    <Dialog title="New physical audit" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !canSubmit} onClick={() => void submit()}>Open audit</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <TextField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} hint="e.g. Q4 Pune floor sweep" />
        <SelectField label="Scope by" value={kind} onChange={(v) => setKind(v as ScopeKind)} options={[{ value: 'location', label: 'Location' }, { value: 'category', label: 'Asset category' }, { value: 'custodian', label: 'Employee custodian' }, { value: 'selected', label: 'Selected assets' }]} />
        {kind === 'location' ? <SelectField label="Location" value={locationId} placeholder="Choose" onChange={setLocationId} options={optionList(locations, (l) => l.path)} error={fields['scope']} hint="Includes everything inside it" /> : null}
        {kind === 'category' ? <SelectField label="Category" value={categoryId} placeholder="Choose" onChange={setCategoryId} options={optionList(categories, (c) => c.name)} error={fields['scope']} /> : null}
        {kind === 'custodian' ? <EmployeePicker label="Employee" value={custodianId} onChange={setCustodianId} error={fields['scope']} /> : null}
        {kind === 'selected' ? (
          <div className="stack">
            <AssetScanField label="Add asset" onFound={(a) => !selected.some((s) => s.id === a.id) && setSelected([...selected, a])} />
            {selected.map((a) => (
              <div className="chips" key={a.id}><span className="ident">{a.assetCode}</span><span className="faint">{a.categoryName}</span><Button small variant="quiet" onClick={() => setSelected(selected.filter((s) => s.id !== a.id))}>Remove</Button></div>
            ))}
            {fields['scope'] ? <span className="field__error">{fields['scope']}</span> : null}
          </div>
        ) : null}
        <TextAreaField label="Notes" value={notes} onChange={setNotes} />
      </div>
    </Dialog>
  )
}

type ItemAction = { kind: 'flag' | 'assign' | 'resolve' | 'correctLocation' | 'accept'; item: AuditItemView } | null

function AuditDetailView({ auditId, session, onBack }: { auditId: string; session: SessionInfo; onBack: () => void }) {
  const has = (p: string) => session.permissions.includes(p as never)
  const [x, setX] = useState<PhysicalAuditDetail | null>(null)
  const [items, setItems] = useState<Page<AuditItemView> | null>(null)
  const [itemStatus, setItemStatus] = useState<'all' | 'pending' | 'verified' | 'discrepancy_open' | 'investigating' | 'resolved' | 'accepted'>('all')
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [action, setAction] = useState<ItemAction>(null)
  const [closing, setClosing] = useState<'close' | 'cancel' | null>(null)

  const guardX = useLatestOnly()
  const guardItems = useLatestOnly()
  const load = useCallback(() => {
    setError(null)
    guardX(call('audits.get', { auditId })).then(setX, setError)
    guardItems(call('audits.getItems', { auditId, status: itemStatus, page: 1, pageSize: 200 })).then(setItems, setError)
  }, [auditId, itemStatus])
  useEffect(load, [load])

  const [scanned, setScanned] = useState<AssetListItem | null>(null)
  const updated = (next: AuditItemView, message: string) => {
    setAction(null)
    setNotice(message)
    load()
  }
  if (!x) return <div className="stack"><ErrorAlert error={error} onRetry={load} />{!error ? <p className="faint" role="status">Loading audit…</p> : null}</div>
  const open = x.status === 'open'
  return (
    <div className="stack">
      <PageHeader
        title={`${x.auditNumber}: ${x.title}`}
        description={`Scope: ${x.scopeLocationPath ?? x.scopeCategoryName ?? x.scopeCustodianName ?? 'selected assets'}. Opened ${formatDateTime(x.openedAt)} by ${x.openedByName ?? '—'}.`}
        actions={
          <>
            <Button onClick={onBack}>All audits</Button>
            {open && has('audits.manage') ? <Button onClick={() => setClosing('cancel')}>Cancel audit</Button> : null}
            {open && has('audits.close') ? <Button variant="primary" disabled={x.blockers.length > 0} onClick={() => setClosing('close')}>Close audit</Button> : null}
          </>
        }
      />
      <ErrorAlert error={error} />
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <Panel title="Progress">
        <div className="ledger" aria-label="Audit progress">
          <div className="ledger__cell"><div className="ledger__value">{x.itemCount}</div><div className="ledger__label">Items</div></div>
          <div className="ledger__cell"><div className="ledger__value">{x.verifiedCount}</div><div className="ledger__label">Verified</div></div>
          <div className="ledger__cell"><div className="ledger__value">{x.unresolvedCount}</div><div className="ledger__label">Unresolved</div></div>
        </div>
      </Panel>
      {open && x.blockers.length ? <Alert tone="warn">{x.blockers.join(' ')}</Alert> : null}
      {x.status === 'closed' ? <Alert tone="success">Closed {x.closureType === 'with_exceptions' ? 'with accepted exceptions' : 'fully verified'} on {formatDateTime(x.closedAt)} by {x.closedByName ?? '—'}.</Alert> : null}
      {x.status === 'cancelled' ? <Alert tone="info">Cancelled: {x.cancelReason}</Alert> : null}
      {open && (has('audits.verify') || has('audits.manage')) ? (
        <Panel title="Scan or look up an asset">
          <AssetScanField label="Asset code, serial or QR" onFound={setScanned} />
          <p className="faint">Confirm or correct the observed location and condition after each scan — a scan records what you found, not what the system expects.</p>
        </Panel>
      ) : null}
      <Panel flush title={`Items (${items?.total ?? '…'})`}>
        <div className="toolbar">
          <SelectField label="Status" value={itemStatus} onChange={(v) => setItemStatus(v as typeof itemStatus)} options={[{ value: 'all', label: 'All' }, { value: 'pending', label: 'Not yet verified' }, { value: 'verified', label: 'Verified' }, { value: 'discrepancy_open', label: 'Discrepancy' }, { value: 'investigating', label: 'Investigating' }, { value: 'resolved', label: 'Resolved' }, { value: 'accepted', label: 'Accepted' }]} />
        </div>
        <div className="table-wrap">
          <table className="grid" aria-label="Audit items">
            <thead><tr><th>Asset</th><th>Expected</th><th>Observed</th><th>Status</th><th className="actions" aria-label="Actions" /></tr></thead>
            <tbody>
              {items?.items.map((i) => (
                <tr key={i.id} data-testid="audit-item">
                  <td className="ident">{i.assetCode}<div className="faint">{i.categoryName}{i.makeModel ? `, ${i.makeModel}` : ''}{i.serialNumber ? `, ${i.serialNumber}` : ''}</div></td>
                  <td>{i.source === 'expected' ? <>{i.expectedLocationPath ?? '—'}<div className="faint">{i.expectedCondition ?? ''}</div></> : <span className="faint">Not expected</span>}</td>
                  <td>{i.observedAt ? <>{i.observedLocationPath ?? '—'}<div className="faint">{i.observedCondition}, {formatDateTime(i.observedAt)}</div></> : '—'}</td>
                  <td>
                    <ItemStatusBadge status={i.status} />
                    {i.discrepancyType ? <div className="faint">{discrepancyLabel(i.discrepancyType)}</div> : null}
                    {i.resolutionNotes ? <div className="muted">{i.resolutionNotes}</div> : null}
                    {i.documents.map((d) => (
                      <div key={d.linkId}><button className="link-btn" onClick={() => void downloadFile(apiUrl(`/api/v1/documents/${d.documentId}/content`), d.originalName).catch(setError)}>{d.originalName}</button></div>
                    ))}
                  </td>
                  <td className="actions">
                    {open ? (
                      <div className="chips">
                        {i.status === 'pending' && has('audits.resolve') ? <Button small variant="quiet" onClick={() => setAction({ kind: 'flag', item: i })}>Mark missing</Button> : null}
                        {i.status === 'discrepancy_open' && has('audits.resolve') ? <Button small variant="quiet" onClick={() => setAction({ kind: 'assign', item: i })}>Assign</Button> : null}
                        {['discrepancy_open', 'investigating'].includes(i.status) && i.discrepancyType === 'location_mismatch' && has('audits.resolve') ? <Button small variant="quiet" onClick={() => setAction({ kind: 'correctLocation', item: i })}>Correct location</Button> : null}
                        {['discrepancy_open', 'investigating'].includes(i.status) && has('audits.resolve') ? <Button small variant="quiet" onClick={() => setAction({ kind: 'resolve', item: i })}>Resolve</Button> : null}
                        {['discrepancy_open', 'investigating'].includes(i.status) && has('audits.close') ? <Button small variant="quiet" onClick={() => setAction({ kind: 'accept', item: i })}>Accept exception</Button> : null}
                        {['discrepancy_open', 'investigating'].includes(i.status) && has('audits.resolve') ? <EvidenceUpload itemId={i.id} onUploaded={load} /> : null}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {items && items.items.length === 0 ? <div className="empty">No items in this view.</div> : null}
        </div>
      </Panel>
      {scanned ? (
        <ConfirmObservationDialog
          auditId={auditId}
          asset={scanned}
          onClose={() => setScanned(null)}
          onDone={() => {
            setScanned(null)
            setNotice(`${scanned.assetCode} recorded.`)
            load()
          }}
        />
      ) : null}
      {action?.kind === 'flag' ? <FlagMissingDialog item={action.item} onClose={() => setAction(null)} onDone={(n) => updated(n, `${action.item.assetCode} flagged missing.`)} /> : null}
      {action?.kind === 'assign' ? <AssignDialog item={action.item} onClose={() => setAction(null)} onDone={(n) => updated(n, `${action.item.assetCode} assigned for investigation.`)} /> : null}
      {action?.kind === 'resolve' ? <ResolveDialog item={action.item} onClose={() => setAction(null)} onDone={(n) => updated(n, `${action.item.assetCode} resolved.`)} /> : null}
      {action?.kind === 'correctLocation' ? <CorrectLocationDialog item={action.item} onClose={() => setAction(null)} onDone={(n) => updated(n, `${action.item.assetCode}'s location corrected.`)} /> : null}
      {action?.kind === 'accept' ? <AcceptDialog item={action.item} onClose={() => setAction(null)} onDone={(n) => updated(n, `Exception accepted for ${action.item.assetCode}.`)} /> : null}
      {closing ? <CloseCancelDialog audit={x} mode={closing} onClose={() => setClosing(null)} onDone={(n) => { setX(n); setClosing(null); setNotice(closing === 'close' ? 'Audit closed.' : 'Audit cancelled.') }} /> : null}
    </div>
  )
}

function useItemAction(onDone: (i: AuditItemView) => void) {
  const [error, setError] = useState<unknown>(null)
  const save = async (fn: () => Promise<AuditItemView>) => {
    setError(null)
    try {
      onDone(await fn())
    } catch (err) {
      setError(err)
    }
  }
  return { error, save }
}

function EvidenceUpload({ itemId, onUploaded }: { itemId: string; onUploaded: () => void }) {
  const [busy, setBusy] = useState(false)
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy(true)
    uploadFile('/api/v1/uploads/documents', file, { entityType: 'audit_item', entityId: itemId, purpose: 'audit_evidence' })
      .then(onUploaded)
      .finally(() => setBusy(false))
  }
  return (
    <label className="btn btn--small btn--quiet">
      {busy ? 'Uploading…' : 'Attach evidence'}
      <input type="file" hidden disabled={busy} accept=".pdf,.png,.jpg,.jpeg,.webp" onChange={onFile} />
    </label>
  )
}

/**
 * After a scan resolves an asset, the operator confirms what they actually found — the fields are
 * prefilled from the asset's current registered values, but a scan is an observation, never an
 * implicit edit, so the operator must explicitly confirm (or correct) them before it is recorded.
 */
function ConfirmObservationDialog({ auditId, asset, onClose, onDone }: { auditId: string; asset: AssetListItem; onClose: () => void; onDone: () => void }) {
  const { locations } = useOrgLookups()
  const [locationId, setLocationId] = useState<string | null | undefined>(undefined)
  const [condition, setCondition] = useState<AuditItemView['observedCondition']>(null)
  const [notes, setNotes] = useState('')
  const [identificationMismatch, setIdentificationMismatch] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    call('assets.get', { id: asset.id }).then(
      (d) => {
        setLocationId(d.locationId)
        setCondition(d.condition)
      },
      setError
    )
  }, [asset.id])
  const loaded = locationId !== undefined && condition !== null
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await call('audits.verifyItem', { auditId, assetId: asset.id, observedLocationId: locationId ?? null, observedCondition: condition!, identificationMismatch, notes: notes.trim() || null })
      onDone()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog title={`Confirm observation: ${asset.assetCode}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !loaded} onClick={() => void submit()}>Record</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        {!loaded ? <p className="faint" role="status">Loading current record…</p> : (
          <>
            <div className="form-grid">
              <SelectField label="Observed location" value={locationId ?? ''} placeholder="No location" onChange={(v) => setLocationId(v || null)} options={optionList(locations, (l) => l.path)} />
              <SelectField label="Observed condition" value={condition ?? ''} onChange={(v) => setCondition(v as AuditItemView['observedCondition'])} options={conditionOptions} />
            </div>
            <label className="checkbox"><input type="checkbox" checked={identificationMismatch} onChange={(e) => setIdentificationMismatch(e.target.checked)} /> The physical label or tag does not match this asset</label>
            <TextAreaField label="Notes" value={notes} onChange={setNotes} hint="Optional" />
          </>
        )}
      </div>
    </Dialog>
  )
}

function FlagMissingDialog({ item, onClose, onDone }: { item: AuditItemView; onClose: () => void; onDone: (i: AuditItemView) => void }) {
  const [notes, setNotes] = useState('')
  const { error, save } = useItemAction(onDone)
  return (
    <Dialog title={`Mark ${item.assetCode} missing`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" disabled={!notes.trim()} onClick={() => void save(() => call('audits.flagMissing', { itemId: item.id, notes }))}>Mark missing</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <p className="muted">The asset is not automatically marked lost or disposed. It stays as a discrepancy until investigated and resolved or formally accepted.</p>
        <TextAreaField label="Notes" value={notes} onChange={setNotes} hint="Required: where was it looked for?" />
      </div>
    </Dialog>
  )
}

function AssignDialog({ item, onClose, onDone }: { item: AuditItemView; onClose: () => void; onDone: (i: AuditItemView) => void }) {
  const reviewers = useReviewers()
  const [userId, setUserId] = useState('')
  const [notes, setNotes] = useState('')
  const { error, save } = useItemAction(onDone)
  return (
    <Dialog title={`Assign ${item.assetCode}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!userId} onClick={() => void save(() => call('audits.assignDiscrepancy', { itemId: item.id, assignedToUserId: userId, notes: notes.trim() || null }))}>Assign</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <SelectField label="Assign to" value={userId} placeholder="Choose" onChange={setUserId} options={reviewers.map((r) => ({ value: r.id, label: r.displayName }))} />
        <TextAreaField label="Notes" value={notes} onChange={setNotes} />
      </div>
    </Dialog>
  )
}

function ResolveDialog({ item, onClose, onDone }: { item: AuditItemView; onClose: () => void; onDone: (i: AuditItemView) => void }) {
  const [notes, setNotes] = useState('')
  const { error, save } = useItemAction(onDone)
  return (
    <Dialog title={`Resolve ${item.assetCode}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!notes.trim()} onClick={() => void save(() => call('audits.resolveDiscrepancy', { itemId: item.id, resolutionNotes: notes }))}>Resolve</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <TextAreaField label="Resolution notes" value={notes} onChange={setNotes} hint="Required: what was done" />
      </div>
    </Dialog>
  )
}

function CorrectLocationDialog({ item, onClose, onDone }: { item: AuditItemView; onClose: () => void; onDone: (i: AuditItemView) => void }) {
  const { locations } = useOrgLookups()
  const [locationId, setLocationId] = useState('')
  const [reason, setReason] = useState('')
  const { error, save } = useItemAction(onDone)
  return (
    <Dialog title={`Correct location for ${item.assetCode}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!locationId || !reason.trim()} onClick={() => void save(() => call('audits.correctLocation', { itemId: item.id, newLocationId: locationId, reason }))}>Update master record</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <p className="muted">Updates the asset's registered location and resolves this discrepancy in one step.</p>
        <SelectField label="Correct location" value={locationId} placeholder="Choose" onChange={setLocationId} options={optionList(locations, (l) => l.path)} />
        <TextAreaField label="Reason" value={reason} onChange={setReason} hint="Required" />
      </div>
    </Dialog>
  )
}

function AcceptDialog({ item, onClose, onDone }: { item: AuditItemView; onClose: () => void; onDone: (i: AuditItemView) => void }) {
  const [notes, setNotes] = useState('')
  const { error, save } = useItemAction(onDone)
  return (
    <Dialog title={`Accept exception for ${item.assetCode}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" disabled={!notes.trim()} onClick={() => void save(() => call('audits.acceptException', { itemId: item.id, decisionNotes: notes }))}>Accept exception</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <Alert tone="warn">This formally accepts the discrepancy without correcting the master record. It does not mark the asset lost or disposed — a separate authorized action is required for that.</Alert>
        <TextAreaField label="Decision notes" value={notes} onChange={setNotes} hint="Required" />
      </div>
    </Dialog>
  )
}

function CloseCancelDialog({ audit, mode, onClose, onDone }: { audit: PhysicalAuditDetail; mode: 'close' | 'cancel'; onClose: () => void; onDone: (x: PhysicalAuditDetail) => void }) {
  const [text, setText] = useState('')
  const [error, setError] = useState<unknown>(null)
  const submit = async () => {
    setError(null)
    try {
      onDone(mode === 'close' ? await call('audits.close', { auditId: audit.id, closingNotes: text.trim() || null }) : await call('audits.cancel', { auditId: audit.id, reason: text }))
    } catch (err) {
      setError(err)
    }
  }
  return (
    <Dialog title={mode === 'close' ? 'Close audit' : 'Cancel audit'} onClose={onClose} footer={<><Button onClick={onClose}>Back</Button><Button variant={mode === 'close' ? 'primary' : 'danger'} disabled={mode === 'cancel' && !text.trim()} onClick={() => void submit()}>{mode === 'close' ? 'Close audit' : 'Cancel audit'}</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <TextAreaField label={mode === 'close' ? 'Closing notes' : 'Reason'} value={text} onChange={setText} hint={mode === 'close' ? 'Optional' : 'Required'} />
      </div>
    </Dialog>
  )
}
