import { useCallback, useEffect, useState, type ChangeEvent } from 'react'
import { CLEARANCE_RESOLUTION_LABELS, RETURN_OUTCOME_LABELS, RETURN_OUTCOMES, UNRESOLVED_RESOLUTIONS, type ClearanceResolution, type ReturnOutcome } from '@shared/allocations'
import type { ClearanceDetail, ClearanceItemView, ClearanceSummary, Page, SessionInfo } from '@shared/api'
import { CONDITION_LABELS, type AssetCondition } from '@shared/assets'
import { ApiError, apiUrl, call, downloadFile, formatDateTime, uploadFile } from '../../api'
import { Alert, Button, Dialog, ErrorAlert, PageHeader, Panel, SelectField, TextAreaField, TextField, useToast } from '../../components/ui'
import { useLatestOnly } from '../../hooks'
import { conditionOptions } from '../allocations/shared'
import { EmployeePicker, optionList, useOrgLookups } from '../organization/lookups'

const resolutionClass = (r: ClearanceResolution) => (r === 'returned' ? 'badge--ok' : r === 'exception_approved' ? '' : r === 'outstanding' ? 'badge--warn' : 'badge--off')

/** Employee exit clearance (W4, TAS §10): list, open, per-item resolution and closure. */
export function ClearancePage({ session, selectedId, navigate }: { session: SessionInfo; selectedId: string | null; navigate: (route: string) => void }) {
  const has = (p: string) => session.permissions.includes(p as never)
  const [status, setStatus] = useState<'open' | 'closed' | 'cancelled' | 'all'>('open')
  const [query, setQuery] = useState('')
  const [data, setData] = useState<Page<ClearanceSummary> | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [opening, setOpening] = useState(false)
  const guard = useLatestOnly()
  const load = useCallback(() => {
    setError(null)
    guard(call('exitClearance.list', { status, ...(query.trim() ? { query: query.trim() } : {}), pageSize: 100 })).then(setData, setError)
  }, [status, query])
  useEffect(() => {
    const t = window.setTimeout(load, 200)
    return () => window.clearTimeout(t)
  }, [load])

  if (selectedId) return <ClearanceDetailView id={selectedId} session={session} onBack={() => { navigate('exit-clearance'); load() }} />
  return (
    <div className="stack">
      <PageHeader
        title="Exit clearance"
        description="Track every asset held by a leaving employee until it is returned or an exception is formally approved. Marking an employee as exited never returns assets automatically."
        actions={has('exit_clearance.manage') ? <Button variant="primary" onClick={() => setOpening(true)}>Open clearance</Button> : null}
      />
      <ErrorAlert error={error} onRetry={load} />
      <Panel flush>
        <div className="toolbar">
          <div className="field field--grow"><TextField label="Search" placeholder="Employee ID, name or clearance number" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
          <SelectField label="Status" value={status} onChange={(v) => setStatus(v as typeof status)} options={[{ value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }, { value: 'cancelled', label: 'Cancelled' }, { value: 'all', label: 'All' }]} />
        </div>
        <div className="table-wrap">
          <table className="grid" aria-label="Exit clearances">
            <thead><tr><th>Clearance</th><th>Employee</th><th>Exit date</th><th>Owner</th><th className="num">Items</th><th className="num">Unresolved</th><th>Status</th></tr></thead>
            <tbody>
              {data?.items.map((x) => (
                <tr key={x.id} className="is-clickable" onClick={() => navigate(`exit-clearance/${x.id}`)}>
                  <td className="ident"><button className="link-btn" onClick={() => navigate(`exit-clearance/${x.id}`)}>{x.clearanceNumber}</button></td>
                  <td>{x.employeeName} <span className="faint">{x.employeeCode}</span></td>
                  <td>{x.exitDate}</td>
                  <td>{x.ownerName ?? '—'}</td>
                  <td className="num">{x.itemCount}</td>
                  <td className="num">{x.unresolvedCount}</td>
                  <td><span className={`badge ${x.status === 'open' ? 'badge--warn' : x.status === 'closed' ? 'badge--ok' : ''}`}>{x.status === 'closed' ? (x.closureType === 'with_exceptions' ? 'Closed with exceptions' : 'Cleared') : x.status === 'open' ? 'Open' : 'Cancelled'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && data.items.length === 0 ? <div className="empty">No exit clearances in this view.</div> : null}
        </div>
      </Panel>
      {opening ? <OpenClearanceDialog onClose={() => setOpening(false)} onDone={(d) => { setOpening(false); navigate(`exit-clearance/${d.id}`) }} /> : null}
    </div>
  )
}

function OpenClearanceDialog({ onClose, onDone }: { onClose: () => void; onDone: (d: ClearanceDetail) => void }) {
  const [employeeId, setEmployeeId] = useState<string | null>(null)
  const [exitDate, setExitDate] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<unknown>(null)
  const fields = error instanceof ApiError ? error.fieldErrors : {}
  const save = async () => {
    setError(null)
    try {
      onDone(await call('exitClearance.open', { employeeId: employeeId ?? '', exitDate, ownerUserId: null, notes: notes.trim() || null }))
    } catch (err) {
      setError(err)
    }
  }
  return (
    <Dialog title="Open exit clearance" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!employeeId || !exitDate} onClick={() => void save()}>Open clearance</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <p className="muted">Every asset currently assigned to the employee becomes a clearance item. You are recorded as the responsible owner.</p>
        <div className="form-grid">
          <EmployeePicker label="Employee" value={employeeId} onChange={setEmployeeId} error={fields['employeeId']} />
          <TextField label="Exit date" type="date" value={exitDate} onChange={(e) => setExitDate(e.target.value)} error={fields['exitDate']} />
        </div>
        <TextAreaField label="Notes" value={notes} onChange={setNotes} />
      </div>
    </Dialog>
  )
}

type ItemAction = { kind: 'return' | 'flag' | 'approve'; item: ClearanceItemView } | null

function ClearanceDetailView({ id, session, onBack }: { id: string; session: SessionInfo; onBack: () => void }) {
  const has = (p: string) => session.permissions.includes(p as never)
  const [d, setD] = useState<ClearanceDetail | null>(null)
  const [error, setError] = useState<unknown>(null)
  const toast = useToast()
  const [action, setAction] = useState<ItemAction>(null)
  const [closing, setClosing] = useState<'close' | 'cancel' | null>(null)
  const guard = useLatestOnly()
  const load = useCallback(() => {
    setError(null)
    guard(call('exitClearance.get', { clearanceId: id })).then(setD, setError)
  }, [id])
  useEffect(load, [load])
  const updated = (next: ClearanceDetail, message: string) => {
    setD(next)
    setAction(null)
    setClosing(null)
    toast.success(message)
  }
  const evidence = async (item: ClearanceItemView, e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(null)
    try {
      await uploadFile('/api/v1/uploads/documents', file, { entityType: 'clearance_item', entityId: item.id, purpose: 'photo' })
      toast.success(`Evidence ${file.name} attached to ${item.assetCode}.`)
      load()
    } catch (err) {
      setError(err)
    }
  }
  if (!d) return <div className="stack"><ErrorAlert error={error} onRetry={load} />{!error ? <p className="faint" role="status">Loading clearance…</p> : null}</div>
  const open = d.status === 'open'
  return (
    <div className="stack">
      <PageHeader
        title={`${d.clearanceNumber}: ${d.employeeName}`}
        description={`Employee ${d.employeeCode}, exit date ${d.exitDate}. Owner: ${d.ownerName ?? '—'}. Opened ${formatDateTime(d.openedAt)} by ${d.openedByName ?? '—'}.`}
        actions={
          <>
            <Button onClick={onBack}>All clearances</Button>
            {open && has('exit_clearance.manage') ? <Button onClick={() => setClosing('cancel')}>Cancel clearance</Button> : null}
            {open && has('exit_clearance.close') ? <Button variant="primary" disabled={d.blockers.length > 0} onClick={() => setClosing('close')}>Close clearance</Button> : null}
          </>
        }
      />
      <ErrorAlert error={error} />
      {open && d.blockers.length ? (
        <Alert tone="warn">
          Cannot close yet:
          <ul>{d.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
        </Alert>
      ) : null}
      {d.status === 'closed' ? <Alert tone="success">Closed {d.closureType === 'with_exceptions' ? 'with approved exceptions' : 'with every asset returned'} on {formatDateTime(d.closedAt)} by {d.closedByName ?? '—'}.{d.closingNotes ? ` ${d.closingNotes}` : ''}</Alert> : null}
      {d.status === 'cancelled' ? <Alert tone="info">Cancelled: {d.cancelReason}</Alert> : null}
      <Panel flush title={`Items (${d.itemCount})`}>
        <div className="table-wrap">
          <table className="grid" aria-label="Clearance items">
            <thead><tr><th>Asset</th><th>Assigned since</th><th>Status</th><th>Details</th><th className="actions" aria-label="Actions" /></tr></thead>
            <tbody>
              {d.items.map((i) => (
                <tr key={i.id} data-testid="clearance-item">
                  <td className="ident">{i.assetCode}<div className="faint">{i.categoryName}{i.makeModel ? `, ${i.makeModel}` : ''}{i.serialNumber ? `, ${i.serialNumber}` : ''}</div></td>
                  <td>{formatDateTime(i.assignedAt)}</td>
                  <td><span className={`badge ${resolutionClass(i.resolution)}`}>{CLEARANCE_RESOLUTION_LABELS[i.resolution]}</span></td>
                  <td>
                    {i.receivedCondition ? <div>Returned: {CONDITION_LABELS[i.receivedCondition]}{i.returnOutcome ? `, ${RETURN_OUTCOME_LABELS[i.returnOutcome].toLowerCase()}` : ''}</div> : null}
                    {i.exceptionReason ? <div className="muted">Reported: {i.exceptionReason}{i.reportedByName ? ` (${i.reportedByName})` : ''}</div> : null}
                    {i.decisionNotes ? <div className="muted">Decision: {i.decisionNotes} ({i.reviewedByName}, {formatDateTime(i.reviewedAt)})</div> : null}
                    {i.documents.map((doc) => (
                      <div key={doc.linkId}>
                        <button className="link-btn" onClick={() => void downloadFile(apiUrl(`/api/v1/documents/${doc.documentId}/content`), doc.originalName).catch(setError)}>{doc.originalName}</button>
                      </div>
                    ))}
                  </td>
                  <td className="actions">
                    {open ? (
                      <div className="chips">
                        {['outstanding', 'missing', 'disputed'].includes(i.resolution) && has('allocations.return') && has('exit_clearance.manage') ? <Button small onClick={() => setAction({ kind: 'return', item: i })}>Record return</Button> : null}
                        {['outstanding', 'missing', 'disputed'].includes(i.resolution) && has('exit_clearance.manage') ? <Button small variant="quiet" onClick={() => setAction({ kind: 'flag', item: i })}>Missing / disputed</Button> : null}
                        {['damaged', 'missing', 'disputed'].includes(i.resolution) && has('exit_clearance.approve_exception') ? <Button small variant="quiet" onClick={() => setAction({ kind: 'approve', item: i })}>Approve exception</Button> : null}
                        {UNRESOLVED_RESOLUTIONS.includes(i.resolution) && has('exit_clearance.manage') ? (
                          <label className="btn btn--small btn--quiet">
                            Attach evidence
                            <input type="file" hidden accept=".pdf,.png,.jpg,.jpeg,.webp" onChange={(e) => void evidence(i, e)} />
                          </label>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {d.items.length === 0 ? <div className="empty">The employee had no assigned assets when the clearance opened.</div> : null}
        </div>
      </Panel>
      {action?.kind === 'return' ? <ReturnItemDialog item={action.item} canInspect={has('allocations.inspect')} onClose={() => setAction(null)} onDone={(n) => updated(n, `${action.item.assetCode} recorded as returned.`)} /> : null}
      {action?.kind === 'flag' ? <FlagItemDialog item={action.item} onClose={() => setAction(null)} onDone={(n) => updated(n, `${action.item.assetCode} flagged.`)} /> : null}
      {action?.kind === 'approve' ? <ApproveDialog item={action.item} onClose={() => setAction(null)} onDone={(n) => updated(n, `Exception approved for ${action.item.assetCode}.`)} /> : null}
      {closing ? <CloseDialog clearance={d} mode={closing} onClose={() => setClosing(null)} onDone={(n) => updated(n, closing === 'close' ? 'Clearance closed.' : 'Clearance cancelled.')} /> : null}
    </div>
  )
}

function useDialogSave(onDone: (d: ClearanceDetail) => void) {
  const [error, setError] = useState<unknown>(null)
  const save = async (fn: () => Promise<ClearanceDetail>) => {
    setError(null)
    try {
      onDone(await fn())
    } catch (err) {
      setError(err)
    }
  }
  return { error, save }
}

function ReturnItemDialog({ item, canInspect, onClose, onDone }: { item: ClearanceItemView; canInspect: boolean; onClose: () => void; onDone: (d: ClearanceDetail) => void }) {
  const { locations } = useOrgLookups()
  const [condition, setCondition] = useState<AssetCondition>('good')
  const [outcome, setOutcome] = useState<ReturnOutcome>('awaiting_inspection')
  const [locationId, setLocationId] = useState('')
  const [notes, setNotes] = useState('')
  const { error, save } = useDialogSave(onDone)
  return (
    <Dialog title={`Record return of ${item.assetCode}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => void save(() => call('exitClearance.recordReturn', { itemId: item.id, condition, outcome, returnLocationId: locationId || null, notes: notes.trim() || null }))}>Record return</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <p className="muted">A damaged or faulty return stays open as an exception until it is approved.</p>
        <div className="form-grid">
          <SelectField label="Condition" value={condition} onChange={(v) => setCondition(v as AssetCondition)} options={conditionOptions} />
          <SelectField label="After return" value={outcome} onChange={(v) => setOutcome(v as ReturnOutcome)} options={RETURN_OUTCOMES.filter((o) => o !== 'ready' || canInspect).map((o) => ({ value: o, label: RETURN_OUTCOME_LABELS[o] }))} />
          <SelectField label="Returned to (location)" value={locationId} placeholder="Keep current location" onChange={setLocationId} options={optionList(locations, (l) => l.path)} />
        </div>
        <TextAreaField label="Observations" value={notes} onChange={setNotes} />
      </div>
    </Dialog>
  )
}

function FlagItemDialog({ item, onClose, onDone }: { item: ClearanceItemView; onClose: () => void; onDone: (d: ClearanceDetail) => void }) {
  const [resolution, setResolution] = useState<'missing' | 'disputed'>('missing')
  const [reason, setReason] = useState('')
  const { error, save } = useDialogSave(onDone)
  return (
    <Dialog title={`Flag ${item.assetCode}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" disabled={!reason.trim()} onClick={() => void save(() => call('exitClearance.flagItem', { itemId: item.id, resolution, reason }))}>Flag item</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <p className="muted">The asset stays assigned to the employee until an authorized person approves the exception.</p>
        <SelectField label="Problem" value={resolution} onChange={(v) => setResolution(v as typeof resolution)} options={[{ value: 'missing', label: 'Missing' }, { value: 'disputed', label: 'Disputed' }]} />
        <TextAreaField label="Reason" value={reason} onChange={setReason} hint="Required. Who reported it and what is known." />
      </div>
    </Dialog>
  )
}

function ApproveDialog({ item, onClose, onDone }: { item: ClearanceItemView; onClose: () => void; onDone: (d: ClearanceDetail) => void }) {
  const [notes, setNotes] = useState('')
  const { error, save } = useDialogSave(onDone)
  return (
    <Dialog title={`Approve exception for ${item.assetCode}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" disabled={!notes.trim()} onClick={() => void save(() => call('exitClearance.approveException', { itemId: item.id, decisionNotes: notes }))}>Approve exception</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        {item.resolution === 'damaged' ? (
          <p className="muted">The asset was returned damaged. Approving accepts the damage for this clearance; the asset stays out of service until inspected or repaired.</p>
        ) : (
          <Alert tone="warn">Approving writes the asset off as lost: its assignment ends as "reported lost" and the asset's lifecycle becomes lost.</Alert>
        )}
        <TextAreaField label="Decision notes" value={notes} onChange={setNotes} hint="Required. Recorded in the clearance and audit log." />
      </div>
    </Dialog>
  )
}

function CloseDialog({ clearance, mode, onClose, onDone }: { clearance: ClearanceDetail; mode: 'close' | 'cancel'; onClose: () => void; onDone: (d: ClearanceDetail) => void }) {
  const [text, setText] = useState('')
  const { error, save } = useDialogSave(onDone)
  const submit = () =>
    save(() => (mode === 'close' ? call('exitClearance.close', { clearanceId: clearance.id, closingNotes: text.trim() || null }) : call('exitClearance.cancel', { clearanceId: clearance.id, reason: text })))
  return (
    <Dialog title={mode === 'close' ? 'Close clearance' : 'Cancel clearance'} onClose={onClose} footer={<><Button onClick={onClose}>Back</Button><Button variant={mode === 'close' ? 'primary' : 'danger'} disabled={mode === 'cancel' && !text.trim()} onClick={() => void submit()}>{mode === 'close' ? 'Close clearance' : 'Cancel clearance'}</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <TextAreaField label={mode === 'close' ? 'Closing notes' : 'Reason'} value={text} onChange={setText} hint={mode === 'close' ? 'Optional' : 'Required, e.g. the resignation was withdrawn'} />
      </div>
    </Dialog>
  )
}
