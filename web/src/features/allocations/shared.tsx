import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react'
import {
  ACKNOWLEDGMENT_METHOD_LABELS,
  ASSIGNMENT_STATUS_LABELS,
  ASSIGNMENT_TARGET_TYPES,
  RETURN_OUTCOME_LABELS,
  TARGET_TYPE_LABELS,
  type AcknowledgmentPolicy,
  type AcknowledgmentStatus,
  type AssignmentStatus,
  type AssignmentTargetType
} from '@shared/allocations'
import type { AssetCustody, HandoverView, SessionInfo } from '@shared/api'
import { CONDITION_LABELS } from '@shared/assets'
import { apiUrl, call, downloadFile, formatDateTime, uploadFile } from '../../api'
import { useLatestOnly } from '../../hooks'
import { Alert, Button, ErrorAlert, SelectField, TextField, useToast } from '../../components/ui'
import { EmployeePicker, optionList } from '../organization/lookups'

export type Target = { type: AssignmentTargetType; id: string } | null

/** The organization's handover acknowledgment policy (Settings; default in-app). */
export function useAckPolicy(): AcknowledgmentPolicy | null {
  const [policy, setPolicy] = useState<AcknowledgmentPolicy | null>(null)
  useEffect(() => {
    call('settings.get').then((s) => setPolicy(s.handoverAcknowledgment), () => setPolicy('in_app'))
  }, [])
  return policy
}

export function AckBadge({ status }: { status: AcknowledgmentStatus }) {
  if (status === 'not_required') return null
  return <span className={`badge ${status === 'acknowledged' ? 'badge--ok' : 'badge--warn'}`}>{status === 'acknowledged' ? 'Acknowledged' : 'Acknowledgment pending'}</span>
}

export function AssignmentStatusBadge({ status }: { status: AssignmentStatus }) {
  return <span className={`badge ${status === 'active' ? 'badge--ok' : status === 'lost' ? 'badge--off' : ''}`}>{ASSIGNMENT_STATUS_LABELS[status]}</span>
}

/** Choose exactly one assignment target: employee, workstation, department, team or pool. */
export function TargetPicker({ value, onChange, error, excludeEmployeeId }: { value: Target; onChange: (t: Target) => void; error?: string | undefined; excludeEmployeeId?: string }) {
  const [type, setType] = useState<AssignmentTargetType>(value?.type ?? 'employee')
  const [options, setOptions] = useState<Array<{ value: string; label: string }>>([])
  const guardOptions = useLatestOnly()
  useEffect(() => {
    if (type === 'employee') return setOptions([])
    const load =
      type === 'workstation'
        ? call('workstations.list', {}).then((r) => optionList(r, (w) => `${w.code}${w.label ? ` (${w.label})` : ''} — ${w.locationPath}`))
        : type === 'department'
          ? call('departments.list', {}).then((r) => optionList(r, (d) => d.name))
          : type === 'team'
            ? call('teams.list', {}).then((r) => optionList(r, (t) => `${t.name} (${t.departmentName})`))
            : call('pools.list', {}).then((r) => optionList(r, (p) => p.name))
    guardOptions(load).then(setOptions, () => setOptions([]))
  }, [type])
  return (
    <>
      <SelectField
        label="Assign to"
        value={type}
        onChange={(v) => {
          setType(v as AssignmentTargetType)
          onChange(null)
        }}
        options={ASSIGNMENT_TARGET_TYPES.map((t) => ({ value: t, label: TARGET_TYPE_LABELS[t] }))}
      />
      {type === 'employee' ? (
        <EmployeePicker label="Employee" value={value?.type === 'employee' ? value.id : null} onChange={(id) => onChange(id ? { type: 'employee', id } : null)} error={error} {...(excludeEmployeeId ? { excludeId: excludeEmployeeId } : {})} />
      ) : (
        <SelectField label={TARGET_TYPE_LABELS[type]} value={value?.type === type ? value.id : ''} placeholder="Choose" onChange={(id) => onChange(id ? { type, id } : null)} options={options} error={error} />
      )}
    </>
  )
}

export interface PickedAsset {
  custody: AssetCustody
  label: string
}

/**
 * Adds assets by asset code, serial number or QR scan (USB scanners type and press Enter).
 * The server re-checks every asset when the handover is saved.
 */
