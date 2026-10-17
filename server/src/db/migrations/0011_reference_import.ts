/**
 * Widens import_sessions.kind to also hold reference-data import sessions (CSV/Excel bulk setup
 * for categories, models, suppliers, departments, teams, locations and workstations). Same table,
 * same owner-bound/expiring/single-use semantics (migration 0002); only the allowed `kind` values
 * grow, matching 0009's precedent for the asset importer.
 */
export const migration0011 = {
  version: 11,
  name: 'reference_import',
  sql: `
ALTER TABLE import_sessions DROP CONSTRAINT import_sessions_kind_check;
ALTER TABLE import_sessions ADD CONSTRAINT import_sessions_kind_check
  CHECK (kind IN ('employees', 'assets', 'categories', 'models', 'suppliers', 'departments', 'teams', 'locations', 'workstations'));
`
} as const
