import type { Result } from './errors'
import type { AssetCondition, AssetDomain, DisposalMethod, DocumentPurpose, LifecycleStatus, OperationalStatus, TrackingMode } from './assets'
import type {
  AssetCodeConfigInput,
  AssetLookupInput,
  AssetSearchInput,
  AttachDocumentInput,
  CatalogListInput,
  ChangeLifecycleInput,
  CreateAssetInput,
  CreateCategoryInput,
  CreateModelInput,
  CreateSupplierInput,
  LabelRequestInput,
  RemoveDocumentLinkInput,
  UpdateAssetInput,
  UpdateCategoryInput,
  UpdateModelInput,
  UpdateSupplierInput
} from './assetSchemas'
import type { EmploymentStatus, ImportDateFormat, ImportField, LocationType, TeamKind, WorkstationKind } from './organization'
import type {
  CreateDepartmentInput,
  CreateEmployeeInput,
  CreateLocationInput,
  CreatePoolInput,
  CreateTeamInput,
  CreateWorkstationInput,
  DeactivateEmployeeInput,
  EmployeeSearchInput,
  ImportCommitInput,
  ImportMapping,
  ImportPreviewInput,
  ListInput,
  ReactivateEmployeeInput,
  SetActiveInput,
  TeamListInput,
  UpdateDepartmentInput,
  UpdateEmployeeInput,
  UpdateLocationInput,
  UpdatePoolInput,
  UpdateTeamInput,
  UpdateWorkstationInput,
  WorkstationListInput
} from './orgSchemas'
import type { PermissionKey } from './permissions'
import type {
  AcknowledgmentMethod,
  AcknowledgmentPolicy,
  AcknowledgmentStatus,
  AssignmentStatus,
  AssignmentTargetType,
  ClearanceResolution,
  ClearanceStatus,
  HandoverType,
  MovementType,
  ReturnOutcome
} from './allocations'
import type {
  AcknowledgeInput,
  ApproveExceptionInput,
  AssignmentListInput,
  CancelClearanceInput,
  ClearanceListInput,
  CloseClearanceInput,
  FlagClearanceItemInput,
  InspectInput,
  IssueInput,
  OpenClearanceInput,
  RecordClearanceReturnInput,
  ReportLostInput,
  ReturnInput,
  TransferInput
} from './allocationSchemas'
import type {
  AcceptExceptionInput,
  AssignDiscrepancyInput,
  AuditItemListInput,
  CancelAuditInput,
  CloseAuditInput,
  CorrectLocationInput,
  CreateAuditInput,
  FlagMissingInput,
  PhysicalAuditListInput,
  ResolveDiscrepancyInput,
  VerifyItemInput
} from './auditSchemas'
import type { AuditItemStatus, AuditStatus, AuditClosureType, DiscrepancyType } from './audits'
import type {
  AssignTicketInput,
  CancelTicketInput,
  CloseTicketInput,
  CreateTicketInput,
  ResolveTicketInput,
  TicketListInput,
  UpdateTicketInput
} from './maintenanceSchemas'
import type { FaultCategory, MaintenancePriority, TicketEventType, TicketStatus } from './maintenance'
import type {
  AmendOrderInput,
  ApprovalQueueInput,
  CreateOrderInput,
  CreateReceiptInput,
  DecideApprovalInput,
  OrderListInput,
  PolicyListInput,
  ReceiptListInput,
  RequestListInput,
  ResolveDiscrepancyInput as ResolveReceiptDiscrepancyInput,
  SaveApprovalPolicyInput,
  SaveRequestDraftInput
} from './procurementSchemas'
import type { ApprovalDecisionValue, ApprovalInstanceStatus, OrderStatus, ReceiptDiscrepancyStatus, RequestStatus, UnitDisposition } from './procurement'
import type { CurrencyTotal, WarrantyReportFilter } from './reports'
import type {
  AssetValuationReportInput,
  DisposalReportInput,
  MaintenanceCostReportInput,
  ProcurementSummaryReportInput,
  WarrantyReportInput
} from './reportsSchemas'
import type {
  AppSettings,
  AuditListInput,
  ChangePasswordInput,
  CreateUserInput,
  LoginInput,
  ResetPasswordInput,
  RestoreInput,
  SettingsUpdateInput,
  SetupInput,
  UnlockInput,
  UpdateRolePermissionsInput,
  UpdateUserInput
} from './schemas'

// ---------- DTOs ----------

export type AppEnvironment = 'development' | 'test' | 'production'

export type StartupStatus = 'ready' | 'setup_required' | 'database_error'

export interface StartupState {
  status: StartupStatus
  appVersion: string
  environment: AppEnvironment
  error?: { code: string; message: string; correlationId: string }
  /** Shown on the recovery screen so an administrator can locate data and logs. */
  dataDirectory?: string
}

export interface SystemInfo {
  appVersion: string
  environment: AppEnvironment
  electronVersion: string
  chromeVersion: string
  nodeVersion: string
  sqliteVersion: string
  schemaVersion: number
  platform: string
  dataDirectory: string
  databasePath: string
  logDirectory: string
  backupDirectory: string
  organizationName: string
}

export interface SessionUser {
  id: string
  username: string
  displayName: string
  mustChangePassword: boolean
}

export interface SessionInfo {
  user: SessionUser
  permissions: PermissionKey[]
  roles: string[]
  idleTimeoutMinutes: number
  locked: boolean
}

export interface UserSummary {
  id: string
  username: string
  displayName: string
  isActive: boolean
  mustChangePassword: boolean
  lastLoginAt: string | null
  roleKeys: string[]
  createdAt: string
}

export interface RoleSummary {
  key: string
  name: string
  description: string
  isSystem: boolean
  permissions: PermissionKey[]
  userCount: number
}

