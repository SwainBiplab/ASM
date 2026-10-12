import { useCallback, useEffect, useState } from 'react'
import type { ApprovalPolicySummary, ApprovalQueueItem, Page, SessionInfo } from '@shared/api'
import type { ApprovalStepInput, SaveApprovalPolicyInput } from '@shared/procurementSchemas'
import { formatMinor } from '@shared/assets'
import { ApiError, call, formatDateTime } from '../../api'
import { Alert, Button, Dialog, ErrorAlert, PageHeader, Panel, SelectField, Tabs, TextAreaField, TextField } from '../../components/ui'
import { useRoles, useUsers } from '../procurement/shared'

type Tab = 'queue' | 'policies'

export function ApprovalsPage({ session }: { session: SessionInfo; selectedId: string | null; navigate: (route: string) => void }) {
  const has = (p: string) => session.permissions.includes(p as never)
  const [tab, setTab] = useState<Tab>(has('procurement.approve') ? 'queue' : 'policies')
  const tabs = [has('procurement.approve') ? [{ id: 'queue' as const, label: 'My approval queue' }] : [], has('approvals.configure') ? [{ id: 'policies' as const, label: 'Approval policies' }] : []].flat()
  return (
    <div className="stack">
      <PageHeader title="Approvals" description="Decide on requests routed to you, and configure how purchase requests are approved." />
      {tabs.length > 1 ? <Tabs tabs={tabs} value={tab} onChange={setTab} label="Approvals view" /> : null}
      {tab === 'queue' && has('procurement.approve') ? <QueueTab /> : null}
      {tab === 'policies' && has('approvals.configure') ? <PoliciesTab /> : null}
    </div>
  )
}

