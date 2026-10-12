/** Organization constants shared by main and renderer (no validation library). */

export const LOCATION_TYPES = ['site', 'building', 'floor', 'room', 'bay', 'storage', 'other'] as const
export type LocationType = (typeof LOCATION_TYPES)[number]

export const LOCATION_TYPE_LABELS: Record<LocationType, string> = {
  site: 'Office / site',
  building: 'Building',
  floor: 'Floor',
  room: 'Room',
  bay: 'Bay',
  storage: 'Storage area',
  other: 'Other'
}

/**
 * Structural parent rules for the physical hierarchy (null = top level). These describe
 * physical containment, not business policy. `other` is a flexible escape hatch; cycles
 * are prevented by the service.
 */
export const LOCATION_PARENT_RULES: Record<LocationType, ReadonlyArray<LocationType | null>> = {
  site: [null],
  building: ['site'],
  floor: ['building'],
  room: ['floor'],
  bay: ['floor', 'room'],
  storage: ['site', 'building', 'floor', 'room'],
  other: [null, 'site', 'building', 'floor', 'room', 'bay', 'storage', 'other']
}

/** Location types that can directly contain workstations/seats. */
export const WORKSTATION_LOCATION_TYPES: ReadonlyArray<LocationType> = ['floor', 'room', 'bay', 'other']

export const WORKSTATION_KINDS = ['workstation', 'seat'] as const
export type WorkstationKind = (typeof WORKSTATION_KINDS)[number]

export const TEAM_KINDS = ['team', 'process'] as const
export type TeamKind = (typeof TEAM_KINDS)[number]

export const EMPLOYMENT_STATUSES = ['active', 'on_leave', 'notice_period', 'exited'] as const
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number]
/** Statuses settable by normal edits; `exited` is set only through deactivation. */
export const EDITABLE_EMPLOYMENT_STATUSES = ['active', 'on_leave', 'notice_period'] as const

export const EMPLOYMENT_STATUS_LABELS: Record<EmploymentStatus, string> = {
  active: 'Active',
  on_leave: 'On leave',
  notice_period: 'Notice period',
  exited: 'Exited'
}

// ---------- Employee CSV import ----------

export const IMPORT_FIELDS = [
  'employeeCode',
  'fullName',
  'email',
  'phone',
  'jobTitle',
  'department',
  'team',
  'managerCode',
  'workLocation',
  'employmentStatus',
  'joiningDate',
  'expectedExitDate'
] as const
export type ImportField = (typeof IMPORT_FIELDS)[number]

export const REQUIRED_IMPORT_FIELDS: ReadonlyArray<ImportField> = ['employeeCode', 'fullName']

export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  employeeCode: 'Employee ID',
  fullName: 'Full name',
  email: 'Email',
  phone: 'Phone',
  jobTitle: 'Job title',
  department: 'Department (name or code)',
  team: 'Team / process (name or code)',
  managerCode: "Manager's employee ID",
  workLocation: 'Work location (code or name)',
  employmentStatus: 'Employment status',
  joiningDate: 'Joining date',
  expectedExitDate: 'Expected exit date'
}

export const IMPORT_DATE_FORMATS = ['YYYY-MM-DD', 'DD-MM-YYYY', 'MM-DD-YYYY'] as const
export type ImportDateFormat = (typeof IMPORT_DATE_FORMATS)[number]

/** Hard safety limits for a single import file. */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024
export const IMPORT_MAX_ROWS = 10_000
