import { verifyPassword } from '../auth.js';

export async function findUserByLogin(client, username, password) {
  const normalizedUsername = username.trim().toLowerCase();
  const result = await client.query(`
    SELECT
      u.id,
      u.organization_id,
      u.display_name,
      u.username,
      u.password_hash,
      u.active,
      u.failed_login_count,
      u.locked_until,
      r.code AS role_code,
      r.name AS role_name
    FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE u.active = TRUE
      AND LOWER(u.username) = $1
    LIMIT 1
  `, [normalizedUsername]);

  const user = result.rows[0];
  if (!user || !(await verifyPassword(password, user.password_hash))) return null;

  return {
    id: user.id,
    organizationId: user.organization_id,
    name: user.display_name,
    username: user.username,
    role: user.role_code,
    roleName: user.role_name,
  };
}

export async function getUserPermissions(client, role) {
  const result = await client.query(`
    SELECT p.code
    FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
    JOIN roles r ON r.id = rp.role_id
    WHERE r.code = $1
      AND r.is_active = TRUE
  `, [role]);

  return new Set(result.rows.map((row) => row.code));
}

export async function getUserById(client, id) {
  const result = await client.query(`
    SELECT u.id, u.organization_id, u.display_name, u.username, u.active, r.code AS role
    FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE u.id = $1
  `, [id]);

  return result.rows[0] ?? null;
}