export interface AuditEventView {
  id: string
  occurredAt: string
  actorUserId: string | null
  actorName: string | null
  eventType: string
  entityType: string
  entityId: string | null
  reason: string | null
  correlationId: string
  summary: Record<string, unknown> | null
}

export interface Page<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export type BackupKind = 'manual' | 'automatic' | 'pre_migration' | 'pre_restore'

export interface BackupSummary {
  backupId: string
  kind: BackupKind
  createdAt: string
  appVersion: string
  schemaVersion: number
  databaseBytes: number
  documentCount: number
  /** Validation status recorded when the backup was produced. */
  verified: boolean
}

export interface BackupValidation {
  backupId: string
  valid: boolean
  problems: string[]
  schemaVersion: number | null
}

export interface RestoreOutcome {
  restoredBackupId: string
  safetyBackupId: string | null
  schemaVersion: number
}

/**
 * Asset counts from live records. "Ready" means active + ready to use; once assignments exist
 * (M4) "available" will additionally exclude assigned assets.
 */
export interface AssetMetrics {
  totalActive: number
  ready: number
  underMaintenance: number
  awaitingInspection: number
  nonOperational: number
  lost: number
  retired: number
  disposed: number
  warrantyExpiringSoon: number
  warrantyWindowDays: number
  /** W4 (web only): active assets with an active assignment, and active+ready+unassigned assets. */
  assigned?: number
  available?: number
}

export interface DashboardSummary {
  organizationName: string
  activeUsers: number
  lastBackup: BackupSummary | null
  auditEventsLast7Days: number
  schemaVersion: number
  /** Null when the user cannot view assets. */
  assets: AssetMetrics | null
  /** W4 (web only): null when the user cannot view exit clearances. */
  exitClearances?: { open: number; withUnresolvedItems: number } | null
  /** W5 (web only): null when the user cannot view maintenance tickets. */
  maintenance?: { open: number; overdue: number } | null
  /** W5 (web only): null when the user cannot view physical audits. */
  audits?: { open: number; withUnresolvedItems: number } | null
  /** W7 (web only): null when the user cannot view purchase requests. */
  procurement?: { draftRequests: number; pendingApprovals: number; openDiscrepancies: number } | null
  /** W7 (web only): null when the user cannot view costs (`finance.view_cost`). Depreciation is intentionally absent (F1 unresolved). */
  finance?: { acquisitionValueByCurrency: CurrencyTotal[] } | null
}

// ---------- Allocation and exit clearance (W4, web only) ----------

export interface AssignmentView {
  id: string
  assetId: string
  assetCode: string
  categoryName: string
  makeModel: string | null
  serialNumber: string | null
  targetType: AssignmentTargetType
  targetId: string
  targetLabel: string
  locationId: string | null
  locationPath: string | null
  status: AssignmentStatus
  assignedAt: string
  expectedReturnDate: string | null
  overdue: boolean
  issuedByName: string | null
  conditionAtIssue: AssetCondition
  accessories: string | null
  endedAt: string | null
  endedByName: string | null
  conditionAtReturn: AssetCondition | null
  returnOutcome: ReturnOutcome | null
  endReason: string | null
  issueHandoverId: string
  issueHandoverNumber: string
  endHandoverId: string | null
  acknowledgmentStatus: AcknowledgmentStatus
}

export interface MovementView {
  id: string
  movementType: MovementType
  occurredAt: string
  actorName: string | null
  assignmentId: string | null
  handoverId: string | null
  handoverNumber: string | null
  targetLabel: string | null
  locationPath: string | null
  notes: string | null
}

/** Custody of one asset: issue eligibility, current and past assignments, and movements. */
export interface AssetCustody {
  assetId: string
  assetCode: string
  lifecycleStatus: LifecycleStatus
  operationalStatus: OperationalStatus
  eligibleForIssue: boolean
  /** Why the asset cannot be issued now (null when it can). */
  ineligibleReason: string | null
  currentAssignment: AssignmentView | null
  assignments: AssignmentView[]
  movements: MovementView[]
}

export interface HandoverItemView {
  assetId: string
  assetCode: string
  categoryName: string
  makeModel: string | null
  serialNumber: string | null
  condition: AssetCondition
  accessories: string | null
  outcome: ReturnOutcome | null
}

export interface HandoverView {
  id: string
  handoverNumber: string
  handoverType: HandoverType
  organizationName: string
  targetType: AssignmentTargetType | null
  targetLabel: string | null
  locationPath: string | null
  performedAt: string
  performedByName: string
  reason: string | null
  notes: string | null
  acknowledgmentPolicy: AcknowledgmentPolicy
  acknowledgmentStatus: AcknowledgmentStatus
  acknowledgmentMethod: AcknowledgmentMethod | null
  acknowledgedByName: string | null
  acknowledgedAt: string | null
  acknowledgmentRecordedByName: string | null
  acknowledgmentDocumentId: string | null
  items: HandoverItemView[]
  documents: DocumentLinkView[]
}

export interface ClearanceItemView {
  id: string
  assetId: string
  assetCode: string
  categoryName: string
  makeModel: string | null
  serialNumber: string | null
  assignmentId: string
  assignedAt: string
  resolution: ClearanceResolution
  receivedCondition: AssetCondition | null
  returnOutcome: ReturnOutcome | null
  exceptionReason: string | null
  reportedByName: string | null
  reportedAt: string | null
  decisionNotes: string | null
  reviewedByName: string | null
  reviewedAt: string | null
  returnHandoverId: string | null
  /** Evidence (photos, statements) attached to this item. */
  documents: DocumentLinkView[]
}

