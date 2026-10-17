import { useCallback, useEffect, useState } from 'react'
import type { DepartmentView, LocationView, PoolView, SessionInfo, TeamView, WorkstationView } from '@shared/api'
import { LOCATION_PARENT_RULES, LOCATION_TYPE_LABELS, LOCATION_TYPES, WORKSTATION_LOCATION_TYPES, type LocationType } from '@shared/organization'
import { ApiError, call } from '../../api'
import { ActiveBadge, Alert, Button, Dialog, ErrorAlert, PageHeader, Panel, ReasonDialog, SelectField, Tabs, TextAreaField, TextField, useToast } from '../../components/ui'
import { useLatestOnly } from '../../hooks'
import { EmployeePicker, optionList } from './lookups'
import { ReferenceImport } from './ReferenceImport'

type Tab = 'departments' | 'locations' | 'workstations' | 'pools'

export function OrganizationPage({ session }: { session: SessionInfo }) {
  const canManage = session.permissions.includes('locations.manage')
  const [tab, setTab] = useState<Tab>('departments')
  return (
    <div className="stack">
      <PageHeader
        title="Departments and locations"
        description="The organization structure and physical places that employees and assets are linked to. Records are deactivated, never deleted, so history stays intact."
      />
      <Tabs
        label="Organization sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'departments', label: 'Departments and teams' },
          { id: 'locations', label: 'Locations' },
          { id: 'workstations', label: 'Workstations and seats' },
          { id: 'pools', label: 'Shared asset pools' }
        ]}
      />
      {tab === 'departments' ? <DepartmentsTab canManage={canManage} /> : null}
      {tab === 'locations' ? <LocationsTab canManage={canManage} /> : null}
      {tab === 'workstations' ? <WorkstationsTab canManage={canManage} /> : null}
      {tab === 'pools' ? <PoolsTab canManage={canManage} /> : null}
    </div>
  )
}

/** Shared list-loading state with an include-inactive toggle and search text. */
function useList<T>(load: (includeInactive: boolean, search: string) => Promise<T[]>) {
  const [items, setItems] = useState<T[]>([])
  const [includeInactive, setIncludeInactive] = useState(false)
  const [search, setSearch] = useState('')
  const [error, setError] = useState<unknown>(null)
  const guard = useLatestOnly()
  const reload = useCallback(() => {
    guard(load(includeInactive, search)).then(setItems, setError)
  }, [load, includeInactive, search])
  useEffect(reload, [reload])
  return { items, includeInactive, setIncludeInactive, search, setSearch, error, setError, reload }
}

function ListToolbar({ search, setSearch, includeInactive, setIncludeInactive, children }: {
  search: string
  setSearch: (s: string) => void
  includeInactive: boolean
  setIncludeInactive: (b: boolean) => void
  children?: React.ReactNode
}) {
  return (
    <div className="toolbar">
      <div className="field--grow">
        <TextField label="Search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or code" />
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
        Show deactivated
      </label>
      {children}
    </div>
  )
}

function useFormErrors() {
  const [error, setError] = useState<unknown>(null)
  const fields = error instanceof ApiError ? error.fieldErrors : {}
  return { error, setError, fields }
}

const nullIfEmpty = (s: string): string | null => (s.trim() === '' ? null : s)

// =============================== Departments & teams ===============================

