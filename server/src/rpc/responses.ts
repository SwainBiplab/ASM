import { z } from 'zod'
import type { AuditEventView, BackupSummary, DashboardSummary, Page, PasswordResetRequestSummary, RoleSummary, SessionInfo, StartupState, UserSummary } from '@shared/api'
import { ALL_PERMISSION_KEYS, type PermissionKey } from '@shared/permissions'
import { settingsSchema } from '@shared/schemas'

/**
 * Output schemas (D34). Parsing a handler result through these strips undeclared keys, so
 * nothing leaves the server unless it is part of the shared DTO. Each schema is checked against
 * its DTO type at compile time (`z.ZodType<Dto>`).
 */

export const iso = z.string().min(1)
export const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
export const uuid = z.string().uuid()
export const nullable = <T extends z.ZodTypeAny>(t: T) => t.nullable()
export const permissionKey = z.enum(ALL_PERMISSION_KEYS as [PermissionKey, ...PermissionKey[]])

export function pageOf<T>(item: z.ZodType<T>): z.ZodType<Page<T>> {
  return z.object({ items: z.array(item), total: z.number().int().min(0), page: z.number().int().min(1), pageSize: z.number().int().min(1) })
}

export const nullOutput: z.ZodType<null> = z.null()

export const startupStateOutput: z.ZodType<StartupState> = z.object({
  status: z.enum(['ready', 'setup_required', 'database_error']),
  appVersion: z.string(),
  environment: z.enum(['development', 'test', 'production']),
  error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }).optional(),
  dataDirectory: z.string().optional()
})

export const sessionInfoOutput: z.ZodType<SessionInfo> = z.object({
  user: z.object({ id: uuid, username: z.string(), displayName: z.string(), mustChangePassword: z.boolean() }),
  permissions: z.array(permissionKey),
  roles: z.array(z.string()),
  idleTimeoutMinutes: z.number().int(),
  locked: z.boolean()
})

export const userSummaryOutput: z.ZodType<UserSummary> = z.object({
  id: uuid,
  username: z.string(),
  displayName: z.string(),
  isActive: z.boolean(),
  mustChangePassword: z.boolean(),
  lastLoginAt: nullable(iso),
  roleKeys: z.array(z.string()),
  createdAt: iso
})

export const passwordResetRequestSummaryOutput: z.ZodType<PasswordResetRequestSummary> = z.object({
  id: uuid,
  userId: uuid,
  username: z.string(),
  displayName: z.string(),
  message: nullable(z.string()),
  status: z.enum(['pending', 'resolved', 'dismissed']),
  requestedAt: iso,
  resolvedAt: nullable(iso)
})

export const roleSummaryOutput: z.ZodType<RoleSummary> = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  isSystem: z.boolean(),
  permissions: z.array(permissionKey),
  userCount: z.number().int()
})

export const auditEventOutput: z.ZodType<AuditEventView> = z.object({
  id: uuid,
  occurredAt: iso,
  actorUserId: nullable(uuid),
  actorName: nullable(z.string()),
  eventType: z.string(),
  entityType: z.string(),
  entityId: nullable(z.string()),
  reason: nullable(z.string()),
  correlationId: z.string(),
  summary: nullable(z.record(z.string(), z.unknown()))
})

const backupSummaryOutput: z.ZodType<BackupSummary> = z.object({
  backupId: z.string(),
  kind: z.enum(['manual', 'automatic', 'pre_migration', 'pre_restore']),
  createdAt: iso,
  appVersion: z.string(),
  schemaVersion: z.number().int(),
  databaseBytes: z.number().int(),
  documentCount: z.number().int(),
  verified: z.boolean()
})

const assetMetricsOutput = z.object({
  totalActive: z.number().int(),
  ready: z.number().int(),
  underMaintenance: z.number().int(),
  awaitingInspection: z.number().int(),
  nonOperational: z.number().int(),
  lost: z.number().int(),
  retired: z.number().int(),
  disposed: z.number().int(),
  warrantyExpiringSoon: z.number().int(),
  warrantyWindowDays: z.number().int(),
  assigned: z.number().int().optional(),
  available: z.number().int().optional()
})

export const dashboardOutput: z.ZodType<DashboardSummary> = z.object({
  organizationName: z.string(),
  activeUsers: z.number().int(),
  lastBackup: nullable(backupSummaryOutput),
  auditEventsLast7Days: z.number().int(),
  schemaVersion: z.number().int(),
  assets: nullable(assetMetricsOutput),
  allocations: z.object({ active: z.number().int(), overdueReturns: z.number().int() }).nullable().optional(),
  exitClearances: z.object({ open: z.number().int(), withUnresolvedItems: z.number().int() }).nullable().optional(),
  maintenance: z.object({ open: z.number().int(), overdue: z.number().int() }).nullable().optional(),
  audits: z.object({ open: z.number().int(), withUnresolvedItems: z.number().int() }).nullable().optional(),
  procurement: z.object({ draftRequests: z.number().int(), pendingApprovals: z.number().int(), openDiscrepancies: z.number().int() }).nullable().optional(),
  finance: z.object({ acquisitionValueByCurrency: z.array(z.object({ currency: z.string(), totalMinor: z.number().int(), count: z.number().int() })) }).nullable().optional(),
  pendingPasswordResets: z.number().int().nullable().optional()
})

export const settingsOutput = settingsSchema
