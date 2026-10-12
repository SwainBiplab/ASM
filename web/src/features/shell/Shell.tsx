import { useEffect, useState } from 'react'
import type { AppEnvironment, SessionInfo } from '@shared/api'
import { call } from '../../api'
import { ALL_NAV_ITEMS, NAV_GROUPS, canSee, type NavItem } from '../../app/navigation'
import { Button, TagMark } from '../../components/ui'
import { AuditLogPage } from '../audit/AuditLogPage'
import { DashboardPage } from '../dashboard/DashboardPage'
import { AssetsPage } from '../assets/AssetsPage'
import { AllocationsPage } from '../allocations/AllocationsPage'
import { ClearancePage } from '../clearance/ClearancePage'
import { MaintenancePage } from '../maintenance/MaintenancePage'
import { AuditsPage } from '../audits/AuditsPage'
import { ProcurementPage } from '../procurement/ProcurementPage'
import { ApprovalsPage } from '../approvals/ApprovalsPage'
import { OrdersPage } from '../orders/OrdersPage'
import { ReceiptsPage } from '../receipts/ReceiptsPage'
import { ReportsPage } from '../reports/ReportsPage'
import { CatalogPage } from '../assets/CatalogPage'
import { ScanPage } from '../assets/ScanPage'
import { EmployeesPage } from '../employees/EmployeesPage'
import { OrganizationPage } from '../organization/OrganizationPage'
import { SettingsPage } from '../settings/SettingsPage'
import { UsersPage } from '../users/UsersPage'
import { OfflineAgentsPage } from '../offlineAgents/OfflineAgentsPage'
import { ErrorBoundary } from './ErrorBoundary'
import { PendingModule } from './PendingModule'

function useHashRoute(defaultId: string): [string, (id: string) => void] {
  const read = () => window.location.hash.replace(/^#\/?/, '') || defaultId
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const onHash = () => setRoute(read())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  })
  return [route, (id) => (window.location.hash = `#/${id}`)]
}

export function Shell({
  session,
  environment,
  onSignedOut
}: {
  session: SessionInfo
  environment: AppEnvironment
  onSignedOut: (notice?: string) => void
}) {
  const [route, navigate] = useHashRoute('dashboard')
  // Routes look like "#/section" or "#/section/param" (e.g. #/assets/<id>).
  const [section, param] = route.split('/') as [string, string | undefined]
  const visible = (item: NavItem) => canSee(item, session.permissions)
  const current = ALL_NAV_ITEMS.find((i) => i.id === section && visible(i)) ?? ALL_NAV_ITEMS[0]!

  const signOut = async () => {
    await call('session.logout').catch(() => undefined)
    onSignedOut('You have signed out.')
  }

  return (
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <div className="rail__brand">
          <TagMark />
        </div>
        {NAV_GROUPS.map((group) => {
          const items = group.items.filter(visible)
          if (!items.length) return null
          return (
            <div className="rail__group" key={group.title}>
              <div className="rail__group-title">{group.title}</div>
              {items.map((item) => (
                <a
                  key={item.id}
                  href={`#/${item.id}`}
                  className="rail__link"
                  aria-current={current.id === item.id ? 'page' : undefined}
                >
                  {item.label}
                  {item.pendingMilestone ? <span className="rail__pending">Planned</span> : null}
                </a>
              ))}
            </div>
          )
        })}
        <div className="rail__foot">Signed in to your organization’s server</div>
      </nav>
      <div className="workspace">
        <header className="topbar">
          <div className="topbar__user">
            <strong>{session.user.displayName}</strong>
            <span>{session.user.username}</span>
          </div>
          {environment !== 'production' ? <span className="env-flag">{environment === 'test' ? 'Test data' : 'Development data'}</span> : null}
          <Button small onClick={() => void signOut()}>
            Sign out
          </Button>
        </header>
        <main className="content" id="main">
          <ErrorBoundary key={current.id}>{renderPage(current, session, navigate, param)}</ErrorBoundary>
        </main>
      </div>
    </div>
  )
}

function renderPage(item: NavItem, session: SessionInfo, navigate: (id: string) => void, param?: string) {
  switch (item.id) {
    case 'dashboard':
      return <DashboardPage session={session} navigate={navigate} />
    case 'assets':
      return <AssetsPage session={session} selectedId={param ?? null} navigate={navigate} />
    case 'allocations':
      return <AllocationsPage session={session} navigate={navigate} />
    case 'exit-clearance':
      return <ClearancePage session={session} selectedId={param ?? null} navigate={navigate} />
    case 'maintenance':
      return <MaintenancePage session={session} selectedId={param ?? null} navigate={navigate} />
    case 'audits':
      return <AuditsPage session={session} selectedId={param ?? null} navigate={navigate} />
    case 'procurement':
      return <ProcurementPage session={session} selectedId={param ?? null} navigate={navigate} />
    case 'approvals':
      return <ApprovalsPage session={session} selectedId={param ?? null} navigate={navigate} />
    case 'orders':
      return <OrdersPage session={session} selectedId={param ?? null} navigate={navigate} />
    case 'receipts':
      return <ReceiptsPage session={session} selectedId={param ?? null} navigate={navigate} />
    case 'reports':
      return <ReportsPage session={session} selectedId={param ?? null} navigate={navigate} />
    case 'scan':
      return <ScanPage navigate={navigate} />
    case 'catalog':
      return <CatalogPage session={session} />
    case 'employees':
      return <EmployeesPage session={session} />
    case 'locations':
      return <OrganizationPage session={session} />
    case 'users':
      return <UsersPage session={session} />
    case 'offline-agents':
      return <OfflineAgentsPage session={session} />
    case 'audit-log':
      return <AuditLogPage />
    case 'settings':
      return <SettingsPage session={session} />
    default:
      return <PendingModule item={item} />
  }
}
