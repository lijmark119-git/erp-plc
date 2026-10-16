INSERT INTO permissions (code, name, description, category)
VALUES
  ('finance:transfers:create', 'Create finance transfer', 'Transfer funds between bank accounts', 'finance'),
  ('inventory:stock:receive', 'Receive inventory stock', 'Receive stock into inventory', 'inventory')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'finance:transfers:create',
  'inventory:stock:receive'
)
WHERE r.code IN ('ADMIN', 'MANAGER')
  AND r.is_active = TRUE
  AND NOT EXISTS (
    SELECT 1
    FROM role_permissions rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );
