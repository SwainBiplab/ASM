import { useCallback, useEffect, useState } from 'react'
import type { Page, PurchaseRequestDetail, PurchaseRequestSummary, SessionInfo } from '@shared/api'
import type { RequestItemInput, SaveRequestDraftInput } from '@shared/procurementSchemas'
import { formatMinor } from '@shared/assets'
import { ApiError, apiUrl, call, downloadFile, formatDateTime, uploadFile } from '../../api'
import { Alert, Button, Dialog, ErrorAlert, PageHeader, Panel, SelectField, TextAreaField, TextField } from '../../components/ui'
import { useLatestOnly } from '../../hooks'
import { RequestStatusBadge, useCategories } from './shared'

const PAGE_SIZE = 50
const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP']

export function ProcurementPage({ session, selectedId, navigate }: { session: SessionInfo; selectedId: string | null; navigate: (route: string) => void }) {
  const has = (p: string) => session.permissions.includes(p as never)
  const [status, setStatus] = useState<'all' | 'draft' | 'submitted' | 'approved' | 'rejected' | 'cancelled'>('all')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<Page<PurchaseRequestSummary> | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [editing, setEditing] = useState(false)

  const guard = useLatestOnly()
  const load = useCallback(() => {
    setError(null)
    guard(call('procurement.list', { status, query: query.trim() || undefined, page, pageSize: PAGE_SIZE })).then(setData, setError)
  }, [status, query, page])
  useEffect(() => {
    const t = window.setTimeout(load, 200)
    return () => window.clearTimeout(t)
  }, [load])

  if (selectedId) return <RequestDetail requestId={selectedId} session={session} onBack={() => { navigate('procurement'); load() }} />
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1
  return (
    <div className="stack">
      <PageHeader title="Purchase requests" description="Draft, submit, and track procurement requests through configurable approval." actions={has('procurement.create') ? <Button variant="primary" onClick={() => setEditing(true)}>New request</Button> : null} />
      <ErrorAlert error={error} onRetry={load} />
      <Panel flush>
        <div className="toolbar">
          <div className="field field--grow"><TextField label="Search" placeholder="Request number or justification" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
          <SelectField label="Status" value={status} onChange={(v) => setStatus(v as typeof status)} options={[{ value: 'all', label: 'All' }, { value: 'draft', label: 'Draft' }, { value: 'submitted', label: 'Submitted' }, { value: 'approved', label: 'Approved' }, { value: 'rejected', label: 'Rejected' }, { value: 'cancelled', label: 'Cancelled' }]} />
        </div>
        <div className="table-wrap">
          <table className="grid" aria-label="Purchase requests">
            <thead><tr><th>Request</th><th>Requester</th><th>Justification</th><th>Total</th><th>Status</th><th>Submitted</th></tr></thead>
            <tbody>
              {data?.items.map((r) => (
                <tr key={r.id} className="is-clickable" onClick={() => navigate(`procurement/${r.id}`)}>
                  <td className="ident"><button className="link-btn" onClick={() => navigate(`procurement/${r.id}`)}>{r.requestNumber}</button></td>
                  <td>{r.requesterName ?? '—'}</td>
                  <td>{r.justification}</td>
                  <td className="num">{formatMinor(r.totalMinor, r.currency)}</td>
                  <td><RequestStatusBadge status={r.status} /></td>
                  <td>{r.submittedAt ? formatDateTime(r.submittedAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && data.items.length === 0 ? <div className="empty">No requests match these filters.</div> : null}
        </div>
        {data && data.total > PAGE_SIZE ? (
          <div className="toolbar">
            <Button small disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
            <span className="faint">Page {page} of {pages} ({data.total} requests)</span>
            <Button small disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
          </div>
        ) : null}
      </Panel>
      {editing ? <DraftEditor onClose={() => setEditing(false)} onDone={(r) => { setEditing(false); navigate(`procurement/${r.id}`) }} /> : null}
    </div>
  )
}

type DraftLine = RequestItemInput
const blankLine = (): DraftLine => ({ description: '', categoryId: null, modelId: null, quantity: 1, estimatedUnitCost: '' })

function DraftEditor({ existing, onClose, onDone }: { existing?: PurchaseRequestDetail; onClose: () => void; onDone: (r: PurchaseRequestDetail) => void }) {
  const categories = useCategories()
  const [justification, setJustification] = useState(existing?.justification ?? '')
  const [requiredByDate, setRequiredByDate] = useState(existing?.requiredByDate ?? '')
  const [currency, setCurrency] = useState(existing?.currency ?? 'INR')
  const [lines, setLines] = useState<DraftLine[]>(existing ? existing.items.map((i) => ({ description: i.description, categoryId: i.categoryId, modelId: null, quantity: i.quantity, estimatedUnitCost: String(i.estimatedUnitCostMinor / 100) })) : [blankLine()])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const fields = error instanceof ApiError ? error.fieldErrors : {}

  const setLine = (idx: number, patch: Partial<DraftLine>) => setLines(lines.map((l, i) => (i === idx ? { ...l, ...patch } : l)))
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const input: SaveRequestDraftInput = {
        requestId: existing?.id ?? null, departmentId: null, teamId: null, justification, requiredByDate: requiredByDate || null, currency,
        items: lines.filter((l) => l.description.trim())
      }
      onDone(await call('procurement.saveDraft', input))
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      title={existing ? `Edit draft ${existing.requestNumber}` : 'New purchase request'}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !justification.trim() || lines.every((l) => !l.description.trim())} onClick={() => void submit()}>{busy ? 'Saving…' : 'Save draft'}</Button></>}
    >
      <div className="stack">
        <ErrorAlert error={error} />
        <div className="form-grid">
          <TextField label="Required by" type="date" value={requiredByDate} onChange={(e) => setRequiredByDate(e.target.value)} hint="Optional" />
          <SelectField label="Currency" value={currency} onChange={setCurrency} options={CURRENCIES.map((c) => ({ value: c, label: c }))} />
        </div>
        <TextAreaField label="Business justification" value={justification} onChange={setJustification} error={fields['justification']} hint="Required" />
        <h3 className="section-title">Line items</h3>
        {lines.map((l, idx) => (
          <div className="form-grid" key={idx}>
            <TextField label="Description" value={l.description} onChange={(e) => setLine(idx, { description: e.target.value })} />
            <SelectField label="Category" value={l.categoryId ?? ''} placeholder="Not specified" onChange={(v) => setLine(idx, { categoryId: v || null })} options={categories.map((c) => ({ value: c.id, label: c.name }))} />
            <TextField label="Quantity" inputMode="numeric" value={String(l.quantity)} onChange={(e) => setLine(idx, { quantity: Number(e.target.value) || 1 })} />
            <TextField label={`Estimated unit cost (${currency})`} value={l.estimatedUnitCost} onChange={(e) => setLine(idx, { estimatedUnitCost: e.target.value })} />
            {lines.length > 1 ? <Button small variant="quiet" onClick={() => setLines(lines.filter((_, i) => i !== idx))}>Remove line</Button> : null}
          </div>
        ))}
        <Button small onClick={() => setLines([...lines, blankLine()])}>Add line</Button>
      </div>
    </Dialog>
  )
}

function RequestDetail({ requestId, session, onBack }: { requestId: string; session: SessionInfo; onBack: () => void }) {
  const has = (p: string) => session.permissions.includes(p as never)
  const [r, setR] = useState<PurchaseRequestDetail | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const guard = useLatestOnly()
  const load = useCallback(() => {
    setError(null)
    guard(call('procurement.get', { requestId })).then(setR, setError)
  }, [requestId])
  useEffect(load, [load])
  if (!r) return <div className="stack"><ErrorAlert error={error} onRetry={load} />{!error ? <p className="faint" role="status">Loading request…</p> : null}</div>
  const isOwner = r.requesterName === session.user.displayName
  const canEdit = r.status === 'draft' && isOwner && has('procurement.create')
  const canSubmit = canEdit && has('procurement.submit')
  const canCancel = (r.status === 'draft' || r.status === 'submitted') && (isOwner ? has('procurement.create') : has('procurement.approve'))

  const submit = async () => {
    setError(null)
    try {
      setR(await call('procurement.submit', { requestId: r.id }))
      setNotice('Request submitted for approval.')
    } catch (err) {
      setError(err)
    }
  }
  return (
    <div className="stack">
      <PageHeader title={`${r.requestNumber}`} description={r.justification} actions={<Button onClick={onBack}>All requests</Button>} />
      <ErrorAlert error={error} />
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <Panel>
        <div className="chips"><RequestStatusBadge status={r.status} /></div>
        <dl className="dl">
          <dt>Requester</dt><dd>{r.requesterName ?? '—'}</dd>
          <dt>Required by</dt><dd>{r.requiredByDate ?? '—'}</dd>
          <dt>Total</dt><dd className="num">{formatMinor(r.totalMinor, r.currency)}</dd>
          {r.cancelReason ? (<><dt>Cancelled</dt><dd>{r.cancelReason}</dd></>) : null}
        </dl>
        <div className="table-wrap">
          <table className="grid"><thead><tr><th>Line</th><th>Category</th><th>Qty</th><th>Unit cost</th><th>Total</th></tr></thead>
            <tbody>{r.items.map((i) => (<tr key={i.id}><td>{i.description}</td><td>{i.categoryName ?? '—'}</td><td className="num">{i.quantity}</td><td className="num">{formatMinor(i.estimatedUnitCostMinor, r.currency)}</td><td className="num">{formatMinor(i.lineTotalMinor, r.currency)}</td></tr>))}</tbody>
          </table>
        </div>
        <div className="chips">
          {canEdit ? <Button small onClick={() => setEditing(true)}>Edit draft</Button> : null}
          {canSubmit ? <Button small variant="primary" onClick={() => void submit()}>Submit for approval</Button> : null}
          {canCancel ? <Button small variant="quiet" onClick={() => setCancelling(true)}>Cancel request</Button> : null}
        </div>
      </Panel>
      {r.approval ? (
        <Panel title="Approval">
          <p className="faint">Policy: {r.approval.policyName} (v{r.approval.policyVersion}). Step {r.approval.currentStep} of {r.approval.totalSteps}.</p>
          <ul className="history">
            {r.approval.steps.map((s) => (
              <li key={s.stepOrder}>
                <strong>Step {s.stepOrder}: {s.requiredUserName ?? s.requiredRoleName ?? s.requiredRoleKey}</strong>{' '}
                {s.decision ? <span className={`badge ${s.decision === 'approved' ? 'badge--ok' : 'badge--off'}`}>{s.decision}</span> : <span className="faint">pending</span>}
                {s.decidedByName ? <div className="muted">{s.decidedByName}, {formatDateTime(s.decidedAt!)}{s.reason ? `: ${s.reason}` : ''}</div> : null}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
      <DocumentsSection requestId={r.id} documents={r.documents} canManage={canEdit} onChanged={load} />
      {editing ? <DraftEditor existing={r} onClose={() => setEditing(false)} onDone={(n) => { setEditing(false); setR(n) }} /> : null}
      {cancelling ? <CancelDialog requestId={r.id} onClose={() => setCancelling(false)} onDone={(n) => { setCancelling(false); setR(n); setNotice('Request cancelled.') }} /> : null}
    </div>
  )
}

function CancelDialog({ requestId, onClose, onDone }: { requestId: string; onClose: () => void; onDone: (r: PurchaseRequestDetail) => void }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  return (
    <Dialog title="Cancel request" onClose={onClose} footer={<><Button onClick={onClose}>Back</Button><Button variant="danger" disabled={busy || !reason.trim()} onClick={() => {
      setBusy(true)
      call('procurement.cancel', { requestId, reason }).then(onDone, setError).finally(() => setBusy(false))
    }}>Cancel request</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <TextAreaField label="Reason" value={reason} onChange={setReason} hint="Required" />
      </div>
    </Dialog>
  )
}

function DocumentsSection({ requestId, documents, canManage, onChanged }: { requestId: string; documents: PurchaseRequestDetail['documents']; canManage: boolean; onChanged: () => void }) {
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  return (
    <div>
      <h3 className="section-title">Supporting documents ({documents.length})</h3>
      <ErrorAlert error={error} />
      {documents.map((d) => (
        <div className="doc-row" key={d.linkId}>
          <span>{d.originalName}</span>
          <Button small variant="quiet" onClick={() => void downloadFile(apiUrl(`/api/v1/documents/${d.documentId}/content`), d.originalName).catch(setError)}>Download</Button>
        </div>
      ))}
      {canManage ? (
        <label className="btn btn--small">
          {busy ? 'Uploading…' : 'Attach quotation or document'}
          <input type="file" hidden disabled={busy} accept=".pdf,.png,.jpg,.jpeg,.webp" onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (!file) return
            setError(null)
            setBusy(true)
            uploadFile('/api/v1/uploads/documents', file, { entityType: 'purchase_request', entityId: requestId, purpose: 'other' }).then(onChanged, setError).finally(() => setBusy(false))
          }} />
        </label>
      ) : null}
    </div>
  )
}
