import { useCallback, useEffect, useState } from 'react'
import type { CategoryView, ModelView, SessionInfo, SupplierView } from '@shared/api'
import { DOMAIN_LABELS, type AssetDomain, type TrackingMode } from '@shared/assets'
import { ApiError, call } from '../../api'
import { ActiveBadge, Button, Dialog, ErrorAlert, PageHeader, Panel, ReasonDialog, SelectField, Tabs, TextAreaField, TextField, useToast } from '../../components/ui'
import { useLatestOnly } from '../../hooks'
import { optionList } from '../organization/lookups'
import { ReferenceImport } from '../organization/ReferenceImport'

type Tab = 'categories' | 'models' | 'suppliers'
const n = (s: string): string | null => (s.trim() === '' ? null : s)

export function CatalogPage({ session }: { session: SessionInfo }) {
  const canRef = session.permissions.includes('reference_data.manage')
  const canSup = session.permissions.includes('suppliers.manage')
  const [tab, setTab] = useState<Tab>('categories')
  return (
    <div className="stack">
      <PageHeader title="Asset catalogue" description="Categories, models and suppliers used when registering assets. Changes never rewrite existing asset records." />
      <Tabs label="Catalogue sections" value={tab} onChange={setTab} tabs={[{ id: 'categories', label: 'Categories' }, { id: 'models', label: 'Models' }, { id: 'suppliers', label: 'Suppliers' }]} />
      {tab === 'categories' ? <CategoriesTab canManage={canRef} /> : null}
      {tab === 'models' ? <ModelsTab canManage={canRef} /> : null}
      {tab === 'suppliers' ? <SuppliersTab canManage={canSup} /> : null}
    </div>
  )
}

function useList<T>(load: (includeInactive: boolean) => Promise<T[]>) {
  const [items, setItems] = useState<T[]>([])
  const [includeInactive, setIncludeInactive] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const guard = useLatestOnly()
  const reload = useCallback(() => {
    guard(load(includeInactive)).then(setItems, setError)
  }, [load, includeInactive])
  useEffect(reload, [reload])
  return { items, includeInactive, setIncludeInactive, error, reload }
}

function InactiveToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="toolbar">
      <label className="checkbox">
        <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
        Show deactivated
      </label>
    </div>
  )
}

function Toggle<T extends { id: string; isActive: boolean }>({ item, label, command, onDone, onClose }: { item: T; label: string; command: 'categories.setActive' | 'models.setActive' | 'suppliers.setActive'; onDone: () => void; onClose: () => void }) {
  return (
    <ReasonDialog
      title={`${item.isActive ? 'Deactivate' : 'Reactivate'} ${label}?`}
      description={item.isActive ? 'Existing assets keep their reference; it can no longer be chosen for new assets.' : 'It becomes available again.'}
      confirmLabel={item.isActive ? 'Deactivate' : 'Reactivate'}
      danger={item.isActive}
      onClose={onClose}
      onConfirm={async (reason) => {
        await call(command, { id: item.id, isActive: !item.isActive, reason })
        onDone()
      }}
    />
  )
}

// ---------- Categories ----------

