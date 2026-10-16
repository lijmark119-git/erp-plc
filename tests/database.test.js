import assert from 'node:assert/strict';
import test from 'node:test';

import { checkDatabaseConnection, createDatabasePool } from '../database.js';

test('connects to PostgreSQL and returns server metadata', async () => {
  const pool = createDatabasePool();

  try {
    const result = await checkDatabaseConnection(pool);
    assert.equal(result.database, 'erpplc');
    assert.equal(result.user, 'neondb_owner');
    assert.match(result.version, /^PostgreSQL /);
  } finally {
    await pool.end();
  }
});
