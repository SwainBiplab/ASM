import { useCallback, useEffect, useState } from 'react'
import type { Page, PurchaseOrderDetail, PurchaseOrderSummary, PurchaseRequestSummary, SessionInfo } from '@shared/api'
import type { OrderItemInput } from '@shared/procurementSchemas'
import { formatMinor } from '@shared/assets'
import { ApiError, call, formatDateTime } from '../../api'
import { Alert, Button, Dialog, ErrorAlert, PageHeader, Panel, SelectField, TextAreaField, TextField } from '../../components/ui'
import { OrderStatusBadge, useCategories, useSuppliers } from '../procurement/shared'

const PAGE_SIZE = 50

export function OrdersPage({ session, selectedId, navigate }: { session: SessionInfo; selectedId: string | null; navigate: (route: string) => void }) {
  const has = (p: string) => session.permissions.includes(p as never)
  const [status, setStatus] = useState<'all' | 'open' | 'partially_received' | 'received' | 'cancelled'>('all')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<Page<PurchaseOrderSummary> | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [creating, setCreating] = useState(false)

  const load = useCallback(() => {
    setError(null)
    call('orders.list', { status, page, pageSize: PAGE_SIZE }).then(setData, setError)
  }, [status, page])
  useEffect(load, [load])

  if (selectedId) return <OrderDetail poId={selectedId} session={session} onBack={() => { navigate('orders'); load() }} />
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1
  return (
    <div className="stack">
      <PageHeader title="Purchase orders" description="Orders placed against approved purchase requests. Approval authorizes ordering, not receipt." actions={has('procurement.manage_orders') ? <Button variant="primary" onClick={() => setCreating(true)}>New order</Button> : null} />
      <ErrorAlert error={error} onRetry={load} />
      <Panel flush>
        <div className="toolbar">
          <SelectField label="Status" value={status} onChange={(v) => setStatus(v as typeof status)} options={[{ value: 'all', label: 'All' }, { value: 'open', label: 'Open' }, { value: 'partially_received', label: 'Partially received' }, { value: 'received', label: 'Received' }, { value: 'cancelled', label: 'Cancelled' }]} />
        </div>
        <div className="table-wrap">
          <table className="grid" aria-label="Purchase orders">
            <thead><tr><th>PO</th><th>Supplier</th><th>Request</th><th>Total</th><th>Status</th><th>Expected</th></tr></thead>
            <tbody>
              {data?.items.map((o) => (
                <tr key={o.id} className="is-clickable" onClick={() => navigate(`orders/${o.id}`)}>
                  <td className="ident"><button className="link-btn" onClick={() => navigate(`orders/${o.id}`)}>{o.poNumber}</button></td>
                  <td>{o.supplierName}</td>
                  <td>{o.requestNumber}</td>
                  <td className="num">{formatMinor(o.totalMinor, o.currency)}</td>
                  <td><OrderStatusBadge status={o.status} /></td>
                  <td>{o.expectedDeliveryDate ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && data.items.length === 0 ? <div className="empty">No purchase orders match these filters.</div> : null}
        </div>
        {data && data.total > PAGE_SIZE ? (
          <div className="toolbar">
            <Button small disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
            <span className="faint">Page {page} of {pages} ({data.total} orders)</span>
            <Button small disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
          </div>
        ) : null}
      </Panel>
      {creating ? <CreateOrderDialog onClose={() => setCreating(false)} onDone={(o) => { setCreating(false); navigate(`orders/${o.id}`) }} /> : null}
    </div>
  )
}

function CreateOrderDialog({ onClose, onDone }: { onClose: () => void; onDone: (o: PurchaseOrderDetail) => void }) {
  const categories = useCategories()
  const suppliers = useSuppliers()
  const [approved, setApproved] = useState<PurchaseRequestSummary[]>([])
  const [requestId, setRequestId] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [currency, setCurrency] = useState('INR')
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState('')
  const [lines, setLines] = useState<Array<OrderItemInput & { requestQuantity: number }>>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const fields = error instanceof ApiError ? error.fieldErrors : {}

  useEffect(() => {
    call('procurement.list', { status: 'approved', page: 1, pageSize: 100 }).then((r) => setApproved(r.items), () => setApproved([]))
  }, [])
  useEffect(() => {
    if (!requestId) return setLines([])
    call('procurement.get', { requestId }).then((r) => {
      setCurrency(r.currency)
      setLines(r.items.map((i) => ({ requestItemId: i.id, description: i.description, categoryId: i.categoryId ?? '', modelId: i.modelId, quantity: i.quantity, unitPrice: String(i.estimatedUnitCostMinor / 100), requestQuantity: i.quantity })))
    })
  }, [requestId])

  const setLine = (idx: number, patch: Partial<OrderItemInput>) => setLines(lines.map((l, i) => (i === idx ? { ...l, ...patch } : l)))
  const submit = () => {
    setBusy(true)
    setError(null)
    call('orders.create', { requestId, supplierId, currency, orderDate: null, expectedDeliveryDate: expectedDeliveryDate || null, notes: null, items: lines.map(({ requestQuantity, ...l }) => l) })
      .then(onDone, setError)
      .finally(() => setBusy(false))
  }
  return (
    <Dialog title="New purchase order" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !requestId || !supplierId || lines.length === 0} onClick={submit}>Create order</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <div className="form-grid">
          <SelectField label="Approved request" value={requestId} placeholder="Choose" onChange={setRequestId} options={approved.map((r) => ({ value: r.id, label: `${r.requestNumber} — ${r.justification}` }))} />
          <SelectField label="Supplier" value={supplierId} placeholder="Choose" onChange={setSupplierId} options={suppliers.map((s) => ({ value: s.id, label: s.name }))} />
          <TextField label="Expected delivery" type="date" value={expectedDeliveryDate} onChange={(e) => setExpectedDeliveryDate(e.target.value)} />
        </div>
        {lines.length > 0 ? (
          <>
            <h3 className="section-title">Order lines</h3>
            {lines.map((l, idx) => (
              <div className="form-grid" key={idx}>
                <TextField label="Description" value={l.description} onChange={(e) => setLine(idx, { description: e.target.value })} />
                <SelectField label="Category" value={l.categoryId} placeholder="Choose" onChange={(v) => setLine(idx, { categoryId: v })} options={categories.map((c) => ({ value: c.id, label: c.name }))} />
                <TextField label={`Quantity (max ${l.requestQuantity} authorized)`} inputMode="numeric" value={String(l.quantity)} onChange={(e) => setLine(idx, { quantity: Number(e.target.value) || 1 })} />
                <TextField label={`Unit price (${currency})`} value={l.unitPrice} onChange={(e) => setLine(idx, { unitPrice: e.target.value })} error={fields['unitPrice']} />
              </div>
            ))}
          </>
        ) : null}
      </div>
    </Dialog>
  )
}

function OrderDetail({ poId, session, onBack }: { poId: string; session: SessionInfo; onBack: () => void }) {
  const has = (p: string) => session.permissions.includes(p as never)
  const [o, setO] = useState<PurchaseOrderDetail | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [amending, setAmending] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const load = useCallback(() => {
    setError(null)
    call('orders.get', { poId }).then(setO, setError)
  }, [poId])
  useEffect(load, [load])
  if (!o) return <div className="stack"><ErrorAlert error={error} onRetry={load} />{!error ? <p className="faint" role="status">Loading order…</p> : null}</div>
  const canManage = has('procurement.manage_orders')
  return (
    <div className="stack">
      <PageHeader title={o.poNumber} description={`${o.supplierName} — from request ${o.requestNumber}`} actions={<Button onClick={onBack}>All orders</Button>} />
      <ErrorAlert error={error} />
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <Panel>
        <div className="chips"><OrderStatusBadge status={o.status} /></div>
        <dl className="dl">
          <dt>Expected delivery</dt><dd>{o.expectedDeliveryDate ?? '—'}</dd>
          <dt>Total</dt><dd className="num">{formatMinor(o.totalMinor, o.currency)}</dd>
          {o.notes ? (<><dt>Notes</dt><dd>{o.notes}</dd></>) : null}
          {o.cancelReason ? (<><dt>Cancelled</dt><dd>{o.cancelReason}</dd></>) : null}
        </dl>
        <div className="table-wrap">
          <table className="grid"><thead><tr><th>Line</th><th>Category</th><th>Qty</th><th>Unit price</th><th>Received</th><th>Outstanding</th></tr></thead>
            <tbody>{o.items.map((i) => (<tr key={i.id}><td>{i.description}</td><td>{i.categoryName}</td><td className="num">{i.quantity}</td><td className="num">{formatMinor(i.unitPriceMinor, o.currency)}</td><td className="num">{i.receivedQuantity}</td><td className="num">{i.outstandingQuantity}</td></tr>))}</tbody>
          </table>
        </div>
        {canManage && o.status !== 'cancelled' ? (
          <div className="chips">
            <Button small onClick={() => setAmending(true)}>Amend</Button>
            {o.status === 'open' ? <Button small variant="quiet" onClick={() => setCancelling(true)}>Cancel order</Button> : null}
          </div>
        ) : null}
      </Panel>
      {o.amendments.length > 0 ? (
        <Panel title="Amendment history">
          <ul className="history">
            {o.amendments.map((a, idx) => (<li key={idx}><strong>{a.field}</strong>: {a.oldValue ?? '—'} → {a.newValue ?? '—'} <span className="faint">{a.amendedByName}, {formatDateTime(a.amendedAt)}</span><div className="muted">{a.reason}</div></li>))}
          </ul>
        </Panel>
      ) : null}
      {amending ? <AmendDialog order={o} onClose={() => setAmending(false)} onDone={(n) => { setAmending(false); setO(n); setNotice('Order amended.') }} /> : null}
      {cancelling ? <CancelOrderDialog poId={o.id} onClose={() => setCancelling(false)} onDone={(n) => { setCancelling(false); setO(n); setNotice('Order cancelled.') }} /> : null}
    </div>
  )
}

function AmendDialog({ order, onClose, onDone }: { order: PurchaseOrderDetail; onClose: () => void; onDone: (o: PurchaseOrderDetail) => void }) {
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState(order.expectedDeliveryDate ?? '')
  const [notes, setNotes] = useState(order.notes ?? '')
  const [items, setItems] = useState(order.items.map((i) => ({ poItemId: i.id, quantity: i.quantity, unitPrice: String(i.unitPriceMinor / 100) })))
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const submit = () => {
    setBusy(true)
    setError(null)
    call('orders.amend', { poId: order.id, expectedDeliveryDate: expectedDeliveryDate || null, notes: notes.trim() || null, reason, items })
      .then(onDone, setError)
      .finally(() => setBusy(false))
  }
  return (
    <Dialog title={`Amend ${order.poNumber}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !reason.trim()} onClick={submit}>Save amendment</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <div className="form-grid">
          <TextField label="Expected delivery" type="date" value={expectedDeliveryDate} onChange={(e) => setExpectedDeliveryDate(e.target.value)} />
        </div>
        <TextAreaField label="Notes" value={notes} onChange={setNotes} />
        {order.items.map((i, idx) => (
          <div className="form-grid" key={i.id}>
            <span className="faint">{i.description}</span>
            <TextField label="Quantity" inputMode="numeric" value={String(items[idx]!.quantity)} onChange={(e) => setItems(items.map((it, j) => (j === idx ? { ...it, quantity: Number(e.target.value) || 1 } : it)))} />
            <TextField label="Unit price" value={items[idx]!.unitPrice} onChange={(e) => setItems(items.map((it, j) => (j === idx ? { ...it, unitPrice: e.target.value } : it)))} />
          </div>
        ))}
        <TextAreaField label="Reason for amendment" value={reason} onChange={setReason} hint="Required" />
      </div>
    </Dialog>
  )
}

function CancelOrderDialog({ poId, onClose, onDone }: { poId: string; onClose: () => void; onDone: (o: PurchaseOrderDetail) => void }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  return (
    <Dialog title="Cancel order" onClose={onClose} footer={<><Button onClick={onClose}>Back</Button><Button variant="danger" disabled={busy || !reason.trim()} onClick={() => {
      setBusy(true)
      call('orders.cancel', { poId, reason }).then(onDone, setError).finally(() => setBusy(false))
    }}>Cancel order</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <TextAreaField label="Reason" value={reason} onChange={setReason} hint="Required" />
      </div>
    </Dialog>
  )
}