function CategoriesTab({ canManage }: { canManage: boolean }) {
  const list = useList(useCallback((includeInactive: boolean) => call('categories.list', { includeInactive }), []))
  const [editing, setEditing] = useState<CategoryView | 'new' | null>(null)
  const [toggling, setToggling] = useState<CategoryView | null>(null)
  const [importing, setImporting] = useState(false)
  const toast = useToast()
  if (importing) {
    return <ReferenceImport kind="categories" onDone={(message) => { setImporting(false); if (message) toast.success(message); list.reload() }} />
  }
  return (
    <Panel
      flush
      title="Categories"
      actions={canManage ? (
        <>
          <Button small onClick={() => setImporting(true)}>Import CSV/Excel</Button>
          <Button variant="primary" small onClick={() => setEditing('new')}>Add category</Button>
        </>
      ) : null}
    >
      <InactiveToggle value={list.includeInactive} onChange={list.setIncludeInactive} />
      <ErrorAlert error={list.error} />
      <div className="table-wrap">
        <table className="grid">
          <thead><tr><th>Category</th><th>Code</th><th>Area</th><th>Tracking</th><th>Serial numbers</th><th className="num">Assets</th><th>Status</th><th className="actions" aria-label="Actions" /></tr></thead>
          <tbody>
            {list.items.map((c) => (
              <tr key={c.id} className={c.isActive ? '' : 'is-inactive'}>
                <td>{c.name}{c.description ? <div className="faint">{c.description}</div> : null}</td>
                <td className="ident">{c.code}</td>
                <td>{DOMAIN_LABELS[c.assetDomain]}</td>
                <td>{c.trackingMode === 'individual' ? 'Individual' : 'Bulk (quantity)'}</td>
                <td>{c.serialUnique ? 'Required, unique' : c.serialRequired ? 'Required' : 'Optional'}</td>
                <td className="num">{c.assetCount}</td>
                <td><ActiveBadge active={c.isActive} /></td>
                <td className="actions">{canManage ? (<><Button small variant="quiet" onClick={() => setEditing(c)}>Edit</Button><Button small variant="quiet" onClick={() => setToggling(c)}>{c.isActive ? 'Deactivate' : 'Reactivate'}</Button></>) : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.items.length === 0 ? <div className="empty">No categories yet. Add categories such as Laptop, Headset, Monitor or Chair.</div> : null}
      </div>
      {editing ? <CategoryDialog category={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload() }} /> : null}
      {toggling ? <Toggle item={toggling} label={toggling.name} command="categories.setActive" onClose={() => setToggling(null)} onDone={() => { setToggling(null); list.reload() }} /> : null}
    </Panel>
  )
}

function CategoryDialog({ category, onClose, onSaved }: { category: CategoryView | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    code: category?.code ?? '',
    name: category?.name ?? '',
    description: category?.description ?? '',
    assetDomain: category?.assetDomain ?? 'it',
    trackingMode: category?.trackingMode ?? 'individual',
    serial: category?.serialUnique ? 'unique' : category?.serialRequired ? 'required' : 'optional'
  })
  const [error, setError] = useState<unknown>(null)
  const fields = error instanceof ApiError ? error.fieldErrors : {}
  const save = async () => {
    setError(null)
    const payload = {
      code: form.code,
      name: form.name,
      description: n(form.description),
      assetDomain: form.assetDomain as AssetDomain,
      trackingMode: form.trackingMode as TrackingMode,
      serialRequired: form.serial !== 'optional',
      serialUnique: form.serial === 'unique'
    }
    try {
      if (category) await call('categories.update', { id: category.id, ...payload })
      else await call('categories.create', payload)
      onSaved()
    } catch (err) {
      setError(err)
    }
  }
  return (
    <Dialog title={category ? `Edit ${category.name}` : 'Add category'} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => void save()}>{category ? 'Save changes' : 'Add category'}</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <div className="form-grid">
          <TextField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} error={fields['name']} />
          <TextField label="Code" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} error={fields['code']} hint="Short unique code, e.g. LAP" />
          <SelectField label="Area" value={form.assetDomain} onChange={(v) => setForm({ ...form, assetDomain: v as AssetDomain })} options={[{ value: 'it', label: 'IT' }, { value: 'facilities', label: 'Facilities' }]} />
          <SelectField
            label="Tracking"
            value={form.trackingMode}
            onChange={(v) => setForm({ ...form, trackingMode: v as TrackingMode })}
            options={[{ value: 'individual', label: 'Individual (each item has its own code)' }, { value: 'bulk', label: 'Bulk (quantity only; via procurement)' }]}
          />
          <SelectField
            label="Serial numbers"
            value={form.serial}
            onChange={(v) => setForm({ ...form, serial: v })}
            options={[{ value: 'optional', label: 'Optional' }, { value: 'required', label: 'Required' }, { value: 'unique', label: 'Required and unique per manufacturer' }]}
            error={fields['serialUnique']}
          />
          <TextAreaField label="Description" value={form.description} onChange={(v) => setForm({ ...form, description: v })} />
        </div>
      </div>
    </Dialog>
  )
}

// ---------- Models ----------

