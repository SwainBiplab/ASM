/**
 * Widens import_sessions.kind to also hold asset-import sessions (CSV/Excel, individually-tracked
 * categories only). The table and its owner-bound/expiring/single-use semantics are unchanged
 * (migration 0002); only the allowed `kind` values grow, exactly like a prototype enum would.
 */
export const migration0009 = {
  version: 9,
  name: 'asset_import',
  sql: `
ALTER TABLE import_sessions DROP CONSTRAINT import_sessions_kind_check;
ALTER TABLE import_sessions ADD CONSTRAINT import_sessions_kind_check CHECK (kind IN ('employees', 'assets'));
`
} as const
