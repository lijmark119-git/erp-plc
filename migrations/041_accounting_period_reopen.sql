CREATE TABLE IF NOT EXISTS accounting_period_reopen_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE CASCADE,
  reopened_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reason VARCHAR(500) NOT NULL CHECK (length(trim(reason)) > 0),
  previous_closed_at TIMESTAMPTZ,
  previous_closed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reopened_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_accounting_period_reopen_history_period
  ON accounting_period_reopen_history (organization_id, period_id, reopened_at DESC);

INSERT INTO permissions (code, name, description, category)
VALUES (
  'accounting:periods:reopen',
  'Reopen closed accounting periods',
  'Reopen a closed accounting period with a required reason and immutable audit history.',
  'accounting'
)
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM roles role
JOIN permissions permission ON permission.code = 'accounting:periods:reopen'
WHERE role.code = 'ADMIN'
ON CONFLICT (role_id, permission_id) DO NOTHING;
