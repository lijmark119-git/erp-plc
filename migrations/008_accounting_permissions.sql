INSERT INTO permissions (code, name, description, category)
VALUES
  ('accounting:accounts:manage', 'Manage chart of accounts', 'Create, update, activate, or deactivate accounting accounts', 'accounting'),
  ('accounting:periods:manage', 'Manage accounting periods', 'Open or close accounting periods', 'accounting'),
  ('accounting:journals:create', 'Create general ledger journal', 'Create journal entries in draft or submitted status', 'accounting'),
  ('accounting:journals:approve', 'Approve general ledger journal', 'Approve submitted journal entries', 'accounting'),
  ('accounting:journals:post', 'Post general ledger journal', 'Post approved journal entries', 'accounting'),
  ('accounting:journals:reverse', 'Reverse posted journal', 'Create a posted reversal journal', 'accounting'),
  ('accounting:journals:cancel', 'Cancel journal', 'Cancel draft or submitted journal entries', 'accounting'),
  ('accounting:reports:view', 'View accounting reports', 'View ledger, trial balance, and financial statements', 'accounting')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'accounting:accounts:manage',
  'accounting:periods:manage',
  'accounting:journals:create',
  'accounting:journals:approve',
  'accounting:journals:post',
  'accounting:journals:reverse',
  'accounting:journals:cancel',
  'accounting:reports:view'
)
WHERE r.code = 'ADMIN'
  AND r.is_active = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'accounting:journals:approve',
  'accounting:journals:post',
  'accounting:journals:reverse',
  'accounting:reports:view'
)
WHERE r.code = 'MANAGER'
  AND r.is_active = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );
