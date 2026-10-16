import assert from 'node:assert/strict';
import test from 'node:test';

import { app } from '../server.js';

test('inventory trace lookup and QR labels require inventory read access', async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const anonymousQr = await fetch(`${baseUrl}/api/inventory-management/trace/qr?code=LOT-API-TEST`);
    assert.equal(anonymousQr.status, 401);

    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: process.env.ADMIN_USERNAME || 'admin',
        password: process.env.ADMIN_PASSWORD || 'admin123',
      }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);

    const qr = await fetch(`${baseUrl}/api/inventory-management/trace/qr?code=LOT-API-TEST`, {
      headers: { cookie },
    });
    assert.equal(qr.status, 200);
    assert.match(qr.headers.get('content-type'), /image\/png/);
    const png = Buffer.from(await qr.arrayBuffer());
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

    const lookup = await fetch(`${baseUrl}/api/inventory-management/trace/lookup?code=NO-SUCH-INVENTORY-CODE`, {
      headers: { cookie },
    });
    assert.equal(lookup.status, 404);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
