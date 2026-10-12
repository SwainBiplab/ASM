import { useEffect, useId, useState } from 'react'
import { FAULT_CATEGORY_LABELS, MAINTENANCE_PRIORITY_LABELS, TICKET_STATUS_LABELS, type TicketStatus } from '@shared/maintenance'
import type { AssetListItem } from '@shared/api'
import { call } from '../../api'
import { Button } from '../../components/ui'

export const priorityOptions = Object.entries(MAINTENANCE_PRIORITY_LABELS).map(([value, label]) => ({ value, label }))
export const categoryOptions = Object.entries(FAULT_CATEGORY_LABELS).map(([value, label]) => ({ value, label }))

export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  const cls = status === 'closed' ? 'badge--ok' : status === 'cancelled' ? 'badge--off' : status === 'open' ? 'badge--warn' : ''
  return <span className={`badge ${cls}`}>{TICKET_STATUS_LABELS[status]}</span>
}

export function PriorityBadge({ priority }: { priority: keyof typeof MAINTENANCE_PRIORITY_LABELS }) {
  const cls = priority === 'critical' || priority === 'high' ? 'badge--off' : priority === 'medium' ? 'badge--warn' : ''
  return <span className={`badge ${cls}`}>{MAINTENANCE_PRIORITY_LABELS[priority]}</span>
}

/** Active users who can be assigned tickets (maintenance.assign only). */
export function useTechnicians(): Array<{ id: string; displayName: string }> {
  const [list, setList] = useState<Array<{ id: string; displayName: string }>>([])
  useEffect(() => {
    call('maintenance.listTechnicians').then(setList, () => setList([]))
  }, [])
  return list
}

/** Finds one asset by code, serial number or QR scan; the caller decides what to do with it. */
export function AssetScanField({ label, onFound }: { label: string; onFound: (asset: AssetListItem) => void }) {
  const id = useId()
  const [text, setText] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const find = async () => {
    const query = text.trim()
    if (!query) return
    setMessage(null)
    try {
      const r = await call('assets.lookup', { query })
      if (r.matches.length !== 1) return setMessage(r.message)
      onFound(r.matches[0]!)
      setText('')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Lookup failed.')
    }
  }
  return (
    <div className="field field--wide">
      <label className="field__label" htmlFor={id}>{label}</label>
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
              void find()
            }
          }}
          placeholder="e.g. AST-000001, scan or type"
        />
        <Button onClick={() => void find()}>Find</Button>
      </div>
      {message ? <span className="field__error" role="alert">{message}</span> : null}
    </div>
  )
}
