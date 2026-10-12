/**
 * Permission catalog (TAS §6.1). Keys are stable identifiers stored in the database.
 * Role templates below are starting points only; the Super Admin may change role
 * assignments, and services always check permissions — never just the UI.
 */
export const PERMISSIONS = {
  'assets.view': 'View the asset register',
  'assets.create': 'Create assets',
  'assets.update': 'Edit asset records',
  'assets.retire': 'Retire assets',
  'assets.dispose': 'Approve asset disposal / write-off',
  'labels.print': 'Generate and print asset labels',
  'assets.configure_codes': 'Configure asset code prefix and numbering',
  'allocations.issue': 'Issue assets',
  'allocations.transfer': 'Transfer assets',
  'allocations.return': 'Receive returned assets',
  'allocations.override': 'Override allocation holds',
  'allocations.view': 'View assignments, handovers and custody history',
  'allocations.inspect': 'Inspect returned assets and release them for reuse',
  'employees.view': 'View employee records',
  'employees.manage': 'Create and edit employees',
  'employees.import': 'Import employees from CSV/Excel',
  'locations.manage': 'Manage departments, locations, workstations and pools',
  'exit_clearance.view': 'View exit clearance status',
  'exit_clearance.manage': 'Record exit clearance items',
  'exit_clearance.approve_exception': 'Approve exit clearance exceptions',
  'exit_clearance.close': 'Close exit clearances',
  'maintenance.view': 'View maintenance tickets',
  'maintenance.create': 'Report faults / create tickets',
  'maintenance.assign': 'Assign technicians',
  'maintenance.update': 'Work on maintenance tickets',
  'maintenance.close': 'Close maintenance tickets',
  'procurement.view': 'View purchase requests and orders',
  'procurement.create': 'Create purchase requests',
  'procurement.submit': 'Submit purchase requests for approval',
  'procurement.approve': 'Decide on approvals assigned to the user',
  'procurement.manage_orders': 'Create purchase orders',
  'receipts.record': 'Record goods receipts',
  'suppliers.manage': 'Manage supplier records',
  'approvals.configure': 'Configure approval policies',
  'audits.view': 'View physical audits',
  'audits.manage': 'Run physical audits',
  'audits.verify': 'Scan and verify assets during a physical audit',
  'audits.resolve': 'Resolve audit discrepancies',
  'audits.close': 'Close physical audits',
  'finance.view_cost': 'View purchase costs and financial data',
  'finance.configure_depreciation': 'Configure depreciation policy',
  'finance.approve_adjustment': 'Approve financial adjustments',
  'reports.view': 'Run reports',
  'reports.export': 'Export reports',
  'reference_data.manage': 'Manage categories, models and reference data',
  'users.manage': 'Manage local user accounts',
  'roles.manage': 'Manage roles and permissions',
  'settings.manage': 'Change application settings',
  'audit_log.view': 'View the audit log',
  'backup.create': 'Create and validate backups',
  'backup.restore': 'Restore from backup',
  'self.view_assigned': 'View own assigned assets',
  'self.acknowledge': 'Acknowledge own asset issue/return',
  'devices.manage': 'Enroll, verify trust, and revoke offline desktop agent devices',
  'leases.manage': 'Request and release exclusive offline work-authority leases on an enrolled, trusted device',
  'leases.force_reclaim': 'Force-reclaim another user\'s offline lease as the designated recovery authority'
} as const

export type PermissionKey = keyof typeof PERMISSIONS

export const ALL_PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[]

export function isPermissionKey(value: string): value is PermissionKey {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, value)
}

export const SUPER_ADMIN_ROLE_KEY = 'super_admin'

export interface RoleTemplate {
  key: string
  name: string
  description: string
  permissions: PermissionKey[] | 'all'
}

