/** Asset register constants and pure helpers shared by main and renderer (no validation library). */
import type { PermissionKey } from './permissions'

export const LIFECYCLE_STATUSES = ['active', 'retired', 'disposed', 'lost'] as const
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number]

export const OPERATIONAL_STATUSES = ['ready', 'under_maintenance', 'non_operational', 'awaiting_inspection'] as const
export type OperationalStatus = (typeof OPERATIONAL_STATUSES)[number]
/** `under_maintenance` is reserved for maintenance tickets (M5) and cannot be set by hand. */
export const MANUAL_OPERATIONAL_STATUSES = ['ready', 'non_operational', 'awaiting_inspection'] as const

export const CONDITIONS = ['new', 'good', 'fair', 'damaged', 'unknown'] as const
export type AssetCondition = (typeof CONDITIONS)[number]

export const ASSET_DOMAINS = ['it', 'facilities'] as const
export type AssetDomain = (typeof ASSET_DOMAINS)[number]

export const TRACKING_MODES = ['individual', 'bulk'] as const
export type TrackingMode = (typeof TRACKING_MODES)[number]

export const DISPOSAL_METHODS = ['sold', 'scrapped', 'donated', 'returned_to_vendor', 'written_off', 'other'] as const
export type DisposalMethod = (typeof DISPOSAL_METHODS)[number]

export const LIFECYCLE_LABELS: Record<LifecycleStatus, string> = { active: 'Active', retired: 'Retired', disposed: 'Disposed', lost: 'Lost' }
export const OPERATIONAL_LABELS: Record<OperationalStatus, string> = {
  ready: 'Ready',
  under_maintenance: 'Under maintenance',
  non_operational: 'Not working',
  awaiting_inspection: 'Awaiting inspection'
}
export const CONDITION_LABELS: Record<AssetCondition, string> = { new: 'New', good: 'Good', fair: 'Fair', damaged: 'Damaged', unknown: 'Unknown' }
export const DOMAIN_LABELS: Record<AssetDomain, string> = { it: 'IT', facilities: 'Facilities' }
export const DISPOSAL_LABELS: Record<DisposalMethod, string> = {
  sold: 'Sold',
  scrapped: 'Scrapped / e-waste',
  donated: 'Donated',
  returned_to_vendor: 'Returned to vendor',
  written_off: 'Written off',
  other: 'Other'
}

export interface LifecycleTransition {
  label: string
  permission: PermissionKey
}

/**
 * Allowed lifecycle moves (TAS §7.1). Disposed is final. M4 adds: an asset with an active
 * assignment cannot be retired, reported lost or disposed until it is returned.
 */
export const LIFECYCLE_TRANSITIONS: Record<LifecycleStatus, Partial<Record<LifecycleStatus, LifecycleTransition>>> = {
  active: {
    retired: { label: 'Retire', permission: 'assets.retire' },
    lost: { label: 'Report lost', permission: 'assets.retire' }
  },
  retired: {
    active: { label: 'Reinstate', permission: 'assets.retire' },
    disposed: { label: 'Dispose', permission: 'assets.dispose' }
  },
  lost: {
    active: { label: 'Mark as found', permission: 'assets.retire' },
    disposed: { label: 'Write off', permission: 'assets.dispose' }
  },
  disposed: {}
}

// ---------- Identification ----------

/** QR payload: opaque, non-secret, resolvable only by this application (TAS §10.1). */
export const QR_PREFIX = 'BPOAM:ASSET:'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const qrPayloadFor = (assetId: string): string => `${QR_PREFIX}${assetId}`

export function parseQrPayload(value: string): string | null {
  const v = value.trim()
  if (!v.toUpperCase().startsWith(QR_PREFIX)) return null
  const id = v.slice(QR_PREFIX.length)
  return UUID_RE.test(id) ? id.toLowerCase() : null
}

