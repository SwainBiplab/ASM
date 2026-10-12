/**
 * Organization structure and employees (port of prototype M2 to PostgreSQL).
 * Children reference parents through (organization_id, id) composite foreign keys, so a row can
 * never point at another organization's record. Nothing is deleted; is_active /
 * employment_status preserve history.
 */
export const migration0003 = {
  version: 3,
  name: 'organization',
  sql: `
CREATE TABLE departments (
  id                  uuid PRIMARY KEY,
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  code                text,
  code_normalized     text,
  name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  name_normalized     text NOT NULL,
  manager_employee_id uuid,
  notes               text,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, name_normalized)
);
CREATE UNIQUE INDEX ux_departments_code ON departments(organization_id, code_normalized) WHERE code_normalized IS NOT NULL;

CREATE TABLE teams (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  department_id    uuid NOT NULL,
  kind             text NOT NULL DEFAULT 'team' CHECK (kind IN ('team', 'process')),
  code             text,
  code_normalized  text,
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  name_normalized  text NOT NULL,
  lead_employee_id uuid,
  notes            text,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (department_id, name_normalized),
  FOREIGN KEY (organization_id, department_id) REFERENCES departments(organization_id, id)
);
CREATE UNIQUE INDEX ux_teams_code ON teams(organization_id, code_normalized) WHERE code_normalized IS NOT NULL;
CREATE INDEX idx_teams_department ON teams(department_id);

CREATE TABLE locations (
  id                 uuid PRIMARY KEY,
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  parent_location_id uuid,
  location_type      text NOT NULL CHECK (location_type IN ('site', 'building', 'floor', 'room', 'bay', 'storage', 'other')),
  code               text,
  code_normalized    text,
  name               text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  name_normalized    text NOT NULL,
  notes              text,
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE NULLS NOT DISTINCT (organization_id, parent_location_id, name_normalized),
  FOREIGN KEY (organization_id, parent_location_id) REFERENCES locations(organization_id, id),
  CHECK (parent_location_id IS NULL OR parent_location_id <> id)
);
CREATE UNIQUE INDEX ux_locations_code ON locations(organization_id, code_normalized) WHERE code_normalized IS NOT NULL;
CREATE INDEX idx_locations_parent ON locations(parent_location_id);

CREATE TABLE workstations (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  location_id     uuid NOT NULL,
  kind            text NOT NULL DEFAULT 'workstation' CHECK (kind IN ('workstation', 'seat')),
  code            text NOT NULL,
  code_normalized text NOT NULL,
  label           text,
  notes           text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, code_normalized),
  FOREIGN KEY (organization_id, location_id) REFERENCES locations(organization_id, id)
);
CREATE INDEX idx_workstations_location ON workstations(location_id);

CREATE TABLE employees (
  id                       uuid PRIMARY KEY,
  organization_id          uuid NOT NULL REFERENCES organizations(id),
  employee_code            text NOT NULL CHECK (length(employee_code) BETWEEN 1 AND 50),
  employee_code_normalized text NOT NULL,
  full_name                text NOT NULL CHECK (length(full_name) BETWEEN 1 AND 150),
  email                    text,
  email_normalized         text,
  phone                    text,
  job_title                text,
  department_id            uuid,
  team_id                  uuid,
  manager_employee_id      uuid,
  work_location_id         uuid,
  employment_status        text NOT NULL DEFAULT 'active' CHECK (employment_status IN ('active', 'on_leave', 'notice_period', 'exited')),
  joining_date             date,
  expected_exit_date       date,
  actual_exit_date         date,
  notes                    text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, employee_code_normalized),
  FOREIGN KEY (organization_id, department_id) REFERENCES departments(organization_id, id),
  FOREIGN KEY (organization_id, team_id) REFERENCES teams(organization_id, id),
  FOREIGN KEY (organization_id, manager_employee_id) REFERENCES employees(organization_id, id),
  FOREIGN KEY (organization_id, work_location_id) REFERENCES locations(organization_id, id),
  CHECK (manager_employee_id IS NULL OR manager_employee_id <> id),
  CHECK (employment_status <> 'exited' OR actual_exit_date IS NOT NULL),
  CHECK (expected_exit_date IS NULL OR joining_date IS NULL OR expected_exit_date >= joining_date)
);
CREATE INDEX idx_employees_email ON employees(organization_id, email_normalized) WHERE email_normalized IS NOT NULL;
CREATE INDEX idx_employees_department ON employees(department_id);
CREATE INDEX idx_employees_team ON employees(team_id);
CREATE INDEX idx_employees_manager ON employees(manager_employee_id);
CREATE INDEX idx_employees_status ON employees(organization_id, employment_status);
CREATE INDEX idx_employees_name ON employees(organization_id, lower(full_name));

-- Manager/lead references are added after employees exists (circular relationship).
ALTER TABLE departments ADD FOREIGN KEY (organization_id, manager_employee_id) REFERENCES employees(organization_id, id);
ALTER TABLE teams ADD FOREIGN KEY (organization_id, lead_employee_id) REFERENCES employees(organization_id, id);

CREATE TABLE asset_pools (
  id                        uuid PRIMARY KEY,
  organization_id           uuid NOT NULL REFERENCES organizations(id),
  code                      text,
  code_normalized           text,
  name                      text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  name_normalized           text NOT NULL,
  purpose                   text,
  responsible_department_id uuid,
  responsible_team_id       uuid,
  default_location_id       uuid,
  is_active                 boolean NOT NULL DEFAULT true,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, name_normalized),
  FOREIGN KEY (organization_id, responsible_department_id) REFERENCES departments(organization_id, id),
  FOREIGN KEY (organization_id, responsible_team_id) REFERENCES teams(organization_id, id),
  FOREIGN KEY (organization_id, default_location_id) REFERENCES locations(organization_id, id),
  CHECK (responsible_department_id IS NOT NULL OR responsible_team_id IS NOT NULL)
);
CREATE UNIQUE INDEX ux_asset_pools_code ON asset_pools(organization_id, code_normalized) WHERE code_normalized IS NOT NULL;
`
} as const
