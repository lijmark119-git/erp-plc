BEGIN;

DELETE FROM role_permissions rp
USING roles r
WHERE rp.role_id = r.id
  AND r.code = 'MANAGER'
  AND rp.permission_id IN (
    SELECT id FROM permissions WHERE code IN (
      'hr:employees:create',
      'settings:toggle',
      'users:manage'
    )
  );

COMMIT;
