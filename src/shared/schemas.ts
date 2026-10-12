import { z } from 'zod'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, RESTORE_CONFIRMATION_PHRASE } from './constants'
import { ALL_PERMISSION_KEYS } from './permissions'
import { ACKNOWLEDGMENT_POLICIES } from './allocations'

export { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, RESTORE_CONFIRMATION_PHRASE }

/**
 * Input schemas for every IPC command. The renderer may use them for form feedback,
 * but the main process always re-validates (TAS §3.3). Strict objects reject unknown keys.
 */


const trimmed = (max: number) => z.string().trim().min(1, 'Required').max(max, `Maximum ${max} characters`)

export const usernameSchema = z
  .string()
  .trim()
  .min(3, 'At least 3 characters')
  .max(64, 'Maximum 64 characters')
  .regex(/^[A-Za-z0-9._-]+$/, 'Use letters, digits, dot, underscore or hyphen only')

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `At least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Maximum ${PASSWORD_MAX_LENGTH} characters`)

export const timezoneSchema = z
  .string()
  .trim()
  .min(1, 'Required')
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz })
      return true
    } catch {
      return false
    }
  }, 'Unknown time zone')

export const currencySchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO currency code, e.g. INR')

export const uuidSchema = z.uuid('Invalid identifier')

export const roleKeySchema = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/, 'Invalid role key')

export const setupInputSchema = z.strictObject({
  organization: z.strictObject({
    legalName: trimmed(200),
    displayName: trimmed(100),
    baseCurrency: currencySchema,
    timezone: timezoneSchema
  }),
  admin: z.strictObject({
    username: usernameSchema,
    displayName: trimmed(100),
    password: passwordSchema
  })
})
export type SetupInput = z.infer<typeof setupInputSchema>

export const loginInputSchema = z.strictObject({
  username: z.string().trim().min(1, 'Required').max(64),
  password: z.string().min(1, 'Required').max(PASSWORD_MAX_LENGTH)
})
export type LoginInput = z.infer<typeof loginInputSchema>

export const unlockInputSchema = z.strictObject({
  password: z.string().min(1, 'Required').max(PASSWORD_MAX_LENGTH)
})
export type UnlockInput = z.infer<typeof unlockInputSchema>

export const changePasswordInputSchema = z.strictObject({
  currentPassword: z.string().min(1, 'Required').max(PASSWORD_MAX_LENGTH),
  newPassword: passwordSchema
})
export type ChangePasswordInput = z.infer<typeof changePasswordInputSchema>

export const createUserInputSchema = z.strictObject({
  username: usernameSchema,
  displayName: trimmed(100),
  password: passwordSchema,
  roleKeys: z.array(roleKeySchema).max(20)
})
export type CreateUserInput = z.infer<typeof createUserInputSchema>

export const updateUserInputSchema = z.strictObject({
  id: uuidSchema,
  displayName: trimmed(100).optional(),
  isActive: z.boolean().optional(),
  roleKeys: z.array(roleKeySchema).max(20).optional(),
  reason: z.string().trim().max(500).optional()
})
export type UpdateUserInput = z.infer<typeof updateUserInputSchema>

export const resetPasswordInputSchema = z.strictObject({
  id: uuidSchema,
  newPassword: passwordSchema
})
export type ResetPasswordInput = z.infer<typeof resetPasswordInputSchema>

export const updateRolePermissionsInputSchema = z.strictObject({
  roleKey: roleKeySchema,
  permissions: z.array(z.enum(ALL_PERMISSION_KEYS as [string, ...string[]])).max(200),
  reason: z.string().trim().min(1, 'A reason is required for permission changes').max(500)
})
export type UpdateRolePermissionsInput = z.infer<typeof updateRolePermissionsInputSchema>

export const auditListInputSchema = z.strictObject({
  page: z.number().int().min(1).max(100000).default(1),
  pageSize: z.number().int().min(1).max(200).default(50),
  eventType: z.string().trim().max(100).optional(),
  entityType: z.string().trim().max(100).optional()
})
export type AuditListInput = z.input<typeof auditListInputSchema>

/** Allow-listed application settings (TAS §8.8 app_settings). */
export const settingsSchema = z.strictObject({
  idleTimeoutMinutes: z.number().int().min(1).max(240),
  backupRetentionCount: z.number().int().min(2).max(365),
  warrantyExpiryWindowDays: z.number().int().min(1).max(730),
  scannerSuffix: z.enum(['enter', 'tab', 'none']),
  /** How a duplicate email (in file or vs existing employees) is treated. Employee ID is always unique. */
  employeeDuplicateEmailPolicy: z.enum(['warn', 'reject']),
  /** Handover acknowledgment policy (TAS B3, D39). Used by the web app; the prototype ignores it. */
  handoverAcknowledgment: z.enum(ACKNOWLEDGMENT_POLICIES)
})
export type AppSettings = z.infer<typeof settingsSchema>

export const DEFAULT_SETTINGS: AppSettings = {
  idleTimeoutMinutes: 15,
  backupRetentionCount: 14,
  warrantyExpiryWindowDays: 60,
  scannerSuffix: 'enter',
  employeeDuplicateEmailPolicy: 'warn',
  handoverAcknowledgment: 'in_app'
}

export const settingsUpdateInputSchema = settingsSchema.partial().strict()
export type SettingsUpdateInput = z.infer<typeof settingsUpdateInputSchema>

/** Backup IDs are generated by the main process; never accept a path from the renderer. */
export const backupIdSchema = z.string().regex(/^[0-9]{8}T[0-9]{6}Z-[a-z_]+-[0-9a-f]{8}$/, 'Invalid backup identifier')

export const backupRefInputSchema = z.strictObject({ backupId: backupIdSchema })

export const restoreInputSchema = z.strictObject({
  backupId: backupIdSchema,
  confirmation: z.literal(RESTORE_CONFIRMATION_PHRASE, {
    error: `Type ${RESTORE_CONFIRMATION_PHRASE} to confirm`
  })
})
export type RestoreInput = z.infer<typeof restoreInputSchema>

export const voidInputSchema = z.undefined()
