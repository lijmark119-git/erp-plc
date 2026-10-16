CREATE TABLE IF NOT EXISTS accounting_budgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  budget_code VARCHAR(40) NOT NULL,
  budget_name VARCHAR(160) NOT NULL,
  fiscal_year INTEGER NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 9999),
  status VARCHAR(12) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT', 'ACTIVE', 'CLOSED')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, budget_code),
  UNIQUE (organization_id, fiscal_year),
  UNIQUE (id, organization_id)
);

CREATE TABLE IF NOT EXISTS accounting_budget_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  budget_id UUID NOT NULL,
  account_id UUID NOT NULL REFERENCES accounting_accounts(id) ON DELETE RESTRICT,
  period_start DATE NOT NULL,
  cost_center_code VARCHAR(40) NOT NULL DEFAULT '',
  profit_center_code VARCHAR(40) NOT NULL DEFAULT '',
  budget_amount NUMERIC(20, 2) NOT NULL CHECK (budget_amount >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (budget_id, organization_id)
    REFERENCES accounting_budgets(id, organization_id) ON DELETE CASCADE,
  UNIQUE (budget_id, account_id, period_start, cost_center_code, profit_center_code),
  CHECK (EXTRACT(DAY FROM period_start) = 1)
);

ALTER TABLE accounting_journal_lines
  ADD COLUMN IF NOT EXISTS profit_center VARCHAR(40);

CREATE INDEX IF NOT EXISTS idx_accounting_budgets_org_year
  ON accounting_budgets (organization_id, fiscal_year, status);
CREATE INDEX IF NOT EXISTS idx_accounting_budget_lines_period
  ON accounting_budget_lines (organization_id, period_start, account_id);

INSERT INTO permissions (code, name, description, category)
VALUES
  ('accounting:budgets:manage', 'Manage financial budgets', 'Create monthly budgets and maintain budget-versus-actual controls.', 'accounting')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM roles role
JOIN permissions permission ON permission.code = 'accounting:budgets:manage'
WHERE role.code IN ('ADMIN', 'FINANCE_USER')
ON CONFLICT (role_id, permission_id) DO NOTHING;
