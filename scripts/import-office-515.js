const { Client } = require('pg');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');

const normalizeKey = (s) => (s ? s.trim().replace(/\s+/g, ' ').toLowerCase() : '');
const normalizeSerial = (s) => (s ? s.trim().replace(/\s+/g, '').toUpperCase() : null);

function parseDate(v) {
  if (!v) return null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.match(/^\d{4}-\d{2}-\d{2}$/)) return s;
    const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (dmy) {
      const day = dmy[1].padStart(2, '0');
      const month = dmy[2].padStart(2, '0');
      const year = dmy[3];
      return `${year}-${month}-${day}`;
    }
  }
  return null;
}

function computeWarrantyEnd(startDateStr, endDateVal) {
  if (!startDateStr) return null;
  const parsedDirect = parseDate(endDateVal);
  if (parsedDirect) return parsedDirect;

  if (typeof endDateVal === 'string') {
    const lower = endDateVal.trim().toLowerCase();
    const matchYears = lower.match(/^(\d+)\s*years?$/);
    if (matchYears) {
      const years = parseInt(matchYears[1], 10);
      const [y, m, d] = startDateStr.split('-').map(Number);
      const newY = y + years;
      return `${newY}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  return null;
}

async function run() {
  const isApply = process.argv.includes('--apply');
  console.log(`Starting Office-515 Asset Import (Mode: ${isApply ? 'APPLY (Writing to DB)' : 'DRY RUN (Validation only)'})`);

  const rawJsonPath = path.resolve('scratch/office-515-parsed.json');
  if (!fs.existsSync(rawJsonPath)) {
    throw new Error('scratch/office-515-parsed.json not found! Run the python extractor first.');
  }
  const sheets = JSON.parse(fs.readFileSync(rawJsonPath, 'utf8'));

  const client = new Client({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5432/bpoam' });
  await client.connect();

  try {
    const orgRes = await client.query('SELECT id, legal_name FROM organizations LIMIT 1');
    if (!orgRes.rows.length) throw new Error('No organization found in database!');
    const orgId = orgRes.rows[0].id;
    console.log(`Target Organization: ${orgRes.rows[0].legal_name} (${orgId})`);

    // Prepare Location
    const locationName = 'Office No-515';
    const locationCode = 'OFF-515';
    let locationId;

    const locCheck = await client.query('SELECT id FROM locations WHERE organization_id = $1 AND name_normalized = $2', [orgId, normalizeKey(locationName)]);
    if (locCheck.rows.length > 0) {
      locationId = locCheck.rows[0].id;
      console.log(`Found existing location: ${locationName} (${locationId})`);
    } else {
      locationId = randomUUID();
      console.log(`Will create location: ${locationName} (${locationId})`);
    }

    // Categories mapping
    const categoryConfigs = [
      // IT
      { name: 'All-In-One', code: 'CAT-AIO', domain: 'it' },
      { name: 'Monitor', code: 'CAT-MON', domain: 'it' },
      { name: 'LAPTOP', code: 'CAT-LAP', domain: 'it' },
      { name: 'Wifi Adapter', code: 'CAT-WIFI', domain: 'it' },
      { name: 'Wired Keyboard', code: 'CAT-KB-W', domain: 'it' },
      { name: 'Wired Mouse', code: 'CAT-MOU-W', domain: 'it' },
      { name: 'Wireless keyboard & Mouse Combo', code: 'CAT-KB-MOU-WL', domain: 'it' },
      { name: 'POE Switch', code: 'CAT-POE-SW', domain: 'it' },
      { name: 'Firewall', code: 'CAT-FW', domain: 'it' },
      { name: 'Access Point', code: 'CAT-AP', domain: 'it' },
      // Facilities
      { name: 'Chair', code: 'CAT-CHR', domain: 'facilities' },
      { name: 'Plant', code: 'CAT-PLT', domain: 'facilities' },
      { name: 'AC', code: 'CAT-AC', domain: 'facilities' },
      { name: 'AC Remote', code: 'CAT-AC-REM', domain: 'facilities' },
      { name: 'AG HOT & COLD RO UV Water Purifier', code: 'CAT-RO-PUR', domain: 'facilities' },
      { name: 'Camera', code: 'CAT-CAM', domain: 'facilities' },
      { name: 'Smart TV', code: 'CAT-TV', domain: 'facilities' },
      { name: 'Speaker', code: 'CAT-SPK', domain: 'facilities' },
      { name: 'Teliphone', code: 'CAT-TEL', domain: 'facilities' },
      { name: 'Wireless Microphone Receiver', code: 'CAT-MIC-REC', domain: 'facilities' },
      { name: 'Wireless Microphone Transmitter', code: 'CAT-MIC-TX', domain: 'facilities' }
    ];

    const categoryMap = new Map(); // nameNormalized -> { id, ... }
    const existingCats = await client.query('SELECT id, code, name, name_normalized FROM asset_categories WHERE organization_id = $1', [orgId]);
    for (const c of existingCats.rows) {
      categoryMap.set(c.name_normalized, c);
    }

    for (const cfg of categoryConfigs) {
      const nm = normalizeKey(cfg.name);
      if (!categoryMap.has(nm)) {
        categoryMap.set(nm, {
          id: randomUUID(),
          code: cfg.code,
          name: cfg.name,
          asset_domain: cfg.domain,
          isNew: true
        });
      }
    }

    // Suppliers mapping
    const supplierConfigs = [
      { name: 'HAVER ELECTRIC PVT LTD', code: 'SUP-HAVER' },
      { name: 'Haver Electric', code: 'SUP-HAVER-2' },
      { name: 'Educare', code: 'SUP-EDUCARE' },
      { name: 'Jai Bajrang Trading Company', code: 'SUP-JAIBAJRANG', address: 'S.P. Tower, OPP, Narayana Hospital,Devendra Nagar, Raipur (C.G.) 492001' },
      { name: 'Penguins India', code: 'SUP-PENGUINS' },
      { name: 'Amazon', code: 'SUP-AMAZON' },
      { name: 'Eureka Forbes Limited', code: 'SUP-EUREKA' },
      { name: 'SAROJ', code: 'SUP-SAROJ' },
      { name: 'Subham Communication', code: 'SUP-SUBHAM' }
    ];

    const supplierMap = new Map(); // nameNormalized -> { id, ... }
    const existingSups = await client.query('SELECT id, code, name, name_normalized FROM suppliers WHERE organization_id = $1', [orgId]);
    for (const s of existingSups.rows) {
      supplierMap.set(s.name_normalized, s);
    }

    for (const cfg of supplierConfigs) {
      const nm = normalizeKey(cfg.name);
      if (!supplierMap.has(nm)) {
        supplierMap.set(nm, {
          id: randomUUID(),
          code: cfg.code,
          name: cfg.name,
          address: cfg.address || null,
          isNew: true
        });
      }
    }

    // Now process all rows across sheets
    const assetsToInsert = [];
    const usedAssetCodes = new Set();
    const existingAssetCodesRes = await client.query('SELECT asset_code FROM assets WHERE organization_id = $1', [orgId]);
    for (const r of existingAssetCodesRes.rows) usedAssetCodes.add(r.asset_code);

    let wifiCounter = 1;
    let micTxCounter = 1;
    let micRecCounter = 1;
    let roCounter = 1;

    // Helper to get category
    function getCat(name) {
      const nm = normalizeKey(name);
      const cat = categoryMap.get(nm);
      if (!cat) throw new Error(`Category not found for: ${name}`);
      return cat.id;
    }

    // Helper to get supplier
    function getSup(name) {
      if (!name) return null;
      let nm = normalizeKey(name);
      // Map variations
      if (nm === 'haver electric') nm = normalizeKey('Haver Electric');
      const sup = supplierMap.get(nm);
      return sup ? sup.id : null;
    }

    // 1. Sheet: IT_Assets
    console.log('\nProcessing IT_Assets...');
    for (const item of sheets['IT_Assets']) {
      const d = item.data;
      const type = d['Asset Type'];
      const manufacturer = d['Manufacturer'] ? String(d['Manufacturer']).trim() : null;
      const assetId = d['Asset ID'] ? String(d['Asset ID']).trim() : null;
      const model = d['Model No.'] ? String(d['Model No.']).trim() : null;
      const serial = d['Serial No'] !== null && d['Serial No'] !== undefined ? String(d['Serial No']).trim() : null;
      const vendor = d['Vendor Name'] ? String(d['Vendor Name']).trim() : null;
      const wStart = parseDate(d['Warranty Start Date']);
      const wEnd = computeWarrantyEnd(wStart, d['Warranty End Date']);

      if (!assetId) throw new Error(`Missing Asset ID in IT_Assets row ${item.row}`);
      if (usedAssetCodes.has(assetId)) throw new Error(`Duplicate asset code: ${assetId}`);
      usedAssetCodes.add(assetId);

      assetsToInsert.push({
        id: randomUUID(),
        sheet: 'IT_Assets',
        row: item.row,
        asset_code: assetId,
        category_id: getCat(type),
        manufacturer,
        model_name: model,
        serial_number: serial,
        serial_normalized: normalizeSerial(serial),
        lifecycle_status: 'active',
        operational_status: 'ready',
        condition: 'good',
        location_id: locationId,
        supplier_id: getSup(vendor),
        purchase_date: null,
        warranty_start: wStart,
        warranty_end: wEnd,
        notes: null
      });
    }

    // 2. Sheet: Stand By
    console.log('Processing Stand By...');
    for (const item of sheets['Stand By']) {
      const d = item.data;
      const type = d['Asset Type'];
      const manufacturer = d['Manufacturer'] ? String(d['Manufacturer']).trim() : null;
      let assetId = d['Asset ID'] ? String(d['Asset ID']).trim() : null;
      const serial = d['Serial No'] !== null && d['Serial No'] !== undefined ? String(d['Serial No']).trim() : null;
      const vendor = d['Vendor Name'] ? String(d['Vendor Name']).trim() : null;
      const usage = d['Usage'] ? String(d['Usage']).trim() : null;

      if (!assetId) throw new Error(`Missing Asset ID in Stand By row ${item.row}`);
      if (usedAssetCodes.has(assetId)) throw new Error(`Duplicate asset code: ${assetId}`);
      usedAssetCodes.add(assetId);

      assetsToInsert.push({
        id: randomUUID(),
        sheet: 'Stand By',
        row: item.row,
        asset_code: assetId,
        category_id: getCat(type),
        manufacturer,
        model_name: null,
        serial_number: serial,
        serial_normalized: normalizeSerial(serial),
        lifecycle_status: 'active',
        operational_status: 'ready',
        condition: 'good',
        location_id: locationId,
        supplier_id: getSup(vendor),
        purchase_date: null,
        warranty_start: null,
        warranty_end: null,
        notes: usage ? `Standby item. Assigned/Used at: ${usage}` : 'Standby stock'
      });
    }

    // 3. Sheet: Monitor
    console.log('Processing Monitor...');
    for (const item of sheets['Monitor']) {
      const d = item.data;
      const type = d['Asset Type'];
      const assetId = d['Asset ID'] ? String(d['Asset ID']).trim() : null;
      const serial = d['Serial No'] !== null && d['Serial No'] !== undefined ? String(d['Serial No']).trim() : null;

      // Skip blank / scratch rows
      if (!type && !assetId && !serial) {
        continue;
      }
      if (!type) continue; // blank note row

      const manufacturer = d['Manufacturer'] ? String(d['Manufacturer']).trim() : null;
      const model = d['Model'] ? String(d['Model']).trim() : null;
      const vendor = d['Vendor Name'] ? String(d['Vendor Name']).trim() : null;
      const status = d['Status'] ? String(d['Status']).trim() : null;
      const wEndRaw = d['Warranty End Date'] ? String(d['Warranty End Date']).trim() : null;

      if (!assetId) {
        console.warn(`Skipping Monitor row ${item.row} without Asset ID: ${JSON.stringify(d)}`);
        continue;
      }
      if (usedAssetCodes.has(assetId)) throw new Error(`Duplicate asset code: ${assetId} in Monitor row ${item.row}`);
      usedAssetCodes.add(assetId);

      const isFaulty = status && status.toLowerCase().includes('faulty');
      const extraNotes = [];
      if (status) extraNotes.push(status);
      if (wEndRaw && isNaN(Number(wEndRaw)) && !wEndRaw.includes('-') && !wEndRaw.includes('/')) {
        extraNotes.push(`Remark: ${wEndRaw}`);
      }

      assetsToInsert.push({
        id: randomUUID(),
        sheet: 'Monitor',
        row: item.row,
        asset_code: assetId,
        category_id: getCat(type),
        manufacturer,
        model_name: model,
        serial_number: serial,
        serial_normalized: normalizeSerial(serial),
        lifecycle_status: 'active',
        operational_status: isFaulty ? 'non_operational' : 'ready',
        condition: isFaulty ? 'damaged' : 'good',
        location_id: locationId,
        supplier_id: getSup(vendor),
        purchase_date: null,
        warranty_start: null,
        warranty_end: null,
        notes: extraNotes.length > 0 ? extraNotes.join('; ') : null
      });
    }

    // 4. Sheet: Non IT Assets
    console.log('Processing Non IT Assets...');
    for (const item of sheets['Non IT Assets']) {
      const d = item.data;
      const type = d['ASSET TYPE'] ? String(d['ASSET TYPE']).trim() : null;
      const assetId = d['ASSET CODE'] ? String(d['ASSET CODE']).trim() : null;

      // Skip empty tail rows
      if (!type && !assetId) continue;

      const manufacturer = d['MANUFACTURER'] ? String(d['MANUFACTURER']).trim() : null;
      let vendor = d['VENDOR NAME'] ? String(d['VENDOR NAME']).trim() : null;
      // In Non IT Assets, manufacturer Jai Bajrang Trading Company is also the vendor
      if (!vendor && manufacturer && manufacturer.toLowerCase().includes('bajrang')) {
        vendor = manufacturer;
      }

      const pDate = parseDate(d['ASSET PURCHASE DATE']);
      const wStart = parseDate(d['WARRANTY START DATE']) || pDate;
      const wEnd = parseDate(d['WARRANTY END DATE']);
      const status = d['STATUS'] ? String(d['STATUS']).trim() : null;

      if (!assetId) {
        console.warn(`Non IT Assets row ${item.row} has no code, skipping.`);
        continue;
      }
      if (usedAssetCodes.has(assetId)) throw new Error(`Duplicate asset code: ${assetId} in Non IT Assets row ${item.row}`);
      usedAssetCodes.add(assetId);

      assetsToInsert.push({
        id: randomUUID(),
        sheet: 'Non IT Assets',
        row: item.row,
        asset_code: assetId,
        category_id: getCat(type),
        manufacturer,
        model_name: null,
        serial_number: null,
        serial_normalized: null,
        lifecycle_status: 'active',
        operational_status: 'ready',
        condition: 'good',
        location_id: locationId,
        supplier_id: getSup(vendor),
        purchase_date: pDate,
        warranty_start: wStart,
        warranty_end: wEnd,
        notes: status ? `Location / Status: ${status}` : null
      });
    }

    // 5. Sheet: Other Electronic Assets
    console.log('Processing Other Electronic Assets...');
    for (const item of sheets['Other Electronic Assets']) {
      const d = item.data;
      const type = d['Asset Type'] ? String(d['Asset Type']).trim() : null;
      if (!type) continue;

      const manufacturer = d['Manufacturer'] ? String(d['Manufacturer']).trim() : null;
      const model = d['Model No.'] ? String(d['Model No.']).trim() : null;
      const serial = d['Serial No'] !== null && d['Serial No'] !== undefined ? String(d['Serial No']).trim() : null;
      const vendor = d['Vendor Name'] ? String(d['Vendor Name']).trim() : null;
      const wStart = parseDate(d['Warranty Start Date']);
      const wEnd = computeWarrantyEnd(wStart, d['Warranty End Date']);

      let assetId = d['Asset ID'] ? String(d['Asset ID']).trim() : null;
      if (!assetId) {
        // Generate an appropriate tag
        if (type.includes('Purifier')) {
          assetId = `VLIV/RO/${String(roCounter++).padStart(2, '0')}`;
        } else if (type.includes('Transmitter')) {
          assetId = `VLIV/MIC/TX/${String(micTxCounter++).padStart(2, '0')}`;
        } else if (type.includes('Receiver')) {
          assetId = `VLIV/MIC/REC/${String(micRecCounter++).padStart(2, '0')}`;
        } else {
          assetId = `VLIV/ELEC/${item.row}`;
        }
      }

      if (usedAssetCodes.has(assetId)) throw new Error(`Duplicate asset code: ${assetId} in Other Electronic Assets row ${item.row}`);
      usedAssetCodes.add(assetId);

      assetsToInsert.push({
        id: randomUUID(),
        sheet: 'Other Electronic Assets',
        row: item.row,
        asset_code: assetId,
        category_id: getCat(type),
        manufacturer,
        model_name: model,
        serial_number: serial,
        serial_normalized: normalizeSerial(serial),
        lifecycle_status: 'active',
        operational_status: 'ready',
        condition: 'good',
        location_id: locationId,
        supplier_id: getSup(vendor),
        purchase_date: null,
        warranty_start: wStart,
        warranty_end: wEnd,
        notes: null
      });
    }

    // 6. Sheet: Wifi-Adapter
    console.log('Processing Wifi-Adapter...');
    for (const item of sheets['Wifi-Adapter']) {
      const d = item.data;
      const type = d['Asset Type'] ? String(d['Asset Type']).trim() : 'Wifi Adapter';
      const manufacturer = d['Manufacturer'] ? String(d['Manufacturer']).trim() : null;
      const model = d['Model No.'] ? String(d['Model No.']).trim() : null;
      const serial = d['Serial No'] !== null && d['Serial No'] !== undefined ? String(d['Serial No']).trim() : null;
      const vendor = d['Vendor Name'] ? String(d['Vendor Name']).trim() : null;
      const usage = d['Usage'] ? String(d['Usage']).trim() : null;

      const assetId = `VLIV/WIFI/${String(wifiCounter++).padStart(3, '0')}`;
      if (usedAssetCodes.has(assetId)) throw new Error(`Duplicate asset code: ${assetId}`);
      usedAssetCodes.add(assetId);

      assetsToInsert.push({
        id: randomUUID(),
        sheet: 'Wifi-Adapter',
        row: item.row,
        asset_code: assetId,
        category_id: getCat(type),
        manufacturer,
        model_name: model,
        serial_number: serial,
        serial_normalized: normalizeSerial(serial),
        lifecycle_status: 'active',
        operational_status: 'ready',
        condition: 'good',
        location_id: locationId,
        supplier_id: getSup(vendor),
        purchase_date: null,
        warranty_start: null,
        warranty_end: null,
        notes: usage ? `Plugged in / Used at: ${usage}` : null
      });
    }

    console.log(`\nValidation complete! Total valid assets to insert: ${assetsToInsert.length}`);

    if (!isApply) {
      console.log('\n[DRY RUN SUMMARY]');
      console.log(`Categories to create / verify: ${categoryConfigs.length}`);
      console.log(`Suppliers to create / verify: ${supplierConfigs.length}`);
      console.log(`Location: ${locationName} (${locationCode})`);
      console.log(`Total Assets prepared: ${assetsToInsert.length}`);
      console.log('Sample prepared assets (first 3):');
      console.log(assetsToInsert.slice(0, 3));
      console.log('\nDRY RUN SUCCESSFUL! To apply changes to the database, run with --apply.');
      return;
    }

    // Apply to Database within a Transaction
    console.log('\nBeginning database transaction...');
    await client.query('BEGIN');

    // 1. Ensure Location
    const locExists = await client.query('SELECT id FROM locations WHERE organization_id = $1 AND id = $2', [orgId, locationId]);
    if (!locExists.rows.length) {
      await client.query(
        `INSERT INTO locations (id, organization_id, parent_location_id, location_type, code, code_normalized, name, name_normalized, notes, is_active)
         VALUES ($1, $2, NULL, 'room', $3, $4, $5, $6, 'Imported from Inventory Office-515.xlsx', true)`,
        [locationId, orgId, locationCode, normalizeKey(locationCode), locationName, normalizeKey(locationName)]
      );
      console.log(`Inserted location: ${locationName}`);
    }

    // 2. Ensure Categories
    for (const cat of categoryMap.values()) {
      if (cat.isNew) {
        await client.query(
          `INSERT INTO asset_categories (id, organization_id, code, code_normalized, name, name_normalized, description, asset_domain, tracking_mode, serial_required, serial_unique, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'individual', false, false, true)
           ON CONFLICT (organization_id, name_normalized) DO NOTHING`,
          [cat.id, orgId, cat.code, normalizeKey(cat.code), cat.name, normalizeKey(cat.name), `Category for ${cat.name}`, cat.asset_domain]
        );
        console.log(`Created category: ${cat.name} (${cat.code})`);
      }
    }

    // 3. Ensure Suppliers
    for (const sup of supplierMap.values()) {
      if (sup.isNew) {
        await client.query(
          `INSERT INTO suppliers (id, organization_id, code, code_normalized, name, name_normalized, contact_name, email, phone, address, tax_reference, notes, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, NULL, $7, NULL, 'Imported from Office 515 Inventory', true)
           ON CONFLICT (organization_id, name_normalized) DO NOTHING`,
          [sup.id, orgId, sup.code, normalizeKey(sup.code), sup.name, normalizeKey(sup.name), sup.address]
        );
        console.log(`Created supplier: ${sup.name}`);
      }
    }

    // 4. Insert Assets
    console.log(`Inserting ${assetsToInsert.length} assets...`);
    const insertAssetSql = `
      INSERT INTO assets (
        id, organization_id, asset_code, category_id, model_id, manufacturer, model_name,
        serial_number, serial_normalized, serial_unique_key, specifications,
        lifecycle_status, operational_status, condition, location_id, supplier_id,
        purchase_date, acquisition_cost_minor, currency, invoice_reference, purchase_reference,
        warranty_start, warranty_end, disposal_date, disposal_method, disposal_proceeds_minor, notes
      ) VALUES (
        $1, $2, $3, $4, NULL, $5, $6,
        $7, $8, NULL, NULL,
        $9, $10, $11, $12, $13,
        $14, NULL, 'INR', NULL, NULL,
        $15, $16, NULL, NULL, NULL, $17
      )
    `;

    let insertedCount = 0;
    for (const a of assetsToInsert) {
      await client.query(insertAssetSql, [
        a.id,
        orgId,
        a.asset_code,
        a.category_id,
        a.manufacturer,
        a.model_name,
        a.serial_number,
        a.serial_normalized,
        a.lifecycle_status,
        a.operational_status,
        a.condition,
        a.location_id,
        a.supplier_id,
        a.purchase_date,
        a.warranty_start,
        a.warranty_end,
        a.notes
      ]);
      insertedCount++;
    }

    await client.query('COMMIT');
    console.log(`\nSuccessfully committed transaction! Total assets inserted: ${insertedCount}`);

  } catch (err) {
    console.error('Error during import:', err);
    try {
      await client.query('ROLLBACK');
      console.log('Transaction rolled back.');
    } catch (_) {}
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
