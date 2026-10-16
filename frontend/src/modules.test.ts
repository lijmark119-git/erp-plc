import { describe, expect, it } from 'vitest';
import type { CurrentUser } from './api';
import { visibleModulePages, visibleModules } from './modules';

const user: CurrentUser = {
  id: 'user-1',
  username: 'test.user',
  full_name: 'Test User',
  permissions: {
    'org-one': ['users:read', 'audit:read', 'finance:read', 'hr:read', 'hr:payroll_read', 'hr:reports', 'procurement:read', 'sales:read'],
    'org-two': ['inventory:read'],
  },
  scopes: [
    { organization_id: 'org-one', branch_id: null, warehouse_id: null, factory_id: null },
    { organization_id: 'org-two', branch_id: null, warehouse_id: null, factory_id: null },
  ],
};

describe('permission-dependent modules', () => {
  it('shows modules granted within the selected organization only', () => {
    expect(visibleModules(user, 'org-one').map((module) => module.slug)).toEqual([
      'administration',
      'finance',
      'hr',
      'procurement',
      'sales',
    ]);
    expect(visibleModules(user, 'org-two').map((module) => module.slug)).toEqual(['inventory']);
  });

  it('shows only administration pages with their specific permission', () => {
    const administration = visibleModules(user, 'org-one').find((module) => module.slug === 'administration');
    expect(administration).toBeDefined();
    expect(visibleModulePages(administration!, user, 'org-one').map((page) => page.slug)).toEqual([
      'users',
      'audit',
    ]);
  });

  it('does not expose modules when no matching permissions exist', () => {
    expect(visibleModules({ ...user, permissions: {} }, 'org-one')).toEqual([]);
  });

  it('exposes a module Overview only after the module itself is authorized', () => {
    const finance = visibleModules(user, 'org-one').find((module) => module.slug === 'finance');
    expect(finance).toBeDefined();
    expect(visibleModulePages(finance!, user, 'org-one').map((page) => page.slug)).toEqual([
      'overview',
      'accounts',
      'journals',
      'ledger',
    ]);

    const unauthorized = { ...user, permissions: { 'org-one': ['users:read'] } };
    expect(visibleModules(unauthorized, 'org-one').some((module) => module.slug === 'finance')).toBe(false);
  });

  it('keeps administration subpages behind their exact permissions', () => {
    const administration = visibleModules(user, 'org-one').find((module) => module.slug === 'administration');
    expect(visibleModulePages(administration!, user, 'org-one').map((page) => page.slug)).toEqual(['users', 'audit']);
  });

  it('shows inventory pages according to their required permissions', () => {
    const inventory = visibleModules(user, 'org-two').find((module) => module.slug === 'inventory');
    expect(inventory?.implementation).toBe('available');
    expect(visibleModulePages(inventory!, user, 'org-two').map((page) => page.slug)).toEqual([
      'overview',
      'items',
      'warehouses',
      'transactions',
    ]);
  });

  it('shows procurement pages only to users with procurement read access', () => {
    const procurement = visibleModules(user, 'org-one').find((module) => module.slug === 'procurement');
    expect(procurement?.implementation).toBe('available');
    expect(visibleModulePages(procurement!, user, 'org-one').map((page) => page.slug)).toEqual([
      'overview',
      'suppliers',
      'orders',
    ]);
    expect(visibleModules({ ...user, permissions: { 'org-one': ['procurement:order'] } }, 'org-one')).toHaveLength(1);
    expect(visibleModulePages(procurement!, { ...user, permissions: { 'org-one': ['procurement:order'] } }, 'org-one')).toEqual([]);
  });

  it('shows Sales only when authorized and limits its navigation pages', () => {
    const sales = visibleModules(user, 'org-one').find((module) => module.slug === 'sales');
    expect(sales?.implementation).toBe('available');
    expect(visibleModulePages(sales!, user, 'org-one').map((page) => page.slug)).toEqual([
      'overview',
      'customers',
      'orders',
    ]);
    expect(visibleModules({ ...user, permissions: { 'org-one': ['sales:order'] } }, 'org-one')).toHaveLength(1);
  });

  it('limits HR pages to the HR permissions held in the selected organization', () => {
    const hr = visibleModules(user, 'org-one').find((module) => module.slug === 'hr');
    expect(hr?.implementation).toBe('available');
    expect(visibleModulePages(hr!, user, 'org-one').map((page) => page.slug)).toEqual([
      'overview',
      'departments',
      'employees',
      'leave',
      'attendance',
      'payroll',
      'reports',
    ]);
    const payrollOnly = { ...user, permissions: { 'org-one': ['hr:payroll_read'] } };
    const payrollModule = visibleModules(payrollOnly, 'org-one').find((module) => module.slug === 'hr');
    expect(visibleModulePages(payrollModule!, payrollOnly, 'org-one').map((page) => page.slug)).toEqual(['payroll']);
  });
});
