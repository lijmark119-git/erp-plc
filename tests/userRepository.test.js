import assert from 'node:assert/strict';
import test from 'node:test';

import { createDatabasePool, loadEnvironmentFile } from '../database.js';
import { findUserByLogin, getUserPermissions } from '../repositories/userRepository.js';

loadEnvironmentFile();
const adminUsername = process.env.ADMIN_USERNAME;
const adminPassword = process.env.ADMIN_PASSWORD;

test('database users authenticate and expose their role permissions', async () => {
  const pool = createDatabasePool();
  const client = await pool.connect();

  try {
    const user = await findUserByLogin(client, adminUsername, adminPassword);
    assert.ok(user);
    assert.equal(user.role, 'ADMIN');

    const permissions = await getUserPermissions(client, user.role);
    assert.ok(permissions.has('users:manage'));
    assert.ok(permissions.has('finance:transactions:approve'));
    assert.equal(permissions.has('sales:orders:create'), true);
  } finally {
    client.release();
    await pool.end();
  }
});
