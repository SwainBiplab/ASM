import { useEffect, useState } from 'react'
import type { MaintenanceTicketSummary, Page } from '@shared/api'
import { call, formatDateTime } from '../../api'
import { ErrorAlert } from '../../components/ui'
import { PriorityBadge, TicketStatusBadge } from './shared'

/** Maintenance history for one asset, shown on the asset's detail page (TAS §11.1). */
export function AssetMaintenanceSection({ assetId, navigate }: { assetId: string; navigate: (route: string) => void }) {
  const [data, setData] = useState<Page<MaintenanceTicketSummary> | null>(null)
  const [denied, setDenied] = useState(false)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    call('maintenance.list', { assetId, status: 'all', page: 1, pageSize: 50 }).then(setData, (err) => {
      setError(err)
      setDenied(true)
    })
  }, [assetId])
  if (denied) return null
  return (
    <section aria-label="Maintenance history">
      <h3 className="section-title">Maintenance ({data?.total ?? '…'})</h3>
      <ErrorAlert error={error} />
      {data && data.items.length === 0 ? <p className="faint">No maintenance tickets for this asset.</p> : null}
      {data?.items.map((t) => (
        <div className="doc-row" key={t.id}>
          <span>
            <button className="link-btn" onClick={() => navigate(`maintenance/${t.id}`)}>{t.ticketNumber}</button>{' '}
            <span className="faint">{t.faultCategory}, {formatDateTime(t.reportedAt)}</span>
          </span>
          <span className="chips"><PriorityBadge priority={t.priority} /><TicketStatusBadge status={t.status} /></span>
        </div>
      ))}
    </section>
  )
}