function ModelsTab({ canManage }: { canManage: boolean }) {
  const list = useList(useCallback((includeInactive: boolean) => call('models.list', { includeInactive }), []))
  const [categories, setCategories] = useState<CategoryView[]>([])
  const [editing, setEditing] = useState<ModelView | 'new' | null>(null)
  const [toggling, setToggling] = useState<ModelView | null>(null)
  const [importing, setImporting] = useState(false)
  const toast = useToast()
  useEffect(() => {
    call('categories.list', {}).then(setCategories, () => undefined)
  }, [])
  if (importing) {
    return <ReferenceImport kind="models" onDone={(message) => { setImporting(false); if (message) toast.success(message); list.reload() }} />
  }
  return (
    <Panel
      flush
      title="Models"
      actions={canManage ? (
        <>
          <Button small onClick={() => setImporting(true)}>Import CSV/Excel</Button>
          <Button variant="primary" small disabled={!categories.length} onClick={() => setEditing('new')}>Add model</Button>
        </>
      ) : null}
    >
      <InactiveToggle value={list.includeInactive} onChange={list.setIncludeInactive} />
      <ErrorAlert error={list.error} />
      <div className="table-wrap">
        <table className="grid">
          <thead><tr><th>Manufacturer</th><th>Model</th><th>Model number</th><th>Category</th><th className="num">Assets</th><th>Status</th><th className="actions" aria-label="Actions" /></tr></thead>
          <tbody>
            {list.items.map((m) => (
              <tr key={m.id} className={m.isActive ? '' : 'is-inactive'}>
                <td>{m.manufacturer}</td>
                <td>{m.modelName}{m.specifications ? <div className="faint">{m.specifications}</div> : null}</td>
                <td className="ident">{m.modelNumber ?? '—'}</td>
                <td>{m.categoryName}</td>
                <td className="num">{m.assetCount}</td>
                <td><ActiveBadge active={m.isActive} /></td>
                <td className="actions">{canManage ? (<><Button small variant="quiet" onClick={() => setEditing(m)}>Edit</Button><Button small variant="quiet" onClick={() => setToggling(m)}>{m.isActive ? 'Deactivate' : 'Reactivate'}</Button></>) : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.items.length === 0 ? <div className="empty">No models yet.</div> : null}
      </div>
      {editing ? <ModelDialog model={editing === 'new' ? null : editing} categories={categories} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload() }} /> : null}
      {toggling ? <Toggle item={toggling} label={`${toggling.manufacturer} ${toggling.modelName}`} command="models.setActive" onClose={() => setToggling(null)} onDone={() => { setToggling(null); list.reload() }} /> : null}
    </Panel>
  )
}

function ModelDialog({ model, categories, onClose, onSaved }: { model: ModelView | null; categories: CategoryView[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    categoryId: model?.categoryId ?? categories[0]?.id ?? '',
    manufacturer: model?.manufacturer ?? '',
    modelName: model?.modelName ?? '',
    modelNumber: model?.modelNumber ?? '',
    specifications: model?.specifications ?? ''
  })
  const [error, setError] = useState<unknown>(null)
  const fields = error instanceof ApiError ? error.fieldErrors : {}
  const save = async () => {
    setError(null)
    const payload = { categoryId: form.categoryId, manufacturer: form.manufacturer, modelName: form.modelName, modelNumber: n(form.modelNumber), specifications: n(form.specifications) }
    try {
      if (model) await call('models.update', { id: model.id, ...payload })
      else await call('models.create', payload)
      onSaved()
    } catch (err) {
      setError(err)
    }
  }
  return (
    <Dialog title={model ? 'Edit model' : 'Add model'} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => void save()}>{model ? 'Save changes' : 'Add model'}</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <div className="form-grid">
          <SelectField label="Category" value={form.categoryId} onChange={(v) => setForm({ ...form, categoryId: v })} options={optionList(categories, (c) => c.name)} error={fields['categoryId']} />
          <TextField label="Manufacturer" value={form.manufacturer} onChange={(e) => setForm({ ...form, manufacturer: e.target.value })} error={fields['manufacturer']} />
          <TextField label="Model name" value={form.modelName} onChange={(e) => setForm({ ...form, modelName: e.target.value })} error={fields['modelName']} />
          <TextField label="Model number" value={form.modelNumber} onChange={(e) => setForm({ ...form, modelNumber: e.target.value })} />
          <TextAreaField label="Specifications" value={form.specifications} onChange={(v) => setForm({ ...form, specifications: v })} />
        </div>
      </div>
    </Dialog>
  )
}

// ---------- Suppliers ----------

