import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_ROLE_PERMISSIONS, hasPermission } from '../authorization.js';

test('role permissions allow authorized operations', () => {
  assert.equal(hasPermission({ role: 'ADMIN' }, 'finance:transactions:create'), true);
  assert.equal(hasPermission({ role: 'MANAGER' }, 'inventory:stock:update'), true);
  assert.equal(hasPermission({ role: 'SELLER' }, 'sales:orders:create'), true);
});

test('role permissions deny unauthorized operations', () => {
  assert.equal(hasPermission({ role: 'SELLER' }, 'finance:transactions:create'), false);
  assert.equal(hasPermission({ role: 'MANAGER' }, 'settings:toggle'), false);
  assert.equal(hasPermission({ role: 'Unknown' }, 'sales:orders:create'), false);
  assert.equal(hasPermission({ role: 'Admin' }, 'finance:transactions:delete'), false);
  assert.equal(hasPermission({ role: 'SELLER' }, 'accounting:journals:post'), false);
});

test('default permissions are least-privilege role definitions', () => {
  assert.deepEqual(DEFAULT_ROLE_PERMISSIONS.ADMIN, new Set(DEFAULT_ROLE_PERMISSIONS.ADMIN));
  assert.equal(DEFAULT_ROLE_PERMISSIONS.MANAGER.has('settings:toggle'), false);
  assert.equal(DEFAULT_ROLE_PERMISSIONS.MANAGER.has('hr:employees:create'), false);
  assert.equal(DEFAULT_ROLE_PERMISSIONS.SELLER.has('inventory:stock:update'), false);
  assert.equal(DEFAULT_ROLE_PERMISSIONS.SELLER.has('sales:orders:approve'), false);
  assert.equal(DEFAULT_ROLE_PERMISSIONS.ADMIN.has('accounting:accounts:manage'), true);
  assert.equal(DEFAULT_ROLE_PERMISSIONS.MANAGER.has('accounting:journals:approve'), true);
  assert.equal(DEFAULT_ROLE_PERMISSIONS.MANAGER.has('accounting:accounts:manage'), false);
});

test('HR organization and attendance permissions are role-scoped', () => {
  assert.equal(hasPermission({ role: 'ADMIN' }, 'hr:organizations:manage'), true);
  assert.equal(hasPermission({ role: 'ADMIN' }, 'hr:attendance:manage'), true);
  assert.equal(hasPermission({ role: 'MANAGER' }, 'hr:attendance:manage'), true);
  assert.equal(hasPermission({ role: 'SELLER' }, 'hr:attendance:review'), false);
});

test('manufacturing access separates master data, execution, and reporting', () => {
  assert.equal(hasPermission({ role: 'ADMIN' }, 'manufacturing:bom:manage'), true);
  assert.equal(hasPermission({ role: 'MANAGER' }, 'manufacturing:materials:consume'), true);
  assert.equal(hasPermission({ role: 'ADMIN' }, 'manufacturing:quality:manage'), true);
  assert.equal(hasPermission({ role: 'MANAGER' }, 'manufacturing:quality:manage'), true);
  assert.equal(hasPermission({ role: 'MANAGER' }, 'manufacturing:reports:read'), true);
  assert.equal(hasPermission({ role: 'MANAGER' }, 'manufacturing:bom:manage'), false);
  assert.equal(hasPermission({ role: 'SELLER' }, 'manufacturing:quality:manage'), false);
  assert.equal(hasPermission({ role: 'SELLER' }, 'manufacturing:read'), false);
});

test('module-specific users cannot access permissions from other modules', () => {
  assert.equal(hasPermission({ role: 'SALES_USER' }, 'sales:orders:read'), true);
  assert.equal(hasPermission({ role: 'SALES_USER' }, 'inventory:reports:view'), false);
  assert.equal(hasPermission({ role: 'SALES_USER' }, 'manufacturing:read'), false);
  assert.equal(hasPermission({ role: 'INVENTORY_USER' }, 'inventory:reports:view'), true);
  assert.equal(hasPermission({ role: 'INVENTORY_USER' }, 'sales:orders:read'), false);
  assert.equal(hasPermission({ role: 'PROCUREMENT_USER' }, 'procurement:orders:read'), true);
  assert.equal(hasPermission({ role: 'PROCUREMENT_USER' }, 'finance:transactions:create'), false);
  assert.equal(hasPermission({ role: 'HR_USER' }, 'hr:employees:read'), true);
  assert.equal(hasPermission({ role: 'HR_USER' }, 'hr:payroll:read'), false);
  assert.equal(hasPermission({ role: 'FINANCE_USER' }, 'accounting:reports:view'), true);
  assert.equal(hasPermission({ role: 'FINANCE_USER' }, 'manufacturing:read'), false);
  assert.equal(hasPermission({ role: 'BANKING_USER' }, 'finance:transactions:create'), true);
  assert.equal(hasPermission({ role: 'BANKING_USER' }, 'sales:orders:read'), false);
  assert.equal(hasPermission({ role: 'MANUFACTURING_USER' }, 'manufacturing:read'), true);
  assert.equal(hasPermission({ role: 'MANUFACTURING_USER' }, 'inventory:reports:view'), false);
});
