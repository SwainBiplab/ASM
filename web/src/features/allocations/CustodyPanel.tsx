import { useCallback, useEffect, useState } from 'react'
import { MOVEMENT_LABELS, RETURN_OUTCOME_LABELS, TARGET_TYPE_LABELS } from '@shared/allocations'
import type { AssetCustody, SessionInfo } from '@shared/api'
import { CONDITION_LABELS } from '@shared/assets'
import { call, formatDateTime } from '../../api'
import { Alert, Button, ErrorAlert } from '../../components/ui'
import { useLatestOnly } from '../../hooks'
import { InspectDialog, IssueDialog, ReportLostDialog, ReturnDialog, TransferDialog } from './dialogs'
import { AckBadge, AssignmentStatusBadge, HandoverReceipt } from './shared'
import { CreateTicketDialog } from '../maintenance/MaintenancePage'

type Open = 'issue' | 'transfer' | 'return' | 'inspect' | 'lost' | null

/** Current assignment, custody actions and chain of custody for one asset (asset detail). */
export function CustodyPanel({ assetId, assetCode, categoryName, assetLabel, session, onChanged }: { assetId: string; assetCode: string; categoryName: string; assetLabel: string; session: SessionInfo; onChanged: () => void }) {
  const has = (p: string) => session.permissions.includes(p as never)
  const [c, setC] = useState<AssetCustody | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [open, setOpen] = useState<Open>(null)
  const [receipt, setReceipt] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [faultPrompt, setFaultPrompt] = useState(false)
  const [reportingFault, setReportingFault] = useState(false)
  const canView = has('allocations.view')
  const guard = useLatestOnly()
  const load = useCallback(() => {
    if (!canView) return
    setError(null)
    guard(call('allocations.custody', { assetId })).then(setC, setError)
  }, [assetId, canView])
  useEffect(load, [load])
  if (!canView) return null
  const done = (message: string, handoverId?: string) => {
    setOpen(null)
    setNotice(message)
    if (handoverId) setReceipt(handoverId)
    load()
    onChanged()
  }
  const picked = c ? { custody: c, label: assetLabel } : undefined
  const active = c?.lifecycleStatus === 'active'
  return (
    <section className="custody" aria-label="Custody">
      <h3 className="section-title">Custody</h3>
      <ErrorAlert error={error} onRetry={load} />
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {c ? (
        <div className="stack">
          {c.currentAssignment ? (
            <dl className="dl">
              <dt>Assigned to</dt>
              <dd>
                {TARGET_TYPE_LABELS[c.currentAssignment.targetType]}: <strong>{c.currentAssignment.targetLabel}</strong> <AckBadge status={c.currentAssignment.acknowledgmentStatus} />
                {c.currentAssignment.overdue ? <span className="badge badge--off">Overdue</span> : null}
              </dd>
              <dt>Since</dt><dd>{formatDateTime(c.currentAssignment.assignedAt)} ({c.currentAssignment.issueHandoverNumber})</dd>
              {c.currentAssignment.expectedReturnDate ? (<><dt>Expected return</dt><dd>{c.currentAssignment.expectedReturnDate}</dd></>) : null}
            </dl>
          ) : (
            <p className="muted">{c.eligibleForIssue ? 'Not assigned. Ready to issue.' : `Not assigned. ${c.ineligibleReason ?? ''}`}</p>
          )}
          <div className="chips">
            {has('allocations.issue') && c.eligibleForIssue ? <Button small onClick={() => setOpen('issue')}>Issue</Button> : null}
            {has('allocations.transfer') && c.currentAssignment ? <Button small onClick={() => setOpen('transfer')}>Transfer</Button> : null}
            {has('allocations.return') && c.currentAssignment ? <Button small onClick={() => setOpen('return')}>Return</Button> : null}
            {has('allocations.inspect') && active && c.operationalStatus === 'awaiting_inspection' ? <Button small onClick={() => setOpen('inspect')}>Record inspection</Button> : null}
            {has('assets.retire') && active && c.currentAssignment ? <Button small variant="danger" onClick={() => setOpen('lost')}>Report lost</Button> : null}
            {c.currentAssignment ? <Button small variant="quiet" onClick={() => setReceipt(c.currentAssignment!.issueHandoverId)}>Handover receipt</Button> : null}
          </div>
          {c.assignments.length ? (
            <div className="table-wrap">
              <table className="grid" aria-label="Assignment history">
                <thead><tr><th>Target</th><th>From</th><th>To</th><th>Status</th><th>Return</th></tr></thead>
                <tbody>
                  {c.assignments.map((s) => (
                    <tr key={s.id}>
                      <td>{TARGET_TYPE_LABELS[s.targetType]}: {s.targetLabel}</td>
                      <td>{formatDateTime(s.assignedAt)}</td>
                      <td>{s.endedAt ? formatDateTime(s.endedAt) : '—'}</td>
                      <td><AssignmentStatusBadge status={s.status} /></td>
                      <td>
                        {s.conditionAtReturn ? CONDITION_LABELS[s.conditionAtReturn] : ''}
                        {s.returnOutcome ? `, ${RETURN_OUTCOME_LABELS[s.returnOutcome].toLowerCase()}` : ''}
                        {s.endReason ? <div className="faint">{s.endReason}</div> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {c.movements.length ? (
            <ul className="history" aria-label="Movements">
              {c.movements.map((m) => (
                <li key={m.id}>
                  <strong>{MOVEMENT_LABELS[m.movementType]}</strong> {m.targetLabel ? `— ${m.targetLabel} ` : ''}
                  <span className="faint">{formatDateTime(m.occurredAt)} by {m.actorName ?? 'system'}{m.handoverNumber ? `, ${m.handoverNumber}` : ''}</span>
                  {m.notes ? <div className="muted">{m.notes}</div> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {open === 'issue' && picked ? <IssueDialog initial={picked} onClose={() => setOpen(null)} onDone={(h) => done(`Issued under ${h.handoverNumber}.`, h.id)} /> : null}
      {open === 'transfer' && picked ? <TransferDialog initial={picked} onClose={() => setOpen(null)} onDone={(h) => done(`Transferred under ${h.handoverNumber}.`, h.id)} /> : null}
      {open === 'return' && picked ? (
        <ReturnDialog
          initial={picked}
          session={session}
          onClose={() => setOpen(null)}
          onDone={(h) => {
            done(`Return recorded under ${h.handoverNumber}.`)
            if (h.items.some((i) => i.outcome === 'non_operational')) setFaultPrompt(true)
          }}
        />
      ) : null}
      {open === 'inspect' && c ? (
        <InspectDialog
          custody={c}
          onClose={() => setOpen(null)}
          onDone={(updated) => {
            done('Inspection recorded.')
            // A fault found during inspection can be reported immediately, without losing the link to it (TAS §6.4/§11).
            if (updated.operationalStatus === 'non_operational') setFaultPrompt(true)
          }}
        />
      ) : null}
      {open === 'lost' && c ? <ReportLostDialog custody={c} onClose={() => setOpen(null)} onDone={() => done(`${c.assetCode} was reported lost.`)} /> : null}
      {receipt ? <HandoverReceipt handoverId={receipt} session={session} onClose={() => setReceipt(null)} /> : null}
      {faultPrompt && has('maintenance.create') ? (
        <Alert tone="warn">
          This inspection found a fault.{' '}
          <Button small onClick={() => { setFaultPrompt(false); setReportingFault(true) }}>Report a fault now</Button>{' '}
          <Button small variant="quiet" onClick={() => setFaultPrompt(false)}>Not now</Button>
        </Alert>
      ) : null}
      {reportingFault ? (
        <CreateTicketDialog
          presetAsset={{ id: assetId, assetCode, categoryName }}
          defaultDescription="Found non-operational during inspection"
          onClose={() => setReportingFault(false)}
          onDone={() => {
            setReportingFault(false)
            setNotice('Maintenance ticket opened.')
            load()
            onChanged()
          }}
        />
      ) : null}
    </section>
  )
}
