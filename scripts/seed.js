import { hashPassword } from '../auth.js';
import { createDatabasePool, loadEnvironmentFile } from '../database.js';

loadEnvironmentFile();

const adminUsername = process.env.ADMIN_USERNAME;
const adminPassword = process.env.ADMIN_PASSWORD;
const managerUsername = process.env.MANAGER_USERNAME;
const managerPassword = process.env.MANAGER_PASSWORD;
const sellerUsername = process.env.SELLER_USERNAME;
const sellerPassword = process.env.SELLER_PASSWORD;

if (!adminUsername || !adminPassword || !managerUsername || !managerPassword || !sellerUsername || !sellerPassword) {
  console.log('Seed skipped: required user credentials are not configured.');
  process.exit(0);
}

const pool = createDatabasePool();
const client = await pool.connect();
try {
  const organization = await client.query(
    'SELECT id FROM organizations WHERE code = $1',
    ['DEFAULT'],
  );

  if (organization.rowCount === 0) {
    throw new Error('Run db:migrate before seeding users.');
  }

  const roles = await client.query(
    'SELECT code, id FROM roles WHERE organization_id = $1 AND is_active = TRUE',
    [organization.rows[0].id],
  );
  const roleMap = Object.fromEntries(roles.rows.map((role) => [role.code, role.id]));

  for (const [username, password, roleCode, displayName] of [
    [adminUsername, adminPassword, 'ADMIN', 'System Administrator'],
    [managerUsername, managerPassword, 'MANAGER', 'Operations Manager'],
    [sellerUsername, sellerPassword, 'SELLER', 'Sales Representative'],
  ]) {
    const passwordHash = await hashPassword(password);
    await client.query(`
      INSERT INTO users (organization_id, display_name, username, password_hash, role_id)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (organization_id, username) DO UPDATE
      SET password_hash = EXCLUDED.password_hash,
          password_changed_at = CURRENT_TIMESTAMP,
          active = TRUE,
          role_id = EXCLUDED.role_id
    `, [organization.rows[0].id, displayName, username.trim().toLowerCase(), passwordHash, roleMap[roleCode]]);
  }

  console.log('Seeded administrator, manager, and seller users.');
} finally {
  client.release();
  await pool.end();
}