function SuppliersTab({ canManage }: { canManage: boolean }) {
  const list = useList(useCallback((includeInactive: boolean) => call('suppliers.list', { includeInactive }), []))
  const [editing, setEditing] = useState<SupplierView | 'new' | null>(null)
  const [toggling, setToggling] = useState<SupplierView | null>(null)
  const [importing, setImporting] = useState(false)
  const toast = useToast()
  if (importing) {
    return <ReferenceImport kind="suppliers" onDone={(message) => { setImporting(false); if (message) toast.success(message); list.reload() }} />
  }
  return (
    <Panel
      flush
      title="Suppliers"
      actions={canManage ? (
        <>
          <Button small onClick={() => setImporting(true)}>Import CSV/Excel</Button>
          <Button variant="primary" small onClick={() => setEditing('new')}>Add supplier</Button>
        </>
      ) : null}
    >
      <InactiveToggle value={list.includeInactive} onChange={list.setIncludeInactive} />
      <ErrorAlert error={list.error} />
      <div className="table-wrap">
        <table className="grid">
          <thead><tr><th>Supplier</th><th>Code</th><th>Contact</th><th>Tax reference</th><th className="num">Assets</th><th>Status</th><th className="actions" aria-label="Actions" /></tr></thead>
          <tbody>
            {list.items.map((s) => (
              <tr key={s.id} className={s.isActive ? '' : 'is-inactive'}>
                <td>{s.name}</td>
                <td className="ident">{s.code ?? '—'}</td>
                <td>{[s.contactName, s.email, s.phone].filter(Boolean).join(', ') || '—'}</td>
                <td>{s.taxReference ?? '—'}</td>
                <td className="num">{s.assetCount}</td>
                <td><ActiveBadge active={s.isActive} /></td>
                <td className="actions">{canManage ? (<><Button small variant="quiet" onClick={() => setEditing(s)}>Edit</Button><Button small variant="quiet" onClick={() => setToggling(s)}>{s.isActive ? 'Deactivate' : 'Reactivate'}</Button></>) : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.items.length === 0 ? <div className="empty">No suppliers yet.</div> : null}
      </div>
      {editing ? <SupplierDialog supplier={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload() }} /> : null}
      {toggling ? <Toggle item={toggling} label={toggling.name} command="suppliers.setActive" onClose={() => setToggling(null)} onDone={() => { setToggling(null); list.reload() }} /> : null}
    </Panel>
  )
}

function SupplierDialog({ supplier, onClose, onSaved }: { supplier: SupplierView | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: supplier?.name ?? '',
    code: supplier?.code ?? '',
    contactName: supplier?.contactName ?? '',
    email: supplier?.email ?? '',
    phone: supplier?.phone ?? '',
    address: supplier?.address ?? '',
    taxReference: supplier?.taxReference ?? '',
    notes: supplier?.notes ?? ''
  })
  const [error, setError] = useState<unknown>(null)
  const fields = error instanceof ApiError ? error.fieldErrors : {}
  const set = (k: keyof typeof form) => (v: string) => setForm({ ...form, [k]: v })
  const save = async () => {
    setError(null)
    const payload = { name: form.name, code: n(form.code), contactName: n(form.contactName), email: n(form.email), phone: n(form.phone), address: n(form.address), taxReference: n(form.taxReference), notes: n(form.notes) }
    try {
      if (supplier) await call('suppliers.update', { id: supplier.id, ...payload })
      else await call('suppliers.create', payload)
      onSaved()
    } catch (err) {
      setError(err)
    }
  }
  return (
    <Dialog title={supplier ? `Edit ${supplier.name}` : 'Add supplier'} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => void save()}>{supplier ? 'Save changes' : 'Add supplier'}</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <div className="form-grid">
          <TextField label="Name" value={form.name} onChange={(e) => set('name')(e.target.value)} error={fields['name']} />
          <TextField label="Code" value={form.code} onChange={(e) => set('code')(e.target.value)} error={fields['code']} hint="Optional, unique" />
          <TextField label="Contact person" value={form.contactName} onChange={(e) => set('contactName')(e.target.value)} />
          <TextField label="Email" value={form.email} onChange={(e) => set('email')(e.target.value)} error={fields['email']} />
          <TextField label="Phone" value={form.phone} onChange={(e) => set('phone')(e.target.value)} error={fields['phone']} />
          <TextField label="Tax reference (GSTIN)" value={form.taxReference} onChange={(e) => set('taxReference')(e.target.value)} />
          <TextAreaField label="Address" value={form.address} onChange={set('address')} />
          <TextAreaField label="Notes" value={form.notes} onChange={set('notes')} />
        </div>
      </div>
    </Dialog>
  )
}
