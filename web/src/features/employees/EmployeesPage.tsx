import { useCallback, useEffect, useState } from 'react'
import type { AssignmentView, EmployeeDetail, EmployeeListItem, Page, SessionInfo } from '@shared/api'
import { EDITABLE_EMPLOYMENT_STATUSES, EMPLOYMENT_STATUS_LABELS, EMPLOYMENT_STATUSES, type EmploymentStatus } from '@shared/organization'
import { ApiError, call, formatDateTime } from '../../api'
import { Alert, Button, Dialog, ErrorAlert, PageHeader, Panel, SelectField, TextAreaField, TextField } from '../../components/ui'
import { useLatestOnly } from '../../hooks'
import { EmployeePicker, optionList, useOrgLookups, type OrgLookups } from '../organization/lookups'
import { EmployeeImport } from './EmployeeImport'

const PAGE_SIZE = 50

function StatusBadge({ status }: { status: EmploymentStatus }) {
  const cls = status === 'exited' ? 'badge--off' : status === 'active' ? 'badge--ok' : 'badge--warn'
  return <span className={`badge ${cls}`}>{EMPLOYMENT_STATUS_LABELS[status]}</span>
}

export function EmployeesPage({ session }: { session: SessionInfo }) {
  const canManage = session.permissions.includes('employees.manage')
  const canImport = session.permissions.includes('employees.import')
  const lookups = useOrgLookups()
  const [mode, setMode] = useState<'list' | 'import'>('list')
  const [query, setQuery] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [status, setStatus] = useState<'current' | 'all' | EmploymentStatus>('current')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<Page<EmployeeListItem> | null>(null)
  const [selected, setSelected] = useState<EmployeeDetail | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [editing, setEditing] = useState<EmployeeDetail | 'new' | null>(null)
  const [exiting, setExiting] = useState<EmployeeDetail | null>(null)

  const guard = useLatestOnly()
  const load = useCallback(() => {
    guard(call('employees.search', { page, pageSize: PAGE_SIZE, status, ...(query.trim() ? { query: query.trim() } : {}), ...(departmentId ? { departmentId } : {}) })).then(setData, setError)
  }, [page, status, query, departmentId])
  useEffect(load, [load])

  const open = async (id: string) => {
    try {
      setSelected(await call('employees.get', { id }))
    } catch (err) {
      setError(err)
    }
  }
  const afterChange = (e: EmployeeDetail, message: string) => {
    setSelected(e)
    setNotice(message)
    load()
  }

  if (mode === 'import') {
    return (
      <EmployeeImport
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
        title="Employees"
        description="People who can hold assets. Leavers are marked as exited with their exit date; records are never deleted."
        actions={
          <>
            {canImport ? <Button onClick={() => setMode('import')}>Import CSV</Button> : null}
            {canManage ? <Button variant="primary" onClick={() => setEditing('new')}>Add employee</Button> : null}
          </>
        }
      />
      <ErrorAlert error={error} />
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <div className={selected ? 'split' : 'split split--single'}>
        <Panel flush title={data ? `${data.total} employees` : 'Employees'}>
          <div className="toolbar">
            <div className="field--grow">
              <TextField label="Search" placeholder="Employee ID, name or email" value={query} onChange={(e) => { setPage(1); setQuery(e.target.value) }} />
            </div>
            <SelectField label="Department" value={departmentId} placeholder="All departments" onChange={(v) => { setPage(1); setDepartmentId(v) }} options={optionList(lookups.departments, (d) => d.name)} />
            <SelectField
              label="Status"
              value={status}
              onChange={(v) => { setPage(1); setStatus(v as typeof status) }}
              options={[{ value: 'current', label: 'Current (not exited)' }, { value: 'all', label: 'All' }, ...EMPLOYMENT_STATUSES.map((s) => ({ value: s, label: EMPLOYMENT_STATUS_LABELS[s] }))]}
            />
          </div>
          <div className="table-wrap">
            <table className="grid">
              <thead><tr><th>Employee ID</th><th>Name</th><th>Department / team</th><th>Manager</th><th>Status</th></tr></thead>
              <tbody>
                {data?.items.map((e) => (
                  <tr key={e.id} className={`is-clickable ${selected?.id === e.id ? 'is-selected' : ''}`} onClick={() => void open(e.id)}>
                    <td className="ident">{e.employeeCode}</td>
                    <td><button className="link-btn" onClick={() => void open(e.id)}>{e.fullName}</button>{e.jobTitle ? <div className="faint">{e.jobTitle}</div> : null}</td>
                    <td>{e.departmentName ?? '—'}{e.teamName ? <div className="faint">{e.teamName}</div> : null}</td>
                    <td>{e.managerName ?? '—'}</td>
                    <td><StatusBadge status={e.employmentStatus} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data && data.items.length === 0 ? (
              <div className="empty">{data.total === 0 && !query && !departmentId ? 'No employees yet. Add one, or import a CSV file.' : 'No employees match these filters.'}</div>
            ) : null}
          </div>
          <div className="pager">
            <span className="faint">Page {page} of {pages}</span>
            <Button small disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
            <Button small disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
          </div>
        </Panel>
        {selected ? (
          <EmployeeDetailPanel
            employee={selected}
            canManage={canManage}
            onClose={() => setSelected(null)}
            onOpen={(id) => void open(id)}
            onEdit={() => setEditing(selected)}
            onExit={() => setExiting(selected)}
            onReactivated={(e) => afterChange(e, `${e.fullName} was reactivated.`)}
          />
        ) : null}
      </div>
      {editing ? (
        <EmployeeDialog
          employee={editing === 'new' ? null : editing}
          lookups={lookups}
          onClose={() => setEditing(null)}
          onSaved={(e) => {
            setEditing(null)
            afterChange(e, editing === 'new' ? `${e.fullName} was added.` : `${e.fullName} was updated.`)
          }}
        />
      ) : null}
      {exiting ? (
        <ExitDialog
          employee={exiting}
          onClose={() => setExiting(null)}
          onDone={(e) => {
            setExiting(null)
            afterChange(e, `${e.fullName} is marked as exited. Their records and history are kept.`)
          }}
        />
      ) : null}
    </div>
  )
}

function EmployeeDetailPanel({ employee: e, canManage, onClose, onOpen, onEdit, onExit, onReactivated }: {
  employee: EmployeeDetail
  canManage: boolean
  onClose: () => void
  onOpen: (id: string) => void
  onEdit: () => void
  onExit: () => void
  onReactivated: (e: EmployeeDetail) => void
}) {
  const [reactivating, setReactivating] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<unknown>(null)
  const reactivate = async () => {
    try {
      onReactivated(await call('employees.reactivate', { id: e.id, reason }))
      setReactivating(false)
    } catch (err) {
      setError(err)
    }
  }
  return (
    <Panel title={e.fullName} actions={<Button small variant="quiet" onClick={onClose}>Close</Button>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <dl className="dl">
          <dt>Employee ID</dt><dd className="ident">{e.employeeCode}</dd>
          <dt>Status</dt><dd><StatusBadge status={e.employmentStatus} />{e.actualExitDate ? ` on ${e.actualExitDate}` : ''}</dd>
          <dt>Job title</dt><dd>{e.jobTitle ?? '—'}</dd>
          <dt>Department</dt><dd>{e.departmentName ?? '—'}</dd>
          <dt>Team / process</dt><dd>{e.teamName ?? '—'}</dd>
          <dt>Manager</dt>
          <dd>
            {e.managerEmployeeId ? <button className="link-btn" onClick={() => onOpen(e.managerEmployeeId!)}>{e.managerName}</button> : '—'}
            {e.managerStatus === 'exited' ? <span className="faint"> (exited)</span> : null}
          </dd>
          <dt>Work location</dt><dd>{e.workLocationPath ?? '—'}</dd>
          <dt>Email</dt><dd>{e.email ?? '—'}</dd>
          <dt>Phone</dt><dd>{e.phone ?? '—'}</dd>
          <dt>Joined</dt><dd>{e.joiningDate ?? '—'}</dd>
          <dt>Expected exit</dt><dd>{e.expectedExitDate ?? '—'}</dd>
          <dt>Last updated</dt><dd>{formatDateTime(e.updatedAt)}</dd>
          {e.notes ? (<><dt>Notes</dt><dd>{e.notes}</dd></>) : null}
        </dl>
        <div>
          <h3>Direct reports ({e.directReports.length})</h3>
          {e.directReports.length === 0 ? <p className="faint">None</p> : (
            <ul className="issue-list">
              {e.directReports.map((r) => (
                <li key={r.id}>
                  <button className="link-btn" onClick={() => onOpen(r.id)}>{r.fullName}</button> <span className="faint">{r.employeeCode}{r.employmentStatus === 'exited' ? ', exited' : ''}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <EmployeeAssets employeeId={e.id} />
        {canManage ? (
          e.employmentStatus === 'exited' ? (
            reactivating ? (
              <div className="stack">
                <TextField label="Reason for reactivation" value={reason} onChange={(ev) => setReason(ev.target.value)} hint="Recorded in the audit log" />
                <div className="chips">
                  <Button small onClick={() => setReactivating(false)}>Cancel</Button>
                  <Button small variant="primary" disabled={!reason.trim()} onClick={() => void reactivate()}>Reactivate</Button>
                </div>
              </div>
            ) : (
              <div className="chips"><Button small onClick={() => setReactivating(true)}>Reactivate</Button></div>
            )
          ) : (
            <div className="chips">
              <Button small onClick={onEdit}>Edit</Button>
              <Button small onClick={onExit}>Mark as exited</Button>
            </div>
          )
        ) : null}
      </div>
    </Panel>
  )
}

function EmployeeDialog({ employee, lookups, onClose, onSaved }: { employee: EmployeeDetail | null; lookups: OrgLookups; onClose: () => void; onSaved: (e: EmployeeDetail) => void }) {
  const [form, setForm] = useState({
    employeeCode: employee?.employeeCode ?? '',
    fullName: employee?.fullName ?? '',
    email: employee?.email ?? '',
    phone: employee?.phone ?? '',
    jobTitle: employee?.jobTitle ?? '',
    departmentId: employee?.departmentId ?? '',
    teamId: employee?.teamId ?? '',
    workLocationId: employee?.workLocationId ?? '',
    employmentStatus: (employee?.employmentStatus === 'exited' ? 'active' : employee?.employmentStatus ?? 'active') as (typeof EDITABLE_EMPLOYMENT_STATUSES)[number],
    joiningDate: employee?.joiningDate ?? '',
    expectedExitDate: employee?.expectedExitDate ?? '',
    notes: employee?.notes ?? ''
  })
  const [managerId, setManagerId] = useState<string | null>(employee?.managerEmployeeId ?? null)
  const [error, setError] = useState<unknown>(null)
  const fields = error instanceof ApiError ? error.fieldErrors : {}
  const set = (k: keyof typeof form) => (v: string) => setForm({ ...form, [k]: v })
  const n = (s: string): string | null => (s.trim() === '' ? null : s)

  const save = async () => {
    setError(null)
    const payload = {
      employeeCode: form.employeeCode,
      fullName: form.fullName,
      email: n(form.email),
      phone: n(form.phone),
      jobTitle: n(form.jobTitle),
      departmentId: form.departmentId || null,
      teamId: form.teamId || null,
      managerEmployeeId: managerId,
      workLocationId: form.workLocationId || null,
      employmentStatus: form.employmentStatus,
      joiningDate: n(form.joiningDate),
      expectedExitDate: n(form.expectedExitDate),
      notes: n(form.notes)
    }
    try {
      onSaved(employee ? await call('employees.update', { id: employee.id, ...payload }) : await call('employees.create', payload))
    } catch (err) {
      setError(err)
    }
  }
  const teamOptions = lookups.teams.filter((t) => !form.departmentId || t.departmentId === form.departmentId)
  return (
    <Dialog title={employee ? `Edit ${employee.fullName}` : 'Add employee'} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => void save()}>{employee ? 'Save changes' : 'Add employee'}</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <div className="form-grid">
          <TextField label="Employee ID" value={form.employeeCode} onChange={(e) => set('employeeCode')(e.target.value)} error={fields['employeeCode']} hint="From your HR system; must be unique" />
          <TextField label="Full name" value={form.fullName} onChange={(e) => set('fullName')(e.target.value)} error={fields['fullName']} />
          <TextField label="Email" type="email" value={form.email} onChange={(e) => set('email')(e.target.value)} error={fields['email']} />
          <TextField label="Phone" value={form.phone} onChange={(e) => set('phone')(e.target.value)} error={fields['phone']} />
          <TextField label="Job title" value={form.jobTitle} onChange={(e) => set('jobTitle')(e.target.value)} error={fields['jobTitle']} />
          <SelectField label="Status" value={form.employmentStatus} onChange={set('employmentStatus')} options={EDITABLE_EMPLOYMENT_STATUSES.map((s) => ({ value: s, label: EMPLOYMENT_STATUS_LABELS[s] }))} />
          <SelectField label="Department" value={form.departmentId} placeholder="None" onChange={(v) => setForm({ ...form, departmentId: v, teamId: '' })} options={optionList(lookups.departments, (d) => d.name)} error={fields['departmentId']} />
          <SelectField label="Team / process" value={form.teamId} placeholder="None" onChange={set('teamId')} options={optionList(teamOptions, (t) => `${t.name} (${t.departmentName})`)} error={fields['teamId']} />
          <EmployeePicker label="Manager" value={managerId} initialLabel={employee?.managerName ? `${employee.managerName}` : null} onChange={setManagerId} excludeId={employee?.id} error={fields['managerEmployeeId']} />
          <SelectField label="Work location" value={form.workLocationId} placeholder="None" onChange={set('workLocationId')} options={optionList(lookups.locations, (l) => l.path)} error={fields['workLocationId']} />
          <TextField label="Joining date" type="date" value={form.joiningDate} onChange={(e) => set('joiningDate')(e.target.value)} error={fields['joiningDate']} />
          <TextField label="Expected exit date" type="date" value={form.expectedExitDate} onChange={(e) => set('expectedExitDate')(e.target.value)} error={fields['expectedExitDate']} />
          <TextAreaField label="Notes" value={form.notes} onChange={set('notes')} hint="Avoid sensitive personal information" />
        </div>
      </div>
    </Dialog>
  )
}

function ExitDialog({ employee, onClose, onDone }: { employee: EmployeeDetail; onClose: () => void; onDone: (e: EmployeeDetail) => void }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [reason, setReason] = useState('')
  const [error, setError] = useState<unknown>(null)
  const fields = error instanceof ApiError ? error.fieldErrors : {}
  const save = async () => {
    try {
      onDone(await call('employees.deactivate', { id: employee.id, actualExitDate: date, reason }))
    } catch (err) {
      setError(err)
    }
  }
  return (
    <Dialog
      title={`Mark ${employee.fullName} as exited?`}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" disabled={!reason.trim() || !date} onClick={() => void save()}>Mark as exited</Button></>}
    >
      <div className="stack">
        <ErrorAlert error={error} />
        <p className="muted">
          The employee record, reporting lines and history are kept. This does not return or clear any assets; use exit clearance for that once it is available.
        </p>
        {employee.directReports.some((r) => r.employmentStatus !== 'exited') ? (
          <Alert tone="warn">This employee still manages current staff. Assign them a new manager afterwards.</Alert>
        ) : null}
        <div className="form-grid">
          <TextField label="Exit date" type="date" value={date} onChange={(e) => setDate(e.target.value)} error={fields['actualExitDate']} />
          <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} hint="Required. Recorded in the audit log." />
        </div>
      </div>
    </Dialog>
  )
}

/** Assets currently assigned to the employee (visible with the allocation view permission). */
function EmployeeAssets({ employeeId }: { employeeId: string }) {
  const [items, setItems] = useState<AssignmentView[] | null>(null)
  const [denied, setDenied] = useState(false)
  useEffect(() => {
    call('allocations.list', { employeeId, status: 'active', pageSize: 100 }).then(
      (p) => setItems(p.items),
      () => setDenied(true)
    )
  }, [employeeId])
  if (denied) return null
  return (
    <div>
      <h3>Assigned assets ({items?.length ?? '…'})</h3>
      {items && items.length === 0 ? <p className="faint">None</p> : null}
      {items?.length ? (
        <ul className="issue-list" aria-label="Assigned assets">
          {items.map((a) => (
            <li key={a.id}>
              <a href={`#/assets/${a.assetId}`} className="ident">{a.assetCode}</a> <span className="faint">{a.categoryName}{a.makeModel ? `, ${a.makeModel}` : ''} since {formatDateTime(a.assignedAt)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
