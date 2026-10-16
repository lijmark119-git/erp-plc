INSERT INTO roles (organization_id, code, name, description, is_system)
SELECT organization.id, role_definition.code, role_definition.name, role_definition.description, TRUE
FROM organizations organization
CROSS JOIN (VALUES
  ('SALES_USER', 'Sales User', 'Sales module access only'),
  ('INVENTORY_USER', 'Inventory User', 'Inventory module access only'),
  ('PROCUREMENT_USER', 'Procurement User', 'Procurement module access only'),
  ('HR_USER', 'HR User', 'Employee, attendance, and leave access only'),
  ('FINANCE_USER', 'Finance User', 'Finance and accounting access only'),
  ('BANKING_USER', 'Banking User', 'Banking and reconciliation access only'),
  ('MANUFACTURING_USER', 'Manufacturing User', 'Manufacturing execution and reporting access only')
) AS role_definition(code, name, description)
WHERE organization.is_active = TRUE
ON CONFLICT (organization_id, code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM roles role
JOIN (VALUES
  ('SALES_USER', 'sales:orders:create'),
  ('SALES_USER', 'sales:orders:read'),
  ('SALES_USER', 'sales:customers:read'),
  ('SALES_USER', 'sales:customers:create'),
  ('SALES_USER', 'sales:quotations:read'),
  ('SALES_USER', 'sales:quotations:create'),
  ('SALES_USER', 'sales:delivery:read'),
  ('SALES_USER', 'sales:invoices:read'),
  ('SALES_USER', 'sales:payments:read'),
  ('SALES_USER', 'sales:receivables:read'),
  ('SALES_USER', 'sales:reports:read'),
  ('INVENTORY_USER', 'inventory:stock:update'),
  ('INVENTORY_USER', 'inventory:stock:issue'),
  ('INVENTORY_USER', 'inventory:reports:view'),
  ('PROCUREMENT_USER', 'procurement:comparisons:read'),
  ('PROCUREMENT_USER', 'procurement:comparisons:create'),
  ('PROCUREMENT_USER', 'procurement:comparisons:select'),
  ('PROCUREMENT_USER', 'procurement:orders:create'),
  ('PROCUREMENT_USER', 'procurement:orders:read'),
  ('PROCUREMENT_USER', 'procurement:orders:receive'),
  ('HR_USER', 'hr:employees:read'),
  ('HR_USER', 'hr:attendance:manage'),
  ('HR_USER', 'hr:attendance:review'),
  ('HR_USER', 'hr:leave:review'),
  ('HR_USER', 'hr:leave:manage'),
  ('HR_USER', 'hr:leave:approve'),
  ('FINANCE_USER', 'accounting:reports:view'),
  ('FINANCE_USER', 'accounting:accounts:manage'),
  ('FINANCE_USER', 'accounting:periods:manage'),
  ('FINANCE_USER', 'accounting:journals:create'),
  ('FINANCE_USER', 'accounting:journals:approve'),
  ('FINANCE_USER', 'accounting:journals:post'),
  ('BANKING_USER', 'finance:transactions:create'),
  ('BANKING_USER', 'finance:transactions:approve'),
  ('BANKING_USER', 'finance:transactions:reject'),
  ('BANKING_USER', 'finance:accounts:manage'),
  ('MANUFACTURING_USER', 'manufacturing:read'),
  ('MANUFACTURING_USER', 'manufacturing:orders:create'),
  ('MANUFACTURING_USER', 'manufacturing:orders:release'),
  ('MANUFACTURING_USER', 'manufacturing:materials:reserve'),
  ('MANUFACTURING_USER', 'manufacturing:materials:consume'),
  ('MANUFACTURING_USER', 'manufacturing:output:record'),
  ('MANUFACTURING_USER', 'manufacturing:quality:manage'),
  ('MANUFACTURING_USER', 'manufacturing:mrp:run'),
  ('MANUFACTURING_USER', 'manufacturing:reports:read')
) AS role_permission(role_code, permission_code) ON role_permission.role_code = role.code
JOIN permissions permission ON permission.code = role_permission.permission_code
ON CONFLICT (role_id, permission_id) DO NOTHING;