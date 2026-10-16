import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSessionToken,
  hashPassword,
  verifyPassword,
  verifySessionToken,
} from '../auth.js';

const secret = 'test-session-secret';

test('passwords are hashed and verified without storing plaintext', async () => {
  const password = 'correct-horse-battery-staple';
  const stored = await hashPassword(password);

  assert.notEqual(stored, password);
  assert.equal(await verifyPassword(password, stored), true);
  assert.equal(await verifyPassword('different-password', stored), false);
});

test('session tokens contain a valid expiry and cannot be forged', () => {
  const token = createSessionToken({ userId: 'admin', role: 'Admin' }, secret, 60);
  const session = verifySessionToken(token, secret, 60);

  assert.equal(session.userId, 'admin');
  assert.equal(session.role, 'Admin');
  assert.ok(session.expiresAt > Date.now() / 1000);
  assert.equal(verifySessionToken('not-a-valid-token', secret, 60), null);
  assert.equal(verifySessionToken(token, 'wrong-secret', 60), null);
});

test('expired session tokens are rejected', () => {
  const token = createSessionToken({ userId: 'admin', role: 'Admin' }, secret, -1);
  assert.equal(verifySessionToken(token, secret, 60), null);
});
