import type { PermissionKey } from './permissions'

/**
 * Bulk CSV/Excel import for the seven simple reference-data entities (categories, models,
 * suppliers, departments, teams, locations, workstations) -- a one-time bulk-load mechanism for
 * initial setup, modeled on the existing employee/asset importers but sharing one generic engine
 * since these entities are far simpler (no server-issued codes, no manager-loop-style resolution).
 */

export const REFERENCE_IMPORT_KINDS = ['categories', 'models', 'suppliers', 'departments', 'teams', 'locations', 'workstations'] as const
export type ReferenceImportKind = (typeof REFERENCE_IMPORT_KINDS)[number]

export const REFERENCE_IMPORT_KIND_LABELS: Record<ReferenceImportKind, string> = {
  categories: 'categories',
  models: 'models',
  suppliers: 'suppliers',
  departments: 'departments',
  teams: 'teams',
  locations: 'locations',
  workstations: 'workstations'
}

export interface ReferenceImportFieldDef {
  key: string
  label: string
  required: boolean
}

/** Column definitions per kind, in the order shown in the mapping UI. Parent references (category,
 * department, location) resolve only against records that already exist -- never same-file forward
 * references -- so a hierarchy import needs parents uploaded (or already present) before children. */
export const REFERENCE_IMPORT_FIELDS: Record<ReferenceImportKind, readonly ReferenceImportFieldDef[]> = {
  categories: [
    { key: 'code', label: 'Code', required: true },
    { key: 'name', label: 'Name', required: true },
    { key: 'assetDomain', label: 'Domain (IT or Facilities)', required: true },
    { key: 'trackingMode', label: 'Tracking (Individual or Bulk)', required: false },
    { key: 'serialRequired', label: 'Serial number required (Yes/No)', required: false },
    { key: 'serialUnique', label: 'Serial number unique (Yes/No)', required: false },
    { key: 'description', label: 'Description', required: false }
  ],
  models: [
    { key: 'category', label: 'Category (name or code)', required: true },
    { key: 'manufacturer', label: 'Manufacturer', required: true },
    { key: 'modelName', label: 'Model name', required: true },
    { key: 'modelNumber', label: 'Model number', required: false },
    { key: 'specifications', label: 'Specifications', required: false }
  ],
  suppliers: [
    { key: 'name', label: 'Name', required: true },
    { key: 'code', label: 'Code', required: false },
    { key: 'contactName', label: 'Contact name', required: false },
    { key: 'email', label: 'Email', required: false },
    { key: 'phone', label: 'Phone', required: false },
    { key: 'address', label: 'Address', required: false },
    { key: 'taxReference', label: 'Tax reference', required: false }
  ],
  departments: [
    { key: 'name', label: 'Name', required: true },
    { key: 'code', label: 'Code', required: false }
  ],
  teams: [
    { key: 'department', label: 'Department (name or code)', required: true },
    { key: 'name', label: 'Name', required: true },
    { key: 'code', label: 'Code', required: false },
    { key: 'kind', label: 'Kind (Team or Process)', required: false }
  ],
  locations: [
    { key: 'name', label: 'Name', required: true },
    { key: 'locationType', label: 'Type (Site, Building, Floor, Room, Bay, Storage or Other)', required: true },
    { key: 'parentLocation', label: 'Parent location (name of an existing location)', required: false },
    { key: 'code', label: 'Code', required: false }
  ],
  workstations: [
    { key: 'location', label: 'Location (name of an existing floor, room or bay)', required: true },
    { key: 'code', label: 'Code', required: true },
    { key: 'kind', label: 'Kind (Workstation or Seat)', required: false },
    { key: 'label', label: 'Label', required: false }
  ]
}

/** Same permission gate as creating one of these by hand (W2 services). */
export const REFERENCE_IMPORT_PERMISSION: Record<ReferenceImportKind, PermissionKey> = {
  categories: 'reference_data.manage',
  models: 'reference_data.manage',
  suppliers: 'suppliers.manage',
  departments: 'locations.manage',
  teams: 'locations.manage',
  locations: 'locations.manage',
  workstations: 'locations.manage'
}