function QueueTab() {
  const [data, setData] = useState<Page<ApprovalQueueItem> | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [deciding, setDeciding] = useState<ApprovalQueueItem | null>(null)
  const load = useCallback(() => {
    setError(null)
    call('approvals.listQueue', { page: 1, pageSize: 100 }).then(setData, setError)
  }, [])
  useEffect(load, [load])
  return (
    <Panel flush>
      <ErrorAlert error={error} onRetry={load} />
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <div className="table-wrap">
        <table className="grid" aria-label="Approval queue">
          <thead><tr><th>Request</th><th>Requester</th><th>Justification</th><th>Amount</th><th>Step</th><th>Submitted</th><th /></tr></thead>
          <tbody>
            {data?.items.map((item) => (
              <tr key={item.instanceId}>
                <td className="ident">{item.requestNumber}</td>
                <td>{item.requesterName ?? '—'}</td>
                <td>{item.justification}</td>
                <td className="num">{formatMinor(item.totalMinor, item.currency)}</td>
                <td>{item.stepOrder}</td>
                <td>{item.submittedAt ? formatDateTime(item.submittedAt) : '—'}</td>
                <td><Button small variant="primary" onClick={() => setDeciding(item)}>Decide</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.items.length === 0 ? <div className="empty">Nothing is waiting for your decision.</div> : null}
      </div>
      {deciding ? <DecideDialog item={deciding} onClose={() => setDeciding(null)} onDone={(msg) => { setDeciding(null); setNotice(msg); load() }} /> : null}
    </Panel>
  )
}

function DecideDialog({ item, onClose, onDone }: { item: ApprovalQueueItem; onClose: () => void; onDone: (message: string) => void }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const decide = (decision: 'approved' | 'rejected') => {
    setBusy(true)
    setError(null)
    call('approvals.decide', { instanceId: item.instanceId, decision, reason: reason.trim() || null })
      .then(() => onDone(decision === 'approved' ? `${item.requestNumber} approved.` : `${item.requestNumber} rejected.`), setError)
      .finally(() => setBusy(false))
  }
  return (
    <Dialog title={`Decide on ${item.requestNumber}`} onClose={onClose} footer={<>
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="danger" disabled={busy} onClick={() => decide('rejected')}>Reject</Button>
      <Button variant="primary" disabled={busy} onClick={() => decide('approved')}>Approve</Button>
    </>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <p className="muted">{item.justification} — {formatMinor(item.totalMinor, item.currency)}</p>
        <TextAreaField label="Comment" value={reason} onChange={setReason} hint="Optional" />
      </div>
    </Dialog>
  )
}

function PoliciesTab() {
  const [list, setList] = useState<ApprovalPolicySummary[]>([])
  const [error, setError] = useState<unknown>(null)
  const [editing, setEditing] = useState<ApprovalPolicySummary | 'new' | null>(null)
  const load = useCallback(() => {
    setError(null)
    call('approvals.listPolicies', {}).then(setList, setError)
  }, [])
  useEffect(load, [load])
  return (
    <Panel flush actions={<Button small variant="primary" onClick={() => setEditing('new')}>New policy</Button>}>
      <ErrorAlert error={error} onRetry={load} />
      <div className="table-wrap">
        <table className="grid" aria-label="Approval policies">
          <thead><tr><th>Name</th><th>Version</th><th>Threshold</th><th>Steps</th><th>Status</th><th /></tr></thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>v{p.version}{p.isCurrent ? '' : ' (superseded)'}</td>
                <td>{p.minAmountMinor === null ? 'Any amount' : formatMinor(p.minAmountMinor, p.currency!) + '+'}</td>
                <td>{p.steps.map((s) => s.requiredUserName ?? s.requiredRoleName ?? s.requiredRoleKey).join(' → ')}</td>
                <td><span className={`badge ${p.isActive ? 'badge--ok' : 'badge--off'}`}>{p.isActive ? 'Active' : 'Inactive'}</span></td>
                <td>{p.isCurrent ? <Button small onClick={() => setEditing(p)}>Edit (new version)</Button> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.length === 0 ? <div className="empty">No approval policy is configured yet. Purchase requests cannot be submitted until one exists.</div> : null}
      </div>
      {editing ? <PolicyEditor existing={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); load() }} /> : null}
    </Panel>
  )
}

function PolicyEditor({ existing, onClose, onDone }: { existing: ApprovalPolicySummary | null; onClose: () => void; onDone: () => void }) {
  const roles = useRoles()
  const users = useUsers()
  const [name, setName] = useState(existing?.name ?? '')
  const [minAmount, setMinAmount] = useState(existing?.minAmountMinor !== null && existing?.minAmountMinor !== undefined ? String(existing.minAmountMinor / 100) : '')
  const [currency, setCurrency] = useState(existing?.currency ?? 'INR')
  const [preventSelfApproval, setPreventSelfApproval] = useState(existing?.preventSelfApproval ?? true)
  const [isActive, setIsActive] = useState(existing?.isActive ?? true)
  const [steps, setSteps] = useState<ApprovalStepInput[]>(existing ? existing.steps.map((s) => ({ requiredRoleKey: s.requiredRoleKey, requiredUserId: s.requiredUserId })) : [{ requiredRoleKey: null, requiredUserId: null }])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const fields = error instanceof ApiError ? error.fieldErrors : {}

  const setStep = (idx: number, patch: Partial<ApprovalStepInput>) => setSteps(steps.map((s, i) => (i === idx ? { ...s, ...patch } : s)))
  const submit = () => {
    setBusy(true)
    setError(null)
    const input: SaveApprovalPolicyInput = {
      policyGroupId: existing?.policyGroupId ?? null, transactionType: 'purchase_request', name, minAmount: minAmount.trim() || null, currency: minAmount.trim() ? currency : null,
      preventSelfApproval, isActive, steps
    }
    call('approvals.savePolicy', input).then(onDone, setError).finally(() => setBusy(false))
  }
  return (
    <Dialog
      title={existing ? `Edit ${existing.name} (creates version ${existing.version + 1})` : 'New approval policy'}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !name.trim()} onClick={submit}>Save policy</Button></>}
    >
      <div className="stack">
        <ErrorAlert error={error} />
        {existing ? <p className="muted">Saving creates a new version. Requests already awaiting a decision keep following the version they started with.</p> : null}
        <TextField label="Policy name" value={name} onChange={(e) => setName(e.target.value)} error={fields['name']} />
        <div className="form-grid">
          <TextField label="Minimum amount to apply" value={minAmount} onChange={(e) => setMinAmount(e.target.value)} hint="Leave blank to apply at any amount" error={fields['minAmount']} />
          {minAmount.trim() ? <SelectField label="Currency" value={currency} onChange={setCurrency} options={['INR', 'USD', 'EUR', 'GBP'].map((c) => ({ value: c, label: c }))} /> : null}
        </div>
        <label className="checkbox"><input type="checkbox" checked={preventSelfApproval} onChange={(e) => setPreventSelfApproval(e.target.checked)} /> Prevent the requester from approving their own request</label>
        <label className="checkbox"><input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Active</label>
        <h3 className="section-title">Approval steps, in order</h3>
        {steps.map((s, idx) => (
          <div className="form-grid" key={idx}>
            <SelectField label={`Step ${idx + 1}: role`} value={s.requiredRoleKey ?? ''} placeholder="Not role-based" onChange={(v) => setStep(idx, { requiredRoleKey: v || null, requiredUserId: v ? null : s.requiredUserId })} options={roles.map((r) => ({ value: r.key, label: r.name }))} />
            <SelectField label="or named approver" value={s.requiredUserId ?? ''} placeholder="Not a named approver" onChange={(v) => setStep(idx, { requiredUserId: v || null, requiredRoleKey: v ? null : s.requiredRoleKey })} options={users.map((u) => ({ value: u.id, label: u.displayName }))} />
            {steps.length > 1 ? <Button small variant="quiet" onClick={() => setSteps(steps.filter((_, i) => i !== idx))}>Remove step</Button> : null}
          </div>
        ))}
        <Button small onClick={() => setSteps([...steps, { requiredRoleKey: null, requiredUserId: null }])}>Add step</Button>
      </div>
    </Dialog>
  )
}