export interface ClearanceSummary {
  id: string
  clearanceNumber: string
  employeeId: string
  employeeCode: string
  employeeName: string
  employmentStatus: EmploymentStatus
  exitDate: string
  ownerName: string | null
  status: ClearanceStatus
  closureType: 'cleared' | 'with_exceptions' | null
  openedAt: string
  openedByName: string | null
  closedAt: string | null
  itemCount: number
  unresolvedCount: number
}

export interface ClearanceDetail extends ClearanceSummary {
  notes: string | null
  closingNotes: string | null
  closedByName: string | null
  cancelReason: string | null
  items: ClearanceItemView[]
  /** Reasons the clearance cannot be closed yet (empty when it can). */
  blockers: string[]
}

// ---------- Maintenance (W5, web only) ----------

export interface MaintenanceEventView {
  id: string
  eventType: TicketEventType
  occurredAt: string
  actorName: string | null
  notes: string | null
}

export interface MaintenanceTicketSummary {
  id: string
  ticketNumber: string
  assetId: string
  assetCode: string
  assetCategoryName: string
  faultCategory: FaultCategory
  priority: MaintenancePriority
  status: TicketStatus
  description: string
  reportedByName: string | null
  reportedAt: string
  assignedTechnicianName: string | null
  vendorName: string | null
  targetResolutionDate: string | null
  resolvedAt: string | null
  closedAt: string | null
  overdue: boolean
}

export interface MaintenanceTicketDetail extends MaintenanceTicketSummary {
  diagnosis: string | null
  workPerformed: string | null
  vendorReference: string | null
  /** Cost fields are present only for viewers with finance.view_cost; otherwise both are null. */
  costVisible: boolean
  partsCostMinor: number | null
  laborCostMinor: number | null
  currency: string
  downtimeMinutes: number | null
  closingNotes: string | null
  cancelReason: string | null
  resultOutcome: ReturnOutcome | null
  justifiedDuplicate: boolean
  events: MaintenanceEventView[]
  documents: DocumentLinkView[]
}

// ---------- Physical audits (W5, web only) ----------

export interface PhysicalAuditSummary {
  id: string
  auditNumber: string
  title: string
  scopeLocationPath: string | null
  scopeCategoryName: string | null
  scopeCustodianName: string | null
  responsibleUserName: string | null
  status: AuditStatus
  closureType: AuditClosureType | null
  openedAt: string
  openedByName: string | null
  closedAt: string | null
  itemCount: number
  verifiedCount: number
  unresolvedCount: number
}

export interface PhysicalAuditDetail extends PhysicalAuditSummary {
  notes: string | null
  closingNotes: string | null
  closedByName: string | null
  cancelReason: string | null
  /** Reasons the audit cannot be closed yet (empty when it can). */
  blockers: string[]
}

export interface AuditItemView {
  id: string
  auditId: string
  assetId: string
  assetCode: string
  categoryName: string
  makeModel: string | null
  serialNumber: string | null
  source: 'expected' | 'unexpected'
  expectedLocationPath: string | null
  expectedCondition: AssetCondition | null
  expectedCustodianLabel: string | null
  observedAt: string | null
  observedByName: string | null
  observedLocationPath: string | null
  observedCondition: AssetCondition | null
  notes: string | null
  status: AuditItemStatus
  discrepancyType: DiscrepancyType | null
  assignedToName: string | null
  assignmentNotes: string | null
  resolutionNotes: string | null
  resolvedByName: string | null
  resolvedAt: string | null
  documents: DocumentLinkView[]
}

// ---------- Procurement, approvals, purchase orders, goods receipt (W6, web only) ----------

export interface PurchaseRequestItemView {
  id: string
  lineNo: number
  description: string
  categoryId: string | null
  categoryName: string | null
  modelId: string | null
  modelName: string | null
  quantity: number
  estimatedUnitCostMinor: number
  lineTotalMinor: number
}

export interface ApprovalStepView {
  stepOrder: number
  requiredRoleKey: string | null
  requiredRoleName: string | null
  requiredUserId: string | null
  requiredUserName: string | null
  decision: ApprovalDecisionValue | null
  decidedByName: string | null
  decidedAt: string | null
  reason: string | null
}

export interface ApprovalInstanceView {
  id: string
  status: ApprovalInstanceStatus
  currentStep: number
  totalSteps: number
  policyName: string
  policyVersion: number
  steps: ApprovalStepView[]
}

export interface PurchaseRequestSummary {
  id: string
  requestNumber: string
  requesterName: string | null
  departmentName: string | null
  teamName: string | null
  justification: string
  requiredByDate: string | null
  currency: string
  totalMinor: number
  status: RequestStatus
  submittedAt: string | null
  decidedAt: string | null
  createdAt: string
}

export interface PurchaseRequestDetail extends PurchaseRequestSummary {
  cancelReason: string | null
  items: PurchaseRequestItemView[]
  approval: ApprovalInstanceView | null
  documents: DocumentLinkView[]
}

export interface ApprovalPolicyStepView {
  stepOrder: number
  requiredRoleKey: string | null
  requiredRoleName: string | null
  requiredUserId: string | null
  requiredUserName: string | null
}

export interface ApprovalPolicySummary {
  id: string
  policyGroupId: string
  version: number
  name: string
  transactionType: 'purchase_request'
  minAmountMinor: number | null
  currency: string | null
  preventSelfApproval: boolean
  isActive: boolean
  isCurrent: boolean
  steps: ApprovalPolicyStepView[]
}

export interface ApprovalQueueItem {
  instanceId: string
  requestId: string
  requestNumber: string
  requesterName: string | null
  justification: string
  totalMinor: number
  currency: string
  stepOrder: number
  submittedAt: string | null
}

