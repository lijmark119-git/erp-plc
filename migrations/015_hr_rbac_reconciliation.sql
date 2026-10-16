INSERT INTO permissions (code, name, description, category)
VALUES
  ('hr:employees:read', 'Read employee records', 'View employee records and employee reports', 'hr'),
  ('hr:employees:create', 'Create employee', 'Create an employee record', 'hr'),
  ('hr:employees:manage', 'Manage employees', 'Update or terminate employee records', 'hr'),
  ('hr:organizations:manage', 'Manage organization structure', 'Manage departments, positions, branches, and hierarchy', 'hr'),
  ('hr:attendance:manage', 'Manage attendance', 'Record employee time, check-ins, check-outs, and absences', 'hr'),
  ('hr:attendance:review', 'Review attendance', 'View attendance records and reports', 'hr'),
  ('hr:leave:review', 'Review leave', 'View leave types, balances, and requests', 'hr'),
  ('hr:leave:manage', 'Manage leave', 'Create leave types and leave requests', 'hr'),
  ('hr:leave:approve', 'Approve leave', 'Approve or reject leave requests', 'hr'),
  ('hr:payroll:read', 'Read payroll', 'View payroll periods and employee payslips', 'hr'),
  ('hr:payroll:calculate', 'Calculate payroll', 'Create payroll periods, calculate payroll, and submit for review', 'hr'),
  ('hr:payroll:approve', 'Approve payroll', 'Approve payroll in review', 'hr'),
  ('hr:payroll:post', 'Post and pay payroll', 'Post payroll journals and record payroll payment', 'hr'),
  ('hr:payroll:settings', 'Manage payroll rules', 'Configure tax, pension, and overtime rules', 'hr'),
  ('hr:payroll:report', 'View payroll reports', 'View payroll, employee, leave, and attendance reports', 'hr')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM roles role
JOIN permissions permission ON permission.code LIKE 'hr:%'
WHERE role.code = 'ADMIN'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM roles role
JOIN permissions permission ON permission.code IN (
  'hr:employees:read',
  'hr:attendance:manage',
  'hr:attendance:review',
  'hr:leave:review',
  'hr:leave:manage',
  'hr:leave:approve',
  'hr:payroll:read',
  'hr:payroll:calculate',
  'hr:payroll:approve',
  'hr:payroll:report'
)
WHERE role.code = 'MANAGER'
ON CONFLICT (role_id, permission_id) DO NOTHING;
