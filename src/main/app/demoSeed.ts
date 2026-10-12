import type { PermissionKey } from '@shared/permissions'
import type { EmploymentStatus, LocationType } from '@shared/organization'
import { loadUserPermissions } from '../auth/permissions'
import * as org from '../services/organization'
import * as catalog from '../services/catalog'
import * as assets from '../services/assets'
import { createEmployee, deactivateEmployee } from '../services/employees'
import { createUser } from '../services/users'
import { completeSetup } from '../services/setup'
import type { OpContext } from '../services/context'
import type { AppContainer } from './container'
import { newCorrelationId } from './ids'

/**
 * Development-only demo data (`npm run seed:demo`). Goes through the normal services, so
 * every record is validated and audited exactly like user-entered data.
 */
export const DEMO_ADMIN = { username: 'admin', password: 'Admin-Pass-123' }
export const DEMO_USER_PASSWORD = 'Demo-Pass-123'

const FIRST = ['Aarav', 'Priya', 'Rohan', 'Ananya', 'Vikram', 'Sneha', 'Arjun', 'Kavya', 'Rahul', 'Isha', 'Karan', 'Meera', 'Siddharth', 'Pooja', 'Aditya', 'Neha', 'Nikhil', 'Divya', 'Manish', 'Riya', 'Suresh', 'Lakshmi', 'Imran', 'Fatima', 'Joseph', 'Mary', 'Harpreet', 'Gurleen', 'Deepak', 'Swati', 'Amit', 'Shreya', 'Varun', 'Nisha', 'Rajesh', 'Anjali', 'Sameer', 'Tanvi', 'Kunal', 'Bhavna']
const LAST = ['Sharma', 'Patel', 'Iyer', 'Reddy', 'Nair', 'Kulkarni', 'Deshpande', 'Gupta', 'Singh', 'Khan', 'Menon', 'Joshi', 'Rao', 'Pillai', 'Chatterjee', 'Banerjee', 'Fernandes', "D'Souza", 'Mehta', 'Kapoor']


export interface SeedSummary {
  skipped: boolean
  message: string
  counts?: Record<string, number>
}

