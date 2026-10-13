import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AssetDetail, AssetListItem, CategoryView, LocationView, ModelView, Page, SessionInfo, SupplierView } from '@shared/api'
import {
  CONDITION_LABELS,
  CONDITIONS,
  DISPOSAL_LABELS,
  DISPOSAL_METHODS,
  DOCUMENT_PURPOSE_LABELS,
  DOCUMENT_PURPOSES,
  ALLOWED_DOCUMENT_TYPES,
  MAX_DOCUMENT_BYTES,
  LIFECYCLE_LABELS,
  LIFECYCLE_STATUSES,
  LIFECYCLE_TRANSITIONS,
  MANUAL_OPERATIONAL_STATUSES,
  OPERATIONAL_LABELS,
  OPERATIONAL_STATUSES,
  formatMinor,
  minorToInput,
  type AssetSort,
  type DocumentPurpose,
  type LifecycleStatus,
  type WarrantyFilter
} from '@shared/assets'
import { ApiError, apiUrl, call, downloadFile, formatBytes, formatDateTime, uploadFile } from '../../api'
import { Alert, Button, Dialog, ErrorAlert, PageHeader, Panel, SelectField, TextAreaField, TextField } from '../../components/ui'
import { optionList } from '../organization/lookups'
import { LabelSheet, LifecycleBadge, OperationalBadge, WarrantyNote, conditionLabel } from './shared'
import { CustodyPanel } from '../allocations/CustodyPanel'
import { AssetMaintenanceSection } from '../maintenance/AssetMaintenanceSection'
import { AssetImport } from './AssetImport'

const PAGE_SIZE = 50

interface Lookups {
  categories: CategoryView[]
  models: ModelView[]
  suppliers: SupplierView[]
  locations: LocationView[]
}

function useAssetLookups(): Lookups {
  const [state, setState] = useState<Lookups>({ categories: [], models: [], suppliers: [], locations: [] })
  useEffect(() => {
    Promise.all([call('categories.list', {}), call('models.list', {}), call('suppliers.list', {}), call('locations.list', {})])
      .then(([categories, models, suppliers, locations]) => setState({ categories, models, suppliers, locations }))
      .catch(() => undefined)
  }, [])
  return state
}

