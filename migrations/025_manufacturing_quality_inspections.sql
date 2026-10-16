CREATE TABLE IF NOT EXISTS manufacturing_quality_inspections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lot_id UUID NOT NULL REFERENCES manufacturing_lots(id) ON DELETE RESTRICT,
  inspection_stage VARCHAR(20) NOT NULL CHECK (inspection_stage IN ('INCOMING', 'IN_PROCESS', 'FINAL')),
  inspected_quantity NUMERIC(20, 6) NOT NULL CHECK (inspected_quantity > 0),
  passed_quantity NUMERIC(20, 6) NOT NULL CHECK (passed_quantity >= 0),
  failed_quantity NUMERIC(20, 6) NOT NULL CHECK (failed_quantity >= 0),
  result VARCHAR(20) NOT NULL CHECK (result IN ('PASS', 'PARTIAL', 'FAIL')),
  defect_code VARCHAR(80),
  notes TEXT,
  inspected_by UUID REFERENCES users(id) ON DELETE SET NULL,
  inspected_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (ABS(inspected_quantity - passed_quantity - failed_quantity) <= 0.000001),
  CHECK (
    (failed_quantity = 0 AND result = 'PASS') OR
    (passed_quantity = 0 AND result = 'FAIL') OR
    (passed_quantity > 0 AND failed_quantity > 0 AND result = 'PARTIAL')
  )
);

CREATE INDEX IF NOT EXISTS idx_manufacturing_quality_org_inspected
  ON manufacturing_quality_inspections (organization_id, inspected_at DESC);
CREATE INDEX IF NOT EXISTS idx_manufacturing_quality_lot
  ON manufacturing_quality_inspections (organization_id, lot_id, inspected_at DESC);

INSERT INTO permissions (code, name, description, category)
VALUES (
  'manufacturing:quality:manage',
  'Manage manufacturing quality inspections',
  'Record incoming, in-process, and final lot inspections',
  'manufacturing'
)
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM roles role JOIN permissions permission ON permission.code = 'manufacturing:quality:manage'
WHERE role.code IN ('ADMIN', 'MANAGER')
ON CONFLICT (role_id, permission_id) DO NOTHING;