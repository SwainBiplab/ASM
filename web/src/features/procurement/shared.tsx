import { useEffect, useState } from 'react'
import { REQUEST_STATUS_LABELS, ORDER_STATUS_LABELS, RECEIPT_DISCREPANCY_LABELS, type RequestStatus, type OrderStatus, type ReceiptDiscrepancyStatus } from '@shared/procurement'
import type { CategoryView, DepartmentView, LocationView, RoleSummary, SupplierView, UserSummary } from '@shared/api'
import { call } from '../../api'

export function RequestStatusBadge({ status }: { status: RequestStatus }) {
  const cls = status === 'approved' ? 'badge--ok' : status === 'rejected' || status === 'cancelled' ? 'badge--off' : status === 'submitted' ? 'badge--warn' : ''
  return <span className={`badge ${cls}`}>{REQUEST_STATUS_LABELS[status]}</span>
}

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const cls = status === 'received' ? 'badge--ok' : status === 'cancelled' ? 'badge--off' : status === 'partially_received' ? 'badge--warn' : ''
  return <span className={`badge ${cls}`}>{ORDER_STATUS_LABELS[status]}</span>
}

export function DiscrepancyBadge({ status }: { status: ReceiptDiscrepancyStatus }) {
  const cls = status === 'open' ? 'badge--off' : status === 'resolved' ? 'badge--ok' : ''
  return <span className={`badge ${cls}`}>{RECEIPT_DISCREPANCY_LABELS[status]}</span>
}

function useList<T>(command: 'categories.list' | 'suppliers.list' | 'users.list' | 'roles.list' | 'locations.list' | 'departments.list', input?: unknown): T[] {
  const [list, setList] = useState<T[]>([])
  useEffect(() => {
    call(command, input as never).then((r) => setList(r as T[]), () => setList([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command])
  return list
}

export const useCategories = (): CategoryView[] => useList<CategoryView>('categories.list', { includeInactive: false })
export const useSuppliers = (): SupplierView[] => useList<SupplierView>('suppliers.list', { includeInactive: false })
export const useUsers = (): UserSummary[] => useList<UserSummary>('users.list')
export const useRoles = (): RoleSummary[] => useList<RoleSummary>('roles.list')
export const useLocations = (): LocationView[] => useList<LocationView>('locations.list', { includeInactive: false })
export const useDepartments = (): DepartmentView[] => useList<DepartmentView>('departments.list', { includeInactive: false })
