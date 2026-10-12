import { useState } from 'react'
import { INSPECTION_OUTCOMES, RETURN_OUTCOME_LABELS, RETURN_OUTCOMES, type ReturnOutcome } from '@shared/allocations'
import type { AssetCustody, HandoverView, SessionInfo } from '@shared/api'
import type { AssetCondition } from '@shared/assets'
import { ApiError, call } from '../../api'
import { Button, Dialog, ErrorAlert, SelectField, TextAreaField, TextField } from '../../components/ui'
import { useOrgLookups, optionList } from '../organization/lookups'
import { AckFields, ackPayload, AssetLinePicker, conditionOptions, TargetPicker, useAckPolicy, type PickedAsset, type Target } from './shared'

interface Line {
  picked: PickedAsset
  condition: AssetCondition
  accessories: string
  outcome: ReturnOutcome
  notes: string
}
const toLine = (picked: PickedAsset): Line => ({ picked, condition: picked.custody.currentAssignment?.conditionAtIssue ?? 'good', accessories: '', outcome: 'awaiting_inspection', notes: '' })
const n = (v: string) => (v.trim() ? v.trim() : null)

function LineList({ lines, setLines, mode, canInspect }: { lines: Line[]; setLines: (l: Line[]) => void; mode: 'handover' | 'return'; canInspect: boolean }) {
  const update = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  if (!lines.length) return <p className="faint">No assets added yet.</p>
  return (
    <div className="stack">
      {lines.map((l, i) => (
        <div className="panel panel__body" key={l.picked.custody.assetId} data-testid="handover-line">
          <div className="chips">
            <strong className="ident">{l.picked.label}</strong>
            {l.picked.custody.currentAssignment ? <span className="faint">with {l.picked.custody.currentAssignment.targetLabel}</span> : null}
            <Button small variant="quiet" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</Button>
          </div>
          <div className="form-grid">
            <SelectField label="Condition" value={l.condition} onChange={(v) => update(i, { condition: v as AssetCondition })} options={conditionOptions} />
            {mode === 'handover' ? (
              <TextField label="Accessories" value={l.accessories} onChange={(e) => update(i, { accessories: e.target.value })} hint="e.g. charger, bag" />
            ) : (
              <>
                <SelectField
                  label="After return"
                  value={l.outcome}
                  onChange={(v) => update(i, { outcome: v as ReturnOutcome })}
                  options={RETURN_OUTCOMES.filter((o) => o !== 'ready' || canInspect).map((o) => ({ value: o, label: RETURN_OUTCOME_LABELS[o] }))}
                  hint={canInspect ? 'Choose "ready" only after inspecting it' : 'Returned assets are inspected before reuse'}
                />
                <TextField label="Accessories returned" value={l.accessories} onChange={(e) => update(i, { accessories: e.target.value })} />
                <TextField label="Observations" value={l.notes} onChange={(e) => update(i, { notes: e.target.value })} />
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function useSave<T>(onDone: (r: T) => void) {
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const fields = error instanceof ApiError ? error.fieldErrors : {}
  const save = async (fn: () => Promise<T>) => {
    setBusy(true)
    setError(null)
    try {
      onDone(await fn())
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  return { error, busy, fields, save }
}

export function IssueDialog({ initial, onClose, onDone }: { initial?: PickedAsset; onClose: () => void; onDone: (h: HandoverView) => void }) {
  const policy = useAckPolicy()
  const { locations } = useOrgLookups()
  const [target, setTarget] = useState<Target>(null)
  const [lines, setLines] = useState<Line[]>(initial ? [toLine(initial)] : [])
  const [locationId, setLocationId] = useState('')
  const [expected, setExpected] = useState('')
  const [notes, setNotes] = useState('')
  const [ack, setAck] = useState({ confirmed: false, name: '' })
  const { error, busy, fields, save } = useSave(onDone)
  const submit = () =>
    save(() =>
      call('allocations.issue', {
        target: target ?? { type: 'employee', id: '' },
        lines: lines.map((l) => ({ assetId: l.picked.custody.assetId, condition: l.condition, accessories: n(l.accessories) })),
        locationId: locationId || null,
        expectedReturnDate: expected || null,
        notes: n(notes),
        acknowledgment: policy ? ackPayload(policy, ack.confirmed, ack.name) : null
      })
    )
  return (
    <Dialog title="Issue assets" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !target || !lines.length || !policy} onClick={() => void submit()}>{busy ? 'Saving…' : 'Issue'}</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <div className="form-grid">
          <TargetPicker value={target} onChange={setTarget} error={fields['target']} />
          <SelectField label="Physical location" value={locationId} placeholder="Keep current / workstation's location" onChange={setLocationId} options={optionList(locations, (l) => l.path)} />
          <TextField label="Expected return" type="date" value={expected} onChange={(e) => setExpected(e.target.value)} error={fields['expectedReturnDate']} hint="Optional" />
        </div>
        <AssetLinePicker mode="issue" onAdd={(p) => !lines.some((l) => l.picked.custody.assetId === p.custody.assetId) && setLines([...lines, toLine(p)])} />
        <LineList lines={lines} setLines={setLines} mode="handover" canInspect={false} />
        <TextAreaField label="Notes" value={notes} onChange={setNotes} />
        {policy ? <AckFields policy={policy} confirmed={ack.confirmed} name={ack.name} onChange={(confirmed, name) => setAck({ confirmed, name })} error={fields['acknowledgment'] ?? fields['acknowledgment.acknowledgedByName']} /> : null}
      </div>
    </Dialog>
  )
}

export function TransferDialog({ initial, onClose, onDone }: { initial?: PickedAsset; onClose: () => void; onDone: (h: HandoverView) => void }) {
  const policy = useAckPolicy()
  const { locations } = useOrgLookups()
  const [target, setTarget] = useState<Target>(null)
  const [lines, setLines] = useState<Line[]>(initial ? [toLine(initial)] : [])
  const [locationId, setLocationId] = useState('')
  const [expected, setExpected] = useState('')
  const [reason, setReason] = useState('')
  const [ack, setAck] = useState({ confirmed: false, name: '' })
  const { error, busy, fields, save } = useSave(onDone)
  const submit = () =>
    save(() =>
      call('allocations.transfer', {
        target: target ?? { type: 'employee', id: '' },
        lines: lines.map((l) => ({ assetId: l.picked.custody.assetId, condition: l.condition, accessories: n(l.accessories) })),
        locationId: locationId || null,
        expectedReturnDate: expected || null,
        reason,
        acknowledgment: policy ? ackPayload(policy, ack.confirmed, ack.name) : null
      })
    )
  return (
    <Dialog title="Transfer assets" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !target || !lines.length || !reason.trim() || !policy} onClick={() => void submit()}>{busy ? 'Saving…' : 'Transfer'}</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <p className="muted">The current assignment is closed and a new one is opened; both stay in the asset's history.</p>
        <div className="form-grid">
          <TargetPicker value={target} onChange={setTarget} error={fields['target']} />
          <SelectField label="Physical location" value={locationId} placeholder="Keep current / workstation's location" onChange={setLocationId} options={optionList(locations, (l) => l.path)} />
          <TextField label="Expected return" type="date" value={expected} onChange={(e) => setExpected(e.target.value)} hint="Optional" />
          <TextField label="Reason for transfer" value={reason} onChange={(e) => setReason(e.target.value)} error={fields['reason']} hint="Required" />
        </div>
        <AssetLinePicker mode="assigned" onAdd={(p) => !lines.some((l) => l.picked.custody.assetId === p.custody.assetId) && setLines([...lines, toLine(p)])} />
        <LineList lines={lines} setLines={setLines} mode="handover" canInspect={false} />
        {policy ? <AckFields policy={policy} confirmed={ack.confirmed} name={ack.name} onChange={(confirmed, name) => setAck({ confirmed, name })} error={fields['acknowledgment']} /> : null}
      </div>
    </Dialog>
  )
}

export function ReturnDialog({ initial, session, onClose, onDone }: { initial?: PickedAsset; session: SessionInfo; onClose: () => void; onDone: (h: HandoverView) => void }) {
  const { locations } = useOrgLookups()
  const canInspect = session.permissions.includes('allocations.inspect')
  const [lines, setLines] = useState<Line[]>(initial ? [toLine(initial)] : [])
  const [locationId, setLocationId] = useState('')
  const [notes, setNotes] = useState('')
  const { error, busy, save } = useSave(onDone)
  const submit = () =>
    save(() =>
      call('allocations.return', {
        lines: lines.map((l) => ({ assetId: l.picked.custody.assetId, condition: l.condition, outcome: l.outcome, accessoriesReturned: n(l.accessories), notes: n(l.notes) })),
        returnLocationId: locationId || null,
        notes: n(notes)
      })
    )
  return (
    <Dialog title="Receive returned assets" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !lines.length} onClick={() => void submit()}>{busy ? 'Saving…' : 'Record return'}</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <div className="form-grid">
          <SelectField label="Returned to (location)" value={locationId} placeholder="Keep current location" onChange={setLocationId} options={optionList(locations, (l) => l.path)} />
        </div>
        <AssetLinePicker mode="assigned" onAdd={(p) => !lines.some((l) => l.picked.custody.assetId === p.custody.assetId) && setLines([...lines, toLine(p)])} />
        <LineList lines={lines} setLines={setLines} mode="return" canInspect={canInspect} />
        <TextAreaField label="Notes" value={notes} onChange={setNotes} />
      </div>
    </Dialog>
  )
}

export function InspectDialog({ custody, onClose, onDone }: { custody: AssetCustody; onClose: () => void; onDone: (c: AssetCustody) => void }) {
  const [outcome, setOutcome] = useState<(typeof INSPECTION_OUTCOMES)[number]>('ready')
  const [condition, setCondition] = useState<AssetCondition>('good')
  const [notes, setNotes] = useState('')
  const { error, busy, fields, save } = useSave(onDone)
  return (
    <Dialog title={`Inspect ${custody.assetCode}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !notes.trim()} onClick={() => void save(() => call('allocations.inspect', { assetId: custody.assetId, outcome, condition, notes }))}>Record inspection</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        <div className="form-grid">
          <SelectField label="Result" value={outcome} onChange={(v) => setOutcome(v as typeof outcome)} options={INSPECTION_OUTCOMES.map((o) => ({ value: o, label: RETURN_OUTCOME_LABELS[o] }))} error={fields['outcome']} />
          <SelectField label="Condition" value={condition} onChange={(v) => setCondition(v as AssetCondition)} options={conditionOptions} />
        </div>
        <TextAreaField label="Inspection notes" value={notes} onChange={setNotes} hint="Required. Recorded in the asset history." />
      </div>
    </Dialog>
  )
}

export function ReportLostDialog({ custody, onClose, onDone }: { custody: AssetCustody; onClose: () => void; onDone: (c: AssetCustody) => void }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [reason, setReason] = useState('')
  const { error, busy, save } = useSave(onDone)
  return (
    <Dialog title={`Report ${custody.assetCode} lost`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" disabled={busy || !reason.trim()} onClick={() => void save(() => call('allocations.reportLost', { assetId: custody.assetId, effectiveDate: date, reason }))}>Report lost</Button></>}>
      <div className="stack">
        <ErrorAlert error={error} />
        {custody.currentAssignment ? <p className="muted">The assignment to {custody.currentAssignment.targetLabel} ends as "reported lost". You are recorded as the responsible person; attach evidence (police report, statement) to the asset's documents.</p> : null}
        <div className="form-grid">
          <TextField label="Date lost" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <TextAreaField label="Reason" value={reason} onChange={setReason} hint="Required. Recorded in the asset history and audit log." />
      </div>
    </Dialog>
  )
}
