import { WEB_ONLY_COMMAND_NAMES, type CommandName } from '@shared/api'

/** W1 identity/administration commands served by the web API. */
export const W1_COMMANDS = [
  'system.getStartupState',
  'session.login',
  'session.logout',
  'session.getCurrent',
  'session.touch',
  'session.changePassword',
  'users.list',
  'users.create',
  'users.update',
  'users.resetPassword',
  'roles.list',
  'roles.updatePermissions',
  'audit.list',
  'settings.get',
  'settings.update',
  'dashboard.getSummary'
] as const satisfies readonly CommandName[]

/** W2 organization, employee, catalogue, asset and document commands. */
export const W2_COMMANDS = [
  'departments.list', 'departments.create', 'departments.update', 'departments.setActive',
  'teams.list', 'teams.create', 'teams.update', 'teams.setActive',
  'locations.list', 'locations.create', 'locations.update', 'locations.setActive',
  'workstations.list', 'workstations.create', 'workstations.update', 'workstations.setActive',
  'pools.list', 'pools.create', 'pools.update', 'pools.setActive',
  'employees.search', 'employees.get', 'employees.create', 'employees.update', 'employees.deactivate', 'employees.reactivate',
  'employees.importPreview', 'employees.importCommit', 'employees.importCancel',
  'categories.list', 'categories.create', 'categories.update', 'categories.setActive',
  'models.list', 'models.create', 'models.update', 'models.setActive',
  'suppliers.list', 'suppliers.create', 'suppliers.update', 'suppliers.setActive',
  'assets.getCodeConfig', 'assets.updateCodeConfig', 'assets.search', 'assets.get', 'assets.create', 'assets.update',
  'assets.changeLifecycle', 'assets.lookup', 'assets.generateLabels',
  'assets.importPreview', 'assets.importCommit', 'assets.importCancel',
  'documents.removeLink'
] as const satisfies readonly CommandName[]

/** Every command the web API serves (allow-list). Desktop-only commands are deliberately absent. */
/** W4 allocation and exit-clearance commands (web only). */
export const W4_COMMANDS = [
  'allocations.list', 'allocations.custody', 'allocations.getHandover', 'allocations.issue', 'allocations.transfer',
  'allocations.return', 'allocations.acknowledge', 'allocations.inspect', 'allocations.reportLost',
  'exitClearance.list', 'exitClearance.open', 'exitClearance.get', 'exitClearance.recordReturn', 'exitClearance.flagItem',
  'exitClearance.approveException', 'exitClearance.close', 'exitClearance.cancel'
] as const satisfies readonly CommandName[]

/** W5 maintenance and physical-audit commands (web only). */
export const W5_COMMANDS = [
  'maintenance.list', 'maintenance.get', 'maintenance.listTechnicians', 'maintenance.create', 'maintenance.assign',
  'maintenance.update', 'maintenance.resolve', 'maintenance.close', 'maintenance.cancel',
  'audits.list', 'audits.get', 'audits.getItems', 'audits.listReviewers', 'audits.create', 'audits.verifyItem', 'audits.flagMissing',
  'audits.assignDiscrepancy', 'audits.resolveDiscrepancy', 'audits.correctLocation', 'audits.acceptException', 'audits.close', 'audits.cancel'
] as const satisfies readonly CommandName[]

/** W6 procurement, approval, purchase-order, and goods-receipt commands (web only). */
export const W6_COMMANDS = [
  'procurement.saveDraft', 'procurement.get', 'procurement.list', 'procurement.submit', 'procurement.cancel',
  'approvals.savePolicy', 'approvals.listPolicies', 'approvals.decide', 'approvals.listQueue',
  'orders.create', 'orders.amend', 'orders.cancel', 'orders.get', 'orders.list',
  'receipts.create', 'receipts.resolveDiscrepancy', 'receipts.get', 'receipts.list'
] as const satisfies readonly CommandName[]

/** W7 financial and management reporting commands (web only). */
export const W7_COMMANDS = [
  'reports.assetValuation', 'reports.maintenanceCost', 'reports.procurementSummary', 'reports.warranty', 'reports.disposals'
] as const satisfies readonly CommandName[]

export const SERVER_COMMANDS = [...W1_COMMANDS, ...W2_COMMANDS, ...W4_COMMANDS, ...W5_COMMANDS, ...W6_COMMANDS, ...W7_COMMANDS] as const
export type ServerCommandName = (typeof SERVER_COMMANDS)[number]
export type W2CommandName = (typeof W2_COMMANDS)[number]
export type W4CommandName = (typeof W4_COMMANDS)[number]
export type W5CommandName = (typeof W5_COMMANDS)[number]
export type W6CommandName = (typeof W6_COMMANDS)[number]
export type W7CommandName = (typeof W7_COMMANDS)[number]

// Compile-time check that W2_COMMANDS + W4_COMMANDS + W5_COMMANDS + W6_COMMANDS + W7_COMMANDS together cover every web-only command (api.ts).
// W2 contributes here too: most of it is shared with the frozen prototype, but a few commands (the
// asset importer) are web-only additions with no prototype equivalent, same as any W4+ command.
type MissingWebOnlyCommands = Exclude<(typeof WEB_ONLY_COMMAND_NAMES)[number], W2CommandName | W4CommandName | W5CommandName | W6CommandName | W7CommandName>
const _webOnlyExhaustive: MissingWebOnlyCommands extends never ? true : never = true
void _webOnlyExhaustive
