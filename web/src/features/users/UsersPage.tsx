import { useCallback, useEffect, useState } from 'react'
import type { PasswordResetRequestSummary, RoleSummary, SessionInfo, UserSummary } from '@shared/api'
import { PERMISSIONS, type PermissionKey } from '@shared/permissions'
import { PASSWORD_MIN_LENGTH } from '@shared/constants'
import { ApiError, call, formatDateTime } from '../../api'
import { Button, Dialog, ErrorAlert, PageHeader, Panel, TextField, useToast } from '../../components/ui'

type DialogState =
  | { kind: 'none' }
  | { kind: 'create' }
  | { kind: 'edit'; user: UserSummary }
  | { kind: 'reset'; user: UserSummary }
  | { kind: 'role'; role: RoleSummary }

export function UsersPage({ session }: { session: SessionInfo }) {
  const canUsers = session.permissions.includes('users.manage')
  const canRoles = session.permissions.includes('roles.manage')
  const [users, setUsers] = useState<UserSummary[]>([])
  const [roles, setRoles] = useState<RoleSummary[]>([])
  const [resetRequests, setResetRequests] = useState<PasswordResetRequestSummary[]>([])
  const [error, setError] = useState<unknown>(null)
  const toast = useToast()
  const [dialog, setDialog] = useState<DialogState>({ kind: 'none' })

  const load = useCallback(async () => {
    try {
      setRoles(await call('roles.list'))
      if (canUsers) {
        setUsers(await call('users.list'))
        setResetRequests(await call('passwordReset.list'))
      }
    } catch (err) {
      setError(err)
    }
  }, [canUsers])

  useEffect(() => {
    void load()
  }, [load])

  const roleName = (key: string) => roles.find((r) => r.key === key)?.name ?? key
  const done = (message: string) => {
    setDialog({ kind: 'none' })
    toast.success(message)
    void load()
  }
  const close = useCallback(() => setDialog({ kind: 'none' }), [])

  const dismissRequest = async (id: string) => {
    try {
      await call('passwordReset.dismiss', { id })
      toast.success('Request dismissed.')
      void load()
    } catch (err) {
      setError(err)
    }
  }

  const pendingRequests = resetRequests.filter((r) => r.status === 'pending')

  return (
    <div className="stack">
      <PageHeader
        title="Users and roles"
        description="Local accounts for this installation. Roles are templates the Super Admin can adjust; every change is written to the audit log."
        actions={canUsers ? <Button variant="primary" onClick={() => setDialog({ kind: 'create' })}>Add user</Button> : null}
      />
      <ErrorAlert error={error} />

      {canUsers && pendingRequests.length > 0 ? (
        <Panel title="Password reset requests" flush>
          <div className="table-wrap">
            <table className="grid">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Message</th>
                  <th>Requested</th>
                  <th className="actions" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {pendingRequests.map((r) => {
                  const user = users.find((u) => u.id === r.userId)
                  return (
                    <tr key={r.id}>
                      <td>
                        {r.displayName} <span className="faint">({r.username})</span>
                      </td>
                      <td className="muted">{r.message ?? <span className="faint">No message</span>}</td>
                      <td className="num">{formatDateTime(r.requestedAt)}</td>
                      <td className="actions">
                        {user ? (
                          <Button small variant="quiet" onClick={() => setDialog({ kind: 'reset', user })}>Reset password</Button>
                        ) : null}
                        <Button small variant="quiet" onClick={() => void dismissRequest(r.id)}>Dismiss</Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}

      {canUsers ? (
        <Panel title="Users" flush>
          <div className="table-wrap">
            <table className="grid">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Username</th>
                  <th>Roles</th>
                  <th>Status</th>
                  <th>Last sign-in</th>
                  <th className="actions" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.displayName}</td>
                    <td className="ident">{u.username}</td>
                    <td>{u.roleKeys.map(roleName).join(', ') || <span className="faint">No roles</span>}</td>
                    <td>
                      <span className={`badge ${u.isActive ? 'badge--ok' : 'badge--off'}`}>{u.isActive ? 'Active' : 'Deactivated'}</span>
                      {u.mustChangePassword ? <span className="faint"> must change password</span> : null}
                    </td>
                    <td className="num">{formatDateTime(u.lastLoginAt)}</td>
                    <td className="actions">
                      <Button small variant="quiet" onClick={() => setDialog({ kind: 'edit', user: u })}>Edit</Button>
                      <Button small variant="quiet" onClick={() => setDialog({ kind: 'reset', user: u })}>Reset password</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}

      <Panel title="Roles" flush>
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th>Role</th>
                <th>Purpose</th>
                <th className="num">Active users</th>
                <th className="num">Permissions</th>
                <th className="actions" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {roles.map((r) => (
                <tr key={r.key}>
                  <td>{r.name}</td>
                  <td className="muted">{r.description}</td>
                  <td className="num">{r.userCount}</td>
                  <td className="num">{r.permissions.length}</td>
                  <td className="actions">
                    {canRoles && !r.isSystem ? (
                      <Button small variant="quiet" onClick={() => setDialog({ kind: 'role', role: r })}>Edit permissions</Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {dialog.kind === 'create' ? <UserDialog roles={roles} onClose={close} onSaved={(u) => done(`${u.displayName} was added. They must change the password at first sign-in.`)} /> : null}
      {dialog.kind === 'edit' ? <UserDialog roles={roles} user={dialog.user} onClose={close} onSaved={(u) => done(`${u.displayName} was updated.`)} /> : null}
      {dialog.kind === 'reset' ? <ResetPasswordDialog user={dialog.user} onClose={close} onSaved={() => done(`Password reset for ${dialog.user.displayName}.`)} /> : null}
      {dialog.kind === 'role' ? <RoleDialog role={dialog.role} onClose={close} onSaved={(r) => done(`Permissions for ${r.name} were updated.`)} /> : null}
    </div>
  )
}

function RolePicker({ roles, value, onChange }: { roles: RoleSummary[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset className="field fieldset-plain">
      <legend className="field__label">Roles</legend>
      <div className="form-grid">
        {roles.map((r) => (
          <label key={r.key} className="checkbox">
            <input
              type="checkbox"
              checked={value.includes(r.key)}
              onChange={(e) => onChange(e.target.checked ? [...value, r.key] : value.filter((k) => k !== r.key))}
            />
            {r.name}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function UserDialog({ roles, user, onClose, onSaved }: { roles: RoleSummary[]; user?: UserSummary; onClose: () => void; onSaved: (u: UserSummary) => void }) {
  const [form, setForm] = useState({
    username: user?.username ?? '',
    displayName: user?.displayName ?? '',
    password: '',
    roleKeys: user?.roleKeys ?? [],
    isActive: user?.isActive ?? true,
    reason: ''
  })
  const [error, setError] = useState<unknown>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const saved = user
        ? await call('users.update', {
            id: user.id,
            displayName: form.displayName,
            isActive: form.isActive,
            roleKeys: form.roleKeys,
            ...(form.reason ? { reason: form.reason } : {})
          })
        : await call('users.create', { username: form.username, displayName: form.displayName, password: form.password, roleKeys: form.roleKeys })
      onSaved(saved)
    } catch (err) {
      setError(err)
      if (err instanceof ApiError) setFields(err.fieldErrors)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={user ? `Edit ${user.displayName}` : 'Add user'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>{user ? 'Save changes' : 'Add user'}</Button>
        </>
      }
    >
      <div className="stack">
        <ErrorAlert error={error} />
        <div className="form-grid">
          {user ? null : <TextField label="Username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} error={fields['username']} autoComplete="off" />}
          <TextField label="Full name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} error={fields['displayName']} />
          {user ? null : (
            <TextField
              label="Temporary password"
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              hint={`At least ${PASSWORD_MIN_LENGTH} characters; changed at first sign-in`}
              error={fields['password']}
              autoComplete="new-password"
            />
          )}
        </div>
        <RolePicker roles={roles} value={form.roleKeys} onChange={(roleKeys) => setForm({ ...form, roleKeys })} />
        {user ? (
          <>
            <label className="checkbox">
              <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
              Account is active
            </label>
            <TextField label="Reason for change" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} hint="Recorded in the audit log" />
          </>
        ) : null}
      </div>
    </Dialog>
  )
}

function ResetPasswordDialog({ user, onClose, onSaved }: { user: UserSummary; onClose: () => void; onSaved: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<unknown>(null)
  const save = async () => {
    try {
      await call('users.resetPassword', { id: user.id, newPassword: password })
      onSaved()
    } catch (err) {
      setError(err)
    }
  }
  return (
    <Dialog
      title={`Reset password for ${user.displayName}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()}>Reset password</Button>
        </>
      }
    >
      <div className="stack">
        <ErrorAlert error={error} />
        <TextField
          label="Temporary password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint="The user must replace it at next sign-in. Any lockout is cleared."
          autoComplete="new-password"
        />
      </div>
    </Dialog>
  )
}

function RoleDialog({ role, onClose, onSaved }: { role: RoleSummary; onClose: () => void; onSaved: (r: RoleSummary) => void }) {
  const [selected, setSelected] = useState<PermissionKey[]>(role.permissions)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<unknown>(null)
  const groups = Object.entries(PERMISSIONS).reduce<Record<string, Array<[PermissionKey, string]>>>((acc, [key, label]) => {
    const group = key.split('.')[0]!
    ;(acc[group] ??= []).push([key as PermissionKey, label])
    return acc
  }, {})

  const save = async () => {
    try {
      onSaved(await call('roles.updatePermissions', { roleKey: role.key, permissions: selected, reason }))
    } catch (err) {
      setError(err)
    }
  }

  return (
    <Dialog
      title={`Permissions for ${role.name}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!reason.trim()} onClick={() => void save()}>Save permissions</Button>
        </>
      }
    >
      <div className="stack">
        <ErrorAlert error={error} />
        {Object.entries(groups).map(([group, perms]) => (
          <div key={group}>
            <h3>{group.replace(/_/g, ' ')}</h3>
            {perms.map(([key, label]) => (
              <label key={key} className="checkbox checkbox--block">
                <input
                  type="checkbox"
                  checked={selected.includes(key)}
                  onChange={(e) => setSelected(e.target.checked ? [...selected, key] : selected.filter((k) => k !== key))}
                />
                {label}
              </label>
            ))}
          </div>
        ))}
        <TextField label="Reason for change" value={reason} onChange={(e) => setReason(e.target.value)} hint="Required. Recorded in the audit log." />
      </div>
    </Dialog>
  )
}