export interface PurchaseOrderItemView {
  id: string
  lineNo: number
  description: string
  categoryId: string
  categoryName: string
  modelId: string | null
  quantity: number
  unitPriceMinor: number
  lineTotalMinor: number
  receivedQuantity: number
  outstandingQuantity: number
}

export interface PurchaseOrderAmendmentView {
  field: string
  oldValue: string | null
  newValue: string | null
  reason: string
  amendedByName: string | null
  amendedAt: string
}

export interface PurchaseOrderSummary {
  id: string
  poNumber: string
  supplierId: string
  supplierName: string
  requestId: string
  requestNumber: string
  currency: string
  totalMinor: number
  status: OrderStatus
  orderDate: string | null
  expectedDeliveryDate: string | null
  createdAt: string
}

export interface PurchaseOrderDetail extends PurchaseOrderSummary {
  notes: string | null
  cancelReason: string | null
  items: PurchaseOrderItemView[]
  amendments: PurchaseOrderAmendmentView[]
  documents: DocumentLinkView[]
}

export interface GoodsReceiptUnitView {
  unitNo: number
  serialNumber: string | null
  disposition: UnitDisposition
  assetId: string | null
  assetCode: string | null
}

export interface GoodsReceiptItemView {
  id: string
  poItemId: string
  description: string
  receivedQuantity: number
  acceptedQuantity: number
  damagedQuantity: number
  rejectedQuantity: number
  discrepancyStatus: ReceiptDiscrepancyStatus
  discrepancyNotes: string | null
  resolutionNotes: string | null
  units: GoodsReceiptUnitView[]
}

export interface GoodsReceiptSummary {
  id: string
  receiptNumber: string
  poId: string
  poNumber: string
  receivedByName: string | null
  receivedAt: string
  supplierReference: string | null
  itemCount: number
}

export interface GoodsReceiptDetail extends GoodsReceiptSummary {
  notes: string | null
  items: GoodsReceiptItemView[]
  documents: DocumentLinkView[]
}

// ---------- Financial and management reports (W7, web only) ----------

export interface AssetValuationRow {
  id: string
  assetCode: string
  categoryName: string
  manufacturer: string | null
  modelName: string | null
  locationName: string | null
  departmentName: string | null
  lifecycleStatus: LifecycleStatus
  operationalStatus: OperationalStatus
  purchaseDate: string | null
  /** Null for a viewer without `finance.view_cost`, regardless of whether a value is recorded. */
  acquisitionCostMinor: number | null
  currency: string | null
  supplierName: string | null
  invoiceReference: string | null
  purchaseReference: string | null
  missingFinancialMetadata: boolean
}
export interface AssetValuationReport {
  items: AssetValuationRow[]
  total: number
  page: number
  pageSize: number
  totalsByCurrency: CurrencyTotal[]
  costVisible: boolean
}

export interface MaintenanceCostRow {
  id: string
  ticketNumber: string
  assetId: string
  assetCode: string
  categoryName: string
  locationName: string | null
  vendorName: string | null
  status: TicketStatus
  reportedAt: string
  closedAt: string | null
  partsCostMinor: number | null
  laborCostMinor: number | null
  currency: string | null
  downtimeMinutes: number | null
}
export interface MaintenanceCostReport {
  items: MaintenanceCostRow[]
  total: number
  page: number
  pageSize: number
  totalsByCurrency: CurrencyTotal[]
  topAssets: Array<{ assetId: string; assetCode: string; currency: string; ticketCount: number; totalCostMinor: number }>
  costVisible: boolean
}

export interface ProcurementSummaryReport {
  requestTotals: Array<{ status: RequestStatus; currency: string; totalMinor: number; count: number }>
  orderTotals: Array<{ status: OrderStatus; currency: string; totalMinor: number; count: number }>
  receivedTotals: Array<{ currency: string; receivedMinor: number; outstandingMinor: number }>
  openDiscrepancies: Array<{ id: string; receiptId: string; receiptNumber: string; poNumber: string; description: string; damagedQuantity: number; rejectedQuantity: number; discrepancyNotes: string | null; receivedAt: string }>
  openDiscrepancyTotal: number
  page: number
  pageSize: number
  costVisible: boolean
}

export interface WarrantyRow {
  id: string
  assetCode: string
  categoryName: string
  locationName: string | null
  warrantyEnd: string | null
}
export interface WarrantyReport {
  items: WarrantyRow[]
  total: number
  page: number
  pageSize: number
  windowDays: number
  filter: WarrantyReportFilter
}

export interface DisposalRow {
  id: string
  assetCode: string
  categoryName: string
  disposalDate: string | null
  disposalMethod: string | null
  disposalProceedsMinor: number | null
  currency: string | null
}
export interface DisposalReport {
  items: DisposalRow[]
  total: number
  page: number
  pageSize: number
  totalsByCurrency: CurrencyTotal[]
  costVisible: boolean
}

// ---------- Organization (M2) ----------

export interface DepartmentView {
  id: string
  code: string | null
  name: string
  managerEmployeeId: string | null
  managerName: string | null
  notes: string | null
  isActive: boolean
  activeTeamCount: number
  currentEmployeeCount: number
  updatedAt: string
}

export interface TeamView {
  id: string
  departmentId: string
  departmentName: string
  kind: TeamKind
  code: string | null
  name: string
  leadEmployeeId: string | null
  leadName: string | null
  notes: string | null
  isActive: boolean
  currentEmployeeCount: number
}

export interface LocationView {
  id: string
  parentLocationId: string | null
  locationType: LocationType
  code: string | null
  name: string
  /** Ancestor names from the top, e.g. "Pune Campus / Tower B / Floor 3". */
  path: string
  notes: string | null
  isActive: boolean
  activeChildCount: number
  activeWorkstationCount: number
}