/** Default role templates from TAS §6. Seeded during first-run setup. */
export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    key: SUPER_ADMIN_ROLE_KEY,
    name: 'Super Admin',
    description: 'Full configuration, user, approval and backup control. Cannot erase audit history.',
    permissions: 'all'
  },
  {
    key: 'asset_manager',
    name: 'Asset Manager',
    description: 'Asset register, allocation, transfers, returns, labels and physical audits.',
    permissions: [
      'assets.view', 'assets.create', 'assets.update', 'assets.retire', 'labels.print',
      'allocations.view', 'allocations.issue', 'allocations.transfer', 'allocations.return', 'allocations.inspect',
      'employees.view', 'locations.manage', 'exit_clearance.view', 'exit_clearance.manage',
      'maintenance.view', 'maintenance.create', 'audits.view', 'audits.manage', 'audits.verify', 'audits.resolve',
      'reports.view', 'reports.export', 'reference_data.manage', 'backup.create', 'leases.manage'
    ]
  },
  {
    key: 'it_technician',
    name: 'IT Support / Technician',
    description: 'IT asset maintenance, ticket work, inspection findings and service history.',
    permissions: [
      'assets.view', 'maintenance.view', 'maintenance.create', 'maintenance.update',
      'maintenance.close', 'allocations.view', 'allocations.return', 'allocations.inspect',
      'audits.view', 'audits.verify', 'reports.view', 'leases.manage'
    ]
  },
  {
    key: 'facilities_manager',
    name: 'Facilities Manager',
    description: 'Facilities assets, locations, movement and maintenance.',
    permissions: [
      'assets.view', 'assets.create', 'assets.update', 'locations.manage',
      'allocations.view', 'allocations.issue', 'allocations.transfer', 'allocations.return',
      'maintenance.view', 'maintenance.create', 'maintenance.assign', 'maintenance.update',
      'maintenance.close', 'audits.view', 'audits.verify', 'reports.view'
    ]
  },
  {
    key: 'procurement_officer',
    name: 'Procurement Officer',
    description: 'Purchase requests, suppliers, orders, receiving and procurement documents.',
    permissions: [
      'procurement.view', 'procurement.create', 'procurement.submit', 'procurement.manage_orders',
      'receipts.record', 'suppliers.manage', 'assets.view', 'assets.create', 'reports.view'
    ]
  },
  {
    key: 'department_manager',
    name: 'Department / Process Manager',
    description: 'Requests and approvals within configured scope.',
    permissions: [
      'procurement.view', 'procurement.create', 'procurement.submit', 'procurement.approve',
      'assets.view', 'employees.view', 'reports.view'
    ]
  },
  {
    key: 'hr_officer',
    name: 'HR Officer',
    description: 'Employee lifecycle, exit clearance coordination and clearance status.',
    permissions: [
      'employees.view', 'employees.manage', 'employees.import',
      'exit_clearance.view', 'exit_clearance.manage', 'reports.view'
    ]
  },
  {
    key: 'finance_officer',
    name: 'Finance Officer',
    description: 'Purchase costs, depreciation settings when enabled, disposal financial records.',
    permissions: [
      'assets.view', 'finance.view_cost', 'finance.configure_depreciation',
      'finance.approve_adjustment', 'procurement.view', 'reports.view', 'reports.export'
    ]
  },
  {
    key: 'auditor',
    name: 'Auditor',
    description: 'Read-only register, history, reports and audit evidence.',
    permissions: [
      'assets.view', 'allocations.view', 'employees.view', 'exit_clearance.view', 'maintenance.view',
      'procurement.view', 'audits.view', 'finance.view_cost', 'reports.view', 'audit_log.view'
    ]
  },
  {
    key: 'employee',
    name: 'Employee / Agent',
    description: 'View own assigned assets, acknowledge issue/return, report a fault if permitted.',
    permissions: ['self.view_assigned', 'self.acknowledge', 'maintenance.create']
  }
]

export function resolveTemplatePermissions(template: RoleTemplate): PermissionKey[] {
  return template.permissions === 'all' ? [...ALL_PERMISSION_KEYS] : [...template.permissions]
}
