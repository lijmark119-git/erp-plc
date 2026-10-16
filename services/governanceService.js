const entityTypes = new Set(['SUBSIDIARY', 'PLANT']);
const fiscalYearStatuses = new Set(['DRAFT', 'OPEN', 'CLOSED']);
const policyStatuses = new Set(['DRAFT', 'ACTIVE', 'RETIRED']);
const policyClassifications = new Set(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']);

export class GovernanceValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GovernanceValidationError';
  }
}

function requiredText(value, field, maxLength = 160) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new GovernanceValidationError(`${field} is required.`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new GovernanceValidationError(`${field} must be ${maxLength} characters or fewer.`);
  }
  return normalized;
}

function optionalText(value, field, maxLength = 160) {
  if (value === undefined || value === null || value === '') return null;
  return requiredText(value, field, maxLength);
}

function code(value, field = 'Code') {
  const normalized = requiredText(value, field, 40);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized)) {
    throw new GovernanceValidationError(`${field} may contain letters, numbers, periods, underscores, and hyphens.`);
  }
  return normalized.toUpperCase();
}

function currency(value) {
  const normalized = requiredText(value, 'Currency', 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new GovernanceValidationError('Currency must be a three-letter ISO code.');
  }
  return normalized;
}

function date(value, field) {
  const normalized = requiredText(value, field, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (!match) throw new GovernanceValidationError(`${field} must use YYYY-MM-DD format.`);
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new GovernanceValidationError(`${field} must be a valid calendar date.`);
  }
  return normalized;
}

function optionalEntityId(value) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = requiredText(value, 'Entity ID', 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new GovernanceValidationError('Entity ID must be a valid identifier.');
  }
  return normalized;
}

function optionalId(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = requiredText(value, field, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new GovernanceValidationError(`${field} must be a valid identifier.`);
  }
  return normalized;
}

function optionalRole(value, field) {
  if (value === undefined || value === null || value === '') return null;
  return code(value, field);
}

function positiveInteger(value, field, minimum = 1) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new GovernanceValidationError(`${field} must be an integer of at least ${minimum}.`);
  }
  return parsed;
}

function nonNegativeAmount(value, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 9999999999999999) {
    throw new GovernanceValidationError(`${field} must be a non-negative amount.`);
  }
  return Math.round(parsed * 100) / 100;
}

function enumValue(value, allowed, field) {
  const normalized = requiredText(value, field, 32).toUpperCase();
  if (!allowed.has(normalized)) {
    throw new GovernanceValidationError(`${field} must be one of: ${[...allowed].join(', ')}.`);
  }
  return normalized;
}

function boolValue(value, field, defaultValue = true) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (value === true || value === 'true' || value === 'on' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  throw new GovernanceValidationError(`${field} must be true or false.`);
}

export function normalizeGovernanceRecord(collection, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new GovernanceValidationError('A record object is required.');
  }

  switch (collection) {
    case 'entities':
      return {
        code: code(input.code),
        name: requiredText(input.name, 'Name'),
        entityType: enumValue(input.entityType, entityTypes, 'Entity type'),
        parentEntityId: optionalEntityId(input.parentEntityId),
        currency: input.currency ? currency(input.currency) : null,
      };
    case 'business-units':
      return {
        code: code(input.code),
        name: requiredText(input.name, 'Name'),
        entityId: optionalEntityId(input.entityId),
        departmentCode: optionalText(input.departmentCode, 'Department code', 40),
      };
    case 'cost-centers':
    case 'profit-centers':
      return {
        code: code(input.code),
        name: requiredText(input.name, 'Name'),
        entityId: optionalEntityId(input.entityId),
        businessUnitId: optionalId(input.businessUnitId, 'Business unit ID'),
        departmentCode: optionalText(input.departmentCode, 'Department code', 40),
      };
    case 'fiscal-years': {
      const startDate = date(input.startDate, 'Start date');
      const endDate = date(input.endDate, 'End date');
      if (endDate < startDate) {
        throw new GovernanceValidationError('End date must not be before the start date.');
      }
      return {
        code: code(input.code),
        name: requiredText(input.name, 'Name'),
        entityId: optionalEntityId(input.entityId),
        startDate,
        endDate,
        status: enumValue(input.status || 'DRAFT', fiscalYearStatuses, 'Status'),
      };
    }
    case 'approval-rules': {
      const minAmount = nonNegativeAmount(input.minAmount ?? 0, 'Minimum amount');
      const maxAmount = input.maxAmount === undefined || input.maxAmount === null || input.maxAmount === ''
        ? null
        : nonNegativeAmount(input.maxAmount, 'Maximum amount');
      if (maxAmount !== null && maxAmount <= minAmount) {
        throw new GovernanceValidationError('Maximum amount must be greater than minimum amount.');
      }
      return {
        code: code(input.code),
        transactionType: requiredText(input.transactionType, 'Transaction type', 80),
        departmentCode: optionalText(input.departmentCode, 'Department code', 40),
        requesterRole: optionalRole(input.requesterRole, 'Requester role'),
        entityId: optionalEntityId(input.entityId),
        minAmount,
        maxAmount,
        currency: currency(input.currency),
        approverRole: code(input.approverRole, 'Approver role'),
        delegatedFromRole: optionalRole(input.delegatedFromRole, 'Delegated-from role'),
        priority: input.priority === undefined || input.priority === '' ? 100 : positiveInteger(input.priority, 'Priority', 0),
      };
    }
    case 'policies': {
      const effectiveDate = date(input.effectiveDate, 'Effective date');
      const reviewDate = input.reviewDate ? date(input.reviewDate, 'Review date') : null;
      if (reviewDate && reviewDate < effectiveDate) {
        throw new GovernanceValidationError('Review date must not be before the effective date.');
      }
      return {
        code: code(input.code, 'Policy code'),
        title: requiredText(input.title, 'Title'),
        entityId: optionalEntityId(input.entityId),
        ownerDepartment: requiredText(input.ownerDepartment, 'Owner department', 80),
        classification: enumValue(input.classification || 'INTERNAL', policyClassifications, 'Classification'),
        effectiveDate,
        reviewDate,
        retentionDays: positiveInteger(input.retentionDays, 'Retention days', 0),
        documentReference: optionalText(input.documentReference, 'Document reference', 500),
        status: enumValue(input.status || 'DRAFT', policyStatuses, 'Status'),
      };
    }
    default:
      throw new GovernanceValidationError('Unsupported governance record type.');
  }
}

export function normalizeGovernanceStatus(collection, value) {
  if (collection === 'approval-rules') {
    return { active: boolValue(value, 'Active') };
  }
  if (collection === 'entities' || collection === 'business-units' ||
    collection === 'cost-centers' || collection === 'profit-centers') {
    return { status: enumValue(value, new Set(['ACTIVE', 'INACTIVE']), 'Status') };
  }
  if (collection === 'fiscal-years') {
    return { status: enumValue(value, fiscalYearStatuses, 'Status') };
  }
  if (collection === 'policies') {
    return { status: enumValue(value, policyStatuses, 'Status') };
  }
  throw new GovernanceValidationError('Unsupported governance record type.');
}