function DepartmentsTab({ canManage }: { canManage: boolean }) {
  const list = useList(useCallback((includeInactive: boolean, search: string) => call('departments.list', { includeInactive, ...(search ? { search } : {}) }), []))
  const [selected, setSelected] = useState<DepartmentView | null>(null)
  const [teams, setTeams] = useState<TeamView[]>([])
  const [editing, setEditing] = useState<DepartmentView | 'new' | null>(null)
  const [editingTeam, setEditingTeam] = useState<TeamView | 'new' | null>(null)
  const [toggling, setToggling] = useState<{ kind: 'department' | 'team'; id: string; name: string; isActive: boolean } | null>(null)
  const [importing, setImporting] = useState<'departments' | 'teams' | null>(null)
  const toast = useToast()

  const guardTeams = useLatestOnly()
  const loadTeams = useCallback(() => {
    if (selected) guardTeams(call('teams.list', { departmentId: selected.id, includeInactive: true })).then(setTeams, list.setError)
  }, [selected, list.setError])
  useEffect(loadTeams, [loadTeams])

  const refresh = () => {
    list.reload()
    loadTeams()
  }

  if (importing) {
    return <ReferenceImport kind={importing} onDone={(message) => { setImporting(null); if (message) toast.success(message); refresh() }} />
  }

  return (
    <div className={selected ? 'split' : 'split split--single'}>
      <Panel
        flush
        title="Departments"
        actions={canManage ? (
          <>
            <Button small onClick={() => setImporting('departments')}>Import departments</Button>
            <Button small onClick={() => setImporting('teams')}>Import teams</Button>
            <Button variant="primary" small onClick={() => setEditing('new')}>Add department</Button>
          </>
        ) : null}
      >
        <ListToolbar {...list} />
        <ErrorAlert error={list.error} />
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr><th>Department</th><th>Code</th><th>Manager</th><th className="num">Teams</th><th className="num">Employees</th><th>Status</th></tr>
            </thead>
            <tbody>
              {list.items.map((d) => (
                <tr key={d.id} className={`is-clickable ${selected?.id === d.id ? 'is-selected' : ''} ${d.isActive ? '' : 'is-inactive'}`} onClick={() => setSelected(d)}>
                  <td><button className="link-btn" onClick={() => setSelected(d)}>{d.name}</button></td>
                  <td className="ident">{d.code ?? '—'}</td>
                  <td>{d.managerName ?? '—'}</td>
                  <td className="num">{d.activeTeamCount}</td>
                  <td className="num">{d.currentEmployeeCount}</td>
                  <td><ActiveBadge active={d.isActive} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.items.length === 0 ? <div className="empty">No departments yet.{canManage ? ' Add the first one to start building the structure.' : ''}</div> : null}
        </div>
      </Panel>

      {selected ? (
        <Panel
          title={selected.name}
          actions={<Button small variant="quiet" onClick={() => setSelected(null)}>Close</Button>}
        >
          <div className="stack">
            <dl className="dl">
              <dt>Code</dt><dd>{selected.code ?? '—'}</dd>
              <dt>Manager</dt><dd>{selected.managerName ?? '—'}</dd>
              <dt>Current employees</dt><dd>{selected.currentEmployeeCount}</dd>
              <dt>Status</dt><dd><ActiveBadge active={selected.isActive} /></dd>
              {selected.notes ? (<><dt>Notes</dt><dd>{selected.notes}</dd></>) : null}
            </dl>
            {canManage ? (
              <div className="chips">
                <Button small onClick={() => setEditing(selected)}>Edit</Button>
                <Button small onClick={() => setToggling({ kind: 'department', id: selected.id, name: selected.name, isActive: selected.isActive })}>
                  {selected.isActive ? 'Deactivate' : 'Reactivate'}
                </Button>
              </div>
            ) : null}
            <div className="panel__head">
              <h3>Teams and processes</h3>
              {canManage && selected.isActive ? <Button small onClick={() => setEditingTeam('new')}>Add team</Button> : null}
            </div>
            {teams.length === 0 ? <p className="faint">No teams in this department.</p> : (
              <table className="grid">
                <tbody>
                  {teams.map((t) => (
                    <tr key={t.id} className={t.isActive ? '' : 'is-inactive'}>
                      <td>
                        {t.name} <span className="faint">{t.kind === 'process' ? 'process' : 'team'}{t.code ? `, ${t.code}` : ''}</span>
                        <div className="faint">{t.leadName ? `Lead: ${t.leadName}` : 'No lead'}, {t.currentEmployeeCount} employees</div>
                      </td>
                      <td className="actions">
                        {canManage ? (
                          <>
                            <Button small variant="quiet" onClick={() => setEditingTeam(t)}>Edit</Button>
                            <Button small variant="quiet" onClick={() => setToggling({ kind: 'team', id: t.id, name: t.name, isActive: t.isActive })}>
                              {t.isActive ? 'Deactivate' : 'Reactivate'}
                            </Button>
                          </>
                        ) : <ActiveBadge active={t.isActive} />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Panel>
      ) : null}

      {editing ? (
        <DepartmentDialog
          department={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(d) => {
            setEditing(null)
            setSelected(d)
            refresh()
          }}
        />
      ) : null}
      {editingTeam && selected ? (
        <TeamDialog
          team={editingTeam === 'new' ? null : editingTeam}
          departmentId={selected.id}
          onClose={() => setEditingTeam(null)}
          onSaved={() => {
            setEditingTeam(null)
            refresh()
          }}
        />
      ) : null}
      {toggling ? (
        <ReasonDialog
          title={`${toggling.isActive ? 'Deactivate' : 'Reactivate'} ${toggling.name}?`}
          description={toggling.isActive ? 'The record and its history are kept. It can no longer be chosen for new employees or assignments.' : 'The record becomes available again.'}
          confirmLabel={toggling.isActive ? 'Deactivate' : 'Reactivate'}
          danger={toggling.isActive}
          onClose={() => setToggling(null)}
          onConfirm={async (reason) => {
            const input = { id: toggling.id, isActive: !toggling.isActive, reason }
            if (toggling.kind === 'department') setSelected(await call('departments.setActive', input))
            else await call('teams.setActive', input)
            setToggling(null)
            refresh()
          }}
        />
      ) : null}
    </div>
  )
}

function DepartmentDialog({ department, onClose, onSaved }: { department: DepartmentView | null; onClose: () => void; onSaved: (d: DepartmentView) => void }) {
  const [form, setForm] = useState({ name: department?.name ?? '', code: department?.code ?? '', notes: department?.notes ?? '' })
  const [managerId, setManagerId] = useState<string | null>(department?.managerEmployeeId ?? null)
  const { error, setError, fields } = useFormErrors()
  const save = async () => {
    setError(null)
    const payload = { name: form.name, code: nullIfEmpty(form.code), notes: nullIfEmpty(form.notes), managerEmployeeId: managerId }
    try {
      onSaved(department ? await call('departments.update', { id: department.id, ...payload }) : await call('departments.create', payload))
    } catch (err) {
      setError(err)
    }
  }
  return (
    <Dialog title={department ? `Edit ${department.name}` : 'Add department'} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => void save()}>{department ? 'Save changes' : 'Add department'}</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <div className="form-grid">
          <TextField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} error={fields['name']} />
          <TextField label="Code" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} error={fields['code']} hint="Optional, unique" />
          <EmployeePicker label="Manager" value={managerId} initialLabel={department?.managerName ?? null} onChange={setManagerId} error={fields['managerEmployeeId']} />
          <TextAreaField label="Notes" value={form.notes} onChange={(v) => setForm({ ...form, notes: v })} />
        </div>
      </div>
    </Dialog>
  )
}

function TeamDialog({ team, departmentId, onClose, onSaved }: { team: TeamView | null; departmentId: string; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: team?.name ?? '', code: team?.code ?? '', notes: team?.notes ?? '', kind: team?.kind ?? 'team' })
  const [leadId, setLeadId] = useState<string | null>(team?.leadEmployeeId ?? null)
  const { error, setError, fields } = useFormErrors()
  const save = async () => {
    setError(null)
    const payload = { departmentId: team?.departmentId ?? departmentId, kind: form.kind, name: form.name, code: nullIfEmpty(form.code), notes: nullIfEmpty(form.notes), leadEmployeeId: leadId }
    try {
      if (team) await call('teams.update', { id: team.id, ...payload })
      else await call('teams.create', payload)
      onSaved()
    } catch (err) {
      setError(err)
    }
  }
  return (
    <Dialog title={team ? `Edit ${team.name}` : 'Add team or process'} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => void save()}>{team ? 'Save changes' : 'Add'}</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <div className="form-grid">
          <TextField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} error={fields['name']} />
          <SelectField label="Type" value={form.kind} onChange={(v) => setForm({ ...form, kind: v as 'team' | 'process' })} options={[{ value: 'team', label: 'Team' }, { value: 'process', label: 'Process (client campaign / LOB)' }]} />
          <TextField label="Code" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} error={fields['code']} hint="Optional, unique" />
          <EmployeePicker label="Team lead" value={leadId} initialLabel={team?.leadName ?? null} onChange={setLeadId} error={fields['leadEmployeeId']} />
          <TextAreaField label="Notes" value={form.notes} onChange={(v) => setForm({ ...form, notes: v })} />
        </div>
      </div>
    </Dialog>
  )
}

// =============================== Locations ===============================

function LocationsTab({ canManage }: { canManage: boolean }) {
  const list = useList(useCallback((includeInactive: boolean, search: string) => call('locations.list', { includeInactive, ...(search ? { search } : {}) }), []))
  const [editing, setEditing] = useState<{ location: LocationView | null; parentId: string | null } | null>(null)
  const [toggling, setToggling] = useState<LocationView | null>(null)
  const [importing, setImporting] = useState(false)
  const toast = useToast()
  const depth = (l: LocationView) => l.path.split(' / ').length - 1

  if (importing) {
    return <ReferenceImport kind="locations" onDone={(message) => { setImporting(false); if (message) toast.success(message); list.reload() }} />
  }

  return (
    <Panel
      flush
      title="Location hierarchy"
      actions={canManage ? (
        <>
          <Button small onClick={() => setImporting(true)}>Import CSV/Excel</Button>
          <Button variant="primary" small onClick={() => setEditing({ location: null, parentId: null })}>Add office / site</Button>
        </>
      ) : null}
    >
      <ListToolbar {...list} />
      <ErrorAlert error={list.error} />
      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr><th>Location</th><th>Type</th><th>Code</th><th className="num">Sub-locations</th><th className="num">Workstations</th><th>Status</th><th className="actions" aria-label="Actions" /></tr>
          </thead>
          <tbody>
            {list.items.map((l) => (
              <tr key={l.id} className={l.isActive ? '' : 'is-inactive'}>
                <td>
                  <span className="indent" style={{ width: `${depth(l) * 18}px` }} />
                  {list.search ? l.path : l.name}
                </td>
                <td>{LOCATION_TYPE_LABELS[l.locationType]}</td>
                <td className="ident">{l.code ?? '—'}</td>
                <td className="num">{l.activeChildCount}</td>
                <td className="num">{l.activeWorkstationCount}</td>
                <td><ActiveBadge active={l.isActive} /></td>
                <td className="actions">
                  {canManage ? (
                    <>
                      {l.isActive && LOCATION_TYPES.some((t) => LOCATION_PARENT_RULES[t].includes(l.locationType)) ? (
                        <Button small variant="quiet" onClick={() => setEditing({ location: null, parentId: l.id })}>Add inside</Button>
                      ) : null}
                      <Button small variant="quiet" onClick={() => setEditing({ location: l, parentId: l.parentLocationId })}>Edit</Button>
                      <Button small variant="quiet" onClick={() => setToggling(l)}>{l.isActive ? 'Deactivate' : 'Reactivate'}</Button>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.items.length === 0 ? <div className="empty">No locations yet. Start with an office or site, then add buildings, floors and bays inside it.</div> : null}
      </div>
      {editing ? (
        <LocationDialog
          location={editing.location}
          parentId={editing.parentId}
          all={list.items}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            list.reload()
          }}
        />
      ) : null}
      {toggling ? (
        <ReasonDialog
          title={`${toggling.isActive ? 'Deactivate' : 'Reactivate'} ${toggling.name}?`}
          description={toggling.isActive ? 'Only empty locations can be deactivated: no active sub-locations, workstations, employees or pools.' : 'The location becomes available again.'}
          confirmLabel={toggling.isActive ? 'Deactivate' : 'Reactivate'}
          danger={toggling.isActive}
          onClose={() => setToggling(null)}
          onConfirm={async (reason) => {
            await call('locations.setActive', { id: toggling.id, isActive: !toggling.isActive, reason })
            setToggling(null)
            list.reload()
          }}
        />
      ) : null}
    </Panel>
  )
}

function LocationDialog({ location, parentId, all, onClose, onSaved }: { location: LocationView | null; parentId: string | null; all: LocationView[]; onClose: () => void; onSaved: () => void }) {
  const parent = all.find((l) => l.id === parentId) ?? null
  const allowedTypes = LOCATION_TYPES.filter((t) => LOCATION_PARENT_RULES[t].includes(parent ? parent.locationType : null))
  const [form, setForm] = useState({
    name: location?.name ?? '',
    code: location?.code ?? '',
    notes: location?.notes ?? '',
    locationType: (location?.locationType ?? allowedTypes[0] ?? 'other') as LocationType
  })
  const { error, setError, fields } = useFormErrors()
  const save = async () => {
    setError(null)
    const payload = { parentLocationId: parentId, locationType: form.locationType, name: form.name, code: nullIfEmpty(form.code), notes: nullIfEmpty(form.notes) }
    try {
      if (location) await call('locations.update', { id: location.id, ...payload })
      else await call('locations.create', payload)
      onSaved()
    } catch (err) {
      setError(err)
    }
  }
  const types = location ? LOCATION_TYPES : allowedTypes
  return (
    <Dialog title={location ? `Edit ${location.name}` : parent ? `Add inside ${parent.name}` : 'Add office / site'} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => void save()}>{location ? 'Save changes' : 'Add location'}</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        {parent ? <p className="muted">Inside: {parent.path}</p> : null}
        <div className="form-grid">
          <TextField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} error={fields['name']} />
          <SelectField label="Type" value={form.locationType} onChange={(v) => setForm({ ...form, locationType: v as LocationType })} options={types.map((t) => ({ value: t, label: LOCATION_TYPE_LABELS[t] }))} error={fields['parentLocationId']} />
          <TextField label="Code" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} error={fields['code']} hint="Optional, unique; useful for imports" />
          <TextAreaField label="Notes" value={form.notes} onChange={(v) => setForm({ ...form, notes: v })} />
        </div>
      </div>
    </Dialog>
  )
}

