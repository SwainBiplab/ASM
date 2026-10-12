import { z } from 'zod'
import {
  EDITABLE_EMPLOYMENT_STATUSES,
  EMPLOYMENT_STATUSES,
  IMPORT_DATE_FORMATS,
  IMPORT_FIELDS,
  LOCATION_TYPES,
  TEAM_KINDS,
  WORKSTATION_KINDS
} from './organization'
import { uuidSchema } from './schemas'

/** Input schemas for M2 organization and employee commands (strict: unknown keys rejected). */

const required = (max: number) => z.string().trim().min(1, 'Required').max(max, `Maximum ${max} characters`)

/** Optional text: empty strings become null so "clear this field" is explicit. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Maximum ${max} characters`)
    .nullable()
    .transform((v) => (v === '' || v === null ? null : v))

const codeText = optionalText(30).refine((v) => v === null || /^[A-Za-z0-9._/-]+$/.test(v), 'Use letters, digits, dot, slash, underscore or hyphen')

const optionalId = uuidSchema.nullable()

export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

export const isoDateSchema = z.string().trim().refine(isValidIsoDate, 'Use a valid date (YYYY-MM-DD)')
const optionalDate = isoDateSchema.nullable()

export const listInputSchema = z
  .strictObject({
    includeInactive: z.boolean().default(false),
    search: z.string().trim().max(100).optional()
  })
  .default({ includeInactive: false })
export type ListInput = z.input<typeof listInputSchema>

export const setActiveInputSchema = z.strictObject({
  id: uuidSchema,
  isActive: z.boolean(),
  reason: required(500)
})
export type SetActiveInput = z.infer<typeof setActiveInputSchema>

// ---------- Departments / teams ----------

const departmentFields = {
  code: codeText,
  name: required(120),
  managerEmployeeId: optionalId,
  notes: optionalText(1000)
}
export const createDepartmentSchema = z.strictObject(departmentFields)
export const updateDepartmentSchema = z.strictObject({ id: uuidSchema, ...departmentFields })
export type CreateDepartmentInput = z.input<typeof createDepartmentSchema>
export type UpdateDepartmentInput = z.input<typeof updateDepartmentSchema>

const teamFields = {
  departmentId: uuidSchema,
  kind: z.enum(TEAM_KINDS),
  code: codeText,
  name: required(120),
  leadEmployeeId: optionalId,
  notes: optionalText(1000)
}
export const createTeamSchema = z.strictObject(teamFields)
export const updateTeamSchema = z.strictObject({ id: uuidSchema, ...teamFields })
export type CreateTeamInput = z.input<typeof createTeamSchema>
export type UpdateTeamInput = z.input<typeof updateTeamSchema>

export const teamListInputSchema = z
  .strictObject({
    includeInactive: z.boolean().default(false),
    departmentId: uuidSchema.optional(),
    search: z.string().trim().max(100).optional()
  })
  .default({ includeInactive: false })
export type TeamListInput = z.input<typeof teamListInputSchema>

// ---------- Locations / workstations / pools ----------

const locationFields = {
  parentLocationId: optionalId,
  locationType: z.enum(LOCATION_TYPES),
  code: codeText,
  name: required(120),
  notes: optionalText(1000)
}
export const createLocationSchema = z.strictObject(locationFields)
export const updateLocationSchema = z.strictObject({ id: uuidSchema, ...locationFields })
export type CreateLocationInput = z.input<typeof createLocationSchema>
export type UpdateLocationInput = z.input<typeof updateLocationSchema>

const workstationFields = {
  locationId: uuidSchema,
  kind: z.enum(WORKSTATION_KINDS),
  code: required(30).regex(/^[A-Za-z0-9._/-]+$/, 'Use letters, digits, dot, slash, underscore or hyphen'),
  label: optionalText(120),
  notes: optionalText(1000)
}
export const createWorkstationSchema = z.strictObject(workstationFields)
export const updateWorkstationSchema = z.strictObject({ id: uuidSchema, ...workstationFields })
export type CreateWorkstationInput = z.input<typeof createWorkstationSchema>
export type UpdateWorkstationInput = z.input<typeof updateWorkstationSchema>

export const workstationListInputSchema = z
  .strictObject({
    includeInactive: z.boolean().default(false),
    locationId: uuidSchema.optional(),
    search: z.string().trim().max(100).optional()
  })
  .default({ includeInactive: false })
export type WorkstationListInput = z.input<typeof workstationListInputSchema>

const poolFields = {
  code: codeText,
  name: required(120),
  purpose: optionalText(500),
  responsibleDepartmentId: optionalId,
  responsibleTeamId: optionalId,
  defaultLocationId: optionalId
}
const responsibleRule = (v: { responsibleDepartmentId: string | null; responsibleTeamId: string | null }) =>
  v.responsibleDepartmentId !== null || v.responsibleTeamId !== null
const responsibleMessage = { message: 'Choose a responsible department or team', path: ['responsibleTeamId'] }
export const createPoolSchema = z.strictObject(poolFields).refine(responsibleRule, responsibleMessage)
export const updatePoolSchema = z.strictObject({ id: uuidSchema, ...poolFields }).refine(responsibleRule, responsibleMessage)
export type CreatePoolInput = z.input<typeof createPoolSchema>
export type UpdatePoolInput = z.input<typeof updatePoolSchema>

// ---------- Employees ----------

const employeeFields = {
  employeeCode: required(50).regex(/^[A-Za-z0-9._/-]+$/, 'Use letters, digits, dot, slash, underscore or hyphen'),
  fullName: required(150),
  email: optionalText(254).refine((v) => v === null || z.email().safeParse(v).success, 'Enter a valid email address'),
  phone: optionalText(30).refine((v) => v === null || /^[0-9+()\-\s.]{3,30}$/.test(v), 'Use digits, spaces and + ( ) - only'),
  jobTitle: optionalText(100),
  departmentId: optionalId,
  teamId: optionalId,
  managerEmployeeId: optionalId,
  workLocationId: optionalId,
  employmentStatus: z.enum(EDITABLE_EMPLOYMENT_STATUSES),
  joiningDate: optionalDate,
  expectedExitDate: optionalDate,
  notes: optionalText(1000)
}
export const createEmployeeSchema = z.strictObject(employeeFields)
export const updateEmployeeSchema = z.strictObject({ id: uuidSchema, ...employeeFields })
export type CreateEmployeeInput = z.input<typeof createEmployeeSchema>
export type UpdateEmployeeInput = z.input<typeof updateEmployeeSchema>

export const deactivateEmployeeSchema = z.strictObject({
  id: uuidSchema,
  actualExitDate: isoDateSchema,
  reason: required(500)
})
export type DeactivateEmployeeInput = z.infer<typeof deactivateEmployeeSchema>

export const reactivateEmployeeSchema = z.strictObject({ id: uuidSchema, reason: required(500) })
export type ReactivateEmployeeInput = z.infer<typeof reactivateEmployeeSchema>

export const employeeSearchSchema = z.strictObject({
  query: z.string().trim().max(100).optional(),
  departmentId: uuidSchema.optional(),
  teamId: uuidSchema.optional(),
  status: z.enum([...EMPLOYMENT_STATUSES, 'all', 'current']).default('current'),
  page: z.number().int().min(1).max(100000).default(1),
  pageSize: z.number().int().min(1).max(200).default(50)
})
export type EmployeeSearchInput = z.input<typeof employeeSearchSchema>

export const idInputSchema = z.strictObject({ id: uuidSchema })

// ---------- Import ----------

export const importIdSchema = z.string().regex(/^[0-9a-f]{32}$/, 'Invalid import identifier')

export const importMappingSchema = z.strictObject(
  Object.fromEntries(IMPORT_FIELDS.map((f) => [f, z.number().int().min(0).max(199).nullable()])) as Record<
    (typeof IMPORT_FIELDS)[number],
    z.ZodNullable<z.ZodNumber>
  >
)
export type ImportMapping = z.infer<typeof importMappingSchema>

export const importPreviewInputSchema = z.strictObject({
  importId: importIdSchema,
  mapping: importMappingSchema,
  dateFormat: z.enum(IMPORT_DATE_FORMATS)
})
export type ImportPreviewInput = z.infer<typeof importPreviewInputSchema>

export const importCommitInputSchema = z.strictObject({
  importId: importIdSchema,
  mapping: importMappingSchema,
  dateFormat: z.enum(IMPORT_DATE_FORMATS),
  /** When false (default), any rejected or duplicate row blocks the whole import. */
  skipInvalidRows: z.boolean()
})
export type ImportCommitInput = z.infer<typeof importCommitInputSchema>

export const importRefSchema = z.strictObject({ importId: importIdSchema })
