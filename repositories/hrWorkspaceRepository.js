const HR_WORKSPACE_KEYS = [
  'departments',
  'positions',
  'branches',
  'organizationHierarchy',
  'employees',
  'attendanceRecords',
  'leaveTypes',
  'leaveBalances',
  'leaveRequests',
  'payrollSettings',
  'payrollPeriods',
  'payrollResults',
  'payrollAccountingEntries',
  'auditTrail',
];

function pickHrWorkspace(data) {
  return Object.fromEntries(HR_WORKSPACE_KEYS.map((key) => [key, data[key]]));
}

function mergeHrWorkspace(defaultData, storedData) {
  return {
    ...defaultData,
    ...storedData,
    departments: storedData.departments || defaultData.departments,
    positions: storedData.positions || defaultData.positions,
    branches: storedData.branches || defaultData.branches,
    organizationHierarchy: storedData.organizationHierarchy || defaultData.organizationHierarchy,
    employees: storedData.employees || defaultData.employees,
    attendanceRecords: storedData.attendanceRecords || defaultData.attendanceRecords,
    leaveTypes: storedData.leaveTypes || defaultData.leaveTypes,
    leaveBalances: storedData.leaveBalances || defaultData.leaveBalances,
    leaveRequests: storedData.leaveRequests || defaultData.leaveRequests,
    payrollSettings: storedData.payrollSettings || defaultData.payrollSettings,
    payrollPeriods: storedData.payrollPeriods || defaultData.payrollPeriods,
    payrollResults: storedData.payrollResults || defaultData.payrollResults,
    payrollAccountingEntries: storedData.payrollAccountingEntries || [],
    auditTrail: storedData.auditTrail || [],
  };
}

async function ensureWorkspace(client, organizationId, defaultData) {
  const data = pickHrWorkspace(defaultData);
  await client.query(
    `INSERT INTO hr_workspaces (organization_id, data)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (organization_id) DO NOTHING`,
    [organizationId, JSON.stringify(data)],
  );
}

export async function getHrWorkspace(client, organizationId, defaultData) {
  await ensureWorkspace(client, organizationId, defaultData);
  const result = await client.query(
    'SELECT data FROM hr_workspaces WHERE organization_id = $1',
    [organizationId],
  );
  return mergeHrWorkspace(defaultData, result.rows[0].data || {});
}

export async function updateHrWorkspace(client, organizationId, actorId, defaultData, update) {
  await client.query('BEGIN');
  try {
    await ensureWorkspace(client, organizationId, defaultData);
    const result = await client.query(
      'SELECT data FROM hr_workspaces WHERE organization_id = $1 FOR UPDATE',
      [organizationId],
    );
    const workspace = mergeHrWorkspace(defaultData, result.rows[0].data || {});
    const response = await update(workspace, client);
    if (!response || response.persist !== false) {
      await client.query(
        `UPDATE hr_workspaces
         SET data = $2::jsonb, updated_by = $3, updated_at = CURRENT_TIMESTAMP
         WHERE organization_id = $1`,
        [organizationId, JSON.stringify(pickHrWorkspace(workspace)), actorId || null],
      );
    }
    await client.query('COMMIT');
    return response;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