export async function seedDemoData(c: AppContainer): Promise<SeedSummary> {
  const db = c.dbm.db
  if (c.dbm.status() === 'setup_required') {
    await completeSetup(
      db,
      {
        organization: { legalName: 'Demo BPO Services Pvt Ltd', displayName: 'Demo BPO Services', baseCurrency: 'INR', timezone: 'Asia/Kolkata' },
        admin: { username: DEMO_ADMIN.username, displayName: 'Demo Super Admin', password: DEMO_ADMIN.password }
      },
      newCorrelationId()
    )
    c.refreshStartupStatus()
  }
  if (db.prepare("SELECT 1 FROM departments WHERE code_normalized = 'ops'").get()) {
    return { skipped: true, message: 'Demo data is already present (department OPS exists). Nothing was changed.' }
  }

  const admin = db
    .prepare("SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE r.key = 'super_admin' AND u.is_active = 1 ORDER BY u.created_at LIMIT 1")
    .get() as { id: string }
  const op: OpContext = { correlationId: newCorrelationId(), actor: { userId: admin.id, permissions: loadUserPermissions(db, admin.id) as ReadonlySet<PermissionKey> } }

  // ---------- Role-based demo users (password change not forced, for easy testing) ----------
  const demoUsers: Array<[string, string, string[]]> = [
    ['assetmgr', 'Asha Asset Manager', ['asset_manager']],
    ['ittech', 'Ishaan IT Technician', ['it_technician']],
    ['facilities', 'Farah Facilities Manager', ['facilities_manager']],
    ['procurement', 'Pranav Procurement Officer', ['procurement_officer']],
    ['deptmgr', 'Devika Department Manager', ['department_manager']],
    ['hrofficer', 'Harini HR Officer', ['hr_officer']],
    ['finance', 'Firoz Finance Officer', ['finance_officer']],
    ['auditor', 'Anil Auditor', ['auditor']]
  ]
  for (const [username, displayName, roleKeys] of demoUsers) {
    if (db.prepare('SELECT 1 FROM users WHERE username_normalized = ?').get(username)) continue
    await createUser(db, { username, displayName, password: DEMO_USER_PASSWORD, roleKeys }, op)
  }
  db.prepare('UPDATE users SET must_change_password = 0').run()

  let workstations = 0
  // Everything below is synchronous and runs in one transaction: all or nothing.
  db.transaction(() => {
  // ---------- Departments and teams ----------
  const dept = (code: string, name: string, notes: string | null = null) => org.createDepartment(db, { code, name, managerEmployeeId: null, notes }, op).id
  const D = {
    ops: dept('OPS', 'Operations', 'Client-facing delivery across all processes'),
    it: dept('IT', 'IT Support'),
    hr: dept('HR', 'Human Resources'),
    fin: dept('FIN', 'Finance'),
    fac: dept('FAC', 'Facilities'),
    qt: dept('QT', 'Quality and Training'),
    wfm: dept('WFM', 'Workforce Management')
  }
  const team = (departmentId: string, kind: 'team' | 'process', code: string, name: string) =>
    org.createTeam(db, { departmentId, kind, code, name, leadEmployeeId: null, notes: null }, op).id
  const T = {
    telIn: team(D.ops, 'process', 'TEL-IN', 'Telecom Voice Inbound'),
    bnkChat: team(D.ops, 'process', 'BNK-CHAT', 'Banking Chat Support'),
    hcBo: team(D.ops, 'process', 'HC-BO', 'Healthcare Back Office'),
    rtlEmail: team(D.ops, 'process', 'RTL-EMAIL', 'Retail Email Support'),
    desktop: team(D.it, 'team', 'IT-DESK', 'Desktop Support'),
    network: team(D.it, 'team', 'IT-NET', 'Network and Infrastructure'),
    recruit: team(D.hr, 'team', 'HR-REC', 'Recruitment'),
    er: team(D.hr, 'team', 'HR-ER', 'Employee Relations'),
    accounts: team(D.fin, 'team', 'FIN-ACC', 'Accounts'),
    admin: team(D.fac, 'team', 'FAC-ADM', 'Admin and Facilities'),
    quality: team(D.qt, 'team', 'QT-QA', 'Quality Audit'),
    training: team(D.qt, 'team', 'QT-TRN', 'Training'),
    scheduling: team(D.wfm, 'team', 'WFM-SCH', 'Scheduling and Real-time')
  }

  // ---------- Locations ----------
  const loc = (locationType: LocationType, name: string, parentLocationId: string | null, code: string) =>
    org.createLocation(db, { locationType, name, parentLocationId, code, notes: null }, op).id
  const pun = loc('site', 'Pune - Hinjewadi Campus', null, 'PUN')
  const punA = loc('building', 'Tower A', pun, 'PUN-A')
  const punStore = loc('storage', 'IT Store', pun, 'PUN-STORE')
  const bays: Array<{ id: string; code: string; seats: number }> = []
  for (const f of [1, 2, 3]) {
    const floor = loc('floor', `Floor ${f}`, punA, `PUN-A-F${f}`)
    for (const b of ['A', 'B']) bays.push({ id: loc('bay', `Bay ${f}${b}`, floor, `PUN-A-${f}${b}`), code: `PUN-A-${f}${b}`, seats: 8 })
    if (f === 1) {
      loc('room', 'Server Room', floor, 'PUN-A-SRV')
      bays.push({ id: loc('room', 'Training Room 1', floor, 'PUN-A-TR1'), code: 'PUN-A-TR1', seats: 6 })
    }
  }
  const blr = loc('site', 'Bengaluru - Whitefield Office', null, 'BLR')
  const blr1 = loc('building', 'Block 1', blr, 'BLR-1')
  loc('storage', 'Facilities Store', blr1, 'BLR-STORE')
  for (const f of [1, 2]) {
    const floor = loc('floor', `Floor ${f}`, blr1, `BLR-1-F${f}`)
    for (const b of ['A', 'B']) bays.push({ id: loc('bay', `Bay ${f}${b}`, floor, `BLR-1-${f}${b}`), code: `BLR-1-${f}${b}`, seats: 6 })
  }
  // A closed bay, to try "Show deactivated".
  const closedFloor = (db.prepare("SELECT id FROM locations WHERE code_normalized = 'blr-1-f2'").get() as { id: string }).id
  const closedBay = loc('bay', 'Bay 2C (closed)', closedFloor, 'BLR-1-2C')
  org.setLocationActive(db, { id: closedBay, isActive: false, reason: 'Bay closed for renovation (demo)' }, op)

  for (const bay of bays) {
    for (let s = 1; s <= bay.seats; s++) {
      org.createWorkstation(db, { locationId: bay.id, kind: bay.code.includes('TR') ? 'seat' : 'workstation', code: `${bay.code}-${String(s).padStart(2, '0')}`, label: null, notes: null }, op)
      workstations++
    }
  }

  // ---------- Shared asset pools ----------
  org.createPool(db, { code: 'POOL-HS-PUN', name: 'Spare headsets - Pune', purpose: 'Floor spares for agents whose headset fails mid-shift', responsibleDepartmentId: D.it, responsibleTeamId: T.desktop, defaultLocationId: punStore }, op)
  org.createPool(db, { code: 'POOL-TRN-LAP', name: 'Training room laptops', purpose: 'Laptops for new-hire training batches', responsibleDepartmentId: D.qt, responsibleTeamId: T.training, defaultLocationId: bays.find((b) => b.code === 'PUN-A-TR1')!.id }, op)
  org.createPool(db, { code: 'POOL-ACCESS', name: 'Visitor access cards', purpose: 'Temporary access cards for visitors and contractors', responsibleDepartmentId: D.fac, responsibleTeamId: null, defaultLocationId: null }, op)

  // ---------- Employees ----------
  let seq = 1000
  let nameIdx = 0
  const used = new Set<string>()
  const nextName = (): [string, string] => {
    for (;;) {
      const f = FIRST[nameIdx % FIRST.length]!
      const l = LAST[Math.floor(nameIdx / FIRST.length) % LAST.length]!
      nameIdx += 7
      const key = `${f} ${l}`
      if (!used.has(key)) {
        used.add(key)
        return [f, l]
      }
    }
  }
  const dateFor = (i: number) => {
    const d = new Date(Date.UTC(2019, 0, 1) + ((i * 97) % 2700) * 86_400_000)
    return d.toISOString().slice(0, 10)
  }
  const workSite = (i: number) => (i % 4 === 3 ? blr : pun)
  const add = (opts: { title: string; departmentId: string; teamId?: string | null; managerId?: string | null; status?: EmploymentStatus }) => {
    const [f, l] = nextName()
    seq++
    const e = createEmployee(
      db,
      {
        employeeCode: `E${seq}`,
        fullName: `${f} ${l}`,
        email: `${f}.${l}`.toLowerCase().replace(/[^a-z.]/g, '') + '@demobpo.example',
        phone: `+91 98${String(10000000 + seq * 37).slice(0, 8)}`,
        jobTitle: opts.title,
        departmentId: opts.departmentId,
        teamId: opts.teamId ?? null,
        managerEmployeeId: opts.managerId ?? null,
        workLocationId: workSite(seq),
        employmentStatus: opts.status && opts.status !== 'exited' ? opts.status : 'active',
        joiningDate: dateFor(seq),
        expectedExitDate: opts.status === 'notice_period' ? '2026-11-15' : null,
        notes: null
      },
      op
    )
    if (opts.status === 'exited') deactivateEmployee(db, { id: e.id, actualExitDate: '2026-09-30', reason: 'Resigned (demo data)' }, op)
    return e.id
  }

  const heads: Record<keyof typeof D, string> = {
    ops: add({ title: 'Head of Operations', departmentId: D.ops }),
    it: add({ title: 'IT Manager', departmentId: D.it }),
    hr: add({ title: 'HR Manager', departmentId: D.hr }),
    fin: add({ title: 'Finance Controller', departmentId: D.fin }),
    fac: add({ title: 'Facilities Manager', departmentId: D.fac }),
    qt: add({ title: 'Quality and Training Manager', departmentId: D.qt }),
    wfm: add({ title: 'WFM Manager', departmentId: D.wfm })
  }
  for (const [k, id] of Object.entries(heads)) {
    const d = org.listDepartments(db, { includeInactive: true }, op).find((x) => x.id === D[k as keyof typeof D])!
    org.updateDepartment(db, { id: d.id, code: d.code, name: d.name, notes: d.notes, managerEmployeeId: id }, op)
  }

  const teamPlan: Array<{ teamId: string; dept: keyof typeof D; leadTitle: string; memberTitle: string; members: number }> = [
    { teamId: T.telIn, dept: 'ops', leadTitle: 'Team Leader - Voice', memberTitle: 'Customer Support Associate', members: 18 },
    { teamId: T.bnkChat, dept: 'ops', leadTitle: 'Team Leader - Chat', memberTitle: 'Chat Support Associate', members: 14 },
    { teamId: T.hcBo, dept: 'ops', leadTitle: 'Team Leader - Back Office', memberTitle: 'Process Associate', members: 12 },
    { teamId: T.rtlEmail, dept: 'ops', leadTitle: 'Team Leader - Email', memberTitle: 'Email Support Associate', members: 10 },
    { teamId: T.desktop, dept: 'it', leadTitle: 'Desktop Support Lead', memberTitle: 'Desktop Support Engineer', members: 5 },
    { teamId: T.network, dept: 'it', leadTitle: 'Network Lead', memberTitle: 'Network Engineer', members: 3 },
    { teamId: T.recruit, dept: 'hr', leadTitle: 'Recruitment Lead', memberTitle: 'Recruiter', members: 3 },
    { teamId: T.er, dept: 'hr', leadTitle: 'Employee Relations Lead', memberTitle: 'HR Executive', members: 2 },
    { teamId: T.accounts, dept: 'fin', leadTitle: 'Accounts Lead', memberTitle: 'Accounts Executive', members: 3 },
    { teamId: T.admin, dept: 'fac', leadTitle: 'Admin Supervisor', memberTitle: 'Admin Executive', members: 3 },
    { teamId: T.quality, dept: 'qt', leadTitle: 'Quality Lead', memberTitle: 'Quality Analyst', members: 4 },
    { teamId: T.training, dept: 'qt', leadTitle: 'Training Lead', memberTitle: 'Trainer', members: 3 },
    { teamId: T.scheduling, dept: 'wfm', leadTitle: 'Scheduling Lead', memberTitle: 'Real-time Analyst', members: 3 }
  ]
  let memberNo = 0
  for (const p of teamPlan) {
    const lead = add({ title: p.leadTitle, departmentId: D[p.dept], teamId: p.teamId, managerId: heads[p.dept] })
    const t = org.listTeams(db, { includeInactive: true }, op).find((x) => x.id === p.teamId)!
    org.updateTeam(db, { id: t.id, departmentId: t.departmentId, kind: t.kind, code: t.code, name: t.name, notes: t.notes, leadEmployeeId: lead }, op)
    for (let m = 0; m < p.members; m++) {
      memberNo++
      // A realistic mix: mostly active, some on leave / serving notice, a few already exited.
      const status: EmploymentStatus = memberNo % 23 === 0 ? 'exited' : memberNo % 17 === 0 ? 'notice_period' : memberNo % 13 === 0 ? 'on_leave' : 'active'
      add({ title: p.memberTitle, departmentId: D[p.dept], teamId: p.teamId, managerId: lead, status })
    }
  }

  // ---------- Asset catalogue and register (M3) ----------
  const cat = (code: string, name: string, assetDomain: 'it' | 'facilities', serial: 'optional' | 'required' | 'unique', trackingMode: 'individual' | 'bulk' = 'individual') =>
    catalog.createCategory(db, { code, name, description: null, assetDomain, trackingMode, serialRequired: serial !== 'optional', serialUnique: serial === 'unique' }, op).id
  const C = {
    laptop: cat('LAP', 'Laptop', 'it', 'unique'),
    desktop: cat('DSK', 'Desktop', 'it', 'unique'),
    monitor: cat('MON', 'Monitor', 'it', 'required'),
    headset: cat('HST', 'Headset', 'it', 'optional'),
    printer: cat('PRN', 'Printer', 'it', 'unique'),
    network: cat('NET', 'Network switch', 'it', 'unique'),
    chair: cat('CHR', 'Ergonomic chair', 'facilities', 'optional'),
    desk: cat('DSF', 'Workstation desk', 'facilities', 'optional')
  }
  cat('CBL', 'Cables and adapters', 'it', 'optional', 'bulk')
  const model = (categoryId: string, manufacturer: string, modelName: string, specifications: string | null = null) =>
    catalog.createModel(db, { categoryId, manufacturer, modelName, modelNumber: null, specifications }, op)
  const M = {
    lat: model(C.laptop, 'Dell', 'Latitude 5440', 'Core i5, 16 GB RAM, 512 GB SSD'),
    tp: model(C.laptop, 'Lenovo', 'ThinkPad E14 Gen 5', 'Ryzen 5, 16 GB RAM, 512 GB SSD'),
    elite: model(C.desktop, 'HP', 'EliteDesk 800 G9 Mini', 'Core i5, 8 GB RAM'),
    p24: model(C.monitor, 'Dell', 'P2422H 24"'),
    jabra: model(C.headset, 'Jabra', 'Evolve2 40 USB'),
    poly: model(C.headset, 'Poly', 'Blackwire 3320'),
    lj: model(C.printer, 'HP', 'LaserJet Pro M404dn'),
    cisco: model(C.network, 'Cisco', 'Catalyst 9200L 48-port'),
    chair: model(C.chair, 'Featherlite', 'Optima Mesh'),
    desk: model(C.desk, 'Godrej Interio', 'Linear 1200 mm')
  }
  const sup = (code: string, name: string, taxReference: string) =>
    catalog.createSupplier(db, { code, name, contactName: null, email: null, phone: null, address: null, taxReference, notes: null }, op).id
  const S = { it: sup('SUP-ACME', 'Acme IT Solutions Pvt Ltd', '27AABCA1234A1Z5'), furn: sup('SUP-BOF', 'Bharat Office Furniture', '27AACCB5678B1Z2'), net: sup('SUP-NET', 'NetConnect Systems', '29AADCN9012C1Z8') }

  const store = punStore
  const bayIds = bays.filter((b) => !b.code.includes('TR')).map((b) => b.id)
  let assetNo = 0
  const isoOffset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
  const register = (categoryId: string, m: { id: string; manufacturer: string; modelName: string }, supplierId: string, cost: string, years: number, serialPrefix: string | null) => {
    assetNo++
    const purchaseDaysAgo = 60 + ((assetNo * 53) % 1100)
    const warrantyDays = years * 365 - purchaseDaysAgo
    return assets.createAsset(db, {
      categoryId,
      modelId: m.id,
      manufacturer: null,
      modelName: null,
      serialNumber: serialPrefix ? `${serialPrefix}${String(100000 + assetNo * 7919).slice(-6)}` : null,
      specifications: null,
      condition: assetNo % 11 === 0 ? 'fair' : assetNo % 4 === 0 ? 'good' : 'new',
      operationalStatus: assetNo % 29 === 0 ? 'non_operational' : assetNo % 19 === 0 ? 'awaiting_inspection' : 'ready',
      locationId: assetNo % 6 === 0 ? store : bayIds[assetNo % bayIds.length]!,
      supplierId,
      purchaseDate: isoOffset(-purchaseDaysAgo),
      acquisitionCost: cost,
      invoiceReference: `INV-2026-${String(assetNo).padStart(4, '0')}`,
      purchaseReference: null,
      warrantyStart: isoOffset(-purchaseDaysAgo),
      warrantyEnd: isoOffset(warrantyDays),
      notes: null
    }, op)
  }
  const created: string[] = []
  for (let i = 0; i < 36; i++) created.push(register(C.laptop, i % 2 ? M.tp : M.lat, S.it, i % 2 ? '58500.00' : '64990.00', 3, i % 2 ? 'PF' : 'DL').id)
  for (let i = 0; i < 18; i++) created.push(register(C.desktop, M.elite, S.it, '42000.00', 3, 'HPE').id)
  for (let i = 0; i < 30; i++) created.push(register(C.monitor, M.p24, S.it, '13499.00', 3, 'CN0').id)
  for (let i = 0; i < 40; i++) created.push(register(C.headset, i % 3 ? M.jabra : M.poly, S.it, i % 3 ? '7850.00' : '3200.00', 1, null).id)
  for (let i = 0; i < 3; i++) created.push(register(C.printer, M.lj, S.it, '23500.00', 1, 'PHB').id)
  for (let i = 0; i < 2; i++) created.push(register(C.network, M.cisco, S.net, '185000.00', 5, 'FOC').id)
  for (let i = 0; i < 24; i++) created.push(register(C.chair, M.chair, S.furn, '9800.00', 2, null).id)
  for (let i = 0; i < 12; i++) created.push(register(C.desk, M.desk, S.furn, '14500.00', 5, null).id)
  const life = (id: string, toStatus: 'retired' | 'lost' | 'disposed', reason: string, disposalMethod: 'scrapped' | null = null) =>
    assets.changeLifecycle(db, { id, toStatus, reason, effectiveDate: isoOffset(-20), disposalMethod, disposalProceeds: null }, op)
  life(created[3]!, 'lost', 'Not returned after floor move (demo)')
  life(created[60]!, 'lost', 'Missing at last audit (demo)')
  for (const i of [10, 45, 90]) life(created[i]!, 'retired', 'End of useful life (demo)')
  life(created[90]!, 'disposed', 'Sent for e-waste recycling (demo)', 'scrapped')
  })()

  await c.backups.createFrom(db, 'manual', admin.id, newCorrelationId())

  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n
  return {
    skipped: false,
    message: 'Demo data created.',
    counts: {
      users: n('SELECT count(*) AS n FROM users'),
      departments: n('SELECT count(*) AS n FROM departments'),
      teams: n('SELECT count(*) AS n FROM teams'),
      locations: n('SELECT count(*) AS n FROM locations'),
      workstations,
      pools: n('SELECT count(*) AS n FROM asset_pools'),
      employees: n('SELECT count(*) AS n FROM employees'),
      exitedEmployees: n("SELECT count(*) AS n FROM employees WHERE employment_status = 'exited'"),
      categories: n('SELECT count(*) AS n FROM asset_categories'),
      models: n('SELECT count(*) AS n FROM asset_models'),
      suppliers: n('SELECT count(*) AS n FROM suppliers'),
      assets: n('SELECT count(*) AS n FROM assets')
    }
  }
}
