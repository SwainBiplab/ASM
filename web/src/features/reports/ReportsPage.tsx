import { useCallback, useEffect, useState } from 'react'
import type {
  AssetValuationReport, DisposalReport, MaintenanceCostReport, ProcurementSummaryReport, SessionInfo, WarrantyReport
} from '@shared/api'
import { LIFECYCLE_STATUSES, formatMinor } from '@shared/assets'
import { WARRANTY_REPORT_FILTER_LABELS, WARRANTY_REPORT_FILTERS } from '@shared/reports'
import { REQUEST_STATUS_LABELS, ORDER_STATUS_LABELS } from '@shared/procurement'
import { apiUrl, call, downloadFile, formatDateTime } from '../../api'
import { Button, ErrorAlert, PageHeader, Panel, SelectField, Tabs, TextField } from '../../components/ui'
import { useLatestOnly } from '../../hooks'
import { useCategories, useDepartments, useLocations, useSuppliers } from '../procurement/shared'

type Tab = 'assetValuation' | 'maintenanceCost' | 'procurement' | 'warranty' | 'disposals'
const PAGE_SIZE = 50

export function ReportsPage({ session, navigate }: { session: SessionInfo; selectedId: string | null; navigate: (route: string) => void }) {
  const [tab, setTab] = useState<Tab>('assetValuation')
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'assetValuation', label: 'Asset valuation' },
    { id: 'maintenanceCost', label: 'Maintenance cost' },
    { id: 'procurement', label: 'Procurement' },
    { id: 'warranty', label: 'Warranty and lifecycle' },
    { id: 'disposals', label: 'Disposals' }
  ]
  return (
    <div className="stack">
      <PageHeader title="Reports" description="Financial and management reports from PostgreSQL records. Depreciation and net book value are not shown: Finance has not yet approved a depreciation policy." />
      <Tabs tabs={tabs} value={tab} onChange={setTab} label="Report selection" />
      {tab === 'assetValuation' ? <AssetValuationTab session={session} navigate={navigate} /> : null}
      {tab === 'maintenanceCost' ? <MaintenanceCostTab session={session} navigate={navigate} /> : null}
      {tab === 'procurement' ? <ProcurementTab session={session} navigate={navigate} /> : null}
      {tab === 'warranty' ? <WarrantyTab session={session} navigate={navigate} /> : null}
      {tab === 'disposals' ? <DisposalsTab session={session} navigate={navigate} /> : null}
    </div>
  )
}

function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  if (total <= pageSize) return null
  return (
    <div className="toolbar">
      <Button small disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
      <span className="faint">Page {page} of {pages} ({total} rows)</span>
      <Button small disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button>
    </div>
  )
}

function CurrencyTotals({ totals, label }: { totals: Array<{ currency: string; totalMinor: number; count: number }>; label: string }) {
  if (totals.length === 0) return <p className="muted">No amounts recorded for the current filters.</p>
  return (
    <div className="chips">
      {totals.map((t) => (
        <span className="badge" key={t.currency}>{label} {formatMinor(t.totalMinor, t.currency)} ({t.count} {t.currency})</span>
      ))}
    </div>
  )
}

