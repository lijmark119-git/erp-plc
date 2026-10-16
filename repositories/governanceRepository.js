import {
  GovernanceValidationError,
  normalizeGovernanceRecord,
  normalizeGovernanceStatus,
} from '../services/governanceService.js';

const collectionQueries = {
  entities: `
    SELECT item.id, item.code, item.name, item.entity_type AS "entityType",
      item.parent_entity_id AS "parentEntityId", parent.name AS "parentName",
      item.currency, item.status, item.created_at AS "createdAt"
    FROM enterprise_entities item
    LEFT JOIN enterprise_entities parent ON parent.id = item.parent_entity_id
      AND parent.organization_id = item.organization_id
    WHERE item.organization_id = $1
    ORDER BY item.name, item.code`,
  'business-units': `
    SELECT item.id, item.code, item.name, item.entity_id AS "entityId",
      entity.name AS "entityName", item.department_code AS "departmentCode",
      item.status, item.created_at AS "createdAt"
    FROM enterprise_business_units item
    LEFT JOIN enterprise_entities entity ON entity.id = item.entity_id
      AND entity.organization_id = item.organization_id
    WHERE item.organization_id = $1
    ORDER BY item.name, item.code`,
  'cost-centers': `
    SELECT item.id, item.code, item.name, item.entity_id AS "entityId",
      entity.name AS "entityName", item.business_unit_id AS "businessUnitId",
      unit.name AS "businessUnitName", item.department_code AS "departmentCode",
      item.status, item.created_at AS "createdAt"
    FROM enterprise_cost_centers item
    LEFT JOIN enterprise_entities entity ON entity.id = item.entity_id
      AND entity.organization_id = item.organization_id
    LEFT JOIN enterprise_business_units unit ON unit.id = item.business_unit_id
      AND unit.organization_id = item.organization_id
    WHERE item.organization_id = $1
    ORDER BY item.name, item.code`,
  'profit-centers': `
    SELECT item.id, item.code, item.name, item.entity_id AS "entityId",
      entity.name AS "entityName", item.business_unit_id AS "businessUnitId",
      unit.name AS "businessUnitName", item.department_code AS "departmentCode",
      item.status, item.created_at AS "createdAt"
    FROM enterprise_profit_centers item
    LEFT JOIN enterprise_entities entity ON entity.id = item.entity_id
      AND entity.organization_id = item.organization_id
    LEFT JOIN enterprise_business_units unit ON unit.id = item.business_unit_id
      AND unit.organization_id = item.organization_id
    WHERE item.organization_id = $1
    ORDER BY item.name, item.code`,
  'fiscal-years': `
    SELECT item.id, item.code, item.name, item.entity_id AS "entityId",
      entity.name AS "entityName", item.start_date AS "startDate",
      item.end_date AS "endDate", item.status,
      item.created_at AS "createdAt"
    FROM enterprise_fiscal_years item
    LEFT JOIN enterprise_entities entity ON entity.id = item.entity_id
      AND entity.organization_id = item.organization_id
    WHERE item.organization_id = $1
    ORDER BY item.start_date DESC, item.code`,
  'approval-rules': `
    SELECT item.id, item.code, item.transaction_type AS "transactionType",
      item.department_code AS "departmentCode", item.requester_role AS "requesterRole",
      item.entity_id AS "entityId", entity.name AS "entityName",
      item.min_amount AS "minAmount", item.max_amount AS "maxAmount",
      item.currency, item.approver_role AS "approverRole",
      item.delegated_from_role AS "delegatedFromRole", item.priority,
      item.active, item.created_at AS "createdAt"
    FROM enterprise_approval_rules item
    LEFT JOIN enterprise_entities entity ON entity.id = item.entity_id
      AND entity.organization_id = item.organization_id
    WHERE item.organization_id = $1
    ORDER BY item.priority, item.transaction_type, item.min_amount`,
  policies: `
    SELECT item.id, item.code, item.title, item.entity_id AS "entityId",
      entity.name AS "entityName", item.owner_department AS "ownerDepartment",
      item.classification, item.effective_date AS "effectiveDate",
      item.review_date AS "reviewDate", item.retention_days AS "retentionDays",
      item.document_reference AS "documentReference", item.status,
      item.created_at AS "createdAt"
    FROM enterprise_policies item
    LEFT JOIN enterprise_entities entity ON entity.id = item.entity_id
      AND entity.organization_id = item.organization_id
    WHERE item.organization_id = $1
    ORDER BY item.review_date NULLS LAST, item.title`,
};

const statusTargets = {
  entities: { table: 'enterprise_entities', field: 'status', statusSet: new Set(['ACTIVE', 'INACTIVE']) },
  'business-units': { table: 'enterprise_business_units', field: 'status', statusSet: new Set(['ACTIVE', 'INACTIVE']) },
  'cost-centers': { table: 'enterprise_cost_centers', field: 'status', statusSet: new Set(['ACTIVE', 'INACTIVE']) },
  'profit-centers': { table: 'enterprise_profit_centers', field: 'status', statusSet: new Set(['ACTIVE', 'INACTIVE']) },
  'fiscal-years': { table: 'enterprise_fiscal_years', field: 'status', statusSet: new Set(['DRAFT', 'OPEN', 'CLOSED']) },
  'approval-rules': { table: 'enterprise_approval_rules', field: 'active', statusSet: new Set() },
  policies: { table: 'enterprise_policies', field: 'status', statusSet: new Set(['DRAFT', 'ACTIVE', 'RETIRED']) },
};

