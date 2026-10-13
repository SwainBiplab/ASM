import { useEffect, useState } from 'react'
import type { AuditEventView, Page } from '@shared/api'
import { call, formatDateTime } from '../../api'
import { Button, ErrorAlert, PageHeader, Panel, TextField } from '../../components/ui'
import { useLatestOnly } from '../../hooks'

const PAGE_SIZE = 50

/** Read-only view of the append-only audit trail. */
export function AuditLogPage() {
  const [page, setPage] = useState(1)
  const [eventType, setEventType] = useState('')
  const [data, setData] = useState<Page<AuditEventView> | null>(null)
  const [error, setError] = useState<unknown>(null)
  const guard = useLatestOnly()

  useEffect(() => {
    guard(call('audit.list', { page, pageSize: PAGE_SIZE, ...(eventType.trim() ? { eventType: eventType.trim() } : {}) })).then(setData, setError)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, eventType])

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1

  return (
    <div className="stack">
      <PageHeader title="Audit log" description="Every critical change, with who made it and when. Entries cannot be edited or deleted." />
      <ErrorAlert error={error} />
      <Panel
        flush
        title={data ? `${data.total} events` : 'Events'}
        actions={
          <TextField
            label="Event type"
            placeholder="e.g. user.created"
            value={eventType}
            onChange={(e) => {
              setPage(1)
              setEventType(e.target.value)
            }}
          />
        }
      >
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th>When</th>
                <th>Event</th>
                <th>By</th>
                <th>Record</th>
                <th>Details</th>
                <th>Reference</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((e) => (
                <tr key={e.id}>
                  <td className="num">{formatDateTime(e.occurredAt)}</td>
                  <td>{e.eventType}</td>
                  <td>{e.actorName ?? <span className="faint">System / unknown</span>}</td>
                  <td>{e.entityType}</td>
                  <td className="muted">
                    {e.reason ? <div>Reason: {e.reason}</div> : null}
                    {e.summary ? <div className="faint">{summarize(e.summary)}</div> : null}
                  </td>
                  <td className="ident faint">{e.correlationId}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && data.items.length === 0 ? <div className="empty">No events match this filter.</div> : null}
        </div>
        <div className="pager">
          <span className="faint">
            Page {page} of {pages}
          </span>
          <Button small disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
          <Button small disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
        </div>
      </Panel>
    </div>
  )
}

function summarize(summary: Record<string, unknown>): string {
  const text = JSON.stringify(summary)
  return text.length > 160 ? `${text.slice(0, 157)}…` : text
}
