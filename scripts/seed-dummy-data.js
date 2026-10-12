const { Client } = require('pg');
const { randomUUID } = require('crypto');

const normalizeKey = (s) => (s ? s.trim().replace(/\s+/g, ' ').toLowerCase() : '');

async function seed() {
  const isApply = process.argv.includes('--apply');
  console.log(`Starting Dummy Data Seeding (Mode: ${isApply ? 'APPLY (Writing to DB)' : 'DRY RUN'})`);

  const client = new Client({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5432/bpoam' });
  await client.connect();

  try {
    const orgRes = await client.query('SELECT id, legal_name FROM organizations LIMIT 1');
    if (!orgRes.rows.length) throw new Error('No organization found in database!');
    const orgId = orgRes.rows[0].id;

    const userRes = await client.query('SELECT id, username FROM users WHERE is_active = true ORDER BY created_at LIMIT 1');
    if (!userRes.rows.length) throw new Error('No active user found in database!');
    const actorId = userRes.rows[0].id;

    const locRes = await client.query("SELECT id, name FROM locations WHERE organization_id = $1 AND name_normalized = 'office no-515'", [orgId]);
    if (!locRes.rows.length) throw new Error('Office No-515 location not found!');
    const locationId = locRes.rows[0].id;

    console.log(`Organization: ${orgRes.rows[0].legal_name} (${orgId})`);
    console.log(`Actor User: ${userRes.rows[0].username} (${actorId})`);
    console.log(`Location: Office No-515 (${locationId})`);

    // 1. Departments & Teams
    const departmentsData = [
      {
        code: 'OPS',
        name: 'Operations',
        notes: 'Client-facing process delivery teams',
        teams: [
          { code: 'OPS-VOICE', name: 'Voice Inbound Support', kind: 'process' },
          { code: 'OPS-CHAT', name: 'Banking Chat Support', kind: 'process' },
          { code: 'OPS-BO', name: 'Healthcare Back Office', kind: 'process' }
        ]
      },
      {
        code: 'IT',
        name: 'IT Support & Infrastructure',
        notes: 'Desktop, network and end-user computing support',
        teams: [
          { code: 'IT-DESK', name: 'Desktop Support', kind: 'team' },
          { code: 'IT-NET', name: 'Network & Security', kind: 'team' }
        ]
      },
      {
        code: 'HR',
        name: 'Human Resources',
        notes: 'Talent acquisition, payroll and employee lifecycle',
        teams: [
          { code: 'HR-REC', name: 'Talent Acquisition', kind: 'team' },
          { code: 'HR-OPS', name: 'HR Operations', kind: 'team' }
        ]
      },
      {
        code: 'FAC',
        name: 'Facilities & Admin',
        notes: 'Office maintenance, physical security and asset administration',
        teams: [
          { code: 'FAC-ADM', name: 'Facility Management', kind: 'team' }
        ]
      },
      {
        code: 'FIN',
        name: 'Finance & Accounts',
        notes: 'Procurement billing, cost allocation and financial audits',
        teams: [
          { code: 'FIN-ACC', name: 'Billing & Accounting', kind: 'team' }
        ]
      },
      {
        code: 'QT',
        name: 'Quality & Training',
        notes: 'Training batches and quality assurance audits',
        teams: [
          { code: 'QT-QA', name: 'Quality Assurance', kind: 'team' },
          { code: 'QT-TRN', name: 'Learning & Development', kind: 'team' }
        ]
      }
    ];

    // 2. Workstations in Office No-515
    const workstationsData = [];
    for (let i = 1; i <= 25; i++) {
      const code = `WS-515-${String(i).padStart(2, '0')}`;
      workstationsData.push({
        code,
        label: `Workstation 515 - Desk #${i}`,
        notes: 'Workspace desk in Office 515'
      });
    }

    // 3. New Employees
    const newEmployeesData = [
      { code: 'VS-003', name: 'Aarav Sharma', email: 'aarav.sharma@venturesathi.com', phone: '+91 9820112341', title: 'Senior Desktop Engineer', dept: 'IT', team: 'IT-DESK' },
      { code: 'VS-004', name: 'Priya Nair', email: 'priya.nair@venturesathi.com', phone: '+91 9820112342', title: 'Network Administrator', dept: 'IT', team: 'IT-NET' },
      { code: 'VS-005', name: 'Rohan Gupta', email: 'rohan.gupta@venturesathi.com', phone: '+91 9820112343', title: 'Operations Team Lead', dept: 'OPS', team: 'OPS-VOICE' },
      { code: 'VS-006', name: 'Ananya Deshpande', email: 'ananya.d@venturesathi.com', phone: '+91 9820112344', title: 'Customer Support Specialist', dept: 'OPS', team: 'OPS-VOICE' },
      { code: 'VS-007', name: 'Vikram Reddy', email: 'vikram.reddy@venturesathi.com', phone: '+91 9820112345', title: 'Customer Support Specialist', dept: 'OPS', team: 'OPS-CHAT' },
      { code: 'VS-008', name: 'Sneha Kulkarni', email: 'sneha.k@venturesathi.com', phone: '+91 9820112346', title: 'Process Associate', dept: 'OPS', team: 'OPS-BO' },
      { code: 'VS-009', name: 'Arjun Iyer', email: 'arjun.iyer@venturesathi.com', phone: '+91 9820112347', title: 'Process Associate', dept: 'OPS', team: 'OPS-BO' },
      { code: 'VS-010', name: 'Kavya Singh', email: 'kavya.singh@venturesathi.com', phone: '+91 9820112348', title: 'HR Executive', dept: 'HR', team: 'HR-OPS' },
      { code: 'VS-011', name: 'Rahul Joshi', email: 'rahul.joshi@venturesathi.com', phone: '+91 9820112349', title: 'Technical Recruiter', dept: 'HR', team: 'HR-REC' },
      { code: 'VS-012', name: 'Isha Patel', email: 'isha.patel@venturesathi.com', phone: '+91 9820112350', title: 'Facilities Executive', dept: 'FAC', team: 'FAC-ADM' },
      { code: 'VS-013', name: 'Manish Chatterjee', email: 'manish.c@venturesathi.com', phone: '+91 9820112351', title: 'Senior Finance Analyst', dept: 'FIN', team: 'FIN-ACC' },
      { code: 'VS-014', name: 'Riya Kapoor', email: 'riya.kapoor@venturesathi.com', phone: '+91 9820112352', title: 'Quality Auditor', dept: 'QT', team: 'QT-QA' },
      { code: 'VS-015', name: 'Deepak Verma', email: 'deepak.verma@venturesathi.com', phone: '+91 9820112353', title: 'Corporate Trainer', dept: 'QT', team: 'QT-TRN' },
      { code: 'VS-016', name: 'Swati Menon', email: 'swati.menon@venturesathi.com', phone: '+91 9820112354', title: 'Customer Support Specialist', dept: 'OPS', team: 'OPS-CHAT' },
      { code: 'VS-017', name: 'Amit Rao', email: 'amit.rao@venturesathi.com', phone: '+91 9820112355', title: 'Customer Support Specialist', dept: 'OPS', team: 'OPS-VOICE' },
      { code: 'VS-018', name: 'Shreya Pillai', email: 'shreya.pillai@venturesathi.com', phone: '+91 9820112356', title: 'Desktop Support Tech', dept: 'IT', team: 'IT-DESK' }
    ];

    // 4. Asset Models
    const modelsData = [
      { categoryName: 'Monitor', manufacturer: 'HP', modelName: '324 pb', modelNumber: '324-PB-238' },
      { categoryName: 'Monitor', manufacturer: 'HP', modelName: 'P204V', modelNumber: 'P204V-195' },
      { categoryName: 'Monitor', manufacturer: 'Haver Electric', modelName: 'HE-MON-24', modelNumber: 'HE-24-FHD' },
      { categoryName: 'All-In-One', manufacturer: 'AYKON', modelName: 'AIO-238 Core i5', modelNumber: 'AYK-AIO-515' },
      { categoryName: 'Wifi Adapter', manufacturer: 'TP-Link', modelName: 'T600U Plus', modelNumber: 'Archer T600U+' },
      { categoryName: 'Chair', manufacturer: 'Jai Bajrang Trading Company', modelName: 'Ergonomic Mesh Chair', modelNumber: 'JB-MESH-515' },
      { categoryName: 'AC', manufacturer: 'Hitachi', modelName: '1.5 Ton Split Inverter', modelNumber: 'HIT-15-INV' }
    ];

    // 5. Asset Pools
    const poolsData = [
      { code: 'POOL-IT-SPARES', name: 'IT Floor Spares', purpose: 'Floor spares for keyboards, mice and adapters', deptCode: 'IT' },
      { code: 'POOL-TRN-EQUIP', name: 'Training Room Equipment', purpose: 'Standby systems and peripherals for onboarding', deptCode: 'QT' },
      { code: 'POOL-STANDBY-KB', name: 'Standby Mouse & KB Combos', purpose: 'Quick swap stock for damaged peripherals', deptCode: 'IT' }
    ];

    console.log('\n--- Prepared Dummy Data Counts ---');
    console.log(`Departments: ${departmentsData.length}`);
    console.log(`Teams: ${departmentsData.reduce((acc, d) => acc + d.teams.length, 0)}`);
    console.log(`Workstations: ${workstationsData.length}`);
    console.log(`New Employees: ${newEmployeesData.length}`);
    console.log(`Asset Models: ${modelsData.length}`);
    console.log(`Asset Pools: ${poolsData.length}`);

    if (!isApply) {
      console.log('\nDRY RUN SUCCESSFUL! Run with --apply to insert dummy data.');
      return;
    }

    // APPLY
    console.log('\nStarting Database Transaction...');
    await client.query('BEGIN');

    // 1. Insert Departments & Teams
    const deptIdMap = new Map(); // code -> id
    const teamIdMap = new Map(); // code -> id

    for (const d of departmentsData) {
      let deptId;
      const existing = await client.query('SELECT id FROM departments WHERE organization_id = $1 AND code_normalized = $2', [orgId, normalizeKey(d.code)]);
      if (existing.rows.length) {
        deptId = existing.rows[0].id;
      } else {
        deptId = randomUUID();
        await client.query(
          `INSERT INTO departments (id, organization_id, code, code_normalized, name, name_normalized, notes, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
          [deptId, orgId, d.code, normalizeKey(d.code), d.name, normalizeKey(d.name), d.notes]
        );
        console.log(`Inserted department: ${d.name} (${d.code})`);
      }
      deptIdMap.set(d.code, deptId);

      for (const t of d.teams) {
        let teamId;
        const exTeam = await client.query('SELECT id FROM teams WHERE organization_id = $1 AND code_normalized = $2', [orgId, normalizeKey(t.code)]);
        if (exTeam.rows.length) {
          teamId = exTeam.rows[0].id;
        } else {
          teamId = randomUUID();
          await client.query(
            `INSERT INTO teams (id, organization_id, department_id, kind, code, code_normalized, name, name_normalized, notes, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, true)`,
            [teamId, orgId, deptId, t.kind, t.code, normalizeKey(t.code), t.name, normalizeKey(t.name)]
          );
          console.log(`  Inserted team: ${t.name} (${t.code})`);
        }
        teamIdMap.set(t.code, teamId);
      }
    }

    // 2. Insert Workstations
    const workstationIdMap = new Map(); // code -> id
    for (const ws of workstationsData) {
      let wsId;
      const exWs = await client.query('SELECT id FROM workstations WHERE organization_id = $1 AND code_normalized = $2', [orgId, normalizeKey(ws.code)]);
      if (exWs.rows.length) {
        wsId = exWs.rows[0].id;
      } else {
        wsId = randomUUID();
        await client.query(
          `INSERT INTO workstations (id, organization_id, location_id, kind, code, code_normalized, label, notes, is_active)
           VALUES ($1, $2, $3, 'workstation', $4, $5, $6, $7, true)`,
          [wsId, orgId, locationId, ws.code, normalizeKey(ws.code), ws.label, ws.notes]
        );
      }
      workstationIdMap.set(ws.code, wsId);
    }
    console.log(`Verified / Inserted ${workstationsData.length} workstations.`);

    // 3. Update existing Binoj & Saroj department/team
    const binojDept = deptIdMap.get('IT');
    const binojTeam = teamIdMap.get('IT-DESK');
    const sarojDept = deptIdMap.get('OPS');
    const sarojTeam = teamIdMap.get('OPS-VOICE');

    await client.query(
      `UPDATE employees SET department_id = $1, team_id = $2, work_location_id = $3, job_title = 'Head of IT'
       WHERE organization_id = $4 AND employee_code_normalized = 'vs-001'`,
      [binojDept, binojTeam, locationId, orgId]
    );
    await client.query(
      `UPDATE employees SET department_id = $1, team_id = $2, work_location_id = $3, job_title = 'Operations Manager'
       WHERE organization_id = $4 AND employee_code_normalized = 'vs-002'`,
      [sarojDept, sarojTeam, locationId, orgId]
    );

    // 4. Insert New Employees
    const employeeIdMap = new Map(); // code -> id
    const allEmpsRes = await client.query('SELECT id, employee_code FROM employees WHERE organization_id = $1', [orgId]);
    for (const e of allEmpsRes.rows) employeeIdMap.set(e.employee_code, e.id);

    for (const e of newEmployeesData) {
      if (employeeIdMap.has(e.code)) continue;
      const empId = randomUUID();
      const dId = deptIdMap.get(e.dept);
      const tId = teamIdMap.get(e.team);
      await client.query(
        `INSERT INTO employees (id, organization_id, employee_code, employee_code_normalized, full_name, email, email_normalized, phone, job_title, department_id, team_id, work_location_id, employment_status, joining_date, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'active', '2025-01-15', 'Sample employee for testing')`,
        [empId, orgId, e.code, normalizeKey(e.code), e.name, e.email, normalizeKey(e.email), e.phone, e.title, dId, tId, locationId]
      );
      employeeIdMap.set(e.code, empId);
      console.log(`Inserted employee: ${e.name} (${e.code})`);
    }

    // 5. Insert Asset Models
    for (const m of modelsData) {
      const catRes = await client.query('SELECT id FROM asset_categories WHERE organization_id = $1 AND name_normalized = $2', [orgId, normalizeKey(m.categoryName)]);
      if (!catRes.rows.length) continue;
      const catId = catRes.rows[0].id;

      const exModel = await client.query(
        'SELECT id FROM asset_models WHERE organization_id = $1 AND category_id = $2 AND manufacturer_normalized = $3 AND model_name_normalized = $4',
        [orgId, catId, normalizeKey(m.manufacturer), normalizeKey(m.modelName)]
      );
      let modelId;
      if (!exModel.rows.length) {
        modelId = randomUUID();
        await client.query(
          `INSERT INTO asset_models (id, organization_id, category_id, manufacturer, manufacturer_normalized, model_name, model_name_normalized, model_number, specifications, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Standard office hardware', true)`,
          [modelId, orgId, catId, m.manufacturer, normalizeKey(m.manufacturer), m.modelName, normalizeKey(m.modelName), m.modelNumber]
        );
        console.log(`Inserted asset model: ${m.manufacturer} ${m.modelName}`);
      } else {
        modelId = exModel.rows[0].id;
      }

      // Link model to matching assets in DB
      await client.query(
        `UPDATE assets SET model_id = $1 WHERE organization_id = $2 AND category_id = $3 AND model_id IS NULL AND LOWER(manufacturer) = LOWER($4) AND (model_name IS NULL OR LOWER(model_name) = LOWER($5))`,
        [modelId, orgId, catId, m.manufacturer, m.modelName]
      );
    }

    // 6. Insert Asset Pools
    const poolIdMap = new Map();
    for (const p of poolsData) {
      const exPool = await client.query('SELECT id FROM asset_pools WHERE organization_id = $1 AND code_normalized = $2', [orgId, normalizeKey(p.code)]);
      let pId;
      if (!exPool.rows.length) {
        pId = randomUUID();
        const dId = deptIdMap.get(p.deptCode);
        await client.query(
          `INSERT INTO asset_pools (id, organization_id, code, code_normalized, name, name_normalized, purpose, responsible_department_id, default_location_id, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)`,
          [pId, orgId, p.code, normalizeKey(p.code), p.name, normalizeKey(p.name), p.purpose, dId, locationId]
        );
        console.log(`Inserted asset pool: ${p.name} (${p.code})`);
      } else {
        pId = exPool.rows[0].id;
      }
      poolIdMap.set(p.code, pId);
    }

    // 7. Handover and Asset Assignments
    // We will assign:
    //  - 8 AIO PCs (VLIV/PC/01 to 08) to employees VS-001 to VS-008
    //  - 8 Monitors (VLIV/MON/001 to 008, skipping 003 & 004 which are faulty) to employees VS-001 to VS-008
    //  - 10 Chairs (VLIV/CH/WS/001 to 010) to workstations WS-515-01 to WS-515-10
    //  - 3 StandBy items to POOL-STANDBY-KB

    let counterRes = await client.query('SELECT next_handover FROM allocation_counters WHERE organization_id = $1 FOR UPDATE', [orgId]);
    let nextHoNum = Number(counterRes.rows[0].next_handover);

    async function createHandoverAndAssignment(targetType, targetId, assetCode, reason, ackName) {
      const assetRes = await client.query('SELECT id FROM assets WHERE organization_id = $1 AND asset_code = $2', [orgId, assetCode]);
      if (!assetRes.rows.length) return;
      const assetId = assetRes.rows[0].id;

      // Check if already actively assigned
      const activeCheck = await client.query("SELECT id FROM asset_assignments WHERE asset_id = $1 AND status = 'active'", [assetId]);
      if (activeCheck.rows.length > 0) return;

      const hoNumber = `HO-${String(nextHoNum++).padStart(6, '0')}`;
      const hoId = randomUUID();
      const asgnId = randomUUID();

      const colTarget = {
        employee_id: targetType === 'employee' ? targetId : null,
        workstation_id: targetType === 'workstation' ? targetId : null,
        pool_id: targetType === 'pool' ? targetId : null
      };

      await client.query(
        `INSERT INTO handovers (
           id, organization_id, handover_number, handover_type, target_type,
           employee_id, workstation_id, department_id, team_id, pool_id, location_id,
           performed_at, performed_by, reason, notes,
           ack_policy, ack_status, ack_method, acknowledged_by_name, acknowledged_at, ack_recorded_by
         ) VALUES (
           $1, $2, $3, 'issue', $4,
           $5, $6, NULL, NULL, $7, $8,
           now(), $9, $10, NULL,
           'in_app', 'acknowledged', 'in_app', $11, now(), $9
         )`,
        [hoId, orgId, hoNumber, targetType, colTarget.employee_id, colTarget.workstation_id, colTarget.pool_id, locationId, actorId, reason, ackName]
      );

      await client.query(
        `INSERT INTO handover_items (handover_id, organization_id, asset_id, condition, accessories, outcome, notes)
         VALUES ($1, $2, $3, 'good', NULL, 'ready', NULL)`,
        [hoId, orgId, assetId]
      );

      await client.query(
        `INSERT INTO asset_assignments (
           id, organization_id, asset_id, target_type,
           employee_id, workstation_id, department_id, team_id, pool_id, location_id,
           status, assigned_at, issued_by, issue_handover_id, condition_at_issue, accessories
         ) VALUES (
           $1, $2, $3, $4,
           $5, $6, NULL, NULL, $7, $8,
           'active', now(), $9, $10, 'good', NULL
         )`,
        [asgnId, orgId, assetId, targetType, colTarget.employee_id, colTarget.workstation_id, colTarget.pool_id, locationId, actorId, hoId]
      );

      await client.query(
        `INSERT INTO asset_movements (id, organization_id, asset_id, movement_type, assignment_id, handover_id, location_id, actor_user_id, occurred_at, notes)
         VALUES ($1, $2, $3, 'issued', $4, $5, $6, $7, now(), $8)`,
        [randomUUID(), orgId, assetId, asgnId, hoId, locationId, actorId, `Issued: ${reason}`]
      );
    }

    console.log('\nCreating realistic asset assignments and handovers...');
    const empCodes = ['VS-001', 'VS-002', 'VS-003', 'VS-004', 'VS-005', 'VS-006', 'VS-007', 'VS-008'];

    // Assign AIO PCs to employees
    for (let i = 0; i < empCodes.length; i++) {
      const empCode = empCodes[i];
      const empId = employeeIdMap.get(empCode);
      const aioCode = `VLIV/PC/${String(i + 1).padStart(2, '0')}`;
      await createHandoverAndAssignment('employee', empId, aioCode, 'Standard employee computing setup', empCode);
    }

    // Assign Monitors to employees (use 001, 002, 005..010 to skip faulty 003, 004)
    const monitorCodes = ['VLIV/MON/001', 'VLIV/MON/002', 'VLIV/MON/005', 'VLIV/MON/006', 'VLIV/MON/007', 'VLIV/MON/008', 'VLIV/MON/009', 'VLIV/MON/010'];
    for (let i = 0; i < empCodes.length; i++) {
      const empCode = empCodes[i];
      const empId = employeeIdMap.get(empCode);
      const monCode = monitorCodes[i];
      await createHandoverAndAssignment('employee', empId, monCode, 'Dual monitor setup for desk', empCode);
    }

    // Assign Chairs to workstations
    for (let i = 1; i <= 10; i++) {
      const wsCode = `WS-515-${String(i).padStart(2, '0')}`;
      const wsId = workstationIdMap.get(wsCode);
      const chairCode = `VLIV/CH/WS/${String(i).padStart(3, '0')}`;
      await createHandoverAndAssignment('workstation', wsId, chairCode, 'Workstation chair allocation', wsCode);
    }

    // Update next_handover counter
    await client.query('UPDATE allocation_counters SET next_handover = $1 WHERE organization_id = $2', [nextHoNum, orgId]);

    // 8. Maintenance Tickets for Faulty Monitors
    const w5Res = await client.query('SELECT next_ticket FROM w5_counters WHERE organization_id = $1 FOR UPDATE', [orgId]);
    let nextTicketNum = Number(w5Res.rows[0].next_ticket);

    const faultyAssets = [
      { code: 'VLIV/MON/003', desc: 'Display flickering intermittently during operations. Requires panel inspection.', status: 'open', priority: 'high' },
      { code: 'VLIV/MON/004', desc: 'Screen backlight blackout / flickering on power on.', status: 'in_progress', priority: 'medium' }
    ];

    for (const f of faultyAssets) {
      const aRes = await client.query('SELECT id FROM assets WHERE organization_id = $1 AND asset_code = $2', [orgId, f.code]);
      if (!aRes.rows.length) continue;
      const assetId = aRes.rows[0].id;

      // Check if ticket already exists
      const exT = await client.query('SELECT id FROM maintenance_tickets WHERE organization_id = $1 AND asset_id = $2', [orgId, assetId]);
      if (exT.rows.length > 0) continue;

      const tNumber = `MT-${String(nextTicketNum++).padStart(6, '0')}`;
      const tId = randomUUID();

      await client.query(
        `INSERT INTO maintenance_tickets (
           id, organization_id, ticket_number, asset_id, fault_category, priority, description, status,
           reported_by, reported_at, assigned_technician_id, assigned_at, vendor_name, target_resolution_date,
           diagnosis, work_performed, justified_duplicate
         ) VALUES (
           $1, $2, $3, $4, 'hardware', $5, $6, $7,
           $8, now(), $9, now(), 'Haver Electric', current_date + 7,
           $10, NULL, false
         )`,
        [
          tId, orgId, tNumber, assetId, f.priority, f.desc, f.status,
          actorId, f.status === 'in_progress' ? actorId : null,
          f.status === 'in_progress' ? 'Identified faulty power/inverter board or LVDS cable loose.' : null
        ]
      );
      console.log(`Created maintenance ticket ${tNumber} for ${f.code} (${f.status})`);
    }

    await client.query('UPDATE w5_counters SET next_ticket = $1 WHERE organization_id = $2', [nextTicketNum, orgId]);

    await client.query('COMMIT');
    console.log('\nSUCCESS! Database transaction committed.');

  } catch (err) {
    console.error('Error during seeding:', err);
    try {
      await client.query('ROLLBACK');
      console.log('Transaction rolled back.');
    } catch (_) {}
    process.exit(1);
  } finally {
    await client.end();
  }
}

seed();
