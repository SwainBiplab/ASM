/**
 * W9.5: ties the local asset snapshot to a specific server-granted lease (work package), instead
 * of an unscoped organization-wide download (W9.4). `scope_lease_id` on each row and on the
 * singleton state row both exist so a future multi-scope cache could be added without another
 * migration, but this phase still only ever caches one scope at a time -- `replaceAll` continues
 * to wipe the table first, which is what actually prevents a previous scope's assets from leaking
 * into the current view when the user switches work packages.
 */
export const migration0003 = {
  version: 3,
  name: 'scoped_assets',
  sql: `
ALTER TABLE local_assets ADD COLUMN scope_lease_id TEXT NOT NULL DEFAULT '';
ALTER TABLE local_sync_state ADD COLUMN scope_lease_id TEXT;
`
}