export interface WorkstationView {
  id: string
  locationId: string
  locationPath: string
  kind: WorkstationKind
  code: string
  label: string | null
  notes: string | null
  isActive: boolean
}

export interface PoolView {
  id: string
  code: string | null
  name: string
  purpose: string | null
  responsibleDepartmentId: string | null
  responsibleDepartmentName: string | null
  responsibleTeamId: string | null
  responsibleTeamName: string | null
  defaultLocationId: string | null
  defaultLocationPath: string | null
  isActive: boolean
}

export interface EmployeeListItem {
  id: string
  employeeCode: string
  fullName: string
  email: string | null
  jobTitle: string | null
  departmentName: string | null
  teamName: string | null
  managerName: string | null
  employmentStatus: EmploymentStatus
}

export interface EmployeeDetail {
  id: string
  employeeCode: string
  fullName: string
  email: string | null
  phone: string | null
  jobTitle: string | null
  departmentId: string | null
  departmentName: string | null
  teamId: string | null
  teamName: string | null
  managerEmployeeId: string | null
  managerName: string | null
  managerStatus: EmploymentStatus | null
  workLocationId: string | null
  workLocationPath: string | null
  employmentStatus: EmploymentStatus
  joiningDate: string | null
  expectedExitDate: string | null
  actualExitDate: string | null
  notes: string | null
  createdAt: string
  updatedAt: string
  directReports: Array<{ id: string; employeeCode: string; fullName: string; employmentStatus: EmploymentStatus }>
}

export type ImportRowStatus = 'accepted' | 'warning' | 'rejected' | 'duplicate'

export interface ImportIssue {
  field: ImportField | null
  severity: 'error' | 'warning'
  message: string
}

export interface ImportRowView {
  rowNumber: number
  status: ImportRowStatus
  values: Partial<Record<ImportField, string>>
  issues: ImportIssue[]
}

export interface ImportCounts {
  totalRows: number
  blankRowsSkipped: number
  accepted: number
  withWarnings: number
  rejected: number
  duplicates: number
}

export interface ImportPreview {
  importId: string
  fileName: string
  fileBytes: number
  headers: string[]
  mapping: ImportMapping
  dateFormat: ImportDateFormat
  /** Problems with the file or mapping as a whole; rows are not validated while any exist. */
  fileIssues: string[]
  rows: ImportRowView[]
  counts: ImportCounts
  duplicateEmailPolicy: 'warn' | 'reject'
}

export interface ImportResult {
  imported: number
  skipped: number
  counts: ImportCounts
}

// ---------- Asset register (M3) ----------

export interface CategoryView {
  id: string
  code: string
  name: string
  description: string | null
  assetDomain: AssetDomain
  trackingMode: TrackingMode
  serialRequired: boolean
  serialUnique: boolean
  isActive: boolean
  activeModelCount: number
  assetCount: number
}

export interface ModelView {
  id: string
  categoryId: string
  categoryName: string
  manufacturer: string
  modelName: string
  modelNumber: string | null
  specifications: string | null
  isActive: boolean
  assetCount: number
}

export interface SupplierView {
  id: string
  code: string | null
  name: string
  contactName: string | null
  email: string | null
  phone: string | null
  address: string | null
  taxReference: string | null
  notes: string | null
  isActive: boolean
  assetCount: number
}

export interface AssetCodeConfigView {
  prefix: string
  separator: '-' | '/' | ''
  padding: number
  nextNumber: number
  nextCodePreview: string
  issuedCount: number
}

export interface AssetListItem {
  id: string
  assetCode: string
  categoryName: string
  assetDomain: AssetDomain
  manufacturer: string | null
  modelName: string | null
  serialNumber: string | null
  lifecycleStatus: LifecycleStatus
  operationalStatus: OperationalStatus
  condition: AssetCondition
  locationPath: string | null
  warrantyEnd: string | null
  updatedAt: string
}

export interface DocumentLinkView {
  linkId: string
  documentId: string
  purpose: DocumentPurpose
  originalName: string
  mimeType: string
  byteSize: number
  uploadedAt: string
  uploadedByName: string | null
  openable: boolean
  /** True if the stored file is missing from disk (e.g. after manual tampering). */
  fileMissing: boolean
  /** Malware-scan state (D35). 'not_scanned' while no scanner is configured (U3 open). */
  scanStatus?: 'not_scanned' | 'pending' | 'clean' | 'rejected' | 'quarantined' | 'scan_failed'
}

export type WarrantyState = 'none' | 'active' | 'expiring' | 'expired'

export interface AssetDetail {
  id: string
  assetCode: string
  qrPayload: string
  categoryId: string
  categoryName: string
  assetDomain: AssetDomain
  serialRequired: boolean
  modelId: string | null
  manufacturer: string | null
  modelName: string | null
  serialNumber: string | null
  specifications: string | null
  lifecycleStatus: LifecycleStatus
  operationalStatus: OperationalStatus
  condition: AssetCondition
  locationId: string | null
  locationPath: string | null
  supplierId: string | null
  supplierName: string | null
  purchaseDate: string | null
  /** Cost fields are null unless the viewer holds finance.view_cost. */
  costVisible: boolean
  acquisitionCostMinor: number | null
  disposalProceedsMinor: number | null
  currency: string
  invoiceReference: string | null
  purchaseReference: string | null
  warrantyStart: string | null
  warrantyEnd: string | null
  warrantyState: WarrantyState
  disposalDate: string | null
  disposalMethod: DisposalMethod | null
  notes: string | null
  createdAt: string
  updatedAt: string
  documents: DocumentLinkView[]
  history: AuditEventView[]
}

