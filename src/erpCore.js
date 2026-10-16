import {
  attendanceRecords,
  employees,
  financeLedger,
  inventoryItems,
  organizationHierarchy,
  purchaseOrders,
  salesOrders,
  settings,
} from './data.js';

export const state = {
  activeMenu: 'dashboard',
  selectedRange: '30d',
};

export const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

export function formatCurrency(value) {
  return currency.format(value);
}

export function normalizeStatus(value) {
  return String(value).toLowerCase().replace(/\s+/g, '-');
}

export function renderStatus(value) {
  return `<span class="status ${normalizeStatus(value)}">${value}</span>`;
}

export function getInventoryAlerts(items = inventoryItems) {
  return items
    .filter((item) => item.stock <= item.reorderLevel)
    .map((item) => ({
      ...item,
      risk: Math.round((item.stock / item.reorderLevel) * 100),
    }));
}

export function getPendingApprovalCount(orders = purchaseOrders) {
  return orders.filter((order) => order.status === 'Pending').length;
}

export function getFinanceSummary(entries = financeLedger, orders = salesOrders) {
  const revenue = entries
    .filter((entry) => entry.type === 'Revenue')
    .reduce((total, entry) => total + entry.amount, 0);

  const expenses = Math.abs(
    entries
      .filter((entry) => entry.type === 'Expense')
      .reduce((total, entry) => total + entry.amount, 0),
  );

  return {
    revenue,
    expenses,
    net: revenue - expenses,
    avgInvoice: orders.reduce((sum, order) => sum + order.amount, 0) / Math.max(orders.length, 1),
  };
}

export function getEmployeeSummary(staff = employees) {
  const avgAttendance = staff.reduce((sum, item) => sum + item.attendance, 0) / Math.max(staff.length, 1);
  return {
    avgAttendance,
    totalEmployees: staff.length,
    highPerformer: staff.reduce((best, item) => (item.attendance > best.attendance ? item : best), staff[0]),
  };
}

export function getAttendanceSummary(records = attendanceRecords, staff = employees) {
  const present = records.filter((record) => record.status === 'Present').length;
  const absent = records.filter((record) => record.status === 'Absent').length;
  const totalHours = records.reduce((sum, record) => sum + Number(record.workingHours || 0), 0);
  const overtime = records.reduce((sum, record) => sum + Number(record.overtime || 0), 0);
  const late = records.reduce((sum, record) => sum + Number(record.lateArrival || 0), 0);

  return {
    present,
    absent,
    attendanceRate: records.length ? Math.round((present / records.length) * 100) : 0,
    averageHours: records.length ? totalHours / records.length : 0,
    overtime,
    late,
    staffCount: staff.length,
  };
}

export function getOrganizationSummary(hierarchy = organizationHierarchy, staff = employees) {
  const rootCount = hierarchy.filter((item) => item.parentId === null).length;
  const departmentCount = new Set(hierarchy.map((item) => item.employeeId)).size;
  return {
    roots: rootCount,
    departments: departmentCount,
    staffCount: staff.length,
    branches: new Set(staff.map((item) => item.branchId)).size,
  };
}

export function getSalesTrend() {
  return salesOrders.map((order) => ({
    id: order.id,
    amount: order.amount,
    month: order.date.slice(5, 7),
  }));
}
