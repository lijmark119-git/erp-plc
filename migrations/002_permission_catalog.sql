WITH default_organization AS (
  INSERT INTO organizations (id, code, name, legal_name, timezone, currency)
  SELECT
    gen_random_uuid(),
    'DEFAULT',
    'Default Organization',
    'Default Organization',
    'Africa/Addis_Ababa',
    'ETB'
  WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE code = 'DEFAULT')
  RETURNING id
),
role_ids AS (
  INSERT INTO roles (id, organization_id, code, name, description, is_system)
  SELECT
    gen_random_uuid(),
    id,
    role_code,
    role_name,
    description,
    TRUE
  FROM default_organization,
       (VALUES
         ('ADMIN', 'Administrator', 'Full system administration'),
         ('MANAGER', 'Operations Manager', 'Operational management and approvals'),
         ('SELLER', 'Sales Representative', 'Sales and customer operations')
       ) AS role_definitions(role_code, role_name, description)
  RETURNING id, code
),
permission_ids AS (
  INSERT INTO permissions (id, code, name, description, category)
  SELECT gen_random_uuid(), code, name, description, category
  FROM (VALUES
    ('finance:transactions:create', 'Create finance transaction', 'Create a finance transaction', 'finance'),
    ('finance:transactions:approve', 'Approve finance transaction', 'Approve a pending finance transaction', 'finance'),
    ('finance:transactions:reject', 'Reject finance transaction', 'Reject a pending finance transaction', 'finance'),
    ('inventory:stock:update', 'Update inventory stock', 'Adjust stock levels and dispatch goods', 'inventory'),
    ('inventory:stock:issue', 'Issue inventory stock', 'Issue stock to a production or customer order', 'inventory'),
    ('sales:orders:create', 'Create sales order', 'Create a sales order', 'sales'),
    ('sales:orders:approve', 'Approve sales order', 'Approve a sales order', 'sales'),
    ('procurement:orders:create', 'Create procurement order', 'Create a procurement order', 'procurement'),
    ('manufacturing:orders:create', 'Create manufacturing order', 'Create a manufacturing order', 'manufacturing'),
    ('hr:employees:create', 'Create employee', 'Create an employee record', 'hr'),
    ('settings:toggle', 'Toggle setting', 'Change system settings', 'settings'),
    ('users:manage', 'Manage users', 'Create, update, or disable users', 'users'),
    ('audit:read', 'Read audit events', 'Read security and business audit events', 'audit')
  ) AS permission_definitions(code, name, description, category)
  RETURNING id, code
)
INSERT INTO role_permissions (role_id, permission_id)
SELECT role_ids.id, permission_ids.id
FROM role_ids, permission_ids
WHERE role_ids.code = 'ADMIN'
   AND permission_ids.code IN (
     'finance:transactions:create',
     'finance:transactions:approve',
     'finance:transactions:reject',
     'inventory:stock:update',
     'inventory:stock:issue',
     'sales:orders:create',
     'sales:orders:approve',
     'procurement:orders:create',
     'manufacturing:orders:create',
     'hr:employees:create',
     'settings:toggle',
     'users:manage',
     'audit:read'
   )
UNION ALL
SELECT role_ids.id, permission_ids.id
FROM role_ids, permission_ids
WHERE role_ids.code = 'MANAGER'
   AND permission_ids.code IN (
     'finance:transactions:create',
     'finance:transactions:approve',
     'finance:transactions:reject',
     'inventory:stock:update',
     'inventory:stock:issue',
     'sales:orders:create',
     'sales:orders:approve',
     'procurement:orders:create',
     'manufacturing:orders:create',
     'hr:employees:create',
     'settings:toggle',
     'audit:read'
   )
UNION ALL
SELECT role_ids.id, permission_ids.id
FROM role_ids, permission_ids
WHERE role_ids.code = 'SELLER'
   AND permission_ids.code IN (
     'sales:orders:create',
     'sales:orders:approve',
     'audit:read'
   );