export interface AssetLookupResult {
  matchType: 'asset_code' | 'qr' | 'serial' | 'none'
  matches: AssetListItem[]
  message: string
}

export interface AssetLabel {
  assetId: string
  assetCode: string
  organizationName: string
  qrDataUrl: string
  barcodeDataUrl: string
}

export interface ExportResult {
  saved: boolean
  rowCount: number
  fileName: string | null
}

// ---------- Command contract ----------

/** Every allow-listed IPC command, its input DTO and its committed result. */
export interface CommandMap {
  'system.getStartupState': { input: void; output: StartupState }
  'system.getInfo': { input: void; output: SystemInfo }
  'setup.complete': { input: SetupInput; output: { organizationId: string } }
  'session.login': { input: LoginInput; output: SessionInfo }
  'session.logout': { input: void; output: null }
  'session.getCurrent': { input: void; output: SessionInfo | null }
  'session.touch': { input: void; output: null }
  'session.lock': { input: void; output: null }
  'session.unlock': { input: UnlockInput; output: SessionInfo }
  'session.changePassword': { input: ChangePasswordInput; output: SessionInfo }
  'users.list': { input: void; output: UserSummary[] }
  'users.create': { input: CreateUserInput; output: UserSummary }
  'users.update': { input: UpdateUserInput; output: UserSummary }
  'users.resetPassword': { input: ResetPasswordInput; output: null }
  'roles.list': { input: void; output: RoleSummary[] }
  'roles.updatePermissions': { input: UpdateRolePermissionsInput; output: RoleSummary }
  'audit.list': { input: AuditListInput; output: Page<AuditEventView> }
  'settings.get': { input: void; output: AppSettings }
  'settings.update': { input: SettingsUpdateInput; output: AppSettings }
  'backup.create': { input: void; output: BackupSummary }
  'backup.list': { input: void; output: BackupSummary[] }
  'backup.validate': { input: { backupId: string }; output: BackupValidation }
  'backup.restore': { input: RestoreInput; output: RestoreOutcome }
  'dashboard.getSummary': { input: void; output: DashboardSummary }
  'departments.list': { input: ListInput; output: DepartmentView[] }
  'departments.create': { input: CreateDepartmentInput; output: DepartmentView }
  'departments.update': { input: UpdateDepartmentInput; output: DepartmentView }
  'departments.setActive': { input: SetActiveInput; output: DepartmentView }
  'teams.list': { input: TeamListInput; output: TeamView[] }
  'teams.create': { input: CreateTeamInput; output: TeamView }
  'teams.update': { input: UpdateTeamInput; output: TeamView }
  'teams.setActive': { input: SetActiveInput; output: TeamView }
  'locations.list': { input: ListInput; output: LocationView[] }
  'locations.create': { input: CreateLocationInput; output: LocationView }
  'locations.update': { input: UpdateLocationInput; output: LocationView }
  'locations.setActive': { input: SetActiveInput; output: LocationView }
  'workstations.list': { input: WorkstationListInput; output: WorkstationView[] }
  'workstations.create': { input: CreateWorkstationInput; output: WorkstationView }
  'workstations.update': { input: UpdateWorkstationInput; output: WorkstationView }
  'workstations.setActive': { input: SetActiveInput; output: WorkstationView }
  'pools.list': { input: ListInput; output: PoolView[] }
  'pools.create': { input: CreatePoolInput; output: PoolView }
  'pools.update': { input: UpdatePoolInput; output: PoolView }
  'pools.setActive': { input: SetActiveInput; output: PoolView }
  'employees.search': { input: EmployeeSearchInput; output: Page<EmployeeListItem> }
  'employees.get': { input: { id: string }; output: EmployeeDetail }
  'employees.create': { input: CreateEmployeeInput; output: EmployeeDetail }
  'employees.update': { input: UpdateEmployeeInput; output: EmployeeDetail }
  'employees.deactivate': { input: DeactivateEmployeeInput; output: EmployeeDetail }
  'employees.reactivate': { input: ReactivateEmployeeInput; output: EmployeeDetail }
  'employees.importSelectFile': { input: void; output: ImportPreview | null }
  'employees.importPreview': { input: ImportPreviewInput; output: ImportPreview }
  'employees.importCommit': { input: ImportCommitInput; output: ImportResult }
  'employees.importCancel': { input: { importId: string }; output: null }
  'categories.list': { input: CatalogListInput; output: CategoryView[] }
  'categories.create': { input: CreateCategoryInput; output: CategoryView }
  'categories.update': { input: UpdateCategoryInput; output: CategoryView }
  'categories.setActive': { input: SetActiveInput; output: CategoryView }
  'models.list': { input: CatalogListInput; output: ModelView[] }
  'models.create': { input: CreateModelInput; output: ModelView }
  'models.update': { input: UpdateModelInput; output: ModelView }
  'models.setActive': { input: SetActiveInput; output: ModelView }
  'suppliers.list': { input: CatalogListInput; output: SupplierView[] }
  'suppliers.create': { input: CreateSupplierInput; output: SupplierView }
  'suppliers.update': { input: UpdateSupplierInput; output: SupplierView }
  'suppliers.setActive': { input: SetActiveInput; output: SupplierView }
  'assets.getCodeConfig': { input: void; output: AssetCodeConfigView }
  'assets.updateCodeConfig': { input: AssetCodeConfigInput; output: AssetCodeConfigView }
  'assets.search': { input: AssetSearchInput; output: Page<AssetListItem> }
  'assets.get': { input: { id: string }; output: AssetDetail }
  'assets.create': { input: CreateAssetInput; output: AssetDetail }
  'assets.update': { input: UpdateAssetInput; output: AssetDetail }
  'assets.changeLifecycle': { input: ChangeLifecycleInput; output: AssetDetail }
  'assets.lookup': { input: AssetLookupInput; output: AssetLookupResult }
  'assets.generateLabels': { input: LabelRequestInput; output: AssetLabel[] }
  'assets.export': { input: AssetSearchInput; output: ExportResult }
  'documents.attach': { input: AttachDocumentInput; output: DocumentLinkView | null }
  'documents.removeLink': { input: RemoveDocumentLinkInput; output: null }
  // W4 (web only; not part of the desktop prototype)
  'allocations.list': { input: AssignmentListInput; output: Page<AssignmentView> }
  'allocations.custody': { input: { assetId: string }; output: AssetCustody }
  'allocations.getHandover': { input: { handoverId: string }; output: HandoverView }
  'allocations.issue': { input: IssueInput; output: HandoverView }
  'allocations.transfer': { input: TransferInput; output: HandoverView }
  'allocations.return': { input: ReturnInput; output: HandoverView }
  'allocations.acknowledge': { input: AcknowledgeInput; output: HandoverView }
  'allocations.inspect': { input: InspectInput; output: AssetCustody }
  'allocations.reportLost': { input: ReportLostInput; output: AssetCustody }
  'exitClearance.list': { input: ClearanceListInput; output: Page<ClearanceSummary> }
  'exitClearance.open': { input: OpenClearanceInput; output: ClearanceDetail }
  'exitClearance.get': { input: { clearanceId: string }; output: ClearanceDetail }
  'exitClearance.recordReturn': { input: RecordClearanceReturnInput; output: ClearanceDetail }
  'exitClearance.flagItem': { input: FlagClearanceItemInput; output: ClearanceDetail }
  'exitClearance.approveException': { input: ApproveExceptionInput; output: ClearanceDetail }
  'exitClearance.close': { input: CloseClearanceInput; output: ClearanceDetail }
  'exitClearance.cancel': { input: CancelClearanceInput; output: ClearanceDetail }
  // W5 (web only; not part of the desktop prototype)
  'maintenance.list': { input: TicketListInput; output: Page<MaintenanceTicketSummary> }
  'maintenance.get': { input: { ticketId: string }; output: MaintenanceTicketDetail }
  'maintenance.listTechnicians': { input: void; output: Array<{ id: string; displayName: string }> }
  'maintenance.create': { input: CreateTicketInput; output: MaintenanceTicketDetail }
  'maintenance.assign': { input: AssignTicketInput; output: MaintenanceTicketDetail }
  'maintenance.update': { input: UpdateTicketInput; output: MaintenanceTicketDetail }
  'maintenance.resolve': { input: ResolveTicketInput; output: MaintenanceTicketDetail }
  'maintenance.close': { input: CloseTicketInput; output: MaintenanceTicketDetail }
  'maintenance.cancel': { input: CancelTicketInput; output: MaintenanceTicketDetail }
  'audits.list': { input: PhysicalAuditListInput; output: Page<PhysicalAuditSummary> }
  'audits.get': { input: { auditId: string }; output: PhysicalAuditDetail }
  'audits.getItems': { input: AuditItemListInput; output: Page<AuditItemView> }
  'audits.listReviewers': { input: void; output: Array<{ id: string; displayName: string }> }
  'audits.create': { input: CreateAuditInput; output: PhysicalAuditDetail }
  'audits.verifyItem': { input: VerifyItemInput; output: AuditItemView }
  'audits.flagMissing': { input: FlagMissingInput; output: AuditItemView }
  'audits.assignDiscrepancy': { input: AssignDiscrepancyInput; output: AuditItemView }
  'audits.resolveDiscrepancy': { input: ResolveDiscrepancyInput; output: AuditItemView }
  'audits.correctLocation': { input: CorrectLocationInput; output: AuditItemView }
  'audits.acceptException': { input: AcceptExceptionInput; output: AuditItemView }
  'audits.close': { input: CloseAuditInput; output: PhysicalAuditDetail }
  'audits.cancel': { input: CancelAuditInput; output: PhysicalAuditDetail }
  'documents.open': { input: { documentId: string }; output: null }
  'documents.saveCopy': { input: { documentId: string }; output: { saved: boolean } }
  // W6 (web only; not part of the desktop prototype)
  'procurement.saveDraft': { input: SaveRequestDraftInput; output: PurchaseRequestDetail }
  'procurement.get': { input: { requestId: string }; output: PurchaseRequestDetail }
  'procurement.list': { input: RequestListInput; output: Page<PurchaseRequestSummary> }
  'procurement.submit': { input: { requestId: string }; output: PurchaseRequestDetail }
  'procurement.cancel': { input: { requestId: string; reason: string }; output: PurchaseRequestDetail }
  'approvals.savePolicy': { input: SaveApprovalPolicyInput; output: ApprovalPolicySummary }
  'approvals.listPolicies': { input: PolicyListInput; output: ApprovalPolicySummary[] }
  'approvals.decide': { input: DecideApprovalInput; output: PurchaseRequestDetail }
  'approvals.listQueue': { input: ApprovalQueueInput; output: Page<ApprovalQueueItem> }
  'orders.create': { input: CreateOrderInput; output: PurchaseOrderDetail }
  'orders.amend': { input: AmendOrderInput; output: PurchaseOrderDetail }
  'orders.cancel': { input: { poId: string; reason: string }; output: PurchaseOrderDetail }
  'orders.get': { input: { poId: string }; output: PurchaseOrderDetail }
  'orders.list': { input: OrderListInput; output: Page<PurchaseOrderSummary> }
  'receipts.create': { input: CreateReceiptInput; output: GoodsReceiptDetail }
  'receipts.resolveDiscrepancy': { input: ResolveReceiptDiscrepancyInput; output: GoodsReceiptDetail }
  'receipts.get': { input: { receiptId: string }; output: GoodsReceiptDetail }
  'receipts.list': { input: ReceiptListInput; output: Page<GoodsReceiptSummary> }
  // W7 (web only; not part of the desktop prototype)
  'reports.assetValuation': { input: AssetValuationReportInput; output: AssetValuationReport }
  'reports.maintenanceCost': { input: MaintenanceCostReportInput; output: MaintenanceCostReport }
  'reports.procurementSummary': { input: ProcurementSummaryReportInput; output: ProcurementSummaryReport }
  'reports.warranty': { input: WarrantyReportInput; output: WarrantyReport }
  'reports.disposals': { input: DisposalReportInput; output: DisposalReport }
}

