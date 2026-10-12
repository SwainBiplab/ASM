/** Accounts created by the E2E fixtures (test database only). */
export const E2E_ORG = { legalName: 'E2E BPO Services Pvt Ltd', displayName: 'E2E BPO', baseCurrency: 'INR', timezone: 'Asia/Kolkata' }
export const E2E_ADMIN = { username: 'admin', displayName: 'Ada Admin', password: 'Admin-E2E-Pass-1' }
export const E2E_USERS = {
  /** Asset register + export, but no cost visibility and no employee management. */
  assetManager: { username: 'assetmgr', displayName: 'Asha Asset Manager', password: 'Asset-E2E-Pass-1', roleKeys: ['asset_manager'], mustChangePassword: false },
  /** Employees only: no asset register access at all. */
  hr: { username: 'hrofficer', displayName: 'Harini HR Officer', password: 'Hr-E2E-Pass-123', roleKeys: ['hr_officer'], mustChangePassword: false },
  /** Must replace the administrator-set password at first sign-in. */
  newStaff: { username: 'newstaff', displayName: 'Nikhil New Staff', password: 'Temp-E2E-Pass-1', roleKeys: ['auditor'], mustChangePassword: true }
} as const