async function ensureEntity(client, organizationId, entityId) {
  if (!entityId) return;
  const result = await client.query(
    'SELECT 1 FROM enterprise_entities WHERE id = $1 AND organization_id = $2',
    [entityId, organizationId],
  );
  if (!result.rowCount) throw new GovernanceValidationError('The selected entity does not exist in this company.');
}

async function ensureBusinessUnit(client, organizationId, businessUnitId, entityId = null) {
  if (!businessUnitId) return;
  const result = await client.query(
    'SELECT entity_id FROM enterprise_business_units WHERE id = $1 AND organization_id = $2',
    [businessUnitId, organizationId],
  );
  if (!result.rowCount) throw new GovernanceValidationError('The selected business unit does not exist in this company.');
  if (result.rows[0].entity_id && result.rows[0].entity_id !== entityId) {
    throw new GovernanceValidationError('The business unit belongs to a different subsidiary or plant.');
  }
}

async function ensureRole(client, organizationId, roleCode) {
  if (!roleCode) return;
  const result = await client.query(
    'SELECT 1 FROM roles WHERE organization_id = $1 AND code = $2 AND is_active = TRUE',
    [organizationId, roleCode],
  );
  if (!result.rowCount) throw new GovernanceValidationError(`Role "${roleCode}" does not exist or is inactive in this company.`);
}

