CREATE TABLE IF NOT EXISTS enterprise_entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(160) NOT NULL,
  entity_type VARCHAR(20) NOT NULL CHECK (entity_type IN ('SUBSIDIARY', 'PLANT')),
  parent_entity_id UUID,
  currency CHAR(3),
  status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, code),
  UNIQUE (id, organization_id),
  FOREIGN KEY (parent_entity_id, organization_id)
    REFERENCES enterprise_entities(id, organization_id)
);

CREATE TABLE IF NOT EXISTS enterprise_business_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(160) NOT NULL,
  entity_id UUID,
  department_code VARCHAR(40),
  status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, code),
  UNIQUE (id, organization_id),
  FOREIGN KEY (entity_id, organization_id)
    REFERENCES enterprise_entities(id, organization_id)
);

CREATE TABLE IF NOT EXISTS enterprise_cost_centers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(160) NOT NULL,
  entity_id UUID,
  business_unit_id UUID,
  department_code VARCHAR(40),
  status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, code),
  UNIQUE (id, organization_id),
  FOREIGN KEY (entity_id, organization_id)
    REFERENCES enterprise_entities(id, organization_id),
  FOREIGN KEY (business_unit_id, organization_id)
    REFERENCES enterprise_business_units(id, organization_id)
);

CREATE TABLE IF NOT EXISTS enterprise_profit_centers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(160) NOT NULL,
  entity_id UUID,
  business_unit_id UUID,
  department_code VARCHAR(40),
  status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, code),
  UNIQUE (id, organization_id),
  FOREIGN KEY (entity_id, organization_id)
    REFERENCES enterprise_entities(id, organization_id),
  FOREIGN KEY (business_unit_id, organization_id)
    REFERENCES enterprise_business_units(id, organization_id)
);

CREATE TABLE IF NOT EXISTS enterprise_fiscal_years (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(160) NOT NULL,
  entity_id UUID,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'OPEN', 'CLOSED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (end_date >= start_date),
  UNIQUE (organization_id, code),
  UNIQUE (id, organization_id),
  FOREIGN KEY (entity_id, organization_id)
    REFERENCES enterprise_entities(id, organization_id)
);

CREATE TABLE IF NOT EXISTS enterprise_approval_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code VARCHAR(40) NOT NULL,
  transaction_type VARCHAR(80) NOT NULL,
  department_code VARCHAR(40),
  requester_role VARCHAR(80),
  entity_id UUID,
  min_amount NUMERIC(18, 2) NOT NULL DEFAULT 0 CHECK (min_amount >= 0),
  max_amount NUMERIC(18, 2),
  currency CHAR(3) NOT NULL,
  approver_role VARCHAR(80) NOT NULL,
  delegated_from_role VARCHAR(80),
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (max_amount IS NULL OR max_amount > min_amount),
  UNIQUE (organization_id, code),
  UNIQUE (id, organization_id),
  FOREIGN KEY (entity_id, organization_id)
    REFERENCES enterprise_entities(id, organization_id)
);

CREATE TABLE IF NOT EXISTS enterprise_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code VARCHAR(40) NOT NULL,
  title VARCHAR(200) NOT NULL,
  entity_id UUID,
  owner_department VARCHAR(80) NOT NULL,
  classification VARCHAR(20) NOT NULL DEFAULT 'INTERNAL'
    CHECK (classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED')),
  effective_date DATE NOT NULL,
  review_date DATE,
  retention_days INTEGER NOT NULL DEFAULT 0 CHECK (retention_days >= 0),
  document_reference VARCHAR(500),
  status VARCHAR(10) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (review_date IS NULL OR review_date >= effective_date),
  UNIQUE (organization_id, code),
  UNIQUE (id, organization_id),
  FOREIGN KEY (entity_id, organization_id)
    REFERENCES enterprise_entities(id, organization_id)
);

CREATE INDEX IF NOT EXISTS idx_enterprise_entities_org_parent
  ON enterprise_entities(organization_id, parent_entity_id);
CREATE INDEX IF NOT EXISTS idx_enterprise_fiscal_years_org_dates
  ON enterprise_fiscal_years(organization_id, entity_id, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_enterprise_approval_rules_lookup
  ON enterprise_approval_rules(organization_id, active, transaction_type, priority);
CREATE INDEX IF NOT EXISTS idx_enterprise_policies_org_review
  ON enterprise_policies(organization_id, status, review_date);

INSERT INTO permissions (code, name, description, category)
VALUES
  ('governance:read', 'Read enterprise governance', 'View enterprise structure, controls, policies, and governance reports.', 'governance'),
  ('governance:manage', 'Manage enterprise governance', 'Create and maintain enterprise structure, approval rules, fiscal years, and policies.', 'governance')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM roles role
JOIN permissions permission ON permission.code IN ('governance:read', 'governance:manage')
WHERE role.code = 'ADMIN'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM roles role
JOIN permissions permission ON permission.code = 'governance:read'
WHERE role.code = 'MANAGER'
ON CONFLICT (role_id, permission_id) DO NOTHING;
