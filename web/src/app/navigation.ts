import type { PermissionKey } from '@shared/permissions'

export interface NavItem {
  id: string
  label: string
  /** Any one of these grants visibility. Visibility is convenience only; services enforce access. */
  anyOf: PermissionKey[] | 'any'
  /** Planned milestone for modules that are not implemented yet (see IMPLEMENTATION_PLAN.md). */
  pendingMilestone?: string
  pendingScope?: string[]
}

export interface NavGroup {
  title: string
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    title: 'Operations',
    items: [
      { id: 'dashboard', label: 'Dashboard', anyOf: 'any' },
      { id: 'scan', label: 'Scan / find asset', anyOf: ['assets.view'] },
      { id: 'allocations', label: 'Allocations and returns', anyOf: ['allocations.view', 'allocations.issue', 'allocations.transfer', 'allocations.return'] },
      { id: 'exit-clearance', label: 'Exit clearance', anyOf: ['exit_clearance.view'] },
      { id: 'maintenance', label: 'Maintenance', anyOf: ['maintenance.view', 'maintenance.create'] },
      { id: 'procurement', label: 'Purchase requests', anyOf: ['procurement.view'] },
      { id: 'approvals', label: 'Approvals', anyOf: ['procurement.approve', 'approvals.configure'] },
      { id: 'orders', label: 'Purchase orders', anyOf: ['procurement.view'] },
      { id: 'receipts', label: 'Goods receipt', anyOf: ['procurement.view'] },
      { id: 'audits', label: 'Physical audits', anyOf: ['audits.view'] }
    ]
  },
  {
    title: 'Records',
    items: [
      { id: 'assets', label: 'Assets', anyOf: ['assets.view'] },
      { id: 'catalog', label: 'Asset catalogue', anyOf: ['assets.view', 'reference_data.manage', 'suppliers.manage'] },
      { id: 'employees', label: 'Employees', anyOf: ['employees.view', 'employees.manage'] },
      { id: 'locations', label: 'Departments and locations', anyOf: ['locations.manage', 'employees.view', 'employees.manage', 'assets.view'] },
      { id: 'reports', label: 'Reports', anyOf: ['reports.view'] }
    ]
  },
  {
    title: 'Administration',
    items: [
      { id: 'users', label: 'Users and roles', anyOf: ['users.manage', 'roles.manage'] },
      { id: 'offline-agents', label: 'Offline agents', anyOf: ['leases.manage', 'devices.manage', 'leases.force_reclaim'] },
      { id: 'audit-log', label: 'Audit log', anyOf: ['audit_log.view'] },
      { id: 'settings', label: 'Settings', anyOf: 'any' }
    ]
  }
]

export const ALL_NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items)

export function canSee(item: NavItem, permissions: readonly string[]): boolean {
  return item.anyOf === 'any' || item.anyOf.some((p) => permissions.includes(p))
}