// =============================== Workstations ===============================

function WorkstationsTab({ canManage }: { canManage: boolean }) {
  const list = useList(useCallback((includeInactive: boolean, search: string) => call('workstations.list', { includeInactive, ...(search ? { search } : {}) }), []))
  const [locations, setLocations] = useState<LocationView[]>([])
  const [editing, setEditing] = useState<WorkstationView | 'new' | null>(null)
  const [toggling, setToggling] = useState<WorkstationView | null>(null)
  const [importing, setImporting] = useState(false)
  const toast = useToast()
  useEffect(() => {
    call('locations.list', {}).then((ls) => setLocations(ls.filter((l) => WORKSTATION_LOCATION_TYPES.includes(l.locationType))), list.setError)
  }, [list.setError])

  if (importing) {
    return <ReferenceImport kind="workstations" onDone={(message) => { setImporting(false); if (message) toast.success(message); list.reload() }} />
  }

  return (
    <Panel
      flush
      title="Workstations and seats"
      actions={canManage ? (
        <>
          <Button small disabled={locations.length === 0} onClick={() => setImporting(true)}>Import CSV/Excel</Button>
          <Button variant="primary" small disabled={locations.length === 0} onClick={() => setEditing('new')}>Add workstation</Button>
        </>
      ) : null}
    >
      <ListToolbar {...list} />
      <ErrorAlert error={list.error} />
      {canManage && locations.length === 0 ? <Alert tone="info">Add a floor, room or bay under Locations first; workstations are placed inside one.</Alert> : null}
      <div className="table-wrap">
        <table className="grid">
          <thead><tr><th>Code</th><th>Type</th><th>Label</th><th>Location</th><th>Status</th><th className="actions" aria-label="Actions" /></tr></thead>
          <tbody>
            {list.items.map((w) => (
              <tr key={w.id} className={w.isActive ? '' : 'is-inactive'}>
                <td className="ident">{w.code}</td>
                <td>{w.kind === 'seat' ? 'Seat' : 'Workstation'}</td>
                <td>{w.label ?? '—'}</td>
                <td>{w.locationPath}</td>
                <td><ActiveBadge active={w.isActive} /></td>
                <td className="actions">
                  {canManage ? (
                    <>
                      <Button small variant="quiet" onClick={() => setEditing(w)}>Edit</Button>
                      <Button small variant="quiet" onClick={() => setToggling(w)}>{w.isActive ? 'Deactivate' : 'Reactivate'}</Button>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.items.length === 0 ? <div className="empty">No workstations yet.</div> : null}
      </div>
      {editing ? (
        <WorkstationDialog workstation={editing === 'new' ? null : editing} locations={locations} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload() }} />
      ) : null}
      {toggling ? (
        <ReasonDialog
          title={`${toggling.isActive ? 'Deactivate' : 'Reactivate'} ${toggling.code}?`}
          description="The workstation and its history are kept."
          confirmLabel={toggling.isActive ? 'Deactivate' : 'Reactivate'}
          danger={toggling.isActive}
          onClose={() => setToggling(null)}
          onConfirm={async (reason) => {
            await call('workstations.setActive', { id: toggling.id, isActive: !toggling.isActive, reason })
            setToggling(null)
            list.reload()
          }}
        />
      ) : null}
    </Panel>
  )
}

function WorkstationDialog({ workstation, locations, onClose, onSaved }: { workstation: WorkstationView | null; locations: LocationView[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    code: workstation?.code ?? '',
    label: workstation?.label ?? '',
    notes: workstation?.notes ?? '',
    kind: workstation?.kind ?? 'workstation',
    locationId: workstation?.locationId ?? locations[0]?.id ?? ''
  })
  const { error, setError, fields } = useFormErrors()
  const save = async () => {
    setError(null)
    const payload = { locationId: form.locationId, kind: form.kind, code: form.code, label: nullIfEmpty(form.label), notes: nullIfEmpty(form.notes) }
    try {
      if (workstation) await call('workstations.update', { id: workstation.id, ...payload })
      else await call('workstations.create', payload)
      onSaved()
    } catch (err) {
      setError(err)
    }
  }
  return (
    <Dialog title={workstation ? `Edit ${workstation.code}` : 'Add workstation or seat'} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => void save()}>{workstation ? 'Save changes' : 'Add'}</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <div className="form-grid">
          <TextField label="Code" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} error={fields['code']} hint="Unique, e.g. PUN-3A-014" />
          <SelectField label="Type" value={form.kind} onChange={(v) => setForm({ ...form, kind: v as 'workstation' | 'seat' })} options={[{ value: 'workstation', label: 'Workstation' }, { value: 'seat', label: 'Seat' }]} />
          <SelectField label="Location" value={form.locationId} onChange={(v) => setForm({ ...form, locationId: v })} options={optionList(locations, (l) => l.path)} error={fields['locationId']} />
          <TextField label="Label" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} hint="Optional display name" />
          <TextAreaField label="Notes" value={form.notes} onChange={(v) => setForm({ ...form, notes: v })} />
        </div>
      </div>
    </Dialog>
  )
}

