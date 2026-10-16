-- Sales Management RBAC Permissions

INSERT INTO permissions (code, name, description, category)
SELECT code, name, description, 'sales'
FROM (VALUES
  ('sales:customers:read', 'Read customers', 'View customer master data'),
  ('sales:customers:create', 'Create customers', 'Add new customers'),
  ('sales:customers:manage', 'Manage customers', 'Edit and delete customers'),
  ('sales:quotations:read', 'Read quotations', 'View quotations'),
  ('sales:quotations:create', 'Create quotations', 'Create new quotations'),
  ('sales:quotations:manage', 'Manage quotations', 'Edit and delete quotations'),
  ('sales:quotations:approve', 'Approve quotations', 'Approve or reject quotations'),
  ('sales:orders:read', 'Read sales orders', 'View sales orders'),
  ('sales:orders:create', 'Create sales order', 'Create a sales order'),
  ('sales:orders:manage', 'Manage sales orders', 'Edit sales orders'),
  ('sales:orders:approve', 'Approve sales orders', 'Approve or reject sales orders'),
  ('sales:delivery:read', 'Read delivery notes', 'View delivery notes'),
  ('sales:delivery:create', 'Create delivery notes', 'Create new delivery notes'),
  ('sales:delivery:manage', 'Manage delivery notes', 'Update delivery status'),
  ('sales:invoices:read', 'Read invoices', 'View customer invoices'),
  ('sales:invoices:create', 'Create invoices', 'Create new invoices'),
  ('sales:invoices:manage', 'Manage invoices', 'Edit invoices'),
  ('sales:payments:read', 'Read payments', 'View payment records'),
  ('sales:payments:create', 'Record payments', 'Record new payments'),
  ('sales:reports:read', 'Read sales reports', 'View sales reports'),
  ('sales:receivables:read', 'Read receivables', 'View accounts receivable')
) AS permission_definitions(code, name, description)
ON CONFLICT (code) DO NOTHING;

-- Assign permissions to ADMIN role
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'ADMIN' AND p.code IN (
  'sales:customers:read', 'sales:customers:create', 'sales:customers:manage',
  'sales:quotations:read', 'sales:quotations:create', 'sales:quotations:manage', 'sales:quotations:approve',
  'sales:orders:read', 'sales:orders:create', 'sales:orders:manage', 'sales:orders:approve',
  'sales:delivery:read', 'sales:delivery:create', 'sales:delivery:manage',
  'sales:invoices:read', 'sales:invoices:create', 'sales:invoices:manage',
  'sales:payments:read', 'sales:payments:create',
  'sales:reports:read',
  'sales:receivables:read'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Assign permissions to MANAGER role
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'MANAGER' AND p.code IN (
  'sales:customers:read', 'sales:customers:create', 'sales:customers:manage',
  'sales:quotations:read', 'sales:quotations:create', 'sales:quotations:manage', 'sales:quotations:approve',
  'sales:orders:read', 'sales:orders:create', 'sales:orders:manage', 'sales:orders:approve',
  'sales:delivery:read', 'sales:delivery:create', 'sales:delivery:manage',
  'sales:invoices:read', 'sales:invoices:create', 'sales:invoices:manage',
  'sales:payments:read', 'sales:payments:create',
  'sales:reports:read',
  'sales:receivables:read'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Assign limited permissions to SELLER role
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'SELLER' AND p.code IN (
  'sales:customers:read',
  'sales:quotations:read', 'sales:quotations:create',
  'sales:orders:read', 'sales:orders:create',
  'sales:delivery:read',
  'sales:invoices:read',
  'sales:payments:read',
  'sales:reports:read',
  'sales:receivables:read'
)
ON CONFLICT (role_id, permission_id) DO NOTHING;