function AssetValuationTab({ session, navigate }: { session: SessionInfo; navigate: (r: string) => void }) {
  const has = (p: string) => session.permissions.includes(p as never)
  const categories = useCategories()
  const locations = useLocations()
  const departments = useDepartments()
  const suppliers = useSuppliers()
  const [categoryId, setCategoryId] = useState('')
  const [locationId, setLocationId] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [lifecycle, setLifecycle] = useState<'all' | (typeof LIFECYCLE_STATUSES)[number]>('all')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [onlyMissing, setOnlyMissing] = useState(false)
  const [page, setPage] = useState(1)
  const [data, setData] = useState<AssetValuationReport | null>(null)
  const [error, setError] = useState<unknown>(null)

  const filters = {
    categoryId: categoryId || undefined, locationId: locationId || undefined, departmentId: departmentId || undefined, supplierId: supplierId || undefined,
    lifecycle, fromDate: fromDate || undefined, toDate: toDate || undefined, onlyMissingFinancialMetadata: onlyMissing
  }
  const guard = useLatestOnly()
  const load = useCallback(() => {
    setError(null)
    guard(call('reports.assetValuation', { ...filters, page, pageSize: PAGE_SIZE })).then(setData, setError)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryId, locationId, departmentId, supplierId, lifecycle, fromDate, toDate, onlyMissing, page])
  useEffect(load, [load])

  const exportCsv = async () => {
    setError(null)
    try {
      const query = Object.fromEntries(Object.entries(filters).map(([k, v]) => [k, v === undefined ? undefined : String(v)]))
      await downloadFile(apiUrl('/api/v1/exports/reports/asset-valuation.csv', query), 'asset-valuation.csv')
    } catch (err) {
      setError(err)
    }
  }

  return (
    <div className="stack">
      <ErrorAlert error={error} onRetry={load} />
      <Panel flush actions={has('reports.export') ? <Button small onClick={() => void exportCsv()}>Export CSV</Button> : null}>
        <div className="toolbar">
          <SelectField label="Category" value={categoryId} placeholder="All" onChange={setCategoryId} options={categories.map((c) => ({ value: c.id, label: c.name }))} />
          <SelectField label="Location" value={locationId} placeholder="All" onChange={setLocationId} options={locations.map((l) => ({ value: l.id, label: l.path }))} />
          <SelectField label="Department" value={departmentId} placeholder="All" onChange={setDepartmentId} options={departments.map((d) => ({ value: d.id, label: d.name }))} />
          <SelectField label="Supplier" value={supplierId} placeholder="All" onChange={setSupplierId} options={suppliers.map((s) => ({ value: s.id, label: s.name }))} />
          <SelectField label="Lifecycle" value={lifecycle} onChange={(v) => setLifecycle(v as typeof lifecycle)} options={[{ value: 'all', label: 'All' }, ...LIFECYCLE_STATUSES.map((s) => ({ value: s, label: s }))]} />
          <TextField label="Acquired from" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          <TextField label="Acquired to" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          <label className="checkbox"><input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} /> Missing cost or purchase date only</label>
        </div>
        {data ? <CurrencyTotals totals={data.totalsByCurrency} label="Acquisition value" /> : null}
        {data && !data.costVisible ? <p className="faint">Acquisition cost is hidden; your account does not hold financial viewing permission.</p> : null}
        <div className="table-wrap">
          <table className="grid" aria-label="Asset valuation report">
            <thead><tr><th>Asset</th><th>Category</th><th>Location</th><th>Department</th><th>Lifecycle</th><th>Purchase date</th><th>Cost</th><th>Supplier</th></tr></thead>
            <tbody>
              {data?.items.map((r) => (
                <tr key={r.id}>
                  <td className="ident"><button className="link-btn" onClick={() => navigate(`assets/${r.id}`)}>{r.assetCode}</button></td>
                  <td>{r.categoryName}</td>
                  <td>{r.locationName ?? '—'}</td>
                  <td>{r.departmentName ?? '—'}</td>
                  <td>{r.lifecycleStatus}</td>
                  <td>{r.purchaseDate ?? '—'}</td>
                  <td className="num">{r.acquisitionCostMinor === null ? '—' : formatMinor(r.acquisitionCostMinor, r.currency ?? 'INR')}</td>
                  <td>{r.supplierName ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && data.items.length === 0 ? <div className="empty">No assets match these filters.</div> : null}
        </div>
        {data ? <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} /> : null}
      </Panel>
    </div>
  )
}

function MaintenanceCostTab({ session, navigate }: { session: SessionInfo; navigate: (r: string) => void }) {
  const has = (p: string) => session.permissions.includes(p as never)
  const categories = useCategories()
  const locations = useLocations()
  const [categoryId, setCategoryId] = useState('')
  const [locationId, setLocationId] = useState('')
  const [vendorQuery, setVendorQuery] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<MaintenanceCostReport | null>(null)
  const [error, setError] = useState<unknown>(null)

  const filters = { categoryId: categoryId || undefined, locationId: locationId || undefined, vendorQuery: vendorQuery.trim() || undefined, fromDate: fromDate || undefined, toDate: toDate || undefined }
  const guard = useLatestOnly()
  const load = useCallback(() => {
    setError(null)
    guard(call('reports.maintenanceCost', { ...filters, page, pageSize: PAGE_SIZE })).then(setData, setError)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryId, locationId, vendorQuery, fromDate, toDate, page])
  useEffect(() => {
    const t = window.setTimeout(load, 200)
    return () => window.clearTimeout(t)
  }, [load])

  const exportCsv = async () => {
    setError(null)
    try {
      const query = Object.fromEntries(Object.entries(filters).map(([k, v]) => [k, v === undefined ? undefined : String(v)]))
      await downloadFile(apiUrl('/api/v1/exports/reports/maintenance-cost.csv', query), 'maintenance-cost.csv')
    } catch (err) {
      setError(err)
    }
  }

  return (
    <div className="stack">
      <ErrorAlert error={error} onRetry={load} />
      <Panel flush actions={has('reports.export') ? <Button small onClick={() => void exportCsv()}>Export CSV</Button> : null}>
        <div className="toolbar">
          <SelectField label="Category" value={categoryId} placeholder="All" onChange={setCategoryId} options={categories.map((c) => ({ value: c.id, label: c.name }))} />
          <SelectField label="Location" value={locationId} placeholder="All" onChange={setLocationId} options={locations.map((l) => ({ value: l.id, label: l.path }))} />
          <TextField label="Vendor" value={vendorQuery} onChange={(e) => setVendorQuery(e.target.value)} />
          <TextField label="Reported from" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          <TextField label="Reported to" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </div>
        {data ? <CurrencyTotals totals={data.totalsByCurrency} label="Maintenance cost" /> : null}
        {data && !data.costVisible ? <p className="faint">Cost figures are hidden; your account does not hold financial viewing permission.</p> : null}
        {data && data.topAssets.length > 0 ? (
          <div>
            <h3 className="section-title">Highest recorded maintenance expenditure</h3>
            <ul className="history">
              {data.topAssets.map((a) => (
                <li key={a.assetId}><button className="link-btn" onClick={() => navigate(`assets/${a.assetId}`)}>{a.assetCode}</button> — {a.ticketCount} tickets, {formatMinor(a.totalCostMinor, a.currency)}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="table-wrap">
          <table className="grid" aria-label="Maintenance cost report">
            <thead><tr><th>Ticket</th><th>Asset</th><th>Vendor</th><th>Status</th><th>Reported</th><th>Parts</th><th>Labor</th><th>Downtime</th></tr></thead>
            <tbody>
              {data?.items.map((r) => (
                <tr key={r.id}>
                  <td>{r.ticketNumber}</td>
                  <td className="ident"><button className="link-btn" onClick={() => navigate(`assets/${r.assetId}`)}>{r.assetCode}</button></td>
                  <td>{r.vendorName ?? '—'}</td>
                  <td>{r.status}</td>
                  <td>{formatDateTime(r.reportedAt)}</td>
                  <td className="num">{r.partsCostMinor === null ? '—' : formatMinor(r.partsCostMinor, r.currency ?? 'INR')}</td>
                  <td className="num">{r.laborCostMinor === null ? '—' : formatMinor(r.laborCostMinor, r.currency ?? 'INR')}</td>
                  <td className="num">{r.downtimeMinutes ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && data.items.length === 0 ? <div className="empty">No maintenance tickets match these filters.</div> : null}
        </div>
        {data ? <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} /> : null}
      </Panel>
    </div>
  )
}

function ProcurementTab({ session, navigate }: { session: SessionInfo; navigate: (r: string) => void }) {
  const has = (p: string) => session.permissions.includes(p as never)
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<ProcurementSummaryReport | null>(null)
  const [error, setError] = useState<unknown>(null)
  const guard = useLatestOnly()
  const load = useCallback(() => {
    setError(null)
    guard(call('reports.procurementSummary', { fromDate: fromDate || undefined, toDate: toDate || undefined, page, pageSize: PAGE_SIZE })).then(setData, setError)
  }, [fromDate, toDate, page])
  useEffect(load, [load])

  const exportCsv = async () => {
    setError(null)
    try {
      await downloadFile(apiUrl('/api/v1/exports/reports/procurement-discrepancies.csv'), 'procurement-discrepancies.csv')
    } catch (err) {
      setError(err)
    }
  }

  return (
    <div className="stack">
      <ErrorAlert error={error} onRetry={load} />
      <Panel flush actions={has('reports.export') ? <Button small onClick={() => void exportCsv()}>Export open discrepancies CSV</Button> : null}>
        <div className="toolbar">
          <TextField label="From" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          <TextField label="To" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </div>
        {data && !data.costVisible ? <p className="faint">Procurement amounts are hidden; your account does not hold financial viewing permission.</p> : null}
        {data && data.costVisible ? (
          <>
            <h3 className="section-title">Purchase requests, by status</h3>
            <div className="chips">{data.requestTotals.map((t, i) => <span className="badge" key={i}>{REQUEST_STATUS_LABELS[t.status]}: {formatMinor(t.totalMinor, t.currency)} ({t.count})</span>)}</div>
            <h3 className="section-title">Purchase orders, by status</h3>
            <div className="chips">{data.orderTotals.map((t, i) => <span className="badge" key={i}>{ORDER_STATUS_LABELS[t.status]}: {formatMinor(t.totalMinor, t.currency)} ({t.count})</span>)}</div>
            <h3 className="section-title">Accepted value received vs. still outstanding</h3>
            <div className="chips">{data.receivedTotals.map((t, i) => <span className="badge" key={i}>{t.currency}: received {formatMinor(t.receivedMinor, t.currency)}, outstanding {formatMinor(t.outstandingMinor, t.currency)}</span>)}</div>
          </>
        ) : null}
        <h3 className="section-title">Open receiving discrepancies ({data?.openDiscrepancyTotal ?? 0})</h3>
        <div className="table-wrap">
          <table className="grid" aria-label="Open receiving discrepancies">
            <thead><tr><th>Receipt</th><th>Order</th><th>Line</th><th>Damaged</th><th>Rejected</th><th>Received</th></tr></thead>
            <tbody>
              {data?.openDiscrepancies.map((d) => (
                <tr key={d.id}>
                  <td className="ident"><button className="link-btn" onClick={() => navigate(`receipts/${d.receiptId}`)}>{d.receiptNumber}</button></td>
                  <td>{d.poNumber}</td>
                  <td>{d.description}</td>
                  <td className="num">{d.damagedQuantity}</td>
                  <td className="num">{d.rejectedQuantity}</td>
                  <td>{formatDateTime(d.receivedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && data.openDiscrepancies.length === 0 ? <div className="empty">No open receiving discrepancies.</div> : null}
        </div>
        {data ? <Pager page={data.page} pageSize={data.pageSize} total={data.openDiscrepancyTotal} onPage={setPage} /> : null}
      </Panel>
    </div>
  )
}

function WarrantyTab({ session, navigate }: { session: SessionInfo; navigate: (r: string) => void }) {
  const has = (p: string) => session.permissions.includes(p as never)
  const [filter, setFilter] = useState<(typeof WARRANTY_REPORT_FILTERS)[number]>('expiring')
  const [windowDays, setWindowDays] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<WarrantyReport | null>(null)
  const [error, setError] = useState<unknown>(null)
  const guard = useLatestOnly()
  const load = useCallback(() => {
    setError(null)
    guard(call('reports.warranty', { filter, windowDays: windowDays.trim() ? Number(windowDays) : undefined, page, pageSize: PAGE_SIZE })).then(setData, setError)
  }, [filter, windowDays, page])
  useEffect(load, [load])

  const exportCsv = async () => {
    setError(null)
    try {
      await downloadFile(apiUrl('/api/v1/exports/reports/warranty.csv', { filter, windowDays: windowDays.trim() || undefined }), 'warranty.csv')
    } catch (err) {
      setError(err)
    }
  }

  return (
    <div className="stack">
      <ErrorAlert error={error} onRetry={load} />
      <Panel flush actions={has('reports.export') ? <Button small onClick={() => void exportCsv()}>Export CSV</Button> : null}>
        <div className="toolbar">
          <SelectField label="Show" value={filter} onChange={(v) => setFilter(v as typeof filter)} options={WARRANTY_REPORT_FILTERS.map((f) => ({ value: f, label: WARRANTY_REPORT_FILTER_LABELS[f] }))} />
          {filter === 'expiring' ? <TextField label="Window (days)" inputMode="numeric" value={windowDays} onChange={(e) => setWindowDays(e.target.value)} hint={data ? `Default ${data.windowDays} (organization setting)` : undefined} /> : null}
        </div>
        <div className="table-wrap">
          <table className="grid" aria-label="Warranty report">
            <thead><tr><th>Asset</th><th>Category</th><th>Location</th><th>Warranty end</th></tr></thead>
            <tbody>
              {data?.items.map((r) => (
                <tr key={r.id}>
                  <td className="ident"><button className="link-btn" onClick={() => navigate(`assets/${r.id}`)}>{r.assetCode}</button></td>
                  <td>{r.categoryName}</td>
                  <td>{r.locationName ?? '—'}</td>
                  <td>{r.warrantyEnd ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && data.items.length === 0 ? <div className="empty">No assets match this filter.</div> : null}
        </div>
        {data ? <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} /> : null}
      </Panel>
    </div>
  )
}

function DisposalsTab({ session, navigate }: { session: SessionInfo; navigate: (r: string) => void }) {
  const has = (p: string) => session.permissions.includes(p as never)
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<DisposalReport | null>(null)
  const [error, setError] = useState<unknown>(null)
  const guard = useLatestOnly()
  const load = useCallback(() => {
    setError(null)
    guard(call('reports.disposals', { fromDate: fromDate || undefined, toDate: toDate || undefined, page, pageSize: PAGE_SIZE })).then(setData, setError)
  }, [fromDate, toDate, page])
  useEffect(load, [load])

  const exportCsv = async () => {
    setError(null)
    try {
      await downloadFile(apiUrl('/api/v1/exports/reports/disposals.csv', { fromDate: fromDate || undefined, toDate: toDate || undefined }), 'disposals.csv')
    } catch (err) {
      setError(err)
    }
  }

  return (
    <div className="stack">
      <ErrorAlert error={error} onRetry={load} />
      <Panel flush actions={has('reports.export') ? <Button small onClick={() => void exportCsv()}>Export CSV</Button> : null}>
        <div className="toolbar">
          <TextField label="Disposed from" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          <TextField label="Disposed to" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </div>
        {data ? <CurrencyTotals totals={data.totalsByCurrency} label="Disposal proceeds" /> : null}
        {data && !data.costVisible ? <p className="faint">Proceeds are hidden; your account does not hold financial viewing permission.</p> : null}
        <div className="table-wrap">
          <table className="grid" aria-label="Disposals report">
            <thead><tr><th>Asset</th><th>Category</th><th>Disposed</th><th>Method</th><th>Proceeds</th></tr></thead>
            <tbody>
              {data?.items.map((r) => (
                <tr key={r.id}>
                  <td className="ident"><button className="link-btn" onClick={() => navigate(`assets/${r.id}`)}>{r.assetCode}</button></td>
                  <td>{r.categoryName}</td>
                  <td>{r.disposalDate ?? '—'}</td>
                  <td>{r.disposalMethod ?? '—'}</td>
                  <td className="num">{r.disposalProceedsMinor === null ? '—' : formatMinor(r.disposalProceedsMinor, r.currency ?? 'INR')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && data.items.length === 0 ? <div className="empty">No disposals in this period.</div> : null}
        </div>
        {data ? <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} /> : null}
      </Panel>
    </div>
  )
}
