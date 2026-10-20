const projectStatuses = new Set(['PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED']);
const taskStatuses = new Set(['OPEN', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED']);

export class ProjectValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProjectValidationError';
  }
}

function requiredText(value, field, maxLength) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProjectValidationError(`${field} is required.`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new ProjectValidationError(`${field} must be ${maxLength} characters or fewer.`);
  }
  return normalized;
}

function optionalText(value, field, maxLength) {
  if (value === undefined || value === null || value === '') return null;
  return requiredText(value, field, maxLength);
}

function optionalDate(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = requiredText(value, field, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (!match) throw new ProjectValidationError(`${field} must use YYYY-MM-DD format.`);
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new ProjectValidationError(`${field} must be a valid calendar date.`);
  }
  return normalized;
}

function statusValue(value, allowed, field, defaultValue) {
  const normalized = String(value || defaultValue).toUpperCase();
  if (!allowed.has(normalized)) {
    throw new ProjectValidationError(`${field} must be one of: ${[...allowed].join(', ')}.`);
  }
  return normalized;
}

async function writeAudit(client, organizationId, actorId, action, entityType, entityId, details) {
  await client.query(
    `INSERT INTO audit_events
       (organization_id, actor_user_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [organizationId, actorId, action, entityType, entityId, JSON.stringify(details)],
  );
}

export async function listProjects(client, organizationId) {
  const result = await client.query(
    `SELECT project.id, project.code, project.name, project.description,
            project.start_date AS "startDate", project.due_date AS "dueDate",
            project.status, project.created_at AS "createdAt",
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'id', task.id,
                  'title', task.title,
                  'description', task.description,
                  'dueDate', task.due_date,
                  'status', task.status,
                  'createdAt', task.created_at
                ) ORDER BY task.created_at, task.id
              ) FILTER (WHERE task.id IS NOT NULL),
              '[]'::jsonb
            ) AS tasks
     FROM projects project
     LEFT JOIN project_tasks task
       ON task.project_id = project.id AND task.organization_id = project.organization_id
     WHERE project.organization_id = $1
     GROUP BY project.id
     ORDER BY project.created_at DESC, project.id`,
    [organizationId],
  );
  return result.rows;
}

export async function createProject(client, organizationId, actorId, input = {}) {
  const code = requiredText(input.code, 'Project code', 40).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]*$/.test(code)) {
    throw new ProjectValidationError('Project code may contain letters, numbers, periods, underscores, and hyphens.');
  }
  const name = requiredText(input.name, 'Project name', 160);
  const description = optionalText(input.description, 'Description', 1000);
  const startDate = optionalDate(input.startDate, 'Start date');
  const dueDate = optionalDate(input.dueDate, 'Due date');
  if (startDate && dueDate && dueDate < startDate) {
    throw new ProjectValidationError('Due date must not be before the start date.');
  }
  const status = statusValue(input.status, projectStatuses, 'Project status', 'PLANNED');
  const result = await client.query(
    `INSERT INTO projects
       (organization_id, code, name, description, start_date, due_date, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, code, name, description, start_date AS "startDate",
               due_date AS "dueDate", status, created_at AS "createdAt"`,
    [organizationId, code, name, description, startDate, dueDate, status, actorId],
  );
  const project = result.rows[0];
  project.tasks = [];
  await writeAudit(client, organizationId, actorId, 'project.created', 'project', project.id, { code, name });
  return project;
}

export async function createProjectTask(client, organizationId, actorId, projectId, input = {}) {
  const title = requiredText(input.title, 'Task title', 160);
  const description = optionalText(input.description, 'Description', 1000);
  const dueDate = optionalDate(input.dueDate, 'Due date');
  const status = statusValue(input.status, taskStatuses, 'Task status', 'OPEN');
  const result = await client.query(
    `INSERT INTO project_tasks
       (organization_id, project_id, title, description, due_date, status, created_by)
     SELECT $1, project.id, $3, $4, $5, $6, $7
     FROM projects project
     WHERE project.id = $2 AND project.organization_id = $1
     RETURNING id, project_id AS "projectId", title, description,
               due_date AS "dueDate", status, created_at AS "createdAt"`,
    [organizationId, projectId, title, description, dueDate, status, actorId],
  );
  if (!result.rowCount) return null;
  const task = result.rows[0];
  await writeAudit(client, organizationId, actorId, 'project.task.created', 'project_task', task.id, {
    projectId,
    title,
  });
  return task;
}

export async function updateProjectStatus(client, organizationId, actorId, projectId, input = {}) {
  const status = statusValue(input.status, projectStatuses, 'Project status');
  const result = await client.query(
    `UPDATE projects SET status = $3, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND organization_id = $2
     RETURNING id, status`,
    [projectId, organizationId, status],
  );
  if (!result.rowCount) return null;
  await writeAudit(client, organizationId, actorId, 'project.status.updated', 'project', projectId, { status });
  return result.rows[0];
}

export async function updateProjectTaskStatus(client, organizationId, actorId, projectId, taskId, input = {}) {
  const status = statusValue(input.status, taskStatuses, 'Task status');
  const result = await client.query(
    `UPDATE project_tasks task
     SET status = $4, updated_at = CURRENT_TIMESTAMP
     FROM projects project
     WHERE task.id = $1 AND task.project_id = $2
       AND task.organization_id = $3
       AND project.id = task.project_id AND project.organization_id = $3
     RETURNING task.id, task.status`,
    [taskId, projectId, organizationId, status],
  );
  if (!result.rowCount) return null;
  await writeAudit(client, organizationId, actorId, 'project.task.status.updated', 'project_task', taskId, {
    projectId,
    status,
  });
  return result.rows[0];
}
