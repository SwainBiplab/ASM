/** Maintenance ticket constants (W5, TAS §11). Shared by the server and the browser. */

export const MAINTENANCE_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const
export type MaintenancePriority = (typeof MAINTENANCE_PRIORITIES)[number]
export const MAINTENANCE_PRIORITY_LABELS: Record<MaintenancePriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical'
}

export const FAULT_CATEGORIES = ['hardware', 'software', 'electrical', 'mechanical', 'cosmetic', 'other'] as const
export type FaultCategory = (typeof FAULT_CATEGORIES)[number]
export const FAULT_CATEGORY_LABELS: Record<FaultCategory, string> = {
  hardware: 'Hardware fault',
  software: 'Software fault',
  electrical: 'Electrical fault',
  mechanical: 'Mechanical fault',
  cosmetic: 'Cosmetic damage',
  other: 'Other'
}

/** A ticket is a distinct record; closing it never overwrites the earlier service events (TAS §11.2). */
export const TICKET_STATUSES = ['open', 'in_progress', 'resolved', 'closed', 'cancelled'] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]
export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved, pending closure',
  closed: 'Closed',
  cancelled: 'Cancelled'
}

export const TICKET_EVENT_TYPES = ['created', 'assigned', 'updated', 'resolved', 'closed', 'cancelled'] as const
export type TicketEventType = (typeof TICKET_EVENT_TYPES)[number]
export const TICKET_EVENT_LABELS: Record<TicketEventType, string> = {
  created: 'Ticket created',
  assigned: 'Technician assigned',
  updated: 'Work updated',
  resolved: 'Marked resolved',
  closed: 'Closed',
  cancelled: 'Cancelled'
}
