import assert from 'node:assert/strict';
import test from 'node:test';
import { renderGovernancePage } from '../src/governance.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  "'": '&#39;',
  '"': '&quot;',
})[character]);
const formatCurrency = (amount) => `ETB ${amount}`;
const workspace = {
  organization: { code: 'PLC', name: 'PLC Manufacturing', currency: 'ETB' },
  entities: [{ id: 'entity-1', code: 'SUB-1', name: 'Subsidiary', entityType: 'SUBSIDIARY', status: 'ACTIVE' }],
  businessUnits: [],
  costCenters: [],
  profitCenters: [],
  fiscalYears: [],
  approvalRules: [],
  policies: [],
  auditTrail: [],
  dashboard: {
    subsidiaryAndPlantCount: 1,
    businessUnitCount: 0,
    costCenterCount: 0,
    profitCenterCount: 0,
    openFiscalYearCount: 0,
    activeApprovalRuleCount: 0,
    activePolicyCount: 0,
    policiesDueForReview: 0,
    financialConsolidationAvailable: false,
    financialConsolidationReason: 'Transactions are not tagged to entities.',
  },
};

test('governance overview clearly distinguishes governance metrics from financial consolidation', () => {
  const html = renderGovernancePage({ tab: 'overview', data: workspace }, false, escapeHtml, formatCurrency);
  assert.match(html, /PLC Manufacturing/);
  assert.match(html, /Financial consolidation is not enabled yet/);
  assert.match(html, /Transactions are not tagged to entities\./);
});

test('read-only roles can inspect governance records but do not get lifecycle controls', () => {
  const html = renderGovernancePage({ tab: 'entities', data: workspace }, false, escapeHtml, formatCurrency);
  assert.match(html, /Subsidiaries and plants/);
  assert.match(html, /SUB-1/);
  assert.doesNotMatch(html, /data-governance-status/);
  assert.doesNotMatch(html, /data-governance-form/);
});

test('governance record labels are escaped before rendering', () => {
  const unsafeWorkspace = {
    ...workspace,
    organization: { ...workspace.organization, name: '<script>alert(1)</script>' },
  };
  const html = renderGovernancePage({ tab: 'overview', data: unsafeWorkspace }, false, escapeHtml, formatCurrency);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});
