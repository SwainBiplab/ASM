import { useEffect, useState } from 'react'
import { AUDIT_ITEM_STATUS_LABELS, AUDIT_STATUS_LABELS, DISCREPANCY_TYPE_LABELS, type AuditItemStatus, type AuditStatus, type DiscrepancyType } from '@shared/audits'
import { call } from '../../api'

/** Active users who can investigate discrepancies (audits.resolve/manage/close only). */
export function useReviewers(): Array<{ id: string; displayName: string }> {
  const [list, setList] = useState<Array<{ id: string; displayName: string }>>([])
  useEffect(() => {
    call('audits.listReviewers').then(setList, () => setList([]))
  }, [])
  return list
}

export function AuditStatusBadge({ status }: { status: AuditStatus }) {
  const cls = status === 'closed' ? 'badge--ok' : status === 'open' ? 'badge--warn' : 'badge--off'
  return <span className={`badge ${cls}`}>{AUDIT_STATUS_LABELS[status]}</span>
}

export function ItemStatusBadge({ status }: { status: AuditItemStatus }) {
  const cls = status === 'verified' ? 'badge--ok' : status === 'accepted' || status === 'resolved' ? '' : status === 'pending' ? 'badge--warn' : 'badge--off'
  return <span className={`badge ${cls}`}>{AUDIT_ITEM_STATUS_LABELS[status]}</span>
}

export const discrepancyLabel = (t: DiscrepancyType | null): string => (t ? DISCREPANCY_TYPE_LABELS[t] : '—')
