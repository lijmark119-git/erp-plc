import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { migrationChecksumMatches } from '../scripts/migrate.js';

const sql = 'CREATE TABLE example (\n  id INTEGER\n);\n';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

test('migration checksums are independent of line endings', () => {
  const checksum = hash(sql);

  assert.equal(migrationChecksumMatches(sql, checksum), true);
  assert.equal(migrationChecksumMatches(sql.replace(/\n/g, '\r\n'), checksum), true);
});

test('migration checksums recognize legacy Windows hashes', () => {
  const legacyWindowsChecksum = hash(sql.replace(/\n/g, '\r\n'));

  assert.equal(migrationChecksumMatches(sql, legacyWindowsChecksum), true);
});

test('migration checksums still reject changed SQL', () => {
  assert.equal(migrationChecksumMatches(sql, hash(`${sql}-- changed\n`)), false);
});
