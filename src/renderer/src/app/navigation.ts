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
      {
        id: 'allocations', label: 'Allocations and returns', anyOf: ['allocations.issue', 'allocations.return', 'allocations.transfer'],
        pendingMilestone: 'M4', pendingScope: ['Issue to employee, workstation, department or pool', 'Transfers and returns with condition checks', 'Handover acknowledgment']
      },
      {
        id: 'exit-clearance', label: 'Exit clearance', anyOf: ['exit_clearance.view'],
        pendingMilestone: 'M4', pendingScope: ['Outstanding assets per leaving employee', 'Missing, damaged and disputed items', 'Authorized final clearance']
      },
      {
        id: 'maintenance', label: 'Maintenance', anyOf: ['maintenance.view', 'maintenance.create'],
        pendingMilestone: 'M5', pendingScope: ['Fault tickets, priorities and technicians', 'Repair costs and downtime', 'Return-to-service decisions']
      },
      {
        id: 'procurement', label: 'Procurement', anyOf: ['procurement.view'],
        pendingMilestone: 'M6', pendingScope: ['Purchase requests and orders', 'Goods receipt with partial deliveries', 'Asset registration from receipts']
      },
      {
        id: 'approvals', label: 'Approvals', anyOf: ['procurement.approve', 'approvals.configure'],
        pendingMilestone: 'M6', pendingScope: ['Approval queue', 'Configurable thresholds and approvers']
      },
      {
        id: 'audits', label: 'Physical audits', anyOf: ['audits.view'],
        pendingMilestone: 'M5', pendingScope: ['Audit sessions and expected lists', 'Discrepancy investigation and closure']
      }
    ]
  },
  {
    title: 'Records',
    items: [
      { id: 'assets', label: 'Assets', anyOf: ['assets.view'] },
      { id: 'catalog', label: 'Asset catalogue', anyOf: ['assets.view', 'reference_data.manage', 'suppliers.manage'] },
      { id: 'employees', label: 'Employees', anyOf: ['employees.view', 'employees.manage'] },
      { id: 'locations', label: 'Departments and locations', anyOf: ['locations.manage', 'employees.view', 'employees.manage', 'assets.view'] },
      {
        id: 'finance', label: 'Financial reports', anyOf: ['finance.view_cost'],
        pendingMilestone: 'M7', pendingScope: ['Acquisition cost and warranty reports', 'Depreciation stays disabled until Finance approves a policy']
      },
      {
        id: 'reports', label: 'Reports and exports', anyOf: ['reports.view'],
        pendingMilestone: 'M7', pendingScope: ['Filtered reports across all modules', 'CSV export with formula-injection protection']
      }
    ]
  },
  {
    title: 'Administration',
    items: [
      { id: 'users', label: 'Users and roles', anyOf: ['users.manage', 'roles.manage'] },
      { id: 'audit-log', label: 'Audit log', anyOf: ['audit_log.view'] },
      { id: 'backup', label: 'Backup and recovery', anyOf: ['backup.create', 'backup.restore'] },
      { id: 'settings', label: 'Settings', anyOf: 'any' }
    ]
  }
]

export const ALL_NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items)

export function canSee(item: NavItem, permissions: readonly string[]): boolean {
  return item.anyOf === 'any' || item.anyOf.some((p) => permissions.includes(p))
}