async function recordAudit(client, organizationId, actorId, action, entityType, entityId, details) {
  await client.query(
    `INSERT INTO audit_events
      (organization_id, actor_user_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [organizationId, actorId, action, entityType, entityId, JSON.stringify(details)],
  );
}

export async function getGovernanceWorkspace(client, organizationId) {
  const collectionNames = Object.keys(collectionQueries);
  const results = await Promise.all(collectionNames.map((name) => (
    client.query(collectionQueries[name], [organizationId])
  )));
  const organizationResult = await client.query(
    `SELECT id, code, name, legal_name AS "legalName", currency
     FROM organizations WHERE id = $1 AND is_active = TRUE`,
    [organizationId],
  );
  if (!organizationResult.rowCount) throw new GovernanceValidationError('Company was not found.');

  const auditResult = await client.query(
    `SELECT id, occurred_at AS "occurredAt", actor_user_id AS "actorUserId",
      action, entity_type AS "entityType", entity_id AS "entityId", details
     FROM audit_events
     WHERE organization_id = $1 AND entity_type LIKE 'governance.%'
     ORDER BY occurred_at DESC
     LIMIT 100`,
    [organizationId],
  );
  const recordCount = Object.fromEntries(collectionNames.map((name, index) => [name, results[index].rowCount]));
  const activePolicyCount = results[6].rows.filter((item) => item.status === 'ACTIVE').length;
  const today = new Date().toISOString().slice(0, 10);
  const policiesDueForReview = results[6].rows.filter((item) => (
    item.status === 'ACTIVE' && item.reviewDate && String(item.reviewDate).slice(0, 10) <= today
  )).length;

  return {
    organization: organizationResult.rows[0],
    entities: results[0].rows,
    businessUnits: results[1].rows,
    costCenters: results[2].rows,
    profitCenters: results[3].rows,
    fiscalYears: results[4].rows,
    approvalRules: results[5].rows,
    policies: results[6].rows,
    auditTrail: auditResult.rows,
    dashboard: {
      subsidiaryAndPlantCount: recordCount.entities,
      businessUnitCount: recordCount['business-units'],
      costCenterCount: recordCount['cost-centers'],
      profitCenterCount: recordCount['profit-centers'],
      openFiscalYearCount: results[4].rows.filter((item) => item.status === 'OPEN').length,
      activeApprovalRuleCount: results[5].rows.filter((item) => item.active).length,
      activePolicyCount,
      policiesDueForReview,
      financialConsolidationAvailable: false,
      financialConsolidationReason: 'Current accounting transactions are not tagged to subsidiaries or plants; no consolidated financial totals are presented.',
    },
  };
}

export async function createGovernanceRecord(client, organizationId, actorId, collection, input) {
  if (!collectionQueries[collection]) throw new GovernanceValidationError('Unsupported governance record type.');
  const record = normalizeGovernanceRecord(collection, input);
  await ensureEntity(client, organizationId, record.entityId);
  if (collection === 'entities') {
    await ensureEntity(client, organizationId, record.parentEntityId);
  }
  if (collection === 'cost-centers' || collection === 'profit-centers') {
    await ensureBusinessUnit(client, organizationId, record.businessUnitId, record.entityId);
  }
  if (collection === 'approval-rules') {
    await Promise.all([
      ensureRole(client, organizationId, record.requesterRole),
      ensureRole(client, organizationId, record.approverRole),
      ensureRole(client, organizationId, record.delegatedFromRole),
    ]);
  }
  const insert = {
    entities: {
      sql: `INSERT INTO enterprise_entities
        (organization_id, code, name, entity_type, parent_entity_id, currency)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      values: [organizationId, record.code, record.name, record.entityType, record.parentEntityId, record.currency],
    },
    'business-units': {
      sql: `INSERT INTO enterprise_business_units
        (organization_id, code, name, entity_id, department_code)
        VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      values: [organizationId, record.code, record.name, record.entityId, record.departmentCode],
    },
    'cost-centers': {
      sql: `INSERT INTO enterprise_cost_centers
        (organization_id, code, name, entity_id, business_unit_id, department_code)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      values: [organizationId, record.code, record.name, record.entityId, record.businessUnitId, record.departmentCode],
    },
    'profit-centers': {
      sql: `INSERT INTO enterprise_profit_centers
        (organization_id, code, name, entity_id, business_unit_id, department_code)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      values: [organizationId, record.code, record.name, record.entityId, record.businessUnitId, record.departmentCode],
    },
    'fiscal-years': {
      sql: `INSERT INTO enterprise_fiscal_years
        (organization_id, code, name, entity_id, start_date, end_date, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      values: [organizationId, record.code, record.name, record.entityId, record.startDate, record.endDate, record.status],
    },
    'approval-rules': {
      sql: `INSERT INTO enterprise_approval_rules
        (organization_id, code, transaction_type, department_code, requester_role,
         entity_id, min_amount, max_amount, currency, approver_role,
         delegated_from_role, priority)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id`,
      values: [
        organizationId, record.code, record.transactionType, record.departmentCode,
        record.requesterRole, record.entityId, record.minAmount, record.maxAmount,
        record.currency, record.approverRole, record.delegatedFromRole, record.priority,
      ],
    },
    policies: {
      sql: `INSERT INTO enterprise_policies
        (organization_id, code, title, entity_id, owner_department, classification,
         effective_date, review_date, retention_days, document_reference, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id`,
      values: [
        organizationId, record.code, record.title, record.entityId, record.ownerDepartment,
        record.classification, record.effectiveDate, record.reviewDate,
        record.retentionDays, record.documentReference, record.status,
      ],
    },
  }[collection];

  await client.query('BEGIN');
  try {
    if (collection === 'fiscal-years') {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext(COALESCE($2::text, 'company-root')))`,
        [organizationId, record.entityId],
      );
      const overlaps = await client.query(
        `SELECT 1 FROM enterprise_fiscal_years
         WHERE organization_id = $1
           AND entity_id IS NOT DISTINCT FROM $2::uuid
           AND start_date <= $4::date AND end_date >= $3::date
         LIMIT 1`,
        [organizationId, record.entityId, record.startDate, record.endDate],
      );
      if (overlaps.rowCount) {
        throw new GovernanceValidationError('This fiscal year overlaps an existing fiscal year for the same entity.');
      }
    }
    const result = await client.query(insert.sql, insert.values);
    const id = result.rows[0].id;
    await recordAudit(client, organizationId, actorId, 'governance_record_created', `governance.${collection}`, id, {
      code: record.code,
      name: record.name || record.title,
      status: record.status || (record.active === false ? 'INACTIVE' : 'ACTIVE'),
    });
    await client.query('COMMIT');
    return { id, ...record };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function updateGovernanceStatus(client, organizationId, actorId, collection, id, input) {
  const target = statusTargets[collection];
  if (!target) throw new GovernanceValidationError('Unsupported governance record type.');
  const normalized = normalizeGovernanceStatus(collection, collection === 'approval-rules' ? input.active : input.status);
  const nextValue = normalized[target.field];
  await client.query('BEGIN');
  try {
    const current = await client.query(
      `SELECT ${target.field} AS status FROM ${target.table}
       WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [id, organizationId],
    );
    if (!current.rowCount) throw new GovernanceValidationError('Governance record was not found.');
    const previous = current.rows[0].status;
    if (collection === 'fiscal-years') {
      const allowed = (previous === 'DRAFT' && nextValue === 'OPEN') || (previous === 'OPEN' && nextValue === 'CLOSED');
      if (previous !== nextValue && !allowed) {
        throw new GovernanceValidationError('Fiscal years can only move from Draft to Open, then Open to Closed.');
      }
    }
    if (collection === 'policies') {
      const allowed = (previous === 'DRAFT' && nextValue === 'ACTIVE') || (previous === 'ACTIVE' && nextValue === 'RETIRED');
      if (previous !== nextValue && !allowed) {
        throw new GovernanceValidationError('Policies can only move from Draft to Active, then Active to Retired.');
      }
    }
    await client.query(
      `UPDATE ${target.table} SET ${target.field} = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND organization_id = $3`,
      [nextValue, id, organizationId],
    );
    await recordAudit(client, organizationId, actorId, 'governance_record_status_changed', `governance.${collection}`, id, {
      previousStatus: previous,
      status: nextValue,
    });
    await client.query('COMMIT');
    return { id, status: nextValue };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
