import type { CurrentUser } from './api';

export type ModulePage = {
  slug: string;
  label: string;
  permission: string | null;
};

export type ErpModule = {
  slug: string;
  name: string;
  description: string;
  icon: string;
  permissions: string[];
  permissionPrefix?: string;
  pages: ModulePage[];
  implementation: 'available' | 'placeholder';
};

export const modules: ErpModule[] = [
  {
    slug: 'administration',
    name: 'Administration',
    description: 'Manage access, users, and security audit records.',
    icon: 'AD',
    permissions: ['users:read', 'users:create', 'users:update', 'roles:assign', 'roles:manage', 'audit:read'],
    pages: [
      { slug: 'users', label: 'Users', permission: 'users:read' },
      { slug: 'roles', label: 'Roles & access', permission: 'roles:manage' },
      { slug: 'audit', label: 'Audit trail', permission: 'audit:read' },
    ],
    implementation: 'available',
  },
  {
    slug: 'organization',
    name: 'Organization',
    description: 'Company and location master data.',
    icon: 'OR',
    permissions: [],
    permissionPrefix: 'organization:',
    pages: [{ slug: 'overview', label: 'Overview', permission: null }],
    implementation: 'placeholder',
  },
  {
    slug: 'finance',
    name: 'Finance',
    description: 'Chart of accounts, balanced journals, and account ledgers.',
    icon: 'FN',
    permissions: [],
    permissionPrefix: 'finance:',
    pages: [
      { slug: 'overview', label: 'Overview', permission: 'finance:read' },
      { slug: 'accounts', label: 'Chart of accounts', permission: 'finance:read' },
      { slug: 'journals', label: 'Journal entries', permission: 'finance:read' },
      { slug: 'ledger', label: 'General ledger', permission: 'finance:read' },
    ],
    implementation: 'available',
  },
  {
    slug: 'hr',
    name: 'Human Resources',
    description: 'Employee records, organization, leave, attendance, payroll, and reports.',
    icon: 'HR',
    permissions: [],
    permissionPrefix: 'hr:',
    pages: [
      { slug: 'overview', label: 'Overview', permission: 'hr:read' },
      { slug: 'departments', label: 'Departments', permission: 'hr:read' },
      { slug: 'employees', label: 'Employees', permission: 'hr:read' },
      { slug: 'leave', label: 'Leave', permission: 'hr:read' },
      { slug: 'attendance', label: 'Attendance', permission: 'hr:read' },
      { slug: 'payroll', label: 'Payroll', permission: 'hr:payroll_read' },
      { slug: 'reports', label: 'Reports', permission: 'hr:reports' },
    ],
    implementation: 'available',
  },
  {
    slug: 'procurement',
    name: 'Procurement',
    description: 'Supplier records, purchase orders, and delivery receiving into inventory.',
    icon: 'PR',
    permissions: [],
    permissionPrefix: 'procurement:',
    pages: [
      { slug: 'overview', label: 'Overview', permission: 'procurement:read' },
      { slug: 'suppliers', label: 'Suppliers', permission: 'procurement:read' },
      { slug: 'orders', label: 'Purchase orders', permission: 'procurement:read' },
    ],
    implementation: 'available',
  },
  {
    slug: 'inventory',
    name: 'Inventory',
    description: 'Items, warehouses, FIFO stock movements, and on-hand balances.',
    icon: 'IN',
    permissions: [],
    permissionPrefix: 'inventory:',
    pages: [
      { slug: 'overview', label: 'Overview', permission: 'inventory:read' },
      { slug: 'items', label: 'Items', permission: 'inventory:read' },
      { slug: 'warehouses', label: 'Warehouses', permission: 'inventory:read' },
      { slug: 'transactions', label: 'Transactions', permission: 'inventory:read' },
    ],
    implementation: 'available',
  },
  {
    slug: 'sales',
    name: 'Sales',
    description: 'Customer records, sales orders, and FIFO stock shipment fulfillment.',
    icon: 'SA',
    permissions: [],
    permissionPrefix: 'sales:',
    pages: [
      { slug: 'overview', label: 'Overview', permission: 'sales:read' },
      { slug: 'customers', label: 'Customers', permission: 'sales:read' },
      { slug: 'orders', label: 'Sales orders', permission: 'sales:read' },
    ],
    implementation: 'available',
  },
  {
    slug: 'manufacturing',
    name: 'Manufacturing',
    description: 'Production planning and shop-floor operations.',
    icon: 'MF',
    permissions: [],
    permissionPrefix: 'manufacturing:',
    pages: [{ slug: 'overview', label: 'Overview', permission: null }],
    implementation: 'placeholder',
  },
];

export function permissionsForUser(user: CurrentUser, organizationId?: string): Set<string> {
  const permissions = organizationId
    ? user.permissions[organizationId] ?? []
    : Object.values(user.permissions).flat();
  return new Set(permissions);
}

export function visibleModules(user: CurrentUser, organizationId?: string): ErpModule[] {
  const granted = permissionsForUser(user, organizationId);
  return modules.filter((module) => {
    if (module.permissionPrefix) {
      return [...granted].some((permission) => permission.startsWith(module.permissionPrefix ?? ''));
    }
    return module.permissions.some((permission) => granted.has(permission));
  });
}

export function visibleModulePages(
  module: ErpModule,
  user: CurrentUser,
  organizationId?: string,
): ModulePage[] {
  const granted = permissionsForUser(user, organizationId);
  return module.pages.filter((page) => page.permission === null || granted.has(page.permission));
}