export function AssetLinePicker({ mode, onAdd }: { mode: 'issue' | 'assigned'; onAdd: (a: PickedAsset) => void }) {
  const id = useId()
  const [text, setText] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const add = async () => {
    const query = text.trim()
    if (!query) return
    setMessage(null)
    try {
      const r = await call('assets.lookup', { query })
      if (r.matches.length !== 1) return setMessage(r.message)
      const m = r.matches[0]!
      const custody = await call('allocations.custody', { assetId: m.id })
      if (mode === 'issue' && !custody.eligibleForIssue) return setMessage(custody.ineligibleReason ?? `${m.assetCode} cannot be issued.`)
      if (mode === 'assigned' && !custody.currentAssignment) return setMessage(`${m.assetCode} is not currently assigned.`)
      onAdd({ custody, label: `${m.assetCode} — ${m.categoryName}${m.manufacturer || m.modelName ? `, ${[m.manufacturer, m.modelName].filter(Boolean).join(' ')}` : ''}` })
      setText('')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Lookup failed.')
    }
  }
  return (
    <div className="field field--wide">
      <label className="field__label" htmlFor={id}>Add asset (code, serial or scan)</label>
      <div className="chips">
        <input
          id={id}
          className="input"
          value={text}
          autoComplete="off"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void add()
            }
          }}
          placeholder="e.g. AST-000001"
        />
        <Button onClick={() => void add()}>Add</Button>
      </div>
      {message ? <span className="field__error" role="alert">{message}</span> : <span className="field__hint">Each asset is checked before it is added</span>}
    </div>
  )
}

export const conditionOptions = Object.entries(CONDITION_LABELS).map(([value, label]) => ({ value, label }))

/** On-screen confirmation fields, shown when the policy allows in-app acknowledgment. */
export function AckFields({ policy, confirmed, name, onChange, error }: { policy: AcknowledgmentPolicy; confirmed: boolean; name: string; onChange: (confirmed: boolean, name: string) => void; error?: string | undefined }) {
  if (policy === 'signed_receipt') {
    return <Alert tone="info">This organization records handovers with a signed receipt. After saving, print the receipt, have it signed, and attach the signed copy.</Alert>
  }
  return (
    <div className="stack">
      <label className="checkbox">
        <input type="checkbox" checked={confirmed} onChange={(e) => onChange(e.target.checked, name)} />
        The recipient (or the person responsible for the target) confirmed receipt on this screen
      </label>
      {confirmed ? <TextField label="Confirmed by (name)" value={name} onChange={(e) => onChange(confirmed, e.target.value)} error={error} hint="You are recorded as the witness" /> : null}
      {!confirmed && policy === 'in_app_or_signed' ? <p className="faint">Without on-screen confirmation the handover stays pending until a signed receipt is attached.</p> : null}
      {!confirmed && policy === 'in_app' && error ? <span className="field__error">{error}</span> : null}
    </div>
  )
}

export const ackPayload = (policy: AcknowledgmentPolicy, confirmed: boolean, name: string) => (policy !== 'signed_receipt' && confirmed ? { acknowledgedByName: name } : null)

