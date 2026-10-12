/**
 * Organization structure and employees (M2): departments, teams/processes, physical
 * location hierarchy, workstations/seats, shared asset pools, employees.
 * Rows are never deleted; `is_active` / `employment_status` preserve history.
 * `*_normalized` columns carry case-insensitive uniqueness.
 */
export const migration0002 = {
  version: 2,
  name: 'organization',
  sql: `
CREATE TABLE departments (
  id                  TEXT PRIMARY KEY,
  organization_id     TEXT NOT NULL REFERENCES organization_profile(id),
  code                TEXT,
  code_normalized     TEXT,
  name                TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  name_normalized     TEXT NOT NULL,
  manager_employee_id TEXT REFERENCES employees(id),
  notes               TEXT,
  is_active           INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX ux_departments_name ON departments(organization_id, name_normalized);
CREATE UNIQUE INDEX ux_departments_code ON departments(organization_id, code_normalized) WHERE code_normalized IS NOT NULL;

CREATE TABLE teams (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organization_profile(id),
  department_id    TEXT NOT NULL REFERENCES departments(id),
  kind             TEXT NOT NULL DEFAULT 'team' CHECK (kind IN ('team', 'process')),
  code             TEXT,
  code_normalized  TEXT,
  name             TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  name_normalized  TEXT NOT NULL,
  lead_employee_id TEXT REFERENCES employees(id),
  notes            TEXT,
  is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX ux_teams_name ON teams(department_id, name_normalized);
CREATE UNIQUE INDEX ux_teams_code ON teams(organization_id, code_normalized) WHERE code_normalized IS NOT NULL;
CREATE INDEX idx_teams_department ON teams(department_id);

CREATE TABLE locations (
  id                 TEXT PRIMARY KEY,
  organization_id    TEXT NOT NULL REFERENCES organization_profile(id),
  parent_location_id TEXT REFERENCES locations(id),
  location_type      TEXT NOT NULL CHECK (location_type IN ('site', 'building', 'floor', 'room', 'bay', 'storage', 'other')),
  code               TEXT,
  code_normalized    TEXT,
  name               TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  name_normalized    TEXT NOT NULL,
  notes              TEXT,
  is_active          INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  CHECK (parent_location_id IS NULL OR parent_location_id <> id)
) STRICT;
CREATE UNIQUE INDEX ux_locations_sibling_name ON locations(organization_id, COALESCE(parent_location_id, ''), name_normalized);
CREATE UNIQUE INDEX ux_locations_code ON locations(organization_id, code_normalized) WHERE code_normalized IS NOT NULL;
CREATE INDEX idx_locations_parent ON locations(parent_location_id);

-- Workstations/seats are assignable places (future assignment target), linked to a room/floor/bay.
CREATE TABLE workstations (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization_profile(id),
  location_id     TEXT NOT NULL REFERENCES locations(id),
  kind            TEXT NOT NULL DEFAULT 'workstation' CHECK (kind IN ('workstation', 'seat')),
  code            TEXT NOT NULL,
  code_normalized TEXT NOT NULL,
  label           TEXT,
  notes           TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX ux_workstations_code ON workstations(organization_id, code_normalized);
CREATE INDEX idx_workstations_location ON workstations(location_id);

-- Shared custody groups. Assets join pools through assignments (M4), never via a column here.
CREATE TABLE asset_pools (
  id                        TEXT PRIMARY KEY,
  organization_id           TEXT NOT NULL REFERENCES organization_profile(id),
  code                      TEXT,
  code_normalized           TEXT,
  name                      TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  name_normalized           TEXT NOT NULL,
  purpose                   TEXT,
  responsible_department_id TEXT REFERENCES departments(id),
  responsible_team_id       TEXT REFERENCES teams(id),
  default_location_id       TEXT REFERENCES locations(id),
  is_active                 INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  CHECK (responsible_department_id IS NOT NULL OR responsible_team_id IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX ux_asset_pools_name ON asset_pools(organization_id, name_normalized);
CREATE UNIQUE INDEX ux_asset_pools_code ON asset_pools(organization_id, code_normalized) WHERE code_normalized IS NOT NULL;

CREATE TABLE employees (
  id                       TEXT PRIMARY KEY,
  organization_id          TEXT NOT NULL REFERENCES organization_profile(id),
  employee_code            TEXT NOT NULL CHECK (length(employee_code) BETWEEN 1 AND 50),
  employee_code_normalized TEXT NOT NULL,
  full_name                TEXT NOT NULL CHECK (length(full_name) BETWEEN 1 AND 150),
  email                    TEXT,
  email_normalized         TEXT,
  phone                    TEXT,
  job_title                TEXT,
  department_id            TEXT REFERENCES departments(id),
  team_id                  TEXT REFERENCES teams(id),
  manager_employee_id      TEXT REFERENCES employees(id),
  work_location_id         TEXT REFERENCES locations(id),
  employment_status        TEXT NOT NULL DEFAULT 'active'
                           CHECK (employment_status IN ('active', 'on_leave', 'notice_period', 'exited')),
  joining_date             TEXT CHECK (joining_date IS NULL OR joining_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  expected_exit_date       TEXT CHECK (expected_exit_date IS NULL OR expected_exit_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  actual_exit_date         TEXT CHECK (actual_exit_date IS NULL OR actual_exit_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  notes                    TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  CHECK (manager_employee_id IS NULL OR manager_employee_id <> id),
  CHECK (employment_status <> 'exited' OR actual_exit_date IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX ux_employees_code ON employees(organization_id, employee_code_normalized);
CREATE INDEX idx_employees_email ON employees(email_normalized) WHERE email_normalized IS NOT NULL;
CREATE INDEX idx_employees_department ON employees(department_id);
CREATE INDEX idx_employees_team ON employees(team_id);
CREATE INDEX idx_employees_manager ON employees(manager_employee_id);
CREATE INDEX idx_employees_status ON employees(employment_status);
CREATE INDEX idx_employees_name ON employees(full_name COLLATE NOCASE);
`
} as const