export interface AssetCodeFormat {
  prefix: string
  separator: '-' | '/' | ''
  padding: number
}

/** Formats a sequence number, e.g. AST + '-' + 000001. Longer numbers are never truncated. */
export function formatAssetCode(format: AssetCodeFormat, n: number): string {
  return `${format.prefix}${format.separator}${String(n).padStart(format.padding, '0')}`
}

// ---------- Money (integer minor units, never floating point) ----------

/** Number of minor-unit digits for a currency (INR 2, JPY 0, KWD 3). */
export function currencyMinorDigits(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
  } catch {
    return 2
  }
}

/** Parses "1,23,456.78" into minor units without floating-point arithmetic; null if invalid. */
export function parseMoneyToMinor(input: string, currency: string): number | null {
  const s = input.trim().replace(/[,\s]/g, '')
  const digits = currencyMinorDigits(currency)
  const m = /^(\d{1,13})(?:\.(\d+))?$/.exec(s)
  if (!m) return null
  const frac = m[2] ?? ''
  if (frac.length > digits) return null
  const minor = Number(m[1]) * 10 ** digits + Number(frac.padEnd(digits, '0') || '0')
  return Number.isSafeInteger(minor) ? minor : null
}

export function formatMinor(minor: number | null, currency: string): string {
  if (minor === null) return '—'
  const digits = currencyMinorDigits(currency)
  const major = Math.trunc(minor / 10 ** digits)
  const frac = digits ? String(minor % 10 ** digits).padStart(digits, '0') : ''
  const grouped = new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US').format(major)
  return `${currency} ${grouped}${digits ? `.${frac}` : ''}`
}

export function minorToInput(minor: number | null, currency: string): string {
  if (minor === null) return ''
  const digits = currencyMinorDigits(currency)
  if (!digits) return String(minor)
  return `${Math.trunc(minor / 10 ** digits)}.${String(minor % 10 ** digits).padStart(digits, '0')}`
}

// ---------- Documents ----------

export const DOCUMENT_PURPOSES = ['invoice', 'warranty', 'purchase_order', 'handover', 'photo', 'repair_evidence', 'audit_evidence', 'disposal', 'other'] as const
export type DocumentPurpose = (typeof DOCUMENT_PURPOSES)[number]
export const DOCUMENT_PURPOSE_LABELS: Record<DocumentPurpose, string> = {
  invoice: 'Invoice',
  warranty: 'Warranty',
  purchase_order: 'Purchase order',
  handover: 'Handover form',
  photo: 'Photo',
  repair_evidence: 'Repair evidence',
  audit_evidence: 'Audit evidence',
  disposal: 'Disposal record',
  other: 'Other'
}

/** Entity types that may own documents; extended by later milestones. */
export const DOCUMENT_OWNER_TYPES = ['asset'] as const
export type DocumentOwnerType = (typeof DOCUMENT_OWNER_TYPES)[number]

export interface AllowedDocumentType {
  mime: string
  /** Safe to open with the system's default viewer. Office files are offered as "save a copy". */
  openable: boolean
}
export const ALLOWED_DOCUMENT_TYPES: Record<string, AllowedDocumentType> = {
  pdf: { mime: 'application/pdf', openable: true },
  png: { mime: 'image/png', openable: true },
  jpg: { mime: 'image/jpeg', openable: true },
  jpeg: { mime: 'image/jpeg', openable: true },
  webp: { mime: 'image/webp', openable: true },
  txt: { mime: 'text/plain', openable: true },
  csv: { mime: 'text/csv', openable: false },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', openable: false },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', openable: false }
}
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024

export const ASSET_SORTS = ['code', 'created', 'warranty', 'category'] as const
export type AssetSort = (typeof ASSET_SORTS)[number]
export const WARRANTY_FILTERS = ['any', 'in_warranty', 'expiring', 'expired', 'none'] as const
export type WarrantyFilter = (typeof WARRANTY_FILTERS)[number]
