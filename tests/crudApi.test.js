import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { app } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = path.join(__dirname, '..', 'erp-data.json');

function request(server, method, url, options = {}, cookie = '') {
  return fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(options.headers || {}),
    },
    body: options.body,
    credentials: 'include',
  }).then(async (response) => {
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
      headers: response.headers,
    };
  });
}

test('ADMIN can create, edit, and delete a sales order', async (t) => {
  const originalData = fs.readFileSync(dataPath, 'utf8');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    fs.writeFileSync(dataPath, originalData);
    await new Promise((resolve) => server.close(resolve));
  });

  const login = await request(server, 'POST', '/api/login', {
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];

  const create = await request(server, 'POST', '/api/sales', {
    body: JSON.stringify({ customer: 'CRUD Test Customer', date: '2026-10-01', amount: 125.5, status: 'Pending' }),
  }, cookie);
  assert.equal(create.status, 201);
  assert.equal(create.body.customer, 'CRUD Test Customer');

  const id = create.body.id;
  const invalidDateUpdate = await request(server, 'PUT', `/api/sales/${id}`, {
    body: JSON.stringify({ date: '2026-02-30' }),
  }, cookie);
  assert.equal(invalidDateUpdate.status, 400);
  const update = await request(server, 'PUT', `/api/sales/${id}`, {
    body: JSON.stringify({ customer: 'CRUD Test Customer Updated', date: '2026-10-02', amount: 135.75, status: 'Processing' }),
  }, cookie);
  assert.equal(update.status, 200);
  assert.equal(update.body.customer, 'CRUD Test Customer Updated');
  assert.equal(update.body.amount, 135.75);

  const remove = await request(server, 'DELETE', `/api/sales/${id}`, {}, cookie);
  assert.equal(remove.status, 200);
  assert.equal(remove.body.id, id);
});

test('MANAGER cannot update records', async (t) => {
  const originalData = fs.readFileSync(dataPath, 'utf8');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    fs.writeFileSync(dataPath, originalData);
    await new Promise((resolve) => server.close(resolve));
  });

  const login = await request(server, 'POST', '/api/login', {
    body: JSON.stringify({ username: 'manager', password: 'manager123' }),
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const first = await request(server, 'GET', '/api/sales', {}, cookie);
  assert.equal(first.status, 200);
  const update = await request(server, 'PUT', `/api/sales/${first.body[0].id}`, {
    body: JSON.stringify({ customer: 'Unauthorized' }),
  }, cookie);
  assert.equal(update.status, 403);
});
