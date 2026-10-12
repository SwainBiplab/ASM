/** Offline desktop agent: device enrollment and exclusive leases (W9.2, TAS W9 §4/§8). Shared by server and any future admin UI/CLI. */

export const DEVICE_STATUSES = ['pending', 'active', 'revoked'] as const
export type DeviceStatus = (typeof DEVICE_STATUSES)[number]

export const LEASE_SCOPE_TYPES = ['asset', 'asset_code_range'] as const
export type LeaseScopeType = (typeof LEASE_SCOPE_TYPES)[number]

export const LEASE_STATUSES = ['active', 'expired', 'released', 'reclaimed'] as const
export type LeaseStatus = (typeof LEASE_STATUSES)[number]

/** Approved maximum offline grant duration (DECISIONS.md D49/A). Not configurable per-request. */
export const MAX_LEASE_HOURS = 8
