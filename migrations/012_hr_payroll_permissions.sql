INSERT INTO permissions (code, name, description, category)
VALUES ('hr:payroll:settings', 'Manage payroll rules', 'Configure payroll rates, tax bands, and calculation rules', 'hr')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM roles role
JOIN permissions permission ON permission.code = 'hr:payroll:settings'
WHERE role.code = 'ADMIN'
ON CONFLICT (role_id, permission_id) DO NOTHING;
