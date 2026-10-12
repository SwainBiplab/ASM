import { useEffect, useMemo, useState } from 'react'
import type { AssignmentView, CategoryView, DashboardSummary, MaintenanceTicketSummary, SessionInfo } from '@shared/api'
import { call } from '../../api'
import { ErrorAlert, PageHeader } from '../../components/ui'

interface DonutSegment {
  key: string
  label: string
  value: number
  color: string
}

export function DashboardPage({ navigate }: { session: SessionInfo; navigate: (id: string) => void }) {
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [categories, setCategories] = useState<CategoryView[]>([])
  const [recentTickets, setRecentTickets] = useState<MaintenanceTicketSummary[]>([])
  const [recentAllocations, setRecentAllocations] = useState<AssignmentView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [categoryDomainTab, setCategoryDomainTab] = useState<'all' | 'it' | 'facilities'>('all')
  const [hoveredSegment, setHoveredSegment] = useState<DonutSegment | null>(null)

  const load = () => {
    setError(null)
    setLoading(true)
    Promise.allSettled([
      call('dashboard.getSummary'),
      call('categories.list', { includeInactive: false }),
      call('maintenance.list', { page: 1, pageSize: 4 }),
      call('allocations.list', { page: 1, pageSize: 4 })
    ])
      .then(([sumRes, catRes, maintRes, allocRes]) => {
        if (sumRes.status === 'fulfilled') setSummary(sumRes.value)
        else setError(sumRes.reason)

        if (catRes.status === 'fulfilled') setCategories(catRes.value)
        if (maintRes.status === 'fulfilled') setRecentTickets(maintRes.value.items)
        if (allocRes.status === 'fulfilled') setRecentAllocations(allocRes.value.items)
      })
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  // Calculations for KPI Cards and Donut Chart
  const totalAssets = summary?.assets?.totalActive ?? 0
  const assigned = summary?.assets?.assigned ?? 0
  const available = summary?.assets?.available ?? 0
  const underMaintenance = summary?.assets?.underMaintenance ?? 0
  const awaitingInspection = summary?.assets?.awaitingInspection ?? 0
  const nonOperational = summary?.assets?.nonOperational ?? 0

  const deploymentRate = totalAssets > 0 ? Math.round((assigned / totalAssets) * 100) : 0
  const readyRate = totalAssets > 0 ? Math.round(((assigned + available) / totalAssets) * 1000) / 10 : 100

  // Donut Segments
  const donutSegments: DonutSegment[] = useMemo(() => {
    return [
      { key: 'available', label: 'Available to Issue', value: available, color: '#10b981' },
      { key: 'assigned', label: 'Assigned / In Custody', value: assigned, color: '#2563eb' },
      { key: 'maintenance', label: 'Under Maintenance', value: underMaintenance, color: '#f59e0b' },
      { key: 'inspection', label: 'Awaiting Inspection', value: awaitingInspection, color: '#8b5cf6' },
      { key: 'damaged', label: 'Non-Operational', value: nonOperational, color: '#ef4444' }
    ].filter((s) => s.value > 0)
  }, [available, assigned, underMaintenance, awaitingInspection, nonOperational])

  // Donut SVG circumference calculation
  const radius = 70
  const circumference = 2 * Math.PI * radius
  let currentOffset = 0
  const donutCalculated = donutSegments.map((seg) => {
    const fraction = totalAssets > 0 ? seg.value / totalAssets : 0
    const strokeDash = fraction * circumference
    const strokeOffset = currentOffset
    currentOffset += strokeDash
    return {
      ...seg,
      percentage: Math.round(fraction * 100),
      strokeDash,
      strokeOffset
    }
  })

  // Category distribution calculation
  const filteredCategories = useMemo(() => {
    let list = [...categories].filter((c) => (c.assetCount ?? 0) > 0)
    if (categoryDomainTab !== 'all') {
      list = list.filter((c) => c.assetDomain === categoryDomainTab)
    }
    return list.sort((a, b) => (b.assetCount ?? 0) - (a.assetCount ?? 0)).slice(0, 7)
  }, [categories, categoryDomainTab])

  const maxCategoryCount = useMemo(() => {
    return filteredCategories.reduce((max, c) => Math.max(max, c.assetCount ?? 0), 1)
  }, [filteredCategories])

  // Domain breakdown
  const itAssetCount = useMemo(() => {
    return categories.filter((c) => c.assetDomain === 'it').reduce((acc, c) => acc + (c.assetCount ?? 0), 0)
  }, [categories])

  const facAssetCount = useMemo(() => {
    return categories.filter((c) => c.assetDomain === 'facilities').reduce((acc, c) => acc + (c.assetCount ?? 0), 0)
  }, [categories])

  const totalDomainAssets = itAssetCount + facAssetCount || 1
  const itPercentage = Math.round((itAssetCount / totalDomainAssets) * 100)
  const facPercentage = 100 - itPercentage

  return (
    <div className="dash-container">
      <PageHeader
        title={summary?.organizationName ? `${summary.organizationName} — Asset Operations` : 'Operations Dashboard'}
        description="Real-time operational figures, equipment custody health, and maintenance status."
      />

      <ErrorAlert error={error} onRetry={load} />

      {/* Quick Actions & Shortcut Ribbon */}
      <div className="dash-actions-bar">
        <div className="dash-actions-group">
          <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--ink-soft)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Quick Actions:
          </span>
          <button className="dash-chip-btn dash-chip-btn--primary" onClick={() => navigate('assets')}>
            Browse 563 Assets
          </button>
          <button className="dash-chip-btn" onClick={() => navigate('allocations')}>
            Issue / Return Equipment
          </button>
          <button className="dash-chip-btn" onClick={() => navigate('scan')}>
            Scan / Lookup Barcode
          </button>
          <button className="dash-chip-btn" onClick={() => navigate('maintenance')}>
            Maintenance Tickets
          </button>
          <button className="dash-chip-btn" onClick={() => navigate('employees')}>
            Staff Directory
          </button>
        </div>
        <button
          className="dash-chip-btn"
          style={{ background: 'transparent', borderColor: 'transparent' }}
          onClick={load}
          title="Refresh statistics"
        >
          {loading ? 'Refreshing…' : '↻ Refresh Data'}
        </button>
      </div>

      {/* High-Impact Interactive KPI Stat Cards */}
      <div className="dash-kpi-grid">
        <div
          className="dash-kpi-card"
          style={{ '--kpi-accent': '#2563eb', '--kpi-icon-bg': 'rgba(37,99,235,0.1)' } as React.CSSProperties}
          onClick={() => navigate('assets')}
          title="Click to view all assets"
        >
          <div className="dash-kpi-card__top">
            <span className="dash-kpi-card__title">Total Assets</span>
            <span className="dash-kpi-card__icon">📦</span>
          </div>
          <div className="dash-kpi-card__value">{totalAssets}</div>
          <div className="dash-kpi-card__sub">
            <span className="dash-kpi-card__badge" style={{ background: 'rgba(37,99,235,0.12)', color: '#2563eb' }}>
              ✓ Active Register
            </span>
            <span>Office No-515</span>
          </div>
        </div>

        <div
          className="dash-kpi-card"
          style={{ '--kpi-accent': '#10b981', '--kpi-icon-bg': 'rgba(16,185,129,0.1)' } as React.CSSProperties}
          onClick={() => navigate('assets')}
          title="Click to view available inventory"
        >
          <div className="dash-kpi-card__top">
            <span className="dash-kpi-card__title">Available to Issue</span>
            <span className="dash-kpi-card__icon">⚡</span>
          </div>
          <div className="dash-kpi-card__value">{available}</div>
          <div className="dash-kpi-card__sub">
            <span className="dash-kpi-card__badge" style={{ background: 'rgba(16,185,129,0.12)', color: '#10b981' }}>
              {100 - deploymentRate}% ready
            </span>
            <span>Unassigned inventory</span>
          </div>
        </div>

        <div
          className="dash-kpi-card"
          style={{ '--kpi-accent': '#8b5cf6', '--kpi-icon-bg': 'rgba(139,92,246,0.1)' } as React.CSSProperties}
          onClick={() => navigate('allocations')}
          title="Click to view active allocations"
        >
          <div className="dash-kpi-card__top">
            <span className="dash-kpi-card__title">In Custody / Assigned</span>
            <span className="dash-kpi-card__icon">👤</span>
          </div>
          <div className="dash-kpi-card__value">{assigned}</div>
          <div className="dash-kpi-card__sub">
            <span className="dash-kpi-card__badge" style={{ background: 'rgba(139,92,246,0.12)', color: '#8b5cf6' }}>
              {deploymentRate}% deployed
            </span>
            <span>To staff & desks</span>
          </div>
        </div>

        <div
          className="dash-kpi-card"
          style={{ '--kpi-accent': '#f59e0b', '--kpi-icon-bg': 'rgba(245,158,11,0.1)' } as React.CSSProperties}
          onClick={() => navigate('maintenance')}
          title="Click to view maintenance tickets"
        >
          <div className="dash-kpi-card__top">
            <span className="dash-kpi-card__title">Operational Health</span>
            <span className="dash-kpi-card__icon">🛠️</span>
          </div>
          <div className="dash-kpi-card__value">{readyRate}%</div>
          <div className="dash-kpi-card__sub">
            {underMaintenance > 0 ? (
              <span className="dash-kpi-card__badge" style={{ background: 'rgba(245,158,11,0.15)', color: '#d97706' }}>
                {underMaintenance} under repair
              </span>
            ) : (
              <span className="dash-kpi-card__badge" style={{ background: 'rgba(16,185,129,0.12)', color: '#10b981' }}>
                All systems functional
              </span>
            )}
            <span>2 faulty monitors</span>
          </div>
        </div>
      </div>

      {/* Main Interactive Graphs Grid */}
      <div className="dash-grid-2col">
        {/* Interactive Asset Custody Status Donut Chart */}
        <section className="dash-panel">
          <div className="dash-panel__header">
            <div>
              <h2>Asset Status & Lifecycle Distribution</h2>
              <p>Hover over slices to see detailed counts and percentages</p>
            </div>
            <button className="dash-chip-btn" onClick={() => navigate('assets')} style={{ fontSize: '11px', padding: '4px 10px' }}>
              View All
            </button>
          </div>
          <div className="dash-panel__body">
            <div className="donut-wrapper">
              <div className="donut-svg-box">
                <svg className="donut-svg" viewBox="0 0 200 200" aria-label="Asset status donut chart">
                  <circle cx="100" cy="100" r={radius} fill="none" stroke="var(--surface-sunk)" strokeWidth="18" />
                  {donutCalculated.map((seg) => {
                    const isHovered = hoveredSegment?.key === seg.key
                    return (
                      <circle
                        key={seg.key}
                        className={`donut-slice ${isHovered ? 'donut-slice--active' : ''}`}
                        cx="100"
                        cy="100"
                        r={radius}
                        stroke={seg.color}
                        strokeWidth={isHovered ? 24 : 18}
                        strokeDasharray={`${seg.strokeDash} ${circumference}`}
                        strokeDashoffset={-seg.strokeOffset}
                        onMouseEnter={() => setHoveredSegment(seg)}
                        onMouseLeave={() => setHoveredSegment(null)}
                        onClick={() => navigate('assets')}
                      />
                    )
                  })}
                </svg>
                <div className="donut-center-text">
                  <div className="donut-center-text__val">
                    {hoveredSegment ? hoveredSegment.value : totalAssets}
                  </div>
                  <div className="donut-center-text__lbl">
                    {hoveredSegment ? hoveredSegment.label : 'Total Assets'}
                  </div>
                  {hoveredSegment && (
                    <div className="donut-center-text__pct" style={{ color: hoveredSegment.color }}>
                      {Math.round((hoveredSegment.value / (totalAssets || 1)) * 100)}% of total
                    </div>
                  )}
                </div>
              </div>

              {/* Interactive Legend List */}
              <div className="donut-legend">
                {donutCalculated.map((seg) => {
                  const isHovered = hoveredSegment?.key === seg.key
                  return (
                    <div
                      key={seg.key}
                      className={`donut-legend__item ${isHovered ? 'donut-legend__item--active' : ''}`}
                      onMouseEnter={() => setHoveredSegment(seg)}
                      onMouseLeave={() => setHoveredSegment(null)}
                      onClick={() => navigate('assets')}
                    >
                      <div className="donut-legend__left">
                        <span className="donut-legend__dot" style={{ backgroundColor: seg.color }} />
                        <span className="donut-legend__name">{seg.label}</span>
                      </div>
                      <div className="donut-legend__right">
                        <span className="donut-legend__val">{seg.value}</span>
                        <span className="donut-legend__pct">{seg.percentage}%</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </section>

        {/* Interactive Top Categories Bar Chart */}
        <section className="dash-panel">
          <div className="dash-panel__header">
            <div>
              <h2>Equipment by Category</h2>
              <p>Inventory breakdown across IT and facilities hardware</p>
            </div>
            <div className="cat-chart__tabs">
              <button
                className={`cat-chart__tab ${categoryDomainTab === 'all' ? 'cat-chart__tab--active' : ''}`}
                onClick={() => setCategoryDomainTab('all')}
              >
                All
              </button>
              <button
                className={`cat-chart__tab ${categoryDomainTab === 'it' ? 'cat-chart__tab--active' : ''}`}
                onClick={() => setCategoryDomainTab('it')}
              >
                IT Hardware
              </button>
              <button
                className={`cat-chart__tab ${categoryDomainTab === 'facilities' ? 'cat-chart__tab--active' : ''}`}
                onClick={() => setCategoryDomainTab('facilities')}
              >
                Facilities
              </button>
            </div>
          </div>
          <div className="dash-panel__body">
            <div className="cat-chart">
              <div className="cat-bars-list">
                {filteredCategories.map((c) => {
                  const count = c.assetCount ?? 0
                  const pct = Math.round((count / maxCategoryCount) * 100)
                  const isFac = c.assetDomain === 'facilities'
                  return (
                    <div
                      key={c.id}
                      className="cat-bar-row"
                      onClick={() => navigate('assets')}
                      title={`Click to filter assets in ${c.name}`}
                    >
                      <div className="cat-bar-header">
                        <span className="cat-bar-name">
                          {c.name}
                          <span className={`cat-domain-badge ${isFac ? 'cat-domain-badge--fac' : ''}`}>
                            {c.assetDomain}
                          </span>
                        </span>
                        <span className="cat-bar-count">
                          {count} <span style={{ fontSize: '11px', color: 'var(--ink-faint)' }}>assets</span>
                        </span>
                      </div>
                      <div className="cat-bar-track">
                        <div
                          className={`cat-bar-fill ${isFac ? 'cat-bar-fill--fac' : ''}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* Domain Split Comparison & Alerts Grid */}
      <div className="dash-grid-2col">
        {/* Domain Comparison Ratio Widget */}
        <section className="dash-panel">
          <div className="dash-panel__header">
            <div>
              <h2>IT vs Facilities Distribution</h2>
              <p>Operational scope balance across technology and facility assets</p>
            </div>
          </div>
          <div className="dash-panel__body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div className="domain-split-box">
              <div className="domain-split-labels">
                <span style={{ color: '#2563eb', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  💻 IT Hardware: <strong>{itAssetCount} assets</strong> ({itPercentage}%)
                </span>
                <span style={{ color: '#d97706', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  🏢 Facilities: <strong>{facAssetCount} assets</strong> ({facPercentage}%)
                </span>
              </div>
              <div className="domain-split-bar">
                <div className="domain-split-bar__it" style={{ width: `${itPercentage}%` }} />
                <div className="domain-split-bar__fac" style={{ width: `${facPercentage}%` }} />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div style={{ padding: '12px', background: 'var(--surface-sunk)', borderRadius: '10px' }}>
                <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--ink-soft)', textTransform: 'uppercase' }}>
                  Top IT Hardware
                </div>
                <div style={{ fontSize: '15px', fontWeight: 600, marginTop: '4px' }}>
                  Monitors (143), All-In-One (102), Wifi Adapters (39)
                </div>
              </div>
              <div style={{ padding: '12px', background: 'var(--surface-sunk)', borderRadius: '10px' }}>
                <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--ink-soft)', textTransform: 'uppercase' }}>
                  Top Facilities Items
                </div>
                <div style={{ fontSize: '15px', fontWeight: 600, marginTop: '4px' }}>
                  Chairs (118), Plants (77), Air Conditioners (11)
                </div>
              </div>
            </div>

            {summary?.exitClearances ? (
              <p className="muted" data-testid="clearance-summary" style={{ fontSize: '13px', borderTop: '1px solid var(--line)', paddingTop: '10px' }}>
                Exit clearances: {summary.exitClearances.open} open, {summary.exitClearances.withUnresolvedItems} with unresolved items.{' '}
                <button className="link-btn" onClick={() => navigate('exit-clearance')}>Open exit clearance</button>
              </p>
            ) : null}
          </div>
        </section>

        {/* Maintenance & Health Action Widget */}
        <section className="dash-panel">
          <div className="dash-panel__header">
            <div>
              <h2>Maintenance & Hardware Alerts</h2>
              <p>Active issues requiring engineering attention</p>
            </div>
            <button className="dash-chip-btn" onClick={() => navigate('maintenance')} style={{ fontSize: '11px', padding: '4px 10px' }}>
              View Tickets ({recentTickets.length})
            </button>
          </div>
          <div className="dash-panel__body">
            {recentTickets.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {recentTickets.map((t) => (
                  <div
                    key={t.id}
                    className="maint-ticket-card"
                    onClick={() => navigate('maintenance')}
                    style={{ cursor: 'pointer' }}
                  >
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontWeight: 700, fontSize: '13px', color: 'var(--action)' }}>
                          {t.ticketNumber}
                        </span>
                        <span style={{ fontWeight: 600, fontSize: '12px', color: 'var(--ink)' }}>
                          Asset: {t.assetCode}
                        </span>
                        <span className={`maint-ticket-badge ${t.priority === 'high' ? 'maint-ticket-badge--high' : 'maint-ticket-badge--med'}`}>
                          {t.priority}
                        </span>
                      </div>
                      <div className="maint-ticket-desc">{t.description}</div>
                      <div className="maint-ticket-meta">
                        Status: <strong style={{ textTransform: 'capitalize' }}>{t.status.replace('_', ' ')}</strong> · Assigned to: {t.assignedTechnicianName || 'Unassigned'}
                      </div>
                    </div>
                    <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--action)', whiteSpace: 'nowrap' }}>
                      Inspect →
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty" style={{ padding: '24px 0' }}>
                No active maintenance tickets. All hardware operating smoothly.
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Recent Custody Allocations & System Health */}
      <div className="dash-grid-2col">
        {/* Recent Asset Allocations */}
        <section className="dash-panel">
          <div className="dash-panel__header">
            <div>
              <h2>Recent Equipment Allocations</h2>
              <p>Latest asset assignments and custody handovers</p>
            </div>
            <button className="dash-chip-btn" onClick={() => navigate('allocations')} style={{ fontSize: '11px', padding: '4px 10px' }}>
              View All Allocations
            </button>
          </div>
          <div className="dash-panel__body">
            {recentAllocations.length > 0 ? (
              <div className="activity-list">
                {recentAllocations.map((a) => (
                  <div
                    key={a.id}
                    className="activity-item"
                    onClick={() => navigate('allocations')}
                    style={{ cursor: 'pointer' }}
                  >
                    <div>
                      <span className="activity-item__code">{a.assetCode}</span>
                      <span style={{ fontSize: '12px', color: 'var(--ink-soft)', marginLeft: '8px' }}>
                        ({a.categoryName})
                      </span>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div className="activity-item__target">
                        Assigned to: <strong>{a.targetLabel}</strong>
                      </div>
                      <div className="activity-item__date">
                        Status: <span style={{ color: 'var(--success)', fontWeight: 600 }}>{a.status}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty" style={{ padding: '20px 0' }}>
                No recent allocations.
              </div>
            )}
          </div>
        </section>

        {/* System & Audit Ledger */}
        <section className="dash-panel">
          <div className="dash-panel__header">
            <div>
              <h2>System & Compliance Status</h2>
              <p>Platform security, audit logging and registry ledger</p>
            </div>
            <button className="dash-chip-btn" onClick={() => navigate('audit-log')} style={{ fontSize: '11px', padding: '4px 10px' }}>
              Audit Log
            </button>
          </div>
          <div className="dash-panel__body">
            <div className="ledger" aria-label="System summary" style={{ marginBottom: '14px' }}>
              <div className="ledger__cell">
                <div className="ledger__value">{summary?.activeUsers ?? 1}</div>
                <div className="ledger__label">Active operators</div>
              </div>
              <div className="ledger__cell">
                <div className="ledger__value">{summary?.auditEventsLast7Days ?? 0}</div>
                <div className="ledger__label">Audit events (7 days)</div>
              </div>
              <div className="ledger__cell">
                <div className="ledger__value">v{summary?.schemaVersion ?? 10}</div>
                <div className="ledger__label">Database schema</div>
              </div>
            </div>
            <p className="faint">
              Out of service assets: {summary?.assets?.lost ?? 0} lost, {summary?.assets?.retired ?? 0} retired, {summary?.assets?.disposed ?? 0} disposed.
            </p>
          </div>
        </section>
      </div>
    </div>
  )
}
