import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GovernanceValidationError,
  normalizeGovernanceRecord,
  normalizeGovernanceStatus,
} from '../services/governanceService.js';

test('normalizes subsidiary and fiscal year identifiers without mutating input', () => {
  const input = { code: 'sub-east', name: 'Eastern Subsidiary', entityType: 'subsidiary', currency: 'etb' };
  const record = normalizeGovernanceRecord('entities', input);

  assert.deepEqual(record, {
    code: 'SUB-EAST',
    name: 'Eastern Subsidiary',
    entityType: 'SUBSIDIARY',
    parentEntityId: null,
    currency: 'ETB',
  });
  assert.equal(input.code, 'sub-east');
  assert.deepEqual(normalizeGovernanceRecord('fiscal-years', {
    code: 'fy-2027',
    name: 'FY 2027',
    startDate: '2026-07-01',
    endDate: '2027-06-30',
  }), {
    code: 'FY-2027',
    name: 'FY 2027',
    entityId: null,
    startDate: '2026-07-01',
    endDate: '2027-06-30',
    status: 'DRAFT',
  });
});

test('validates approval ranges and delegated approver dimensions', () => {
  assert.deepEqual(normalizeGovernanceRecord('approval-rules', {
    code: 'PO-APPROVAL-1',
    transactionType: 'Purchase order',
    departmentCode: 'FIN',
    requesterRole: 'PROCUREMENT_USER',
    minAmount: '5000',
    maxAmount: '25000',
    currency: 'ETB',
    approverRole: 'MANAGER',
    delegatedFromRole: 'ADMIN',
    priority: '10',
  }), {
    code: 'PO-APPROVAL-1',
    transactionType: 'Purchase order',
    departmentCode: 'FIN',
    requesterRole: 'PROCUREMENT_USER',
    entityId: null,
    minAmount: 5000,
    maxAmount: 25000,
    currency: 'ETB',
    approverRole: 'MANAGER',
    delegatedFromRole: 'ADMIN',
    priority: 10,
  });

  assert.throws(() => normalizeGovernanceRecord('approval-rules', {
    code: 'BAD-RANGE',
    transactionType: 'Purchase order',
    minAmount: 25,
    maxAmount: 25,
    currency: 'ETB',
    approverRole: 'MANAGER',
  }), GovernanceValidationError);
});

test('rejects invalid date ranges, invalid dates, and unsupported collections', () => {
  assert.throws(() => normalizeGovernanceRecord('fiscal-years', {
    code: 'FY-2027',
    name: 'FY 2027',
    startDate: '2027-02-30',
    endDate: '2027-06-30',
  }), /valid calendar date/);
  assert.throws(() => normalizeGovernanceRecord('fiscal-years', {
    code: 'FY-2027',
    name: 'FY 2027',
    startDate: '2027-07-01',
    endDate: '2027-06-30',
  }), /must not be before/);
  assert.throws(() => normalizeGovernanceRecord('users', {}), /Unsupported/);
});

test('validates policy lifecycle and approval activation status', () => {
  assert.deepEqual(normalizeGovernanceRecord('policies', {
    code: 'HR-RETENTION',
    title: 'Employee record retention',
    ownerDepartment: 'Human Resources',
    effectiveDate: '2026-01-01',
    reviewDate: '2027-01-01',
    retentionDays: '3650',
    documentReference: 'POLICY-001',
  }), {
    code: 'HR-RETENTION',
    title: 'Employee record retention',
    entityId: null,
    ownerDepartment: 'Human Resources',
    classification: 'INTERNAL',
    effectiveDate: '2026-01-01',
    reviewDate: '2027-01-01',
    retentionDays: 3650,
    documentReference: 'POLICY-001',
    status: 'DRAFT',
  });
  assert.deepEqual(normalizeGovernanceStatus('approval-rules', false), { active: false });
  assert.deepEqual(normalizeGovernanceStatus('entities', 'inactive'), { status: 'INACTIVE' });
});