export function AssetsPage({ session, selectedId, navigate }: { session: SessionInfo; selectedId: string | null; navigate: (route: string) => void }) {
  const has = (p: string) => session.permissions.includes(p as never)
  const lookups = useAssetLookups()
  const [mode, setMode] = useState<'list' | 'import'>('list')
  const [filters, setFilters] = useState({ query: '', categoryId: '', lifecycle: 'active', operational: '', locationId: '', warranty: 'any' as WarrantyFilter })
  const [sort, setSort] = useState<{ by: AssetSort; dir: 'asc' | 'desc' }>({ by: 'code', dir: 'asc' })
  const [page, setPage] = useState(1)
  const [data, setData] = useState<Page<AssetListItem> | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [detail, setDetail] = useState<AssetDetail | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [editing, setEditing] = useState<AssetDetail | 'new' | null>(null)
  const [labelIds, setLabelIds] = useState<string[] | null>(null)

  const searchInput = useMemo(
    () => ({
      page,
      pageSize: PAGE_SIZE,
      sort: sort.by,
      direction: sort.dir,
      lifecycle: filters.lifecycle as LifecycleStatus | 'all',
      warranty: filters.warranty,
      ...(filters.query.trim() ? { query: filters.query.trim() } : {}),
      ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
      ...(filters.operational ? { operational: filters.operational as (typeof OPERATIONAL_STATUSES)[number] } : {}),
      ...(filters.locationId ? { locationId: filters.locationId } : {})
    }),
    [page, sort, filters]
  )

  const load = useCallback(() => {
    call('assets.search', searchInput).then(setData, setError)
  }, [searchInput])
  useEffect(load, [load])

  const loadDetail = useCallback(() => {
    if (!selectedId) return setDetail(null)
    call('assets.get', { id: selectedId }).then(setDetail, (err) => {
      setError(err)
      setDetail(null)
    })
  }, [selectedId])
  useEffect(loadDetail, [loadDetail])

  const setFilter = (k: keyof typeof filters) => (v: string) => {
    setPage(1)
    setFilters({ ...filters, [k]: v })
  }
  const toggleSort = (by: AssetSort) => setSort((s) => ({ by, dir: s.by === by && s.dir === 'asc' ? 'desc' : 'asc' }))
  const ariaSort = (by: AssetSort) => (sort.by === by ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined)
  const toggleSelect = (id: string) => setSelected((s) => {
    const next = new Set(s)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const exportCsv = async () => {
    setError(null)
    try {
      const { page: _p, pageSize: _s, ...filtersOnly } = searchInput
      const query = Object.fromEntries(Object.entries(filtersOnly).map(([k, v]) => [k, v === undefined || v === null ? undefined : String(v)]))
      const name = await downloadFile(apiUrl('/api/v1/exports/assets.csv', query), 'assets.csv')
      setNotice(`Downloaded ${name}.`)
    } catch (err) {
      setError(err)
    }
  }

  const afterSave = (a: AssetDetail, message: string) => {
    setEditing(null)
    setNotice(message)
    load()
    if (a.id === selectedId) setDetail(a)
    else navigate(`assets/${a.id}`)
  }

  if (mode === 'import') {
    return (
      <AssetImport
        onDone={(message) => {
          setMode('list')
          if (message) setNotice(message)
          load()
        }}
      />
    )
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1
  return (
    <div className="stack">
      <PageHeader
        title="Assets"
        description="Every individually tracked asset with its identity, condition, location and history. Asset codes are permanent and never reused."
        actions={
          <>
            {has('labels.print') && selected.size > 0 ? <Button onClick={() => setLabelIds([...selected])}>Print {selected.size} label{selected.size === 1 ? '' : 's'}</Button> : null}
            {has('reports.export') ? <Button onClick={() => void exportCsv()}>Export CSV</Button> : null}
            {has('assets.import') ? <Button onClick={() => setMode('import')}>Import CSV/Excel</Button> : null}
            {has('assets.create') ? <Button variant="primary" onClick={() => setEditing('new')}>Add asset</Button> : null}
          </>
        }
      />
      <ErrorAlert error={error} />
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <div className={detail ? 'split' : 'split split--single'}>
        <Panel flush title={data ? `${data.total} asset${data.total === 1 ? '' : 's'}` : 'Assets'}>
          <div className="toolbar">
            <div className="field--grow">
              <TextField label="Search" placeholder="Code, serial, make, model, supplier, location" value={filters.query} onChange={(e) => setFilter('query')(e.target.value)} />
            </div>
            <SelectField label="Category" value={filters.categoryId} placeholder="All" onChange={setFilter('categoryId')} options={optionList(lookups.categories, (c) => c.name)} />
            <SelectField label="Lifecycle" value={filters.lifecycle} onChange={setFilter('lifecycle')} options={[...LIFECYCLE_STATUSES.map((s) => ({ value: s, label: LIFECYCLE_LABELS[s] })), { value: 'all', label: 'All' }]} />
            <SelectField label="Status" value={filters.operational} placeholder="Any" onChange={setFilter('operational')} options={OPERATIONAL_STATUSES.map((s) => ({ value: s, label: OPERATIONAL_LABELS[s] }))} />
            <SelectField label="Location" value={filters.locationId} placeholder="Anywhere" onChange={setFilter('locationId')} options={optionList(lookups.locations, (l) => l.path)} />
            <SelectField
              label="Warranty"
              value={filters.warranty}
              onChange={setFilter('warranty')}
              options={[
                { value: 'any', label: 'Any' },
                { value: 'in_warranty', label: 'In warranty' },
                { value: 'expiring', label: 'Expiring soon' },
                { value: 'expired', label: 'Expired' },
                { value: 'none', label: 'Not recorded' }
              ]}
            />
          </div>
          <div className="table-wrap">
            <table className="grid">
              <thead>
                <tr>
                  {has('labels.print') ? <th className="check" aria-label="Select" /> : null}
                  <th className="sortable" aria-sort={ariaSort('code')} onClick={() => toggleSort('code')}>Asset code</th>
                  <th className="sortable" aria-sort={ariaSort('category')} onClick={() => toggleSort('category')}>Category</th>
                  <th>Make / model</th>
                  <th>Serial</th>
                  <th>Status</th>
                  <th>Location</th>
                  <th className="sortable" aria-sort={ariaSort('warranty')} onClick={() => toggleSort('warranty')}>Warranty end</th>
                </tr>
              </thead>
              <tbody>
                {data?.items.map((a) => (
                  <tr key={a.id} className={`is-clickable ${selectedId === a.id ? 'is-selected' : ''}`} onClick={() => navigate(`assets/${a.id}`)}>
                    {has('labels.print') ? (
                      <td className="check" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" aria-label={`Select ${a.assetCode}`} checked={selected.has(a.id)} onChange={() => toggleSelect(a.id)} />
                      </td>
                    ) : null}
                    <td className="ident"><button className="link-btn" onClick={() => navigate(`assets/${a.id}`)}>{a.assetCode}</button></td>
                    <td>{a.categoryName}</td>
                    <td>{[a.manufacturer, a.modelName].filter(Boolean).join(' ') || '—'}</td>
                    <td className="ident">{a.serialNumber ?? '—'}</td>
                    <td>{a.lifecycleStatus === 'active' ? <OperationalBadge status={a.operationalStatus} /> : <LifecycleBadge status={a.lifecycleStatus} />}</td>
                    <td>{a.locationPath ?? '—'}</td>
                    <td className="num">{a.warrantyEnd ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data && data.items.length === 0 ? (
              <div className="empty">{data.total === 0 && !filters.query ? 'No assets match. Add an asset, or change the filters.' : 'No assets match these filters.'}</div>
            ) : null}
          </div>
          <div className="pager">
            <span className="faint">Page {page} of {pages}</span>
            <Button small disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
            <Button small disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
          </div>
        </Panel>

        {detail ? (
          <AssetDetailPanel
            asset={detail}
            session={session}
            navigate={navigate}
            onClose={() => navigate('assets')}
            onEdit={() => setEditing(detail)}
            onChanged={(a, message) => {
              setDetail(a)
              setNotice(message)
              load()
            }}
            onReload={loadDetail}
            onPrint={() => setLabelIds([detail.id])}
          />
        ) : null}
      </div>
      {editing ? (
        <AssetDialog
          asset={editing === 'new' ? null : editing}
          lookups={lookups}
          canEditCost={has('finance.view_cost')}
          onClose={() => setEditing(null)}
          onSaved={(a) => afterSave(a, editing === 'new' ? `${a.assetCode} was registered.` : `${a.assetCode} was updated.`)}
        />
      ) : null}
      {labelIds ? <LabelSheet assetIds={labelIds} onClose={() => setLabelIds(null)} /> : null}
    </div>
  )
}

function AssetDetailPanel({ asset: a, session, navigate, onClose, onEdit, onChanged, onReload, onPrint }: {
  asset: AssetDetail
  session: SessionInfo
  navigate: (route: string) => void
  onClose: () => void
  onEdit: () => void
  onChanged: (a: AssetDetail, message: string) => void
  onReload: () => void
  onPrint: () => void
}) {
  const has = (p: string) => session.permissions.includes(p as never)
  const [lifecycleTo, setLifecycleTo] = useState<LifecycleStatus | null>(null)
  const transitions = Object.entries(LIFECYCLE_TRANSITIONS[a.lifecycleStatus]).filter(([, t]) => t && has(t.permission)) as Array<[LifecycleStatus, { label: string }]>
  return (
    <Panel title={a.assetCode} actions={<Button small variant="quiet" onClick={onClose}>Close</Button>}>
      <div className="stack">
        <div className="chips">
          <LifecycleBadge status={a.lifecycleStatus} />
          {a.lifecycleStatus === 'active' ? <OperationalBadge status={a.operationalStatus} /> : null}
          <span className="badge">{conditionLabel(a.condition)}</span>
        </div>
        <dl className="dl">
          <dt>Category</dt><dd>{a.categoryName}</dd>
          <dt>Make / model</dt><dd>{[a.manufacturer, a.modelName].filter(Boolean).join(' ') || '—'}</dd>
          <dt>Serial number</dt><dd className="ident">{a.serialNumber ?? '—'}</dd>
          <dt>Location</dt><dd>{a.locationPath ?? '—'}</dd>
          <dt>Supplier</dt><dd>{a.supplierName ?? '—'}</dd>
          <dt>Purchase date</dt><dd>{a.purchaseDate ?? '—'}</dd>
          <dt>Invoice / PO</dt><dd>{[a.invoiceReference, a.purchaseReference].filter(Boolean).join(' / ') || '—'}</dd>
          {a.costVisible ? (<><dt>Acquisition cost</dt><dd className="num">{formatMinor(a.acquisitionCostMinor, a.currency)}</dd></>) : null}
          <dt>Warranty</dt><dd><WarrantyNote end={a.warrantyEnd} state={a.warrantyState} /></dd>
          {a.lifecycleStatus === 'disposed' ? (
            <>
              <dt>Disposed</dt>
              <dd>{a.disposalDate} {a.disposalMethod ? `(${DISPOSAL_LABELS[a.disposalMethod]})` : ''}{a.costVisible && a.disposalProceedsMinor !== null ? `, proceeds ${formatMinor(a.disposalProceedsMinor, a.currency)}` : ''}</dd>
            </>
          ) : null}
          {a.specifications ? (<><dt>Specifications</dt><dd>{a.specifications}</dd></>) : null}
          {a.notes ? (<><dt>Notes</dt><dd>{a.notes}</dd></>) : null}
        </dl>
        <div className="chips">
          {has('assets.update') && a.lifecycleStatus !== 'disposed' ? <Button small onClick={onEdit}>Edit</Button> : null}
          {has('labels.print') && a.lifecycleStatus !== 'disposed' ? <Button small onClick={onPrint}>Print label</Button> : null}
          {transitions.map(([to, t]) => (
            <Button key={to} small onClick={() => setLifecycleTo(to)}>{t.label}</Button>
          ))}
        </div>
        <CustodyPanel assetId={a.id} assetCode={a.assetCode} categoryName={a.categoryName} assetLabel={`${a.assetCode} — ${a.categoryName}`} session={session} onChanged={onReload} />
        <AssetMaintenanceSection assetId={a.id} navigate={navigate} />
        <DocumentsSection asset={a} canManage={has('assets.update')} onChanged={onReload} />
        <div>
          <h3 className="section-title">History</h3>
          <ul className="history">
            {a.history.map((h) => (
              <li key={h.id}>
                <strong>{h.eventType.replace(/^asset\.|^document\./, '').replace(/_/g, ' ')}</strong>{' '}
                <span className="faint">{formatDateTime(h.occurredAt)} by {h.actorName ?? 'system'}</span>
                {h.reason ? <div className="muted">Reason: {h.reason}</div> : null}
              </li>
            ))}
          </ul>
        </div>
      </div>
      {lifecycleTo ? (
        <LifecycleDialog
          asset={a}
          toStatus={lifecycleTo}
          canRecordProceeds={has('finance.view_cost')}
          onClose={() => setLifecycleTo(null)}
          onDone={(updated) => {
            setLifecycleTo(null)
            onChanged(updated, `${updated.assetCode} is now ${LIFECYCLE_LABELS[updated.lifecycleStatus].toLowerCase()}.`)
          }}
        />
      ) : null}
    </Panel>
  )
}

function DocumentsSection({ asset, canManage, onChanged }: { asset: AssetDetail; canManage: boolean; onChanged: () => void }) {
  const [purpose, setPurpose] = useState<DocumentPurpose>('invoice')
  const [file, setFile] = useState<File | null>(null)
  const [inputKey, setInputKey] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const run = async (label: string, fn: () => Promise<unknown>) => {
    setError(null)
    setNotice(null)
    setBusy(label)
    try {
      await fn()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(null)
    }
  }
  const upload = () =>
    run('upload', async () => {
      if (!file) return
      await uploadFile('/api/v1/uploads/documents', file, { entityType: 'asset', entityId: asset.id, purpose })
      setFile(null)
      setInputKey((k) => k + 1)
      setNotice(`Uploaded ${file.name}.`)
      onChanged()
    })
  const contentUrl = (documentId: string) => apiUrl(`/api/v1/documents/${encodeURIComponent(documentId)}/content`)
  return (
    <div>
      <h3 className="section-title">Documents ({asset.documents.length})</h3>
      <ErrorAlert error={error} />
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {asset.documents.length === 0 ? <p className="faint">No documents attached.</p> : null}
      {asset.documents.map((d) => (
        <div className="doc-row" key={d.linkId}>
          <span>
            {d.originalName.split(/[\/]/).pop()} <span className="faint">{DOCUMENT_PURPOSE_LABELS[d.purpose]}, {formatBytes(d.byteSize)}</span>
            {d.scanStatus === 'not_scanned' ? <span className="badge" title="Malware scanning is not enabled on this server. Open files only from sources you trust."> Not scanned</span> : null}
            {d.fileMissing ? <span className="badge badge--off"> File missing</span> : null}
          </span>
          <span className="chips">
            {d.openable && !d.fileMissing ? (
              <a className="btn btn--small btn--quiet" href={contentUrl(d.documentId)} target="_blank" rel="noopener noreferrer">
                Open
              </a>
            ) : null}
            {!d.fileMissing ? (
              <Button small variant="quiet" disabled={busy !== null} onClick={() => void run('download', () => downloadFile(contentUrl(d.documentId), d.originalName))}>
                Download
              </Button>
            ) : null}
            {canManage ? <Button small variant="quiet" onClick={() => setRemoving(d.linkId)}>Remove</Button> : null}
          </span>
        </div>
      ))}
      {canManage && asset.lifecycleStatus !== 'disposed' ? (
        <div className="toolbar toolbar--flush">
          <SelectField label="Attach as" value={purpose} onChange={(v) => setPurpose(v as DocumentPurpose)} options={DOCUMENT_PURPOSES.map((p) => ({ value: p, label: DOCUMENT_PURPOSE_LABELS[p] }))} />
          <div className="field">
            <label className="field__label" htmlFor="doc-file">File</label>
            <input
              key={inputKey}
              id="doc-file"
              className="input"
              type="file"
              accept={Object.keys(ALLOWED_DOCUMENT_TYPES).map((e) => `.${e}`).join(',')}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <span className="field__hint">PDF, image or office file, up to {Math.floor(MAX_DOCUMENT_BYTES / (1024 * 1024))} MB</span>
          </div>
          <Button variant="primary" disabled={!file || busy !== null} onClick={() => void upload()}>
            {busy === 'upload' ? 'Uploading…' : 'Upload'}
          </Button>
        </div>
      ) : null}
      {removing ? (
        <Dialog
          title="Remove this attachment?"
          onClose={() => setRemoving(null)}
          footer={
            <>
              <Button onClick={() => setRemoving(null)}>Cancel</Button>
              <Button variant="danger" disabled={!reason.trim()} onClick={() => void run('remove', async () => {
                await call('documents.removeLink', { linkId: removing, reason })
                setRemoving(null)
                setReason('')
                onChanged()
              })}>Remove</Button>
            </>
          }
        >
          <div className="stack">
            <p className="muted">The file is kept in storage and backups for audit purposes; it is only unlinked from this asset.</p>
            <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} hint="Required. Recorded in the asset history." />
          </div>
        </Dialog>
      ) : null}
    </div>
  )
}

function LifecycleDialog({ asset, toStatus, canRecordProceeds, onClose, onDone }: { asset: AssetDetail; toStatus: LifecycleStatus; canRecordProceeds: boolean; onClose: () => void; onDone: (a: AssetDetail) => void }) {
  const t = LIFECYCLE_TRANSITIONS[asset.lifecycleStatus][toStatus]!
  const [form, setForm] = useState({ reason: '', effectiveDate: new Date().toISOString().slice(0, 10), disposalMethod: '', proceeds: '' })
  const [error, setError] = useState<unknown>(null)
  const fields = error instanceof ApiError ? error.fieldErrors : {}
  const disposing = toStatus === 'disposed'
  const save = async () => {
    setError(null)
    try {
      onDone(await call('assets.changeLifecycle', {
        id: asset.id,
        toStatus,
        reason: form.reason,
        effectiveDate: form.effectiveDate,
        disposalMethod: disposing && form.disposalMethod ? (form.disposalMethod as (typeof DISPOSAL_METHODS)[number]) : null,
        disposalProceeds: disposing && form.proceeds.trim() ? form.proceeds : null
      }))
    } catch (err) {
      setError(err)
    }
  }
  return (
    <Dialog
      title={`${t.label}: ${asset.assetCode}`}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant={disposing ? 'danger' : 'primary'} disabled={!form.reason.trim()} onClick={() => void save()}>{t.label}</Button></>}
    >
      <div className="stack">
        <ErrorAlert error={error} />
        <p className="muted">
          {disposing
            ? 'Disposal is final. The asset record, its code and its history are kept permanently.'
            : toStatus === 'active'
              ? 'The asset returns to service as "awaiting inspection" so it is checked before reuse.'
              : 'The asset leaves active inventory. Its record and history are kept.'}
        </p>
        <div className="form-grid">
          <TextField label={disposing ? 'Disposal date' : 'Effective date'} type="date" value={form.effectiveDate} onChange={(e) => setForm({ ...form, effectiveDate: e.target.value })} />
          {disposing ? (
            <SelectField label="Disposal method" value={form.disposalMethod} placeholder="Choose" onChange={(v) => setForm({ ...form, disposalMethod: v })} options={DISPOSAL_METHODS.map((m) => ({ value: m, label: DISPOSAL_LABELS[m] }))} error={fields['disposalMethod']} />
          ) : null}
          {disposing && canRecordProceeds ? (
            <TextField label={`Proceeds (${asset.currency})`} value={form.proceeds} onChange={(e) => setForm({ ...form, proceeds: e.target.value })} error={fields['disposalProceeds']} hint="Optional" />
          ) : null}
          <TextAreaField label="Reason" value={form.reason} onChange={(v) => setForm({ ...form, reason: v })} hint="Required. Recorded in the asset history." />
        </div>
      </div>
    </Dialog>
  )
}

function AssetDialog({ asset, lookups, canEditCost, onClose, onSaved }: { asset: AssetDetail | null; lookups: Lookups; canEditCost: boolean; onClose: () => void; onSaved: (a: AssetDetail) => void }) {
  const individual = lookups.categories.filter((c) => c.trackingMode === 'individual')
  const [form, setForm] = useState({
    categoryId: asset?.categoryId ?? individual[0]?.id ?? '',
    modelId: asset?.modelId ?? '',
    manufacturer: asset?.manufacturer ?? '',
    modelName: asset?.modelName ?? '',
    serialNumber: asset?.serialNumber ?? '',
    specifications: asset?.specifications ?? '',
    condition: asset?.condition ?? 'new',
    operationalStatus: (asset && asset.operationalStatus !== 'under_maintenance' ? asset.operationalStatus : 'ready') as (typeof MANUAL_OPERATIONAL_STATUSES)[number],
    locationId: asset?.locationId ?? '',
    supplierId: asset?.supplierId ?? '',
    purchaseDate: asset?.purchaseDate ?? '',
    acquisitionCost: asset && asset.costVisible ? minorToInput(asset.acquisitionCostMinor, asset.currency) : '',
    invoiceReference: asset?.invoiceReference ?? '',
    purchaseReference: asset?.purchaseReference ?? '',
    warrantyStart: asset?.warrantyStart ?? '',
    warrantyEnd: asset?.warrantyEnd ?? '',
    notes: asset?.notes ?? '',
    reason: ''
  })
  const [error, setError] = useState<unknown>(null)
  const fields = error instanceof ApiError ? error.fieldErrors : {}
  const set = (k: keyof typeof form) => (v: string) => setForm({ ...form, [k]: v })
  const n = (s: string): string | null => (s.trim() === '' ? null : s)
  const category = lookups.categories.find((c) => c.id === form.categoryId)
  const models = lookups.models.filter((m) => m.categoryId === form.categoryId)

  const save = async () => {
    setError(null)
    const payload = {
      categoryId: form.categoryId,
      modelId: form.modelId || null,
      manufacturer: n(form.manufacturer),
      modelName: n(form.modelName),
      serialNumber: n(form.serialNumber),
      specifications: n(form.specifications),
      condition: form.condition,
      operationalStatus: form.operationalStatus,
      locationId: form.locationId || null,
      supplierId: form.supplierId || null,
      purchaseDate: n(form.purchaseDate),
      acquisitionCost: canEditCost ? n(form.acquisitionCost) : null,
      invoiceReference: n(form.invoiceReference),
      purchaseReference: n(form.purchaseReference),
      warrantyStart: n(form.warrantyStart),
      warrantyEnd: n(form.warrantyEnd),
      notes: n(form.notes)
    }
    try {
      onSaved(asset ? await call('assets.update', { id: asset.id, ...payload, reason: n(form.reason) }) : await call('assets.create', payload))
    } catch (err) {
      setError(err)
    }
  }

  if (!asset && individual.length === 0) {
    return (
      <Dialog title="Add asset" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
        <Alert tone="info">Create at least one asset category (Asset catalogue) before registering assets.</Alert>
      </Dialog>
    )
  }

  return (
    <Dialog
      title={asset ? `Edit ${asset.assetCode}` : 'Add asset'}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => void save()}>{asset ? 'Save changes' : 'Register asset'}</Button></>}
    >
      <div className="stack">
        <ErrorAlert error={error} />
        {!asset ? <p className="muted">The asset code is assigned automatically when you save.</p> : null}
        <div className="form-grid">
          <SelectField label="Category" value={form.categoryId} onChange={(v) => setForm({ ...form, categoryId: v, modelId: '' })} options={optionList(individual, (c) => c.name)} error={fields['categoryId']} />
          <SelectField label="Model" value={form.modelId} placeholder="Not in catalogue" onChange={set('modelId')} options={optionList(models, (m) => `${m.manufacturer} ${m.modelName}`)} error={fields['modelId']} />
          {!form.modelId ? (
            <>
              <TextField label="Manufacturer" value={form.manufacturer} onChange={(e) => set('manufacturer')(e.target.value)} />
              <TextField label="Model name" value={form.modelName} onChange={(e) => set('modelName')(e.target.value)} />
            </>
          ) : null}
          <TextField
            label={`Serial number${category?.serialRequired ? ' (required)' : ''}`}
            value={form.serialNumber}
            onChange={(e) => set('serialNumber')(e.target.value)}
            error={fields['serialNumber']}
            hint={category?.serialUnique ? 'Must be unique for this manufacturer' : undefined}
          />
          <SelectField label="Condition" value={form.condition} onChange={set('condition')} options={CONDITIONS.map((c) => ({ value: c, label: CONDITION_LABELS[c] }))} />
          {asset?.operationalStatus === 'under_maintenance' ? null : (
            <SelectField label="Operational status" value={form.operationalStatus} onChange={set('operationalStatus')} options={MANUAL_OPERATIONAL_STATUSES.map((s) => ({ value: s, label: OPERATIONAL_LABELS[s] }))} />
          )}
          <SelectField label="Location" value={form.locationId} placeholder="Not set" onChange={set('locationId')} options={optionList(lookups.locations, (l) => l.path)} error={fields['locationId']} />
          <SelectField label="Supplier" value={form.supplierId} placeholder="Not set" onChange={set('supplierId')} options={optionList(lookups.suppliers, (s) => s.name)} error={fields['supplierId']} />
          <TextField label="Purchase date" type="date" value={form.purchaseDate} onChange={(e) => set('purchaseDate')(e.target.value)} error={fields['purchaseDate']} />
          {canEditCost ? <TextField label="Acquisition cost" value={form.acquisitionCost} onChange={(e) => set('acquisitionCost')(e.target.value)} error={fields['acquisitionCost']} hint="e.g. 45000.00" /> : null}
          <TextField label="Invoice reference" value={form.invoiceReference} onChange={(e) => set('invoiceReference')(e.target.value)} />
          <TextField label="Purchase order reference" value={form.purchaseReference} onChange={(e) => set('purchaseReference')(e.target.value)} />
          <TextField label="Warranty start" type="date" value={form.warrantyStart} onChange={(e) => set('warrantyStart')(e.target.value)} error={fields['warrantyStart']} />
          <TextField label="Warranty end" type="date" value={form.warrantyEnd} onChange={(e) => set('warrantyEnd')(e.target.value)} error={fields['warrantyEnd']} />
          <TextAreaField label="Specifications" value={form.specifications} onChange={set('specifications')} />
          <TextAreaField label="Notes" value={form.notes} onChange={set('notes')} />
          {asset ? <TextField label="Reason for change" value={form.reason} onChange={(e) => set('reason')(e.target.value)} hint="Optional; recorded in the history" /> : null}
        </div>
      </div>
    </Dialog>
  )
}