// =============================== Pools ===============================

function PoolsTab({ canManage }: { canManage: boolean }) {
  const list = useList(useCallback((includeInactive: boolean, search: string) => call('pools.list', { includeInactive, ...(search ? { search } : {}) }), []))
  const [editing, setEditing] = useState<PoolView | 'new' | null>(null)
  const [toggling, setToggling] = useState<PoolView | null>(null)
  return (
    <Panel flush title="Shared asset pools" actions={canManage ? <Button variant="primary" small onClick={() => setEditing('new')}>Add pool</Button> : null}>
      <ListToolbar {...list} />
      <ErrorAlert error={list.error} />
      <p className="faint toolbar">A pool is a shared custody group, such as floor spare headsets. Assets join a pool through assignment once the asset modules are available.</p>
      <div className="table-wrap">
        <table className="grid">
          <thead><tr><th>Pool</th><th>Purpose</th><th>Responsible</th><th>Default location</th><th>Status</th><th className="actions" aria-label="Actions" /></tr></thead>
          <tbody>
            {list.items.map((p) => (
              <tr key={p.id} className={p.isActive ? '' : 'is-inactive'}>
                <td>{p.name}{p.code ? <span className="faint"> {p.code}</span> : null}</td>
                <td className="muted">{p.purpose ?? '—'}</td>
                <td>{[p.responsibleDepartmentName, p.responsibleTeamName].filter(Boolean).join(' / ')}</td>
                <td>{p.defaultLocationPath ?? '—'}</td>
                <td><ActiveBadge active={p.isActive} /></td>
                <td className="actions">
                  {canManage ? (
                    <>
                      <Button small variant="quiet" onClick={() => setEditing(p)}>Edit</Button>
                      <Button small variant="quiet" onClick={() => setToggling(p)}>{p.isActive ? 'Deactivate' : 'Reactivate'}</Button>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.items.length === 0 ? <div className="empty">No shared pools yet.</div> : null}
      </div>
      {editing ? <PoolDialog pool={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload() }} /> : null}
      {toggling ? (
        <ReasonDialog
          title={`${toggling.isActive ? 'Deactivate' : 'Reactivate'} ${toggling.name}?`}
          description="The pool and its history are kept."
          confirmLabel={toggling.isActive ? 'Deactivate' : 'Reactivate'}
          danger={toggling.isActive}
          onClose={() => setToggling(null)}
          onConfirm={async (reason) => {
            await call('pools.setActive', { id: toggling.id, isActive: !toggling.isActive, reason })
            setToggling(null)
            list.reload()
          }}
        />
      ) : null}
    </Panel>
  )
}

function PoolDialog({ pool, onClose, onSaved }: { pool: PoolView | null; onClose: () => void; onSaved: () => void }) {
  const [departments, setDepartments] = useState<DepartmentView[]>([])
  const [teams, setTeams] = useState<TeamView[]>([])
  const [locations, setLocations] = useState<LocationView[]>([])
  const [form, setForm] = useState({
    name: pool?.name ?? '',
    code: pool?.code ?? '',
    purpose: pool?.purpose ?? '',
    responsibleDepartmentId: pool?.responsibleDepartmentId ?? '',
    responsibleTeamId: pool?.responsibleTeamId ?? '',
    defaultLocationId: pool?.defaultLocationId ?? ''
  })
  const { error, setError, fields } = useFormErrors()
  useEffect(() => {
    Promise.all([call('departments.list', {}), call('teams.list', {}), call('locations.list', {})]).then(([d, t, l]) => {
      setDepartments(d)
      setTeams(t)
      setLocations(l)
    }, setError)
  }, [setError])
  const save = async () => {
    setError(null)
    const payload = {
      name: form.name,
      code: nullIfEmpty(form.code),
      purpose: nullIfEmpty(form.purpose),
      responsibleDepartmentId: form.responsibleDepartmentId || null,
      responsibleTeamId: form.responsibleTeamId || null,
      defaultLocationId: form.defaultLocationId || null
    }
    try {
      if (pool) await call('pools.update', { id: pool.id, ...payload })
      else await call('pools.create', payload)
      onSaved()
    } catch (err) {
      setError(err)
    }
  }
  const teamOptions = teams.filter((t) => !form.responsibleDepartmentId || t.departmentId === form.responsibleDepartmentId)
  return (
    <Dialog title={pool ? `Edit ${pool.name}` : 'Add shared asset pool'} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => void save()}>{pool ? 'Save changes' : 'Add pool'}</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <div className="form-grid">
          <TextField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} error={fields['name']} />
          <TextField label="Code" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} error={fields['code']} hint="Optional, unique" />
          <SelectField label="Responsible department" value={form.responsibleDepartmentId} placeholder="None" onChange={(v) => setForm({ ...form, responsibleDepartmentId: v, responsibleTeamId: '' })} options={optionList(departments, (d) => d.name)} error={fields['responsibleDepartmentId']} />
          <SelectField label="Responsible team" value={form.responsibleTeamId} placeholder="None" onChange={(v) => setForm({ ...form, responsibleTeamId: v })} options={optionList(teamOptions, (t) => `${t.name} (${t.departmentName})`)} error={fields['responsibleTeamId']} hint="A department, a team, or both" />
          <SelectField label="Default location" value={form.defaultLocationId} placeholder="None" onChange={(v) => setForm({ ...form, defaultLocationId: v })} options={optionList(locations, (l) => l.path)} />
          <TextAreaField label="Purpose" value={form.purpose} onChange={(v) => setForm({ ...form, purpose: v })} />
        </div>
      </div>
    </Dialog>
  )
}
