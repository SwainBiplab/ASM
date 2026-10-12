import type { NavItem } from '../../app/navigation'
import { PageHeader, Panel } from '../../components/ui'

/** Honest placeholder for modules scheduled in later milestones — no demonstration data. */
export function PendingModule({ item }: { item: NavItem }) {
  return (
    <div className="pending">
      <PageHeader title={item.label} description="This module is not available in this build yet." />
      <Panel title={`Planned for milestone ${item.pendingMilestone ?? '—'}`}>
        <p className="muted">It will cover:</p>
        <ul>{item.pendingScope?.map((s) => <li key={s}>{s}</li>)}</ul>
      </Panel>
    </div>
  )
}