/** Printable handover receipt with acknowledgment actions (on-screen confirmation or signed copy). */
export function HandoverReceipt({ handoverId, session, onClose }: { handoverId: string; session: SessionInfo; onClose: () => void }) {
  const [h, setH] = useState<HandoverView | null>(null)
  const [error, setError] = useState<unknown>(null)
  const toast = useToast()
  const [name, setName] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const has = (p: string) => session.permissions.includes(p as never)
  const canAcknowledge = has('allocations.issue') || has('allocations.transfer')
  const guard = useLatestOnly()
  const load = () => guard(call('allocations.getHandover', { handoverId })).then(setH, setError)
  useEffect(() => {
    void load()
  }, [handoverId])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const run = async (fn: () => Promise<unknown>, message: string) => {
    setError(null)
    try {
      await fn()
      toast.success(message)
      await load()
    } catch (err) {
      setError(err)
    }
  }
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) void run(() => uploadFile('/api/v1/uploads/documents', file, { entityType: 'handover', entityId: handoverId, purpose: 'handover' }), `Attached ${file.name}.`)
  }
  const title = h ? `${h.handoverType === 'issue' ? 'Asset issue' : h.handoverType === 'transfer' ? 'Asset transfer' : 'Asset return'} receipt ${h.handoverNumber}` : 'Handover receipt'
  return (
    <div className="label-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="label-overlay__bar no-print">
        <strong>{title}</strong>
        <span className="chips">
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" disabled={!h} onClick={() => window.print()}>Print</Button>
        </span>
      </div>
      <div className="stack receipt-actions no-print">
        <ErrorAlert error={error} />
        {h && h.acknowledgmentStatus === 'pending' && canAcknowledge ? (
          <div className="toolbar toolbar--flush">
            {h.acknowledgmentPolicy !== 'signed_receipt' ? (
              <>
                <TextField label="Confirmed by (name)" value={name} onChange={(e) => setName(e.target.value)} />
                <Button disabled={!name.trim()} onClick={() => void run(() => call('allocations.acknowledge', { handoverId, acknowledgedByName: name }), 'Acknowledgment recorded.')}>Record on-screen confirmation</Button>
              </>
            ) : null}
            {h.acknowledgmentPolicy !== 'in_app' ? (
              <>
                <input ref={fileInput} type="file" hidden accept=".pdf,.png,.jpg,.jpeg,.webp" data-testid="signed-receipt-file" onChange={onFile} />
                <Button onClick={() => fileInput.current?.click()}>Attach signed receipt</Button>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      {h ? (
        <article className="receipt print-area">
          <header>
            <p className="faint">{h.organizationName}</p>
            <h2>{title}</h2>
            <dl className="dl">
              <dt>Date</dt><dd>{formatDateTime(h.performedAt)}</dd>
              {h.targetLabel ? (<><dt>{h.handoverType === 'transfer' ? 'Transferred to' : 'Issued to'}</dt><dd>{h.targetType ? `${TARGET_TYPE_LABELS[h.targetType]}: ` : ''}{h.targetLabel}</dd></>) : null}
              {h.locationPath ? (<><dt>Location</dt><dd>{h.locationPath}</dd></>) : null}
              <dt>Handled by</dt><dd>{h.performedByName}</dd>
              {h.reason ? (<><dt>Reason</dt><dd>{h.reason}</dd></>) : null}
              {h.notes ? (<><dt>Notes</dt><dd>{h.notes}</dd></>) : null}
            </dl>
          </header>
          <table className="grid">
            <thead><tr><th>Asset</th><th>Description</th><th>Serial</th><th>Condition</th><th>{h.handoverType === 'return' ? 'Next state' : 'Accessories'}</th></tr></thead>
            <tbody>
              {h.items.map((i) => (
                <tr key={i.assetId}>
                  <td className="ident">{i.assetCode}</td>
                  <td>{i.categoryName}{i.makeModel ? `, ${i.makeModel}` : ''}</td>
                  <td className="ident">{i.serialNumber ?? '—'}</td>
                  <td>{CONDITION_LABELS[i.condition]}</td>
                  <td>{h.handoverType === 'return' ? (i.outcome ? RETURN_OUTCOME_LABELS[i.outcome] : '—') : (i.accessories ?? '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <section className="receipt__ack">
            {h.acknowledgmentStatus === 'acknowledged' ? (
              <p>
                <strong>Acknowledged</strong> — {h.acknowledgmentMethod ? ACKNOWLEDGMENT_METHOD_LABELS[h.acknowledgmentMethod] : ''}
                {h.acknowledgedByName ? ` by ${h.acknowledgedByName}` : ''} on {formatDateTime(h.acknowledgedAt)}, recorded by {h.acknowledgmentRecordedByName ?? '—'}.
              </p>
            ) : h.acknowledgmentStatus === 'pending' ? (
              <p><strong>Acknowledgment pending.</strong></p>
            ) : null}
            {h.handoverType !== 'return' ? (
              <div className="receipt__sign">
                <div>Received by (name and signature)</div>
                <div>Handed over by</div>
              </div>
            ) : null}
          </section>
          {h.documents.length ? (
            <section className="no-print">
              <h3 className="section-title">Attached evidence</h3>
              {h.documents.map((d) => (
                <div className="doc-row" key={d.linkId}>
                  <span>{d.originalName}</span>
                  <Button small variant="quiet" onClick={() => void run(() => downloadFile(apiUrl(`/api/v1/documents/${d.documentId}/content`), d.originalName), `Downloaded ${d.originalName}.`)}>Download</Button>
                </div>
              ))}
            </section>
          ) : null}
        </article>
      ) : null}
    </div>
  )
}
