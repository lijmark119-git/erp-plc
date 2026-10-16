BEGIN;

DELETE FROM role_permissions rp
WHERE rp.role_id IN (
  SELECT id FROM roles WHERE code = 'MANAGER'
)
  AND rp.permission_id NOT IN (
    SELECT id FROM permissions
    WHERE code IN (
      'audit:read',
      'finance:transactions:create',
      'finance:transactions:approve',
      'finance:transactions:reject',
      'inventory:stock:update',
      'inventory:stock:issue',
      'sales:orders:create',
      'sales:orders:approve',
      'procurement:orders:create',
      'manufacturing:orders:create'
    )
  );

DELETE FROM role_permissions rp
WHERE rp.role_id IN (
  SELECT id FROM roles WHERE code = 'SELLER'
)
  AND rp.permission_id NOT IN (
    SELECT id FROM permissions
    WHERE code IN (
      'audit:read',
      'sales:orders:create'
    )
  );

COMMIT;