export type CommandName = keyof CommandMap

export const COMMAND_NAMES = [
  'system.getStartupState',
  'system.getInfo',
  'setup.complete',
  'session.login',
  'session.logout',
  'session.getCurrent',
  'session.touch',
  'session.lock',
  'session.unlock',
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
  'backup.create',
  'backup.list',
  'backup.validate',
  'backup.restore',
  'dashboard.getSummary',
  'departments.list',
  'departments.create',
  'departments.update',
  'departments.setActive',
  'teams.list',
  'teams.create',
  'teams.update',
  'teams.setActive',
  'locations.list',
  'locations.create',
  'locations.update',
  'locations.setActive',
  'workstations.list',
  'workstations.create',
  'workstations.update',
  'workstations.setActive',
  'pools.list',
  'pools.create',
  'pools.update',
  'pools.setActive',
  'employees.search',
  'employees.get',
  'employees.create',
  'employees.update',
  'employees.deactivate',
  'employees.reactivate',
  'employees.importSelectFile',
  'employees.importPreview',
  'employees.importCommit',
  'employees.importCancel',
  'categories.list',
  'categories.create',
  'categories.update',
  'categories.setActive',
  'models.list',
  'models.create',
  'models.update',
  'models.setActive',
  'suppliers.list',
  'suppliers.create',
  'suppliers.update',
  'suppliers.setActive',
  'assets.getCodeConfig',
  'assets.updateCodeConfig',
  'assets.search',
  'assets.get',
  'assets.create',
  'assets.update',
  'assets.changeLifecycle',
  'assets.lookup',
  'assets.generateLabels',
  'assets.export',
  'documents.attach',
  'documents.removeLink',
  'documents.open',
  'documents.saveCopy'
] as const satisfies readonly CommandName[]

