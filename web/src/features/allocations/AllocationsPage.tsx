import { useCallback, useEffect, useState } from 'react'
import { ASSIGNMENT_STATUS_LABELS, ASSIGNMENT_STATUSES, ASSIGNMENT_TARGET_TYPES, TARGET_TYPE_LABELS, type AssignmentStatus, type AssignmentTargetType } from '@shared/allocations'
import type { AssignmentView, Page, SessionInfo } from '@shared/api'
import { call, formatDateTime } from '../../api'
import { Button, ErrorAlert, PageHeader, Panel, SelectField, SkeletonRows, TextField, useToast } from '../../components/ui'
import { useLatestOnly } from '../../hooks'
import { IssueDialog, ReturnDialog, TransferDialog } from './dialogs'
import { AckBadge, AssignmentStatusBadge, HandoverReceipt, type PickedAsset } from './shared'

const PAGE_SIZE = 50
type Open = { kind: 'issue' | 'transfer' | 'return'; initial?: PickedAsset } | null

/** Assignments across the organization, with issue, transfer, return and receipts (W4). */
export function AllocationsPage({ session, navigate }: { session: SessionInfo; navigate: (route: string) => void }) {
  const has = (p: string) => session.permissions.includes(p as never)
  const [status, setStatus] = useState<AssignmentStatus | 'all'>('active')
  const [targetType, setTargetType] = useState<AssignmentTargetType | ''>('')
  const [query, setQuery] = useState('')
  const [overdue, setOverdue] = useState(false)
  const [pending, setPending] = useState(false)
  const [page, setPage] = useState(1)
  const [data, setData] = useState<Page<AssignmentView> | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [open, setOpen] = useState<Open>(null)
  const [receipt, setReceipt] = useState<string | null>(null)
  const toast = useToast()

  const guard = useLatestOnly()
  const load = useCallback(() => {
    setError(null)
    guard(call('allocations.list', { status, ...(targetType ? { targetType } : {}), ...(query.trim() ? { query: query.trim() } : {}), overdueOnly: overdue, pendingAcknowledgmentOnly: pending, page, pageSize: PAGE_SIZE })).then(setData, setError)
  }, [status, targetType, query, overdue, pending, page])
  useEffect(() => {
    const t = window.setTimeout(load, 200)
    return () => window.clearTimeout(t)
  }, [load])

  const rowAction = async (kind: 'transfer' | 'return', a: AssignmentView) => {
    try {
      const custody = await call('allocations.custody', { assetId: a.assetId })
      setOpen({ kind, initial: { custody, label: `${a.assetCode} — ${a.categoryName}${a.makeModel ? `, ${a.makeModel}` : ''}` } })
    } catch (err) {
      setError(err)
    }
  }
  const done = (message: string, handoverId?: string) => {
    setOpen(null)
    toast.success(message)
    if (handoverId) setReceipt(handoverId)
    load()
  }
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1
  return (
    <div className="stack">
      <PageHeader
        title="Allocations and returns"
        description="Who holds each asset. Issues, transfers and returns are recorded as handovers and never overwrite earlier custody."
        actions={
          <>
            {has('allocations.return') ? <Button onClick={() => setOpen({ kind: 'return' })}>Receive return</Button> : null}
            {has('allocations.transfer') ? <Button onClick={() => setOpen({ kind: 'transfer' })}>Transfer</Button> : null}
            {has('allocations.issue') ? <Button variant="primary" onClick={() => setOpen({ kind: 'issue' })}>Issue assets</Button> : null}
          </>
        }
      />
      <ErrorAlert error={error} onRetry={load} />
      <Panel flush>
        <div className="toolbar">
          <div className="field field--grow">
            <TextField label="Search" placeholder="Asset code, serial, employee, workstation, team or pool" value={query} onChange={(e) => { setPage(1); setQuery(e.target.value) }} />
          </div>
          <SelectField label="Status" value={status} onChange={(v) => { setPage(1); setStatus(v as AssignmentStatus | 'all') }} options={[...ASSIGNMENT_STATUSES.map((s) => ({ value: s, label: ASSIGNMENT_STATUS_LABELS[s] })), { value: 'all', label: 'All' }]} />
          <SelectField label="Target" value={targetType} placeholder="Any" onChange={(v) => { setPage(1); setTargetType(v as AssignmentTargetType | '') }} options={ASSIGNMENT_TARGET_TYPES.map((t) => ({ value: t, label: TARGET_TYPE_LABELS[t] }))} />
          <label className="checkbox"><input type="checkbox" checked={overdue} onChange={(e) => { setPage(1); setOverdue(e.target.checked) }} /> Overdue only</label>
          <label className="checkbox"><input type="checkbox" checked={pending} onChange={(e) => { setPage(1); setPending(e.target.checked) }} /> Acknowledgment pending</label>
        </div>
        <div className="table-wrap">
          <table className="grid" aria-label="Assignments">
            <thead><tr><th>Asset</th><th>Assigned to</th><th>Location</th><th>Since</th><th>Expected return</th><th>Status</th><th className="actions" aria-label="Actions" /></tr></thead>
            <tbody>
              {!data && !error ? <SkeletonRows columns={7} /> : null}
              {data?.items.map((a) => (
                <tr key={a.id}>
                  <td className="ident">
                    <button className="link-btn" onClick={() => navigate(`assets/${a.assetId}`)}>{a.assetCode}</button>
                    <div className="faint">{a.categoryName}{a.makeModel ? `, ${a.makeModel}` : ''}</div>
                  </td>
                  <td>{TARGET_TYPE_LABELS[a.targetType]}: {a.targetLabel}</td>
                  <td>{a.locationPath ?? '—'}</td>
                  <td>{formatDateTime(a.assignedAt)}</td>
                  <td>{a.expectedReturnDate ?? '—'} {a.overdue ? <span className="badge badge--off">Overdue</span> : null}</td>
                  <td><div className="chips"><AssignmentStatusBadge status={a.status} /> {a.status === 'active' ? <AckBadge status={a.acknowledgmentStatus} /> : null}</div></td>
                  <td className="actions">
                    <div className="chips">
                      <Button small variant="quiet" onClick={() => setReceipt(a.issueHandoverId)}>Receipt</Button>
                      {a.status === 'active' && has('allocations.transfer') ? <Button small variant="quiet" onClick={() => void rowAction('transfer', a)}>Transfer</Button> : null}
                      {a.status === 'active' && has('allocations.return') ? <Button small variant="quiet" onClick={() => void rowAction('return', a)}>Return</Button> : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && data.items.length === 0 ? <div className="empty">{status === 'active' && !query ? 'No assets are assigned yet. Use "Issue assets" to record the first handover.' : 'No assignments match these filters.'}</div> : null}
        </div>
        {data && data.total > PAGE_SIZE ? (
          <div className="toolbar">
            <Button small disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
            <span className="faint">Page {page} of {pages} ({data.total} assignments)</span>
            <Button small disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
          </div>
        ) : null}
      </Panel>
      {open?.kind === 'issue' ? <IssueDialog {...(open.initial ? { initial: open.initial } : {})} onClose={() => setOpen(null)} onDone={(h) => done(`Issued under ${h.handoverNumber}.`, h.id)} /> : null}
      {open?.kind === 'transfer' ? <TransferDialog {...(open.initial ? { initial: open.initial } : {})} onClose={() => setOpen(null)} onDone={(h) => done(`Transferred under ${h.handoverNumber}.`, h.id)} /> : null}
      {open?.kind === 'return' ? <ReturnDialog {...(open.initial ? { initial: open.initial } : {})} session={session} onClose={() => setOpen(null)} onDone={(h) => done(`Return recorded under ${h.handoverNumber}.`, h.id)} /> : null}
      {receipt ? <HandoverReceipt handoverId={receipt} session={session} onClose={() => setReceipt(null)} /> : null}
    </div>
  )
}
