CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(160) NOT NULL,
  description VARCHAR(1000),
  start_date DATE,
  due_date DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'PLANNED'
    CHECK (status IN ('PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (start_date IS NULL OR due_date IS NULL OR due_date >= start_date),
  UNIQUE (organization_id, code),
  UNIQUE (id, organization_id)
);

CREATE TABLE IF NOT EXISTS project_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id UUID NOT NULL,
  title VARCHAR(160) NOT NULL,
  description VARCHAR(1000),
  due_date DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (id, organization_id),
  FOREIGN KEY (project_id, organization_id)
    REFERENCES projects(id, organization_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_projects_org_status_due
  ON projects (organization_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_project_tasks_project_status_due
  ON project_tasks (organization_id, project_id, status, due_date);

INSERT INTO permissions (code, name, description, category)
VALUES
  ('projects:read', 'Read projects', 'View organization projects and project tasks.', 'projects'),
  ('projects:manage', 'Manage projects', 'Create projects and update project and task statuses.', 'projects')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM roles role
JOIN permissions permission ON permission.code IN ('projects:read', 'projects:manage')
WHERE role.code = 'ADMIN'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM roles role
JOIN permissions permission ON permission.code IN ('projects:read', 'projects:manage')
WHERE role.code = 'MANAGER'
ON CONFLICT (role_id, permission_id) DO NOTHING;