/** Commands that exist only in the web application (W4+); the desktop prototype never exposes them. */
export const WEB_ONLY_COMMAND_NAMES = [
  'allocations.list',
  'allocations.custody',
  'allocations.getHandover',
  'allocations.issue',
  'allocations.transfer',
  'allocations.return',
  'allocations.acknowledge',
  'allocations.inspect',
  'allocations.reportLost',
  'exitClearance.list',
  'exitClearance.open',
  'exitClearance.get',
  'exitClearance.recordReturn',
  'exitClearance.flagItem',
  'exitClearance.approveException',
  'exitClearance.close',
  'exitClearance.cancel',
  'maintenance.list',
  'maintenance.get',
  'maintenance.listTechnicians',
  'maintenance.create',
  'maintenance.assign',
  'maintenance.update',
  'maintenance.resolve',
  'maintenance.close',
  'maintenance.cancel',
  'audits.list',
  'audits.get',
  'audits.getItems',
  'audits.listReviewers',
  'audits.create',
  'audits.verifyItem',
  'audits.flagMissing',
  'audits.assignDiscrepancy',
  'audits.resolveDiscrepancy',
  'audits.correctLocation',
  'audits.acceptException',
  'audits.close',
  'audits.cancel',
  'procurement.saveDraft',
  'procurement.get',
  'procurement.list',
  'procurement.submit',
  'procurement.cancel',
  'approvals.savePolicy',
  'approvals.listPolicies',
  'approvals.decide',
  'approvals.listQueue',
  'orders.create',
  'orders.amend',
  'orders.cancel',
  'orders.get',
  'orders.list',
  'receipts.create',
  'receipts.resolveDiscrepancy',
  'receipts.get',
  'receipts.list',
  'reports.assetValuation',
  'reports.maintenanceCost',
  'reports.procurementSummary',
  'reports.warranty',
  'reports.disposals'
] as const satisfies readonly CommandName[]

/** Commands available to the frozen desktop prototype (its command table must cover exactly these). */
export type DesktopCommandName = (typeof COMMAND_NAMES)[number]

// Compile-time check that the two name lists cover every key of CommandMap.
type MissingCommands = Exclude<CommandName, (typeof COMMAND_NAMES)[number] | (typeof WEB_ONLY_COMMAND_NAMES)[number]>
const _exhaustive: MissingCommands extends never ? true : never = true
void _exhaustive

export const IPC_CHANNEL_PREFIX = 'bpoam:'

export function channelFor(command: CommandName): string {
  return `${IPC_CHANNEL_PREFIX}${command}`
}

type GroupOf<K> = K extends `${infer G}.${string}` ? G : never
type MethodOf<K, G extends string> = K extends `${G}.${infer M}` ? M : never

export type CommandFn<K extends CommandName> = CommandMap[K]['input'] extends void
  ? () => Promise<Result<CommandMap[K]['output']>>
  : (input: CommandMap[K]['input']) => Promise<Result<CommandMap[K]['output']>>

/** Shape of `window.api` exposed by the preload bridge (desktop commands only). */
export type AppApi = {
  [G in GroupOf<DesktopCommandName>]: {
    [K in DesktopCommandName as MethodOf<K, G>]: CommandFn<K>
  }
}
