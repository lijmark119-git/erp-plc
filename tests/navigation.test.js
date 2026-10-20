import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ROLE_PERMISSIONS } from '../authorization.js';
import { getNavigationForDisplay, getNavigationKeyFromHash, getVisibleNavigation, resolveNavigationRoute } from '../src/navigation.js';

const stylesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles.css');

function keysFor(role) {
  return getVisibleNavigation(DEFAULT_ROLE_PERMISSIONS[role])
    .flatMap((section) => section.items.flatMap((item) => [item.key, ...item.children.map((child) => child.key)]));
}

test('Admin and Manager see modules allowed by their assigned permissions', () => {
  const adminKeys = keysFor('ADMIN');
  const managerKeys = keysFor('MANAGER');

  for (const key of ['dashboard', 'sales', 'customers', 'inventory', 'warehouses', 'procurement', 'suppliers', 'projects', 'manufacturing', 'hr', 'payroll', 'finance', 'accounting', 'banking', 'reports']) {
    assert.ok(adminKeys.includes(key), `Admin should see ${key}`);
    assert.ok(managerKeys.includes(key), `Manager should see ${key}`);
  }
  assert.ok(adminKeys.includes('settings'));
  assert.ok(!managerKeys.includes('settings'));
});

test('Seller sees only permitted sales destinations', () => {
  assert.deepEqual(keysFor('SELLER'), ['dashboard', 'sales', 'customers', 'reports']);
  assert.equal(resolveNavigationRoute('payroll', DEFAULT_ROLE_PERMISSIONS.SELLER), null);
  assert.equal(resolveNavigationRoute('accounting', DEFAULT_ROLE_PERMISSIONS.SELLER), null);
});

test('Seller sees authorized reports while other operational modules remain unavailable', () => {
  const sections = getNavigationForDisplay(DEFAULT_ROLE_PERMISSIONS.SELLER);
  const items = sections.flatMap((section) => section.items);
  const sellerModules = items.filter((item) => item.allowed).map((item) => item.key);
  const unavailableModules = items.filter((item) => !item.allowed).map((item) => item.key);

  assert.deepEqual(sellerModules, ['dashboard', 'sales', 'reports']);
  assert.deepEqual(unavailableModules, [
    'inventory', 'procurement', 'projects', 'manufacturing', 'hr', 'finance', 'banking', 'governance', 'settings',
  ]);
  assert.ok(items.find((item) => item.key === 'inventory').children.some((child) => !child.allowed));
  assert.equal(resolveNavigationRoute('inventory', DEFAULT_ROLE_PERMISSIONS.SELLER), null);
  assert.equal(resolveNavigationRoute('inventory', DEFAULT_ROLE_PERMISSIONS.ADMIN)?.menu, 'inventory');
});

test('Navigation routes resolve to implemented parent pages and tabs', () => {
  const adminPermissions = DEFAULT_ROLE_PERMISSIONS.ADMIN;
  assert.deepEqual(resolveNavigationRoute('customers', adminPermissions), { key: 'customers', menu: 'sales', tab: 'customers' });
  assert.deepEqual(resolveNavigationRoute('suppliers', adminPermissions), { key: 'suppliers', menu: 'procurement', tab: 'suppliers' });
  assert.deepEqual(resolveNavigationRoute('warehouses', adminPermissions), { key: 'warehouses', menu: 'inventory', tab: 'transfers' });
  assert.deepEqual(resolveNavigationRoute('accounting', adminPermissions), { key: 'accounting', menu: 'finance', tab: 'accounting' });
  assert.deepEqual(resolveNavigationRoute('payroll', adminPermissions), { key: 'payroll', menu: 'hr', tab: 'payroll' });
  assert.deepEqual(resolveNavigationRoute('projects', adminPermissions), { key: 'projects', menu: 'projects' });
  assert.equal(resolveNavigationRoute('fleet', adminPermissions), null);
});

test('Hash parser handles direct routes and empty hashes', () => {
  assert.equal(getNavigationKeyFromHash('#customers'), 'customers');
  assert.equal(getNavigationKeyFromHash('#/accounting'), 'accounting');
  assert.equal(getNavigationKeyFromHash(''), 'dashboard');
});

test('Responsive sidebar remains scrollable and opens as an off-canvas drawer on small screens', () => {
  const styles = fs.readFileSync(stylesPath, 'utf8');
  const mobileStyles = styles.slice(styles.indexOf('@media (max-width: 980px)'));

  assert.match(styles, /\.sidebar\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(mobileStyles, /\.sidebar\.open\s*\{[^}]*transform:\s*translateX\(0\)/s);
  assert.match(mobileStyles, /\.sidebar-overlay\.visible\s*\{[^}]*pointer-events:\s*auto/s);
  assert.match(mobileStyles, /\.nav-menu\s*\{[^}]*overflow:\s*visible/s);
  assert.match(styles, /\.nav-sublist\s*\{[^}]*display:\s*flex/s);
});

test('Banking layout uses compact responsive cards without changing its module routes', () => {
  const styles = fs.readFileSync(stylesPath, 'utf8');
  const bankingStyles = styles.slice(styles.lastIndexOf('\n.banking-page {'));
  assert.match(bankingStyles, /\.banking-page\s*\{\s*gap:\s*12px;/);
  assert.match(bankingStyles, /\.banking-page \.banking-header\s*\{[^}]*linear-gradient/);
  assert.match(bankingStyles, /\.banking-page \.bank-summary-grid\s*\{\s*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(bankingStyles, /\.banking-page \.bank-account-grid\s*\{\s*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(bankingStyles, /\.banking-page \.banking-header \.button-row\s*\{\s*display: grid;\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(bankingStyles, /\.banking-page \.bank-summary-grid\s*\{\s*grid-template-columns: 1fr;\s*gap: 8px;/);
  assert.match(bankingStyles, /\.banking-page \.bank-account-grid\s*\{\s*grid-template-columns: minmax\(0, 1fr\);/);
});

test('Navigation responds to changed session permissions instead of hard-coded roles', () => {
  const changedPermissions = new Set(['sales:orders:read']);
  assert.deepEqual(
    getVisibleNavigation(changedPermissions).flatMap((section) => section.items.map((item) => item.key)),
    ['dashboard', 'sales', 'reports'],
  );
  assert.equal(resolveNavigationRoute('customers', changedPermissions), null);
});
