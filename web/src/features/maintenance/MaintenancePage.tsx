import { useCallback, useEffect, useState, type ChangeEvent } from 'react'
import { FAULT_CATEGORIES, MAINTENANCE_PRIORITIES, type FaultCategory, type MaintenancePriority } from '@shared/maintenance'
import { RETURN_OUTCOME_LABELS, RETURN_OUTCOMES } from '@shared/allocations'
import type { AssetListItem, MaintenanceTicketDetail, MaintenanceTicketSummary, Page, SessionInfo } from '@shared/api'
import { formatMinor, minorToInput } from '@shared/assets'
import { ApiError, apiUrl, call, downloadFile, formatDateTime, uploadFile } from '../../api'
import { Alert, Button, Dialog, ErrorAlert, PageHeader, Panel, SelectField, TextAreaField, TextField } from '../../components/ui'
import { useLatestOnly } from '../../hooks'
import { AssetScanField, PriorityBadge, TicketStatusBadge, categoryOptions, priorityOptions, useTechnicians } from './shared'

const PAGE_SIZE = 50

/** Maintenance tickets (W5, TAS §11): list/filter, create, assign, work, resolve and close. */
export function MaintenancePage({ session, selectedId, navigate }: { session: SessionInfo; selectedId: string | null; navigate: (route: string) => void }) {
  const has = (p: string) => session.permissions.includes(p as never)
  const [status, setStatus] = useState<'all' | 'open' | 'in_progress' | 'resolved' | 'closed' | 'cancelled'>('all')
  const [query, setQuery] = useState('')
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [page, setPage] = useState(1)
  const [data, setData] = useState<Page<MaintenanceTicketSummary> | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [creating, setCreating] = useState(false)

  const guard = useLatestOnly()
  const load = useCallback(() => {
    setError(null)
    guard(call('maintenance.list', { status, query: query.trim() || undefined, overdueOnly, page, pageSize: PAGE_SIZE })).then(setData, setError)
  }, [status, query, overdueOnly, page])
  useEffect(() => {
    const t = window.setTimeout(load, 200)
    return () => window.clearTimeout(t)
  }, [load])

  if (selectedId) return <TicketDetail ticketId={selectedId} session={session} onBack={() => { navigate('maintenance'); load() }} />
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1
  return (
    <div className="stack">
      <PageHeader title="Maintenance" description="Fault tickets for individually tracked assets, from report to return to service." actions={has('maintenance.create') ? <Button variant="primary" onClick={() => setCreating(true)}>Report a fault</Button> : null} />
      <ErrorAlert error={error} onRetry={load} />
      <Panel flush>
        <div className="toolbar">
          <div className="field field--grow"><TextField label="Search" placeholder="Ticket number, asset code, vendor or technician" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
          <SelectField label="Status" value={status} onChange={(v) => setStatus(v as typeof status)} options={[{ value: 'all', label: 'All' }, { value: 'open', label: 'Open' }, { value: 'in_progress', label: 'In progress' }, { value: 'resolved', label: 'Resolved' }, { value: 'closed', label: 'Closed' }, { value: 'cancelled', label: 'Cancelled' }]} />
          <label className="checkbox"><input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} /> Overdue only</label>
        </div>
        <div className="table-wrap">
          <table className="grid" aria-label="Maintenance tickets">
            <thead><tr><th>Ticket</th><th>Asset</th><th>Priority</th><th>Status</th><th>Technician</th><th>Reported</th><th>Target date</th></tr></thead>
            <tbody>
              {data?.items.map((t) => (
                <tr key={t.id} className="is-clickable" onClick={() => navigate(`maintenance/${t.id}`)}>
                  <td className="ident"><button className="link-btn" onClick={() => navigate(`maintenance/${t.id}`)}>{t.ticketNumber}</button></td>
                  <td>{t.assetCode} <span className="faint">{t.assetCategoryName}</span></td>
                  <td><PriorityBadge priority={t.priority} /></td>
                  <td><TicketStatusBadge status={t.status} /></td>
                  <td>{t.assignedTechnicianName ?? t.vendorName ?? '—'}</td>
                  <td>{formatDateTime(t.reportedAt)}</td>
                  <td>{t.targetResolutionDate ?? '—'} {t.overdue ? <span className="badge badge--off">Overdue</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && data.items.length === 0 ? <div className="empty">No tickets match these filters.</div> : null}
        </div>
        {data && data.total > PAGE_SIZE ? (
          <div className="toolbar">
            <Button small disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
            <span className="faint">Page {page} of {pages} ({data.total} tickets)</span>
            <Button small disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
          </div>
        ) : null}
      </Panel>
      {creating ? <CreateTicketDialog onClose={() => setCreating(false)} onDone={(t) => { setCreating(false); navigate(`maintenance/${t.id}`) }} /> : null}
    </div>
  )
}

export type MinimalAsset = Pick<AssetListItem, 'id' | 'assetCode' | 'categoryName'> & Partial<Pick<AssetListItem, 'manufacturer' | 'modelName'>>

export function CreateTicketDialog({ presetAsset, defaultDescription, onClose, onDone }: { presetAsset?: MinimalAsset; defaultDescription?: string; onClose: () => void; onDone: (t: MaintenanceTicketDetail) => void }) {
  const technicians = useTechnicians()
  const [asset, setAsset] = useState<MinimalAsset | null>(presetAsset ?? null)
  const [category, setCategory] = useState<FaultCategory>('hardware')
  const [priority, setPriority] = useState<MaintenancePriority>('medium')
  const [description, setDescription] = useState(defaultDescription ?? '')
  const [targetDate, setTargetDate] = useState('')
  const [technicianId, setTechnicianId] = useState('')
  const [vendorName, setVendorName] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const fields = error instanceof ApiError ? error.fieldErrors : {}
  const forced = error instanceof ApiError && error.code === 'STATE_CONFLICT' && error.message.includes('already has an open ticket')
  const [forceAdditional, setForceAdditional] = useState(false)
  const [justification, setJustification] = useState('')
  const submit = async () => {
    if (!asset) return
    setBusy(true)
    setError(null)
    try {
      onDone(await call('maintenance.create', {
        assetId: asset.id, category, priority, description, targetResolutionDate: targetDate || null,
        assignedTechnicianId: technicianId || null, vendorName: vendorName.trim() || null, vendorReference: null,
        forceAdditional, justification: justification.trim() || null
      }))
    } catch (err) {
      setError(err)
      if (err instanceof ApiError && err.message.includes('already has an open ticket')) setForceAdditional(false)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog title="Report a fault" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !asset || !description.trim()} onClick={() => void submit()}>{busy ? 'Saving…' : 'Open ticket'}</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        {!asset ? (
          <AssetScanField label="Asset" onFound={setAsset} />
        ) : (
          <div className="chips"><strong className="ident">{asset.assetCode}</strong><span className="faint">{asset.categoryName}{asset.manufacturer || asset.modelName ? `, ${[asset.manufacturer, asset.modelName].filter(Boolean).join(' ')}` : ''}</span><Button small variant="quiet" onClick={() => setAsset(null)}>Change</Button></div>
        )}
        <div className="form-grid">
          <SelectField label="Fault category" value={category} onChange={(v) => setCategory(v as FaultCategory)} options={categoryOptions} />
          <SelectField label="Priority" value={priority} onChange={(v) => setPriority(v as MaintenancePriority)} options={priorityOptions} />
          <TextField label="Target resolution date" type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} hint="Optional" />
          <SelectField label="Assign technician" value={technicianId} placeholder="Unassigned for now" onChange={setTechnicianId} options={technicians.map((t) => ({ value: t.id, label: t.displayName }))} />
          <TextField label="External vendor" value={vendorName} onChange={(e) => setVendorName(e.target.value)} hint="If an outside vendor will do the repair" />
        </div>
        <TextAreaField label="Description" value={description} onChange={setDescription} error={fields['description']} hint="Required" />
        {(forced || forceAdditional) ? (
          <div className="stack">
            <Alert tone="warn">This asset already has an open ticket. Opening another needs a stated reason.</Alert>
            <label className="checkbox"><input type="checkbox" checked={forceAdditional} onChange={(e) => setForceAdditional(e.target.checked)} /> Open an additional ticket anyway</label>
            {forceAdditional ? <TextAreaField label="Justification" value={justification} onChange={setJustification} error={fields['justification']} hint="Required" /> : null}
          </div>
        ) : null}
      </div>
    </Dialog>
  )
}

function TicketDetail({ ticketId, session, onBack }: { ticketId: string; session: SessionInfo; onBack: () => void }) {
  const has = (p: string) => session.permissions.includes(p as never)
  const [t, setT] = useState<MaintenanceTicketDetail | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const guard = useLatestOnly()
  const load = useCallback(() => {
    setError(null)
    guard(call('maintenance.get', { ticketId })).then(setT, setError)
  }, [ticketId])
  useEffect(load, [load])
  if (!t) return <div className="stack"><ErrorAlert error={error} onRetry={load} />{!error ? <p className="faint" role="status">Loading ticket…</p> : null}</div>
  const canWork = has('maintenance.update') && ['open', 'in_progress'].includes(t.status)
  return (
    <div className="stack">
      <PageHeader
        title={`${t.ticketNumber}: ${t.assetCode}`}
        description={`${t.assetCategoryName}. Reported ${formatDateTime(t.reportedAt)} by ${t.reportedByName ?? '—'}.`}
        actions={<Button onClick={onBack}>All tickets</Button>}
      />
      <ErrorAlert error={error} />
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <Panel>
        <div className="chips"><PriorityBadge priority={t.priority} /><TicketStatusBadge status={t.status} /> {t.overdue ? <span className="badge badge--off">Overdue</span> : null}</div>
        <dl className="dl">
          <dt>Category</dt><dd>{t.faultCategory}</dd>
          <dt>Description</dt><dd>{t.description}</dd>
          <dt>Technician</dt><dd>{t.assignedTechnicianName ?? '—'}</dd>
          <dt>Vendor</dt><dd>{[t.vendorName, t.vendorReference].filter(Boolean).join(', ') || '—'}</dd>
          <dt>Target date</dt><dd>{t.targetResolutionDate ?? '—'}</dd>
          {t.diagnosis ? (<><dt>Diagnosis</dt><dd>{t.diagnosis}</dd></>) : null}
          {t.workPerformed ? (<><dt>Work performed</dt><dd>{t.workPerformed}</dd></>) : null}
          {t.downtimeMinutes !== null ? (<><dt>Downtime</dt><dd>{t.downtimeMinutes} minutes</dd></>) : null}
          {t.costVisible ? (<><dt>Cost</dt><dd className="num">{formatMinor(t.partsCostMinor, t.currency)} parts, {formatMinor(t.laborCostMinor, t.currency)} labor</dd></>) : null}
          {t.status === 'closed' ? (<><dt>Closed</dt><dd>{formatDateTime(t.closedAt)}: {RETURN_OUTCOME_LABELS[t.resultOutcome!]}. {t.closingNotes}</dd></>) : null}
          {t.status === 'cancelled' ? (<><dt>Cancelled</dt><dd>{t.cancelReason}</dd></>) : null}
        </dl>
      </Panel>
      {canWork || t.status === 'resolved' ? <TicketActions ticket={t} session={session} onChanged={(n, msg) => { setT(n); setNotice(msg) }} onError={setError} /> : null}
      <DocumentsSection ticketId={t.id} documents={t.documents} canManage={canWork} onChanged={load} />
      <div>
        <h3 className="section-title">History</h3>
        <ul className="history">
          {t.events.map((e) => (
            <li key={e.id}><strong>{e.eventType}</strong> <span className="faint">{formatDateTime(e.occurredAt)} by {e.actorName ?? 'system'}</span>{e.notes ? <div className="muted">{e.notes}</div> : null}</li>
          ))}
        </ul>
      </div>
    </div>
  )
}

type Action = 'assign' | 'update' | 'resolve' | 'close' | 'cancel' | null

function TicketActions({ ticket, session, onChanged, onError }: { ticket: MaintenanceTicketDetail; session: SessionInfo; onChanged: (t: MaintenanceTicketDetail, message: string) => void; onError: (e: unknown) => void }) {
  const has = (p: string) => session.permissions.includes(p as never)
  const [open, setOpen] = useState<Action>(null)
  const canWork = ['open', 'in_progress'].includes(ticket.status)
  return (
    <div className="chips">
      {canWork && has('maintenance.assign') ? <Button small onClick={() => setOpen('assign')}>Assign technician</Button> : null}
      {canWork && has('maintenance.update') ? <Button small onClick={() => setOpen('update')}>Record work</Button> : null}
      {canWork && has('maintenance.update') ? <Button small onClick={() => setOpen('resolve')}>Mark resolved</Button> : null}
      {ticket.status === 'resolved' && has('maintenance.close') ? <Button small variant="primary" onClick={() => setOpen('close')}>Close ticket</Button> : null}
      {canWork && has('maintenance.close') ? <Button small variant="quiet" onClick={() => setOpen('cancel')}>Cancel</Button> : null}
      {open === 'assign' ? <AssignDialog ticket={ticket} onClose={() => setOpen(null)} onDone={(t) => { setOpen(null); onChanged(t, 'Technician assigned.') }} onError={onError} /> : null}
      {open === 'update' ? <UpdateDialog ticket={ticket} canViewCost={has('finance.view_cost')} onClose={() => setOpen(null)} onDone={(t) => { setOpen(null); onChanged(t, 'Work recorded.') }} onError={onError} /> : null}
      {open === 'resolve' ? <ResolveDialog ticket={ticket} onClose={() => setOpen(null)} onDone={(t) => { setOpen(null); onChanged(t, 'Ticket marked resolved.') }} onError={onError} /> : null}
      {open === 'close' ? <CloseDialog ticket={ticket} canInspect={has('allocations.inspect')} onClose={() => setOpen(null)} onDone={(t) => { setOpen(null); onChanged(t, 'Ticket closed.') }} onError={onError} /> : null}
      {open === 'cancel' ? <CancelDialog ticket={ticket} onClose={() => setOpen(null)} onDone={(t) => { setOpen(null); onChanged(t, 'Ticket cancelled.') }} onError={onError} /> : null}
    </div>
  )
}

function useAction<T>(onDone: (t: T) => void, onError: (e: unknown) => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const run = async (fn: () => Promise<T>) => {
    setBusy(true)
    setError(null)
    try {
      onDone(await fn())
    } catch (err) {
      setError(err)
      onError(err)
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

function AssignDialog({ ticket, onClose, onDone, onError }: { ticket: MaintenanceTicketDetail; onClose: () => void; onDone: (t: MaintenanceTicketDetail) => void; onError: (e: unknown) => void }) {
  const technicians = useTechnicians()
  const [technicianId, setTechnicianId] = useState('')
  const [notes, setNotes] = useState('')
  const { busy, error, run } = useAction(onDone, onError)
  return (
    <Dialog title="Assign technician" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !technicianId} onClick={() => void run(() => call('maintenance.assign', { ticketId: ticket.id, assignedTechnicianId: technicianId, notes: notes.trim() || null }))}>Assign</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <SelectField label="Technician" value={technicianId} placeholder="Choose" onChange={setTechnicianId} options={technicians.map((t) => ({ value: t.id, label: t.displayName }))} />
        <TextAreaField label="Notes" value={notes} onChange={setNotes} />
      </div>
    </Dialog>
  )
}

function UpdateDialog({ ticket, canViewCost, onClose, onDone, onError }: { ticket: MaintenanceTicketDetail; canViewCost: boolean; onClose: () => void; onDone: (t: MaintenanceTicketDetail) => void; onError: (e: unknown) => void }) {
  const [form, setForm] = useState({
    priority: ticket.priority, description: ticket.description, diagnosis: ticket.diagnosis ?? '', workPerformed: ticket.workPerformed ?? '',
    vendorName: ticket.vendorName ?? '', vendorReference: ticket.vendorReference ?? '',
    partsCost: minorToInput(ticket.partsCostMinor, ticket.currency), laborCost: minorToInput(ticket.laborCostMinor, ticket.currency),
    downtimeMinutes: ticket.downtimeMinutes === null ? '' : String(ticket.downtimeMinutes), targetResolutionDate: ticket.targetResolutionDate ?? ''
  })
  const [notes, setNotes] = useState('')
  const { busy, error, run } = useAction(onDone, onError)
  const fields = error instanceof ApiError ? error.fieldErrors : {}
  const submit = () =>
    run(() =>
      call('maintenance.update', {
        ticketId: ticket.id, priority: form.priority, description: form.description, diagnosis: form.diagnosis.trim() || null, workPerformed: form.workPerformed.trim() || null,
        vendorName: form.vendorName.trim() || null, vendorReference: form.vendorReference.trim() || null,
        partsCost: canViewCost ? form.partsCost.trim() || null : null, laborCost: canViewCost ? form.laborCost.trim() || null : null,
        downtimeMinutes: form.downtimeMinutes.trim() ? Number(form.downtimeMinutes) : null, targetResolutionDate: form.targetResolutionDate || null, notes: notes.trim() || null
      })
    )
  return (
    <Dialog title="Record work" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy} onClick={() => void submit()}>Save</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <div className="form-grid">
          <SelectField label="Priority" value={form.priority} onChange={(v) => setForm({ ...form, priority: v as MaintenancePriority })} options={priorityOptions} />
          <TextField label="Target resolution date" type="date" value={form.targetResolutionDate} onChange={(e) => setForm({ ...form, targetResolutionDate: e.target.value })} />
          <TextField label="Vendor" value={form.vendorName} onChange={(e) => setForm({ ...form, vendorName: e.target.value })} />
          <TextField label="Vendor reference" value={form.vendorReference} onChange={(e) => setForm({ ...form, vendorReference: e.target.value })} />
          <TextField label="Downtime (minutes)" inputMode="numeric" value={form.downtimeMinutes} onChange={(e) => setForm({ ...form, downtimeMinutes: e.target.value })} />
          {canViewCost ? (
            <>
              <TextField label="Parts cost" value={form.partsCost} onChange={(e) => setForm({ ...form, partsCost: e.target.value })} error={fields['partsCost']} />
              <TextField label="Labor cost" value={form.laborCost} onChange={(e) => setForm({ ...form, laborCost: e.target.value })} error={fields['laborCost']} />
            </>
          ) : null}
        </div>
        <TextAreaField label="Diagnosis" value={form.diagnosis} onChange={(v) => setForm({ ...form, diagnosis: v })} />
        <TextAreaField label="Work performed" value={form.workPerformed} onChange={(v) => setForm({ ...form, workPerformed: v })} />
        <TextAreaField label="Notes for this update" value={notes} onChange={setNotes} hint="Recorded in the ticket history" />
      </div>
    </Dialog>
  )
}

function ResolveDialog({ ticket, onClose, onDone, onError }: { ticket: MaintenanceTicketDetail; onClose: () => void; onDone: (t: MaintenanceTicketDetail) => void; onError: (e: unknown) => void }) {
  const [diagnosis, setDiagnosis] = useState(ticket.diagnosis ?? '')
  const [workPerformed, setWorkPerformed] = useState(ticket.workPerformed ?? '')
  const [downtime, setDowntime] = useState(ticket.downtimeMinutes === null ? '' : String(ticket.downtimeMinutes))
  const [notes, setNotes] = useState('')
  const { busy, error, run } = useAction(onDone, onError)
  return (
    <Dialog title="Mark resolved" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !diagnosis.trim() || !workPerformed.trim()} onClick={() => void run(() => call('maintenance.resolve', { ticketId: ticket.id, diagnosis, workPerformed, downtimeMinutes: downtime.trim() ? Number(downtime) : null, notes: notes.trim() || null }))}>Mark resolved</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <p className="muted">Resolving records the diagnosis and work done. Closing the ticket afterward decides whether the asset returns to service.</p>
        <TextAreaField label="Diagnosis" value={diagnosis} onChange={setDiagnosis} hint="Required" />
        <TextAreaField label="Work performed" value={workPerformed} onChange={setWorkPerformed} hint="Required" />
        <TextField label="Downtime (minutes)" inputMode="numeric" value={downtime} onChange={(e) => setDowntime(e.target.value)} />
        <TextAreaField label="Notes" value={notes} onChange={setNotes} />
      </div>
    </Dialog>
  )
}

function CloseDialog({ ticket, canInspect, onClose, onDone, onError }: { ticket: MaintenanceTicketDetail; canInspect: boolean; onClose: () => void; onDone: (t: MaintenanceTicketDetail) => void; onError: (e: unknown) => void }) {
  const [outcome, setOutcome] = useState<(typeof RETURN_OUTCOMES)[number]>('awaiting_inspection')
  const [notes, setNotes] = useState('')
  const { busy, error, run } = useAction(onDone, onError)
  return (
    <Dialog title={`Close ${ticket.ticketNumber}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !notes.trim()} onClick={() => void run(() => call('maintenance.close', { ticketId: ticket.id, resultOutcome: outcome, closingNotes: notes }))}>Close ticket</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <p className="muted">Closing never makes the asset available by itself — it records the authorized return-to-service decision.</p>
        <SelectField
          label="Asset after closing"
          value={outcome}
          onChange={(v) => setOutcome(v as typeof outcome)}
          options={RETURN_OUTCOMES.filter((o) => o !== 'ready' || canInspect).map((o) => ({ value: o, label: RETURN_OUTCOME_LABELS[o] }))}
          hint={canInspect ? undefined : 'Releasing an asset as ready needs inspection permission'}
        />
        <TextAreaField label="Closing notes" value={notes} onChange={setNotes} hint="Required" />
      </div>
    </Dialog>
  )
}

function CancelDialog({ ticket, onClose, onDone, onError }: { ticket: MaintenanceTicketDetail; onClose: () => void; onDone: (t: MaintenanceTicketDetail) => void; onError: (e: unknown) => void }) {
  const [reason, setReason] = useState('')
  const { busy, error, run } = useAction(onDone, onError)
  return (
    <Dialog title={`Cancel ${ticket.ticketNumber}`} onClose={onClose} footer={<><Button onClick={onClose}>Back</Button><Button variant="danger" disabled={busy || !reason.trim()} onClick={() => void run(() => call('maintenance.cancel', { ticketId: ticket.id, reason }))}>Cancel ticket</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <p className="muted">For a duplicate or mistaken report. The asset's operational status is not changed.</p>
        <TextAreaField label="Reason" value={reason} onChange={setReason} hint="Required" />
      </div>
    </Dialog>
  )
}

function DocumentsSection({ ticketId, documents, canManage, onChanged }: { ticketId: string; documents: MaintenanceTicketDetail['documents']; canManage: boolean; onChanged: () => void }) {
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(null)
    setBusy(true)
    uploadFile('/api/v1/uploads/documents', file, { entityType: 'maintenance_ticket', entityId: ticketId, purpose: 'repair_evidence' })
      .then(onChanged, setError)
      .finally(() => setBusy(false))
  }
  return (
    <div>
      <h3 className="section-title">Evidence ({documents.length})</h3>
      <ErrorAlert error={error} />
      {documents.map((d) => (
        <div className="doc-row" key={d.linkId}>
          <span>{d.originalName}</span>
          <Button small variant="quiet" onClick={() => void downloadFile(apiUrl(`/api/v1/documents/${d.documentId}/content`), d.originalName).catch(setError)}>Download</Button>
        </div>
      ))}
      {canManage ? (
        <label className="btn btn--small">
          {busy ? 'Uploading…' : 'Attach photo or document'}
          <input type="file" hidden disabled={busy} accept=".pdf,.png,.jpg,.jpeg,.webp" onChange={onFile} />
        </label>
      ) : null}
    </div>
  )
}
