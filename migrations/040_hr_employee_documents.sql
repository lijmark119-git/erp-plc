CREATE TABLE IF NOT EXISTS hr_employee_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id VARCHAR(120) NOT NULL,
  document_type VARCHAR(80) NOT NULL,
  document_name VARCHAR(180) NOT NULL,
  reference_url TEXT,
  expiry_date DATE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_hr_employee_documents_expiry
  ON hr_employee_documents (organization_id, expiry_date)
  WHERE expiry_date IS NOT NULL;

INSERT INTO permissions (code, name, description, category)
VALUES
  ('hr:employees:documents:read', 'Read employee documents', 'View employee document metadata and expiry status', 'hr'),
  ('hr:employees:documents:manage', 'Manage employee documents', 'Register employee document metadata and expiry dates', 'hr')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM roles role
JOIN permissions permission ON permission.code IN (
  'hr:employees:documents:read',
  'hr:employees:documents:manage'
)
WHERE role.code = 'ADMIN'
ON CONFLICT (role_id, permission_id) DO NOTHING;
