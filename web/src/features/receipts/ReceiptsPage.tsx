import { useCallback, useEffect, useState } from 'react'
import type { GoodsReceiptDetail, GoodsReceiptSummary, Page, PurchaseOrderDetail, PurchaseOrderSummary, SessionInfo } from '@shared/api'
import type { UnitDisposition } from '@shared/procurement'
import { UNIT_DISPOSITION_LABELS } from '@shared/procurement'
import { ApiError, call, formatDateTime } from '../../api'
import { Alert, Button, Dialog, ErrorAlert, PageHeader, Panel, SelectField, TextAreaField, TextField } from '../../components/ui'
import { useLatestOnly } from '../../hooks'
import { DiscrepancyBadge, useCategories } from '../procurement/shared'
import { LocationPicker } from './LocationPicker'

const PAGE_SIZE = 50

export function ReceiptsPage({ session, selectedId, navigate }: { session: SessionInfo; selectedId: string | null; navigate: (route: string) => void }) {
  const has = (p: string) => session.permissions.includes(p as never)
  const [page, setPage] = useState(1)
  const [data, setData] = useState<Page<GoodsReceiptSummary> | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [creating, setCreating] = useState(false)

  const guard = useLatestOnly()
  const load = useCallback(() => {
    setError(null)
    guard(call('receipts.list', { page, pageSize: PAGE_SIZE })).then(setData, setError)
  }, [page])
  useEffect(load, [load])

  if (selectedId) return <ReceiptDetail receiptId={selectedId} session={session} onBack={() => { navigate('receipts'); load() }} />
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1
  return (
    <div className="stack">
      <PageHeader title="Goods receipt" description="Receiving is separate from approval: an approved order only authorizes ordering, not that goods have arrived." actions={has('receipts.record') ? <Button variant="primary" onClick={() => setCreating(true)}>Record a receipt</Button> : null} />
      <ErrorAlert error={error} onRetry={load} />
      <Panel flush>
        <div className="table-wrap">
          <table className="grid" aria-label="Goods receipts">
            <thead><tr><th>Receipt</th><th>Order</th><th>Received by</th><th>Received at</th><th>Supplier ref.</th><th>Lines</th></tr></thead>
            <tbody>
              {data?.items.map((r) => (
                <tr key={r.id} className="is-clickable" onClick={() => navigate(`receipts/${r.id}`)}>
                  <td className="ident"><button className="link-btn" onClick={() => navigate(`receipts/${r.id}`)}>{r.receiptNumber}</button></td>
                  <td>{r.poNumber}</td>
                  <td>{r.receivedByName ?? '—'}</td>
                  <td>{formatDateTime(r.receivedAt)}</td>
                  <td>{r.supplierReference ?? '—'}</td>
                  <td className="num">{r.itemCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && data.items.length === 0 ? <div className="empty">No goods receipts recorded yet.</div> : null}
        </div>
        {data && data.total > PAGE_SIZE ? (
          <div className="toolbar">
            <Button small disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
            <span className="faint">Page {page} of {pages} ({data.total} receipts)</span>
            <Button small disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
          </div>
        ) : null}
      </Panel>
      {creating ? <CreateReceiptDialog onClose={() => setCreating(false)} onDone={(r) => { setCreating(false); navigate(`receipts/${r.id}`) }} /> : null}
    </div>
  )
}

interface UnitRow { serialNumber: string; disposition: UnitDisposition }
interface LineState { poItemId: string; description: string; individual: boolean; units: UnitRow[]; acceptedQty: number; damagedQty: number; rejectedQty: number; locationId: string | null; notes: string }

function CreateReceiptDialog({ onClose, onDone }: { onClose: () => void; onDone: (r: GoodsReceiptDetail) => void }) {
  const categories = useCategories()
  const [openOrders, setOpenOrders] = useState<PurchaseOrderSummary[]>([])
  const [poId, setPoId] = useState('')
  const [po, setPo] = useState<PurchaseOrderDetail | null>(null)
  const [supplierReference, setSupplierReference] = useState('')
  const [lines, setLines] = useState<LineState[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const fields = error instanceof ApiError ? error.fieldErrors : {}

  useEffect(() => {
    Promise.all([call('orders.list', { status: 'open', page: 1, pageSize: 100 }), call('orders.list', { status: 'partially_received', page: 1, pageSize: 100 })])
      .then(([a, b]) => setOpenOrders([...a.items, ...b.items]))
  }, [])
  useEffect(() => {
    if (!poId) return setPo(null)
    call('orders.get', { poId }).then((o) => {
      setPo(o)
      setLines(
        o.items
          .filter((i) => i.outstandingQuantity > 0)
          .map((i) => ({
            poItemId: i.id, description: i.description, individual: categories.find((c) => c.id === i.categoryId)?.trackingMode === 'individual',
            units: [], acceptedQty: 0, damagedQty: 0, rejectedQty: 0, locationId: null, notes: ''
          }))
      )
    })
  }, [poId, categories])

  const setLine = (idx: number, patch: Partial<LineState>) => setLines(lines.map((l, i) => (i === idx ? { ...l, ...patch } : l)))
  const addUnit = (idx: number) => setLine(idx, { units: [...lines[idx]!.units, { serialNumber: '', disposition: 'accepted' }] })

  const submit = () => {
    setBusy(true)
    setError(null)
    call('receipts.create', {
      poId, supplierReference: supplierReference.trim() || null, notes: null,
      items: lines
        .filter((l) => (l.individual ? l.units.length > 0 : l.acceptedQty + l.damagedQty + l.rejectedQty > 0))
        .map((l) =>
          l.individual
            ? { poItemId: l.poItemId, units: l.units.map((u) => ({ serialNumber: u.serialNumber.trim() || null, disposition: u.disposition })), locationId: l.locationId, discrepancyNotes: l.notes.trim() || null }
            : { poItemId: l.poItemId, bulkAcceptedQuantity: l.acceptedQty, bulkDamagedQuantity: l.damagedQty, bulkRejectedQuantity: l.rejectedQty, locationId: l.locationId, discrepancyNotes: l.notes.trim() || null }
        )
    } as never)
      .then(onDone, setError)
      .finally(() => setBusy(false))
  }

  return (
    <Dialog title="Record a goods receipt" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !poId || lines.length === 0} onClick={submit}>Record receipt</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <div className="form-grid">
          <SelectField label="Purchase order" value={poId} placeholder="Choose" onChange={setPoId} options={openOrders.map((o) => ({ value: o.id, label: `${o.poNumber} — ${o.supplierName}` }))} />
          <TextField label="Supplier delivery reference" value={supplierReference} onChange={(e) => setSupplierReference(e.target.value)} />
        </div>
        {po ? (
          <>
            <h3 className="section-title">Lines with outstanding quantity</h3>
            {lines.length === 0 ? <p className="muted">This order has nothing outstanding.</p> : null}
            {lines.map((l, idx) => (
              <Panel key={l.poItemId} title={l.description}>
                <div className="form-grid">
                  <LocationPicker value={l.locationId} onChange={(v) => setLine(idx, { locationId: v })} />
                </div>
                {l.individual ? (
                  <div className="stack">
                    {l.units.map((u, uidx) => (
                      <div className="form-grid" key={uidx}>
                        <TextField label={`Unit ${uidx + 1} serial`} value={u.serialNumber} onChange={(e) => setLine(idx, { units: l.units.map((x, j) => (j === uidx ? { ...x, serialNumber: e.target.value } : x)) })} />
                        <SelectField label="Disposition" value={u.disposition} onChange={(v) => setLine(idx, { units: l.units.map((x, j) => (j === uidx ? { ...x, disposition: v as UnitDisposition } : x)) })} options={Object.entries(UNIT_DISPOSITION_LABELS).map(([value, label]) => ({ value, label }))} />
                        <Button small variant="quiet" onClick={() => setLine(idx, { units: l.units.filter((_, j) => j !== uidx) })}>Remove</Button>
                      </div>
                    ))}
                    <Button small onClick={() => addUnit(idx)}>Add received unit</Button>
                  </div>
                ) : (
                  <div className="form-grid">
                    <TextField label="Accepted quantity" inputMode="numeric" value={String(l.acceptedQty)} onChange={(e) => setLine(idx, { acceptedQty: Number(e.target.value) || 0 })} />
                    <TextField label="Damaged quantity" inputMode="numeric" value={String(l.damagedQty)} onChange={(e) => setLine(idx, { damagedQty: Number(e.target.value) || 0 })} />
                    <TextField label="Rejected quantity" inputMode="numeric" value={String(l.rejectedQty)} onChange={(e) => setLine(idx, { rejectedQty: Number(e.target.value) || 0 })} />
                  </div>
                )}
                {(l.individual ? l.units.some((u) => u.disposition !== 'accepted') : l.damagedQty + l.rejectedQty > 0) ? (
                  <TextAreaField label="Discrepancy notes" value={l.notes} onChange={(v) => setLine(idx, { notes: v })} hint="Explain the damage or rejection" error={fields['items']} />
                ) : null}
              </Panel>
            ))}
          </>
        ) : null}
      </div>
    </Dialog>
  )
}

function ReceiptDetail({ receiptId, session, onBack }: { receiptId: string; session: SessionInfo; onBack: () => void }) {
  const has = (p: string) => session.permissions.includes(p as never)
  const [r, setR] = useState<GoodsReceiptDetail | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [resolving, setResolving] = useState<string | null>(null)
  const guard = useLatestOnly()
  const load = useCallback(() => {
    setError(null)
    guard(call('receipts.get', { receiptId })).then(setR, setError)
  }, [receiptId])
  useEffect(load, [load])
  if (!r) return <div className="stack"><ErrorAlert error={error} onRetry={load} />{!error ? <p className="faint" role="status">Loading receipt…</p> : null}</div>
  return (
    <div className="stack">
      <PageHeader title={r.receiptNumber} description={`Order ${r.poNumber}, received ${formatDateTime(r.receivedAt)} by ${r.receivedByName ?? '—'}`} actions={<Button onClick={onBack}>All receipts</Button>} />
      <ErrorAlert error={error} />
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {r.items.map((i) => (
        <Panel key={i.id} title={i.description} actions={<DiscrepancyBadge status={i.discrepancyStatus} />}>
          <dl className="dl">
            <dt>Received / accepted / damaged / rejected</dt><dd>{i.receivedQuantity} / {i.acceptedQuantity} / {i.damagedQuantity} / {i.rejectedQuantity}</dd>
            {i.discrepancyNotes ? (<><dt>Notes</dt><dd>{i.discrepancyNotes}</dd></>) : null}
            {i.resolutionNotes ? (<><dt>Resolution</dt><dd>{i.resolutionNotes}</dd></>) : null}
          </dl>
          {i.units.length > 0 ? (
            <ul className="history">
              {i.units.map((u) => (<li key={u.unitNo}>{u.serialNumber ?? `Unit ${u.unitNo}`} — {u.disposition}{u.assetCode ? ` → ${u.assetCode}` : ''}</li>))}
            </ul>
          ) : null}
          {i.discrepancyStatus === 'open' && has('receipts.record') ? <Button small onClick={() => setResolving(i.id)}>Resolve discrepancy</Button> : null}
        </Panel>
      ))}
      {resolving ? <ResolveDialog receiptItemId={resolving} onClose={() => setResolving(null)} onDone={(n) => { setResolving(null); setR(n); setNotice('Discrepancy resolved.') }} /> : null}
    </div>
  )
}

function ResolveDialog({ receiptItemId, onClose, onDone }: { receiptItemId: string; onClose: () => void; onDone: (r: GoodsReceiptDetail) => void }) {
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  return (
    <Dialog title="Resolve discrepancy" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !notes.trim()} onClick={() => {
      setBusy(true)
      call('receipts.resolveDiscrepancy', { receiptItemId, resolutionNotes: notes }).then(onDone, setError).finally(() => setBusy(false))
    }}>Resolve</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <TextAreaField label="Resolution notes" value={notes} onChange={setNotes} hint="E.g. supplier agreed to redeliver, or the item was written off" />
      </div>
    </Dialog>
  )
}
