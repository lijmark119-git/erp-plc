import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { app, databasePool } from '../server.js';

async function startTestServer() {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie')?.split(';')[0];
}

test('project APIs enforce permissions, validate data, audit changes, and track tasks', async () => {
  const { server, baseUrl } = await startTestServer();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
  let organizationId;
  let projectId;
  let taskId;
  try {
    const adminCookie = await login(baseUrl, process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);
    const managerCookie = await login(baseUrl, process.env.MANAGER_USERNAME, process.env.MANAGER_PASSWORD);
    const sellerCookie = await login(baseUrl, process.env.SELLER_USERNAME, process.env.SELLER_PASSWORD);
    const headers = (cookie) => ({ cookie, 'content-type': 'application/json' });

    const adminUser = await databasePool.query(
      'SELECT organization_id FROM users WHERE username = $1',
      [String(process.env.ADMIN_USERNAME).toLowerCase()],
    );
    organizationId = adminUser.rows[0]?.organization_id;

    assert.equal((await fetch(`${baseUrl}/api/projects`, { headers: headers(sellerCookie) })).status, 403);
    const adminList = await fetch(`${baseUrl}/api/projects`, { headers: headers(adminCookie) });
    assert.equal(adminList.status, 200);
    assert.ok(Array.isArray(await adminList.json()));

    const invalidDate = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: headers(adminCookie),
      body: JSON.stringify({
        code: `BAD-${suffix}`, name: 'Invalid project', startDate: '2099-02-30', dueDate: '2099-12-31',
      }),
    });
    assert.equal(invalidDate.status, 400);

    const projectResponse = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: headers(adminCookie),
      body: JSON.stringify({
        code: `PRJ-${suffix}`,
        name: 'Project API test',
        startDate: '2099-01-01',
        dueDate: '2099-12-31',
        description: 'Temporary project test data',
      }),
    });
    assert.equal(projectResponse.status, 201);
    const project = await projectResponse.json();
    projectId = project.id;
    assert.equal(project.status, 'PLANNED');

    const duplicateResponse = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: headers(adminCookie),
      body: JSON.stringify({ code: `PRJ-${suffix}`, name: 'Duplicate project' }),
    });
    assert.equal(duplicateResponse.status, 409);

    const taskResponse = await fetch(`${baseUrl}/api/projects/${projectId}/tasks`, {
      method: 'POST',
      headers: headers(managerCookie),
      body: JSON.stringify({ title: 'Review project deliverables', dueDate: '2099-06-01' }),
    });
    assert.equal(taskResponse.status, 201);
    const task = await taskResponse.json();
    taskId = task.id;

    const taskStatusResponse = await fetch(`${baseUrl}/api/projects/${projectId}/tasks/${taskId}/status`, {
      method: 'PATCH',
      headers: headers(managerCookie),
      body: JSON.stringify({ status: 'COMPLETED' }),
    });
    assert.equal(taskStatusResponse.status, 200);

    const projectStatusResponse = await fetch(`${baseUrl}/api/projects/${projectId}/status`, {
      method: 'PATCH',
      headers: headers(managerCookie),
      body: JSON.stringify({ status: 'ACTIVE' }),
    });
    assert.equal(projectStatusResponse.status, 200);

    const managerProjects = await (await fetch(`${baseUrl}/api/projects`, { headers: headers(managerCookie) })).json();
    const loadedProject = managerProjects.find((item) => item.id === projectId);
    assert.equal(loadedProject.status, 'ACTIVE');
    assert.equal(loadedProject.tasks[0].status, 'COMPLETED');

    const deniedWrite = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: headers(sellerCookie),
      body: JSON.stringify({ code: `DENY-${suffix}`, name: 'Denied project' }),
    });
    assert.equal(deniedWrite.status, 403);
  } finally {
    if (organizationId) {
      const client = await databasePool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `DELETE FROM audit_events
           WHERE organization_id = $1 AND entity_type IN ('project', 'project_task')
             AND entity_id IN (
               SELECT id::text FROM projects WHERE organization_id = $1 AND code = $2
               UNION
               SELECT task.id::text FROM project_tasks task
               JOIN projects project ON project.id = task.project_id
               WHERE task.organization_id = $1 AND project.code = $2
             )`,
          [organizationId, `PRJ-${suffix}`],
        );
        await client.query(
          'DELETE FROM projects WHERE organization_id = $1 AND code = $2',
          [organizationId, `PRJ-${suffix}`],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

after(async () => {
  if (databasePool) await databasePool.end();
});
