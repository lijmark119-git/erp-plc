import {
  bankAccounts,
  bankTransactions,
  billOfMaterials,
  branches,
  departments,
  employees,
  financeLedger,
  inventoryItems,
  organizationHierarchy,
  attendanceRecords,
  positions,
  productionOrders,
  purchaseOrders,
  rangeOptions,
  reportMetrics,
  salesOrders,
  settings,
  workCenters,
  navigation,
} from './data.js';
import {
  formatCurrency,
  getAttendanceSummary,
  getEmployeeSummary,
  getFinanceSummary,
  getInventoryAlerts,
  getOrganizationSummary,
  renderStatus,
  state,
} from './erpCore.js';
import { getNavigationForDisplay, getNavigationKeyFromHash, getVisibleNavigation, resolveNavigationRoute } from './navigation.js';
import { getAttendanceCalendarDay } from './ethiopianCalendar.js';
import { renderGovernancePage } from './governance.js';

const root = document.getElementById('root');
const authState = {
  user: null,
  loaded: false,
  dataLoading: false,
  dataLoadError: '',
};
const navigationState = { key: 'dashboard' };
const assistantState = {
  open: false,
  loading: false,
  error: '',
  messages: [],
};
const governanceState = {
  tab: 'overview',
  loading: false,
  data: null,
  error: '',
  message: '',
};
const projectsState = {
  projects: [],
  loading: false,
  error: '',
};
const legacyUiPermissions = {
  ADMIN: new Set(['finance:transactions:manage']),
  MANAGER: new Set(['procurement:orders:manage']),
};
const API_BASE_URL = '';
const actionPermissions = {
  sales: 'sales:orders:create',
  inventory: 'inventory:stock:update',
  procurement: 'procurement:orders:create',
  employee: 'hr:employees:create',
  finance: 'finance:transactions:create',
};
const managePermissions = {
  sales: 'sales:orders:manage',
  inventory: 'inventory:products:manage',
  procurement: 'procurement:orders:manage',
  employee: 'hr:employees:manage',
  finance: 'finance:transactions:manage',
  manufacturing: 'manufacturing:orders:manage',
};

function hasRolePermission(permission) {
  return Boolean(
    authState.user?.permissions?.includes(permission)
    || legacyUiPermissions[authState.user?.role]?.has(permission),
  );
}

function canAccessMenu(menu) {
  return Boolean(authState.user && resolveNavigationRoute(menu, authState.user.permissions || []));
}

function navigationPreferenceKey(type) {
  return `erp-${type}-${authState.user?.id || authState.user?.username || 'unknown'}`;
}

function getNavigationPreferences(type) {
  try {
    const parsed = JSON.parse(localStorage.getItem(navigationPreferenceKey(type)) || '[]');
    return Array.isArray(parsed) ? parsed.filter((key) => typeof key === 'string') : [];
  } catch {
    return [];
  }
}

function setNavigationPreferences(type, values) {
  try {
    localStorage.setItem(navigationPreferenceKey(type), JSON.stringify([...new Set(values)].slice(0, 8)));
  } catch {
    assistantState.error = 'Browser storage is unavailable; navigation preferences were not saved.';
  }
}

function getAuthorizedPages() {
  const pages = [{ key: 'dashboard', label: 'Dashboard' }];
  for (const item of navigation) {
    if (resolveNavigationRoute(item.key, authState.user?.permissions || [])) {
      pages.push({ key: item.key, label: item.label });
    }
    for (const child of item.children || []) {
      if (resolveNavigationRoute(child.key, authState.user?.permissions || [])) {
        pages.push({ key: child.key, label: child.label });
      }
    }
  }
  return pages;
}

function recordRecentPage(key) {
  const recent = getNavigationPreferences('recent').filter((existing) => existing !== key);
  setNavigationPreferences('recent', [key, ...recent]);
}

function removeRecentPage(key) {
  setNavigationPreferences('recent', getNavigationPreferences('recent').filter((recent) => recent !== key));
  render();
}

function toggleFavoritePage(key) {
  const favorites = getNavigationPreferences('favorites');
  setNavigationPreferences('favorites', favorites.includes(key)
    ? favorites.filter((favorite) => favorite !== key)
    : [key, ...favorites]);
  render();
}

function renderQuickNavigation() {
  const available = getAuthorizedPages();
  const getButtons = (keys) => keys
    .map((key) => available.find((page) => page.key === key))
    .filter(Boolean)
    .map((page) => `<button type="button" class="quick-nav-link" data-route-key="${escapeHtml(page.key)}">${escapeHtml(page.label)}</button>`)
    .join('');
  const favorites = getButtons(getNavigationPreferences('favorites'));
  const recent = getNavigationPreferences('recent')
    .map((key) => available.find((page) => page.key === key))
    .filter(Boolean)
    .map((page) => `<div class="quick-nav-entry"><button type="button" class="quick-nav-link" data-route-key="${escapeHtml(page.key)}">${escapeHtml(page.label)}</button><button type="button" class="quick-nav-remove" data-remove-recent="${escapeHtml(page.key)}" aria-label="Remove ${escapeHtml(page.label)} from recently visited" title="Remove from recently visited">×</button></div>`)
    .join('');
  if (!favorites && !recent) return '';
  return `<section class="quick-navigation" aria-label="Quick navigation">
    ${favorites ? `<div><strong>Favorites</strong>${favorites}</div>` : ''}
    ${recent ? `<div><strong>Recently visited</strong>${recent}</div>` : ''}
  </section>`;
}

function activateNavigationRoute(route) {
  state.activeMenu = route.menu;
  navigationState.key = route.key;
  if (route.menu === 'sales' && !route.tab) salesState.tab = 'overview';
  if (route.tab) {
    if (route.menu === 'sales') salesState.tab = route.tab;
    if (route.menu === 'inventory') inventoryTransferState.tab = route.tab;
    if (route.menu === 'procurement') procurementState.tab = route.tab;
    if (route.menu === 'hr') hrState.tab = route.tab;
    if (route.menu === 'finance') financeState.tab = route.tab;
  }
}

function navigateTo(key, replace = false) {
  const route = authState.user
    ? resolveNavigationRoute(key, authState.user.permissions || [])
    : null;
  if (!route) return false;

  activateNavigationRoute(route);
  recordRecentPage(route.key);
  const hash = `#${route.key}`;
  if (window.location.hash !== hash) {
    window.history[replace ? 'replaceState' : 'pushState'](null, '', hash);
  }
  closeSidebar();
  render();
  if (route.menu === 'governance' && !governanceState.data && !governanceState.loading) {
    loadGovernanceData().then(() => {
      if (state.activeMenu === 'governance') render();
    });
  }
  if (route.menu === 'projects' && !projectsState.loading) {
    loadProjectsData().then(() => {
      if (state.activeMenu === 'projects') render();
    });
  }
  return true;
}

function syncNavigationFromHash() {
  const key = getNavigationKeyFromHash(window.location.hash);
  if (!navigateTo(key, true)) navigateTo('dashboard', true);
}

function canManageRecords(module) {
  return Boolean(authState.user && managePermissions[module] && hasRolePermission(managePermissions[module]));
}

function recordActions(module, identifier, label) {
  if (!canManageRecords(module)) return '';
  return `<div class="record-actions"><button type="button" data-record-edit="${module}" data-record-id="${identifier}" aria-label="Edit ${label}">Edit</button><button type="button" class="danger-btn" data-record-delete="${module}" data-record-id="${identifier}" aria-label="Delete ${label}">Delete</button></div>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

const applicationData = {
  salesOrders: [...salesOrders],
  inventoryItems: [...inventoryItems],
  purchaseOrders: [...purchaseOrders],
  productionOrders: [...productionOrders],
  workCenters: [...workCenters],
  billOfMaterials: [...billOfMaterials],
  employees: [...employees],
  departments: [...departments],
  positions: [...positions],
  branches: [...branches],
  organizationHierarchy: [...organizationHierarchy],
  attendanceRecords: [...attendanceRecords],
  financeLedger: [...financeLedger],
  bankAccounts: [...bankAccounts],
  bankTransactions: [...bankTransactions],
  bankStatementTransactions: [],
  bankReconciliationHistory: [],
  reportMetrics: [...reportMetrics],
  settings: [...settings],
};
const bankingState = {
  accounts: applicationData.bankAccounts,
  transactions: applicationData.bankTransactions,
  statementTransactions: applicationData.bankStatementTransactions,
  reconciliationHistory: applicationData.bankReconciliationHistory,
  summary: { pending: 0 },
  error: '',
};
const inventoryTransferState = {
  tab: 'overview',
  statusFilter: 'ALL',
  countStatusFilter: 'ALL',
  transfers: [],
  counts: [],
  traceLots: [],
  serialNumbers: [],
  reservations: [],
  traceLookup: null,
  traceLookupError: '',
  products: [],
  warehouses: [],
  locations: [],
  uoms: [],
  error: '',
};
const dashboardState = {
  metrics: {},
  trend: [],
  currency: 'ETB',
  loading: false,
  error: '',
  requestId: 0,
  chartMetric: 'sales',
  updatedAt: null,
};
const reportsState = {
  rows: [],
  saved: [],
  error: '',
  filter: '',
  range: '30d',
  sortBy: 'module',
  sortDirection: 'asc',
  page: 1,
  pageSize: 10,
  columns: ['module', 'report', 'current', 'previous', 'change', 'count'],
};
const settingsUiState = {
  message: 'Settings are saved when toggled.',
  error: false,
};
const userAccessState = {
  users: [],
  roles: [],
  message: '',
  error: false,
};
const pageTitles = {
  dashboard: ['Overview', 'Enterprise Resource Planning'],
  sales: ['Sales', 'Order management'],
  inventory: ['Inventory', 'Stock control'],
  procurement: ['Procurement', 'Vendor purchasing'],
  manufacturing: ['Manufacturing', 'Production control'],
  projects: ['Projects', 'Project and task tracking'],
  hr: ['People', 'Attendance and staffing'],
  finance: ['Finance', 'Cash flow and ledger'],
  banking: ['Banking', 'Cash management'],
  reports: ['Reports', 'Performance insights'],
  settings: ['Settings', 'Business configuration'],
  governance: ['Enterprise governance', 'Management and company-wide controls'],
};
const manufacturingState = {
  productionOrders: applicationData.productionOrders,
  workCenters: applicationData.workCenters,
  billOfMaterials: applicationData.billOfMaterials,
  summary: { plannedUnits: 0, completedUnits: 0, completionRate: 0, blockedOrders: 0, averageUtilization: 0 },
  tab: 'overview',
  workspace: null,
  selectedOrderId: '',
  selectedOrder: null,
  trace: null,
  reportType: 'production-plan',
  reportRows: [],
  error: '',
};
const hrState = {
  tab: 'employees',
  attendancePeriod: '30',
  attendanceMonth: attendanceDateKey().slice(0, 7),
  attendanceStartDate: '',
  attendanceEndDate: '',
  attendanceEmployeeId: 'ALL',
  attendanceStatus: 'ALL',
  attendanceSearch: '',
  leaveMonth: new Date().toISOString().slice(0, 7),
  leaveCalendar: [],
  reportType: 'employees',
  workspace: { departments: [], positions: [], branches: [], organizationHierarchy: [] },
  leave: { types: [], balances: [], requests: [] },
  payroll: { periods: [], settings: {}, results: [], accountingEntries: [] },
  reports: { employees: [], attendance: [], leave: [], payroll: [] },
  employeeDocuments: [],
};
const salesState = {
  tab: 'overview',
  orderFilter: 'ALL',
  orderSearch: '',
  customers: [],
  customerInsights: [],
  priceLists: [],
  quotations: [],
  orders: [],
  deliveries: [],
  returnRequests: [],
  performance: null,
  performanceStart: `${new Date().toISOString().slice(0, 7)}-01`,
  performanceEnd: new Date().toISOString().slice(0, 10),
  invoices: [],
  payments: [],
  receivables: [],
  warehouses: [],
  reports: null,
  audit: [],
  crmRecords: [],
  activities: [],
  disputes: [],
  error: '',
};
const procurementState = {
  tab: 'comparisons',
  suppliers: [],
  comparisons: [],
  orders: [],
  warehouses: [],
  requisitions: [],
  supplierInvoices: [],
  supplierDocuments: [],
  scorecards: [],
  loading: false,
  error: '',
};
const accountingState = {
  tab: 'ledger',
  accounts: [],
  periods: [],
  journals: [],
  budgets: [],
  ledger: null,
  reports: {},
  error: '',
};
const financeState = { tab: 'overview' };

async function fetchJson(url, options = {}) {
  const response = await fetch(`${API_BASE_URL}${url}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();

  if (!response.ok) {
    throw new Error(typeof payload === 'string' ? payload : (payload.error || payload.message || 'Request failed'));
  }

  return payload;
}

async function loadGovernanceData() {
  if (governanceState.loading) return;
  governanceState.loading = true;
  governanceState.error = '';
  try {
    const data = await fetchJson('/api/governance');
    if (!data || !Array.isArray(data.entities) || !Array.isArray(data.policies)) {
      throw new Error('The governance workspace response is invalid.');
    }
    governanceState.data = data;
  } catch (error) {
    governanceState.error = error.message;
  } finally {
    governanceState.loading = false;
  }
}

async function loadProjectsData() {
  if (projectsState.loading) return;
  projectsState.loading = true;
  projectsState.error = '';
  try {
    const projects = await fetchJson('/api/projects');
    if (!Array.isArray(projects) || projects.some((project) => !Array.isArray(project.tasks))) {
      throw new Error('The projects workspace response is invalid.');
    }
    projectsState.projects = projects;
  } catch (error) {
    projectsState.error = error.message;
  } finally {
    projectsState.loading = false;
  }
}

async function handleProjectFormSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const projectId = form.dataset.projectId;
  const payload = Object.fromEntries(new FormData(form).entries());
  const endpoint = projectId
    ? `/api/projects/${encodeURIComponent(projectId)}/tasks`
    : '/api/projects';
  try {
    await fetchJson(endpoint, { method: 'POST', body: JSON.stringify(payload) });
    await loadProjectsData();
    render();
  } catch (error) {
    projectsState.error = error.message;
    render();
  }
}

async function handleProjectStatusSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const projectId = form.dataset.projectId;
  const taskId = form.dataset.taskId;
  const endpoint = taskId
    ? `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/status`
    : `/api/projects/${encodeURIComponent(projectId)}/status`;
  const payload = Object.fromEntries(new FormData(form).entries());
  try {
    await fetchJson(endpoint, { method: 'PATCH', body: JSON.stringify(payload) });
    await loadProjectsData();
    render();
  } catch (error) {
    projectsState.error = error.message;
    render();
  }
}

async function handleGovernanceFormSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = form.querySelector('.governance-form-error');
  const collection = form.dataset.governanceForm;
  const payload = Object.fromEntries(new FormData(form).entries());
  if (error) error.textContent = '';
  try {
    await fetchJson(`/api/governance/${encodeURIComponent(collection)}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    governanceState.message = 'Governance record created.';
    await loadGovernanceData();
    render();
  } catch (requestError) {
    if (error) error.textContent = requestError.message;
  }
}

async function handleGovernanceStatus(button) {
  const collection = button.dataset.governanceStatus;
  const status = button.dataset.nextStatus;
  button.disabled = true;
  try {
    await fetchJson(`/api/governance/${encodeURIComponent(collection)}/${encodeURIComponent(button.dataset.id)}/status`, {
      method: 'PATCH',
      body: JSON.stringify(collection === 'approval-rules' ? { active: status === 'true' } : { status }),
    });
    governanceState.message = 'Governance record status updated.';
    await loadGovernanceData();
    render();
  } catch (error) {
    governanceState.message = error.message;
    render();
  }
}

async function loadApplicationData() {
  const settingsRequest = hasRolePermission('settings:toggle')
    ? fetchJson('/api/settings')
    : Promise.resolve(null);
  const accessRequest = hasRolePermission('users:manage')
    ? fetchJson('/api/access/users')
    : Promise.resolve(null);
  const [banking, manufacturing, sales, inventory, procurement, finance, reports, settingsData, accessData] = await Promise.all([
    canAccessMenu('banking') ? fetchJson('/api/banking') : Promise.resolve(null),
    canAccessMenu('manufacturing') ? fetchJson('/api/manufacturing') : Promise.resolve(null),
    hasRolePermission('sales:orders:read') ? fetchJson('/api/sales') : Promise.resolve(null),
    hasRolePermission('inventory:reports:view') ? fetchJson('/api/inventory') : Promise.resolve(null),
    hasRolePermission('procurement:orders:read') ? fetchJson('/api/procurement') : Promise.resolve(null),
    hasRolePermission('accounting:reports:view') ? fetchJson('/api/finance') : Promise.resolve(null),
    hasRolePermission('accounting:reports:view') ? fetchJson('/api/reports') : Promise.resolve(null),
    settingsRequest,
    accessRequest,
  ]);

  if (banking) updateBankingData(banking);
  if (settingsData) applicationData.settings = settingsData;
    if (accessData) {
      userAccessState.users = accessData.users || [];
      userAccessState.roles = accessData.roles || [];
      userAccessState.error = false;
    }
  if (sales) applicationData.salesOrders = sales;
  if (inventory) applicationData.inventoryItems = inventory;
  if (procurement) applicationData.purchaseOrders = procurement;
  if (manufacturing) {
    applicationData.productionOrders = manufacturing.productionOrders;
    applicationData.workCenters = manufacturing.workCenters;
    applicationData.billOfMaterials = manufacturing.billOfMaterials;
  }
  if (finance) applicationData.financeLedger = finance;
  if (reports) applicationData.reportMetrics = reports;
  await loadDashboardData();
  if (canAccessMenu('reports')) await loadReportsData();
  if (manufacturing) {
    manufacturingState.productionOrders = manufacturing.productionOrders;
    manufacturingState.workCenters = manufacturing.workCenters;
    manufacturingState.billOfMaterials = manufacturing.billOfMaterials;
    manufacturingState.summary = manufacturing.summary;
  }
  if (canAccessMenu('sales')) await loadSalesData();
  if (hasRolePermission('procurement:comparisons:read')) await loadProcurementData();
  if (canAccessMenu('inventory') && hasRolePermission('inventory:reports:view')) await loadInventoryTransferData();
  if (canAccessMenu('hr')) await loadHrData();
  if (canAccessMenu('finance') && hasRolePermission('accounting:reports:view')) await loadAccountingData();
  if (canAccessMenu('manufacturing') && hasRolePermission('manufacturing:read')) await loadManufacturingData();
}

function updateBankingData(banking) {
  applicationData.bankAccounts = banking.accounts;
  applicationData.bankTransactions = banking.transactions;
  applicationData.bankStatementTransactions = banking.statementTransactions || [];
  applicationData.bankReconciliationHistory = banking.reconciliationHistory || [];
  bankingState.accounts = applicationData.bankAccounts;
  bankingState.transactions = applicationData.bankTransactions;
  bankingState.statementTransactions = applicationData.bankStatementTransactions;
  bankingState.reconciliationHistory = applicationData.bankReconciliationHistory;
  bankingState.summary = banking.summary;
  bankingState.error = '';
}

async function loadDashboardData() {
  const requestId = ++dashboardState.requestId;
  dashboardState.loading = true;
  dashboardState.error = '';
  try {
    const dashboard = await fetchJson(`/api/dashboard?range=${encodeURIComponent(state.selectedRange)}`);
    if (requestId === dashboardState.requestId) {
      Object.assign(dashboardState, {
        metrics: dashboard.metrics || {},
        trend: dashboard.trend || [],
        currency: dashboard.currency || 'ETB',
        error: '',
        updatedAt: new Date(),
      });
    }
  } catch (error) {
    if (requestId === dashboardState.requestId) dashboardState.error = error.message;
  } finally {
    if (requestId === dashboardState.requestId) dashboardState.loading = false;
  }
}

async function loadReportsData() {
  reportsState.error = '';
  try {
    const [workspace, saved] = await Promise.all([
      fetchJson(`/api/reports/catalog?range=${encodeURIComponent(reportsState.range)}`),
      fetchJson('/api/reports/saved'),
    ]);
    reportsState.rows = workspace.reports || [];
    reportsState.period = workspace.period;
    reportsState.generatedAt = workspace.generatedAt;
    reportsState.saved = saved || [];
  } catch (error) {
    reportsState.error = error.message;
  }
}

async function saveReportConfiguration(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const name = String(new FormData(form).get('name') || '').trim();
  try {
    await fetchJson('/api/reports/saved', {
      method: 'POST',
      body: JSON.stringify({
        name,
        reportKey: 'dashboard-summary',
        config: {
          columns: reportsState.columns,
          filter: reportsState.filter,
          pageSize: reportsState.pageSize,
          range: reportsState.range,
          sortBy: reportsState.sortBy,
          sortDirection: reportsState.sortDirection,
        },
      }),
    });
    await loadReportsData();
    render();
  } catch (error) {
    reportsState.error = error.message;
    render();
  }
}

async function applySavedReportConfiguration(event) {
  const selected = reportsState.saved.find((saved) => saved.id === event.currentTarget.value);
  if (!selected) return;
  const config = selected.configuration || {};
  reportsState.columns = Array.isArray(config.columns) ? config.columns : reportsState.columns;
  reportsState.filter = String(config.filter || '');
  reportsState.pageSize = Number(config.pageSize) || 10;
  reportsState.sortBy = reportColumnLabels[config.sortBy] ? config.sortBy : 'module';
  reportsState.sortDirection = config.sortDirection === 'desc' ? 'desc' : 'asc';
  reportsState.range = ['7d', '30d', '90d', '1y'].includes(config.range) ? config.range : '30d';
  reportsState.page = 1;
  await loadReportsData();
  render();
}

async function deleteSavedReportConfiguration() {
  const selected = document.getElementById('report-saved-view')?.value;
  if (!selected) {
    reportsState.error = 'Choose a saved view to delete.';
    render();
    return;
  }
  try {
    await fetchJson(`/api/reports/saved/${encodeURIComponent(selected)}`, { method: 'DELETE' });
    await loadReportsData();
    render();
  } catch (error) {
    reportsState.error = error.message;
    render();
  }
}

async function loadInventoryTransferData() {
  try {
    const [transfers, counts, products, warehouses, locations, uoms, traceLots, serialNumbers, reservations] = await Promise.all([
      fetchJson('/api/inventory-management/transfers'),
      fetchJson('/api/inventory-management/counts'),
      fetchJson('/api/inventory-management/products?activeOnly=true'),
      fetchJson('/api/inventory-management/warehouses'),
      fetchJson('/api/inventory-management/locations'),
      fetchJson('/api/inventory-management/uoms'),
      fetchJson('/api/inventory-management/trace/lots'),
      fetchJson('/api/inventory-management/trace/serials'),
      fetchJson('/api/inventory-management/reservations'),
    ]);
    Object.assign(inventoryTransferState, {
      transfers, counts, products, warehouses, locations, uoms, traceLots, serialNumbers, reservations, error: '',
    });
  } catch (error) {
    inventoryTransferState.error = error.message;
  }
}

async function handleInventoryTransferSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = form.querySelector('.inventory-transfer-error');
  if (error) error.textContent = '';
  const values = Object.fromEntries(new FormData(form).entries());
  const payload = { ...values, requestedQuantity: Number(values.requestedQuantity) };
  try {
    await fetchJson('/api/inventory-management/transfers', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    await loadInventoryTransferData();
    render();
  } catch (requestError) {
    if (error) error.textContent = requestError.message;
  }
}

async function handleInventorySetupSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const type = form.dataset.inventorySetup;
  const error = form.querySelector('.inventory-transfer-error');
  const values = Object.fromEntries(new FormData(form).entries());
  const endpoints = {
    product: '/api/inventory-management/products',
    warehouse: '/api/inventory-management/warehouses',
    uom: '/api/inventory-management/uoms',
    location: '/api/inventory-management/locations',
  };
  if (!endpoints[type]) return;
  if (type === 'uom') values.factor = Number(values.factor || 1);
  if (type === 'product') {
    values.productType = values.productType || 'TRADING_PRODUCT';
    values.unitOfMeasureId = values.unitOfMeasureId || inventoryTransferState.uoms[0]?.id;
    values.standardCost = Number(values.standardCost || 0);
  }
  try {
    await fetchJson(endpoints[type], { method: 'POST', body: JSON.stringify(values) });
    await loadInventoryTransferData();
    render();
  } catch (requestError) {
    if (error) error.textContent = requestError.message;
  }
}

async function handleInventoryStockReceiptSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = form.querySelector('.inventory-transfer-error');
  const values = Object.fromEntries(new FormData(form).entries());
  const payload = {
    productId: values.productId,
    warehouseId: values.warehouseId,
    quantity: Number(values.quantity),
    unitCost: Number(values.unitCost),
    referenceType: 'OPENING_BALANCE',
    referenceId: values.referenceId.trim(),
  };
  try {
    await fetchJson('/api/inventory-management/stock/receive', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    await loadInventoryTransferData();
    render();
  } catch (requestError) {
    if (error) error.textContent = requestError.message;
  }
}

function parseInventorySerialNumbers(value) {
  return String(value || '').split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean);
}

async function handleInventoryTraceReceiveSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = form.querySelector('.inventory-trace-error');
  error.textContent = '';
  const values = Object.fromEntries(new FormData(form).entries());
  const payload = {
    productId: values.productId,
    warehouseId: values.warehouseId,
    locationId: values.locationId || undefined,
    quantity: Number(values.quantity),
    unitCost: Number(values.unitCost),
    referenceType: values.referenceType || 'PURCHASE_RECEIPT',
    referenceId: values.referenceId || undefined,
    lotNumber: values.lotNumber,
    lotQuantity: Number(values.quantity),
    expiryDate: values.expiryDate || undefined,
    warrantyEndDate: values.warrantyEndDate || undefined,
    lotBarcode: values.lotBarcode || undefined,
    qualityStatus: values.qualityStatus,
    serialNumbers: parseInventorySerialNumbers(values.serialNumbers),
  };
  if (!payload.serialNumbers.length) delete payload.serialNumbers;
  try {
    await fetchJson('/api/inventory-management/stock/receive', { method: 'POST', body: JSON.stringify(payload) });
    await loadInventoryTransferData();
    render();
  } catch (requestError) {
    error.textContent = requestError.message;
  }
}

async function handleInventoryTrackedIssueSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = form.querySelector('.inventory-trace-error');
  error.textContent = '';
  const values = Object.fromEntries(new FormData(form).entries());
  const payload = {
    productId: values.productId,
    warehouseId: values.warehouseId,
    quantity: Number(values.quantity),
    transactionType: 'MANUAL_ISSUE',
    referenceType: values.referenceType || 'MANUAL_ISSUE',
    referenceId: values.referenceId || undefined,
    reservationId: values.reservationId || undefined,
    serialNumbers: parseInventorySerialNumbers(values.serialNumbers),
  };
  if (!payload.serialNumbers.length) delete payload.serialNumbers;
  try {
    await fetchJson('/api/inventory-management/stock/issue', { method: 'POST', body: JSON.stringify(payload) });
    await Promise.all([loadInventoryTransferData(), loadDashboardData()]);
    render();
  } catch (requestError) {
    error.textContent = requestError.message;
  }
}

async function handleInventoryReservationSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = form.querySelector('.inventory-trace-error');
  error.textContent = '';
  const values = Object.fromEntries(new FormData(form).entries());
  const payload = {
    productId: values.productId,
    warehouseId: values.warehouseId,
    locationId: values.locationId || undefined,
    quantity: Number(values.quantity),
    referenceType: values.referenceType || undefined,
    referenceId: values.referenceId || undefined,
    reason: values.reason || undefined,
  };
  try {
    await fetchJson('/api/inventory-management/reservations', { method: 'POST', body: JSON.stringify(payload) });
    await loadInventoryTransferData();
    render();
  } catch (requestError) {
    error.textContent = requestError.message;
  }
}

async function handleInventoryTraceLookupSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = form.querySelector('.inventory-trace-error');
  error.textContent = '';
  const code = new FormData(form).get('code');
  try {
    inventoryTransferState.traceLookup = await fetchJson(
      `/api/inventory-management/trace/lookup?code=${encodeURIComponent(code)}`,
    );
    inventoryTransferState.traceLookupError = '';
    render();
  } catch (requestError) {
    inventoryTransferState.traceLookup = null;
    inventoryTransferState.traceLookupError = requestError.message;
    render();
  }
}

async function handleInventoryReservationRelease(reservationId) {
  try {
    await fetchJson(`/api/inventory-management/reservations/${encodeURIComponent(reservationId)}/release`, {
      method: 'POST', body: JSON.stringify({}),
    });
    await loadInventoryTransferData();
    render();
  } catch (error) {
    inventoryTransferState.error = error.message;
    render();
  }
}

async function handleInventoryLotQuality(lotId, qualityStatus) {
  try {
    await fetchJson(`/api/inventory-management/trace/lots/${encodeURIComponent(lotId)}/quality`, {
      method: 'POST',
      body: JSON.stringify({ qualityStatus, reason: 'Updated in inventory traceability.' }),
    });
    await loadInventoryTransferData();
    render();
  } catch (error) {
    inventoryTransferState.error = error.message;
    render();
  }
}

function handleInventoryQrLabel(button) {
  const container = button.closest('[data-qr-label-container]');
  if (!container) return;
  let image = container.querySelector('img');
  if (!image) {
    image = document.createElement('img');
    image.alt = `QR label for ${button.dataset.qrCode}`;
    image.loading = 'lazy';
    image.src = `/api/inventory-management/trace/qr?code=${encodeURIComponent(button.dataset.qrCode)}`;
    container.append(image);
    button.textContent = 'Hide QR';
    return;
  }
  image.remove();
  button.textContent = 'QR label';
}

async function handleInventoryCountSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = form.querySelector('.inventory-count-error');
  error.textContent = '';
  const productLines = [...form.querySelectorAll('.inventory-count-line')];
  const productIds = productLines.map((line) => line.querySelector('[data-count-product]').value);
  if (new Set(productIds).size !== productIds.length) {
    error.textContent = 'Choose a different product for each count line.';
    return;
  }
  const lines = productLines.map((line) => ({
    productId: line.querySelector('[data-count-product]').value,
    countedQuantity: Number(line.querySelector('[data-count-quantity]').value),
  }));
  try {
    await fetchJson('/api/inventory-management/counts', {
      method: 'POST',
      body: JSON.stringify({
        warehouseId: new FormData(form).get('warehouseId'),
        lines,
      }),
    });
    await loadInventoryTransferData();
    render();
  } catch (requestError) {
    error.textContent = requestError.message;
  }
}

async function handleInventoryCountAction(countId, action) {
  if (action === 'post' && !window.confirm('Post this approved stock count? Variances will update stock and the accounting ledger.')) return;
  const endpointAction = action === 'approve' ? 'approve' : 'post';
  try {
    await fetchJson(`/api/inventory-management/counts/${encodeURIComponent(countId)}/${endpointAction}`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    await Promise.all([loadInventoryTransferData(), loadDashboardData()]);
    render();
  } catch (error) {
    inventoryTransferState.error = error.message;
    render();
  }
}

async function showInventoryCountDetails(countId) {
  try {
    const session = await fetchJson(`/api/inventory-management/counts/${encodeURIComponent(countId)}`);
    const lines = (session.lines || []).map((line) => {
      const variance = Number(line.variance);
      const varianceClass = variance > 0 ? 'positive-number' : variance < 0 ? 'negative-number' : '';
      return `<tr><td><strong>${escapeHtml(line.sku)}</strong><small>${escapeHtml(line.name)}</small></td>
        <td>${Number(line.system_quantity).toLocaleString()}</td>
        <td>${Number(line.counted_quantity).toLocaleString()}</td>
        <td class="${varianceClass}">${variance > 0 ? '+' : ''}${variance.toLocaleString()}</td></tr>`;
    }).join('');
    const warehouse = inventoryTransferState.warehouses.find((item) => item.id === session.warehouse_id);
    const dialog = document.createElement('div');
    dialog.className = 'modal-backdrop';
    dialog.innerHTML = `<section class="modal-card inventory-count-detail" role="dialog" aria-modal="true" aria-labelledby="inventory-count-detail-title">
      <div class="modal-header"><div><p class="eyebrow">${escapeHtml(session.status)}</p><h2 id="inventory-count-detail-title">Stock count details</h2></div>
      <button type="button" class="modal-close" aria-label="Close">×</button></div>
      <p>${escapeHtml(warehouse ? `${warehouse.code} · ${warehouse.name}` : 'Warehouse')} · ${escapeHtml(new Date(session.counted_at).toLocaleString())}</p>
      <div class="table-wrap"><table><thead><tr><th>Product</th><th>System quantity</th><th>Counted</th><th>Variance</th></tr></thead>
      <tbody>${lines || '<tr><td colspan="4" class="empty-state">No count lines were recorded.</td></tr>'}</tbody></table></div>
    </section>`;
    const close = () => dialog.remove();
    dialog.querySelector('.modal-close').addEventListener('click', close);
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) close();
    });
    document.body.append(dialog);
    dialog.querySelector('.modal-close').focus();
  } catch (error) {
    inventoryTransferState.error = error.message;
    render();
  }
}

async function handleInventoryTransferAction(transferId, action, quantity) {
  if (action === 'complete') {
    try {
      await fetchJson(`/api/inventory-management/transfers/${encodeURIComponent(transferId)}/complete`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      await loadInventoryTransferData();
      render();
    } catch (error) {
      inventoryTransferState.error = error.message;
      render();
    }
    return;
  }
  const labels = {
    approve: ['Approve transfer', 'Approval reason'],
    reject: ['Reject transfer', 'Rejection reason'],
    dispatch: ['Dispatch transfer', 'Dispatch note or reason'],
    receive: ['Receive transfer', 'Receipt note or reason'],
  };
  const [title, reasonLabel] = labels[action] || ['Complete transfer', 'Reason'];
  const dialog = document.createElement('div');
  dialog.className = 'modal-backdrop';
  dialog.innerHTML = `<section class="modal-card transfer-action-modal" role="dialog" aria-modal="true" aria-labelledby="transfer-action-title">
    <div class="modal-header"><div><p class="eyebrow">Stock transfer</p><h2 id="transfer-action-title">${title}</h2></div><button type="button" class="modal-close" aria-label="Close">×</button></div>
    <form class="inventory-transfer-action-form">
      ${action === 'approve' ? `<label>Approved quantity<input name="approvedQuantity" type="number" min="0.000001" max="${Number(quantity)}" step="0.000001" value="${Number(quantity)}" required /></label>` : ''}
      <label>${reasonLabel}<textarea name="reason" rows="3" required></textarea></label>
      <p class="inventory-transfer-error" role="alert"></p>
      <div class="modal-actions"><button class="ghost-btn modal-close" type="button">Cancel</button><button class="primary-btn" type="submit">${title}</button></div>
    </form>
  </section>`;
  document.body.appendChild(dialog);
  const close = () => dialog.remove();
  dialog.querySelectorAll('.modal-close').forEach((button) => button.addEventListener('click', close));
  dialog.addEventListener('click', (event) => { if (event.target === dialog) close(); });
  const form = dialog.querySelector('form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      await fetchJson(`/api/inventory-management/transfers/${encodeURIComponent(transferId)}/${action}`, {
        method: 'POST',
        body: JSON.stringify({
          reason: values.reason.trim(),
          approvedQuantity: Number(values.approvedQuantity || quantity),
        }),
      });
      await loadInventoryTransferData();
      close();
      render();
    } catch (error) {
      form.querySelector('.inventory-transfer-error').textContent = error.message;
    }
  });
  form.querySelector('textarea')?.focus();
}

async function loadManufacturingData() {
  try {
    const [workspace, qualityInspections] = await Promise.all([
      fetchJson('/api/manufacturing/workspace'),
      fetchJson('/api/manufacturing/quality-inspections'),
    ]);
    manufacturingState.workspace = workspace;
    manufacturingState.qualityInspections = qualityInspections;
    manufacturingState.error = '';
    if (manufacturingState.selectedOrderId) {
      manufacturingState.selectedOrder = await fetchJson(`/api/manufacturing/work-orders/${encodeURIComponent(manufacturingState.selectedOrderId)}`);
    }
  } catch (error) {
    manufacturingState.error = error.message;
  }
}

async function loadAccountingData() {
  try {
    const [accounts, periods, journals, trialBalance, profitAndLoss, balanceSheet, cashFlow, budgets] = await Promise.all([
      fetchJson('/api/accounting/accounts'),
      fetchJson('/api/accounting/periods'),
      fetchJson('/api/accounting/journals'),
      fetchJson('/api/accounting/reports/trial-balance'),
      fetchJson('/api/accounting/reports/profit-and-loss'),
      fetchJson('/api/accounting/reports/balance-sheet'),
      fetchJson('/api/accounting/reports/cash-flow'),
      fetchJson('/api/accounting/budgets'),
    ]);
    Object.assign(accountingState, {
      accounts, periods, journals, budgets,
      reports: { trialBalance, profitAndLoss, balanceSheet, cashFlow },
      error: '',
    });
    const selectedAccountId = accountingState.ledger?.account?.id || accounts[0]?.id;
    accountingState.ledger = selectedAccountId
      ? await fetchJson(`/api/accounting/ledger?accountId=${encodeURIComponent(selectedAccountId)}`)
      : null;
  } catch (error) {
    accountingState.error = error.message;
  }
}

async function loadSalesData() {
  try {
    const [customers, quotations, orders, deliveries, invoices, payments, receivables, warehouses, reports, audit, crm, disputes, customerInsights, priceLists, returnRequests, performance] = await Promise.all([
      fetchJson('/api/sales/customers'),
      fetchJson('/api/sales/quotations'),
      fetchJson('/api/sales/orders'),
      fetchJson('/api/sales/deliveries'),
      fetchJson('/api/sales/invoices'),
      fetchJson('/api/sales/payments'),
      fetchJson('/api/sales/receivables'),
      fetchJson('/api/sales/warehouses'),
      fetchJson('/api/sales/reports'),
      fetchJson('/api/sales/audit'),
      fetchJson('/api/sales/crm'),
      hasRolePermission('sales:receivables:read') ? fetchJson('/api/sales/disputes') : Promise.resolve([]),
      hasRolePermission('sales:customers:read') ? fetchJson('/api/sales/customer-insights') : Promise.resolve([]),
      hasRolePermission('sales:customers:read') ? fetchJson('/api/sales/price-lists') : Promise.resolve([]),
      hasRolePermission('sales:delivery:read') ? fetchJson('/api/sales/return-requests') : Promise.resolve([]),
      hasRolePermission('sales:reports:read') ? fetchJson(`/api/sales/performance?startDate=${encodeURIComponent(salesState.performanceStart)}&endDate=${encodeURIComponent(salesState.performanceEnd)}`) : Promise.resolve(null),
    ]);
    if (!Array.isArray(customerInsights) || !Array.isArray(priceLists)) {
      throw new Error('Sales customer analytics or price-list data has an invalid response shape.');
    }
    if (!Array.isArray(crm.records) || !Array.isArray(crm.activities)) {
      throw new Error('Sales CRM data has an invalid response shape.');
    }
    if (!Array.isArray(returnRequests) || (performance && !Array.isArray(performance.targetVsActual))) {
      throw new Error('Sales return or performance data has an invalid response shape.');
    }
    Object.assign(salesState, {
      customers, quotations, orders, deliveries, invoices, payments, receivables, warehouses, reports, audit,
      crmRecords: crm.records || [], activities: crm.activities || [], disputes, customerInsights, priceLists,
      returnRequests, performance, error: '',
    });
  } catch (error) {
    salesState.error = error.message;
  }
}

async function loadProcurementData() {
  procurementState.loading = true;
  try {
    const workspace = await fetchJson('/api/procurement/workspace');
    Object.assign(procurementState, {
      suppliers: workspace.suppliers || [],
      comparisons: workspace.comparisons || [],
      orders: workspace.orders || [],
      warehouses: workspace.warehouses || [],
      requisitions: workspace.requisitions || [],
      supplierInvoices: workspace.supplierInvoices || [],
      supplierDocuments: workspace.supplierDocuments || [],
      scorecards: workspace.scorecards || [],
      error: '',
    });
  } catch (error) {
    procurementState.error = error.message;
  } finally {
    procurementState.loading = false;
  }
}

async function handleProcurementSupplierSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = form.querySelector('.procurement-form-error');
  if (error) error.textContent = '';
  const payload = Object.fromEntries(new FormData(form).entries());
  try {
    await fetchJson('/api/procurement/suppliers', { method: 'POST', body: JSON.stringify(payload) });
    await loadProcurementData();
    render();
  } catch (requestError) {
    if (error) error.textContent = requestError.message;
  }
}

async function handleProcurementControlSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = form.querySelector('.procurement-form-error');
  if (error) error.textContent = '';
  const values = Object.fromEntries(new FormData(form).entries());
  const kind = form.dataset.procurementControl;
  const endpoints = {
    requisition: '/api/procurement/requisitions',
    supplierInvoice: '/api/procurement/supplier-invoices',
    supplierDocument: '/api/procurement/supplier-documents',
  };
  const payload = { ...values };
  for (const field of ['quantity', 'estimatedUnitCost', 'budgetLimit', 'invoiceQuantity', 'invoiceAmount']) {
    if (field in payload) payload[field] = Number(payload[field]);
  }
  try {
    await fetchJson(endpoints[kind], { method: 'POST', body: JSON.stringify(payload) });
    await loadProcurementData();
    render();
  } catch (requestError) {
    if (error) error.textContent = requestError.message;
  }
}

async function handleProcurementControlledAction(button) {
  const { action, id } = button.dataset;
  try {
    if (action === 'requisition-approve' || action === 'requisition-reject') {
      const reason = window.prompt('Reason for requisition decision:');
      if (!reason?.trim()) return;
      await fetchJson(`/api/procurement/requisitions/${encodeURIComponent(id)}/decision`, {
        method: 'POST',
        body: JSON.stringify({ decision: action === 'requisition-approve' ? 'APPROVED' : 'REJECTED', reason: reason.trim() }),
      });
    } else if (action === 'invoice-match') {
      await fetchJson(`/api/procurement/supplier-invoices/${encodeURIComponent(id)}/match`, { method: 'POST', body: '{}' });
    }
    await loadProcurementData();
    render();
  } catch (error) {
    procurementState.error = error.message;
    render();
  }
}

async function handleProcurementComparisonSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = form.querySelector('.procurement-form-error');
  if (error) error.textContent = '';
  const values = Object.fromEntries(new FormData(form).entries());
  const quotes = [...form.querySelectorAll('[data-quote-editor]')]
    .filter((editor) => editor.querySelector('[data-quote-include]').checked)
    .map((editor) => {
      const quote = { supplierId: editor.dataset.quoteEditor };
      editor.querySelectorAll('[data-quote-value]').forEach((input) => {
        quote[input.dataset.quoteValue] = input.value;
      });
      return quote;
    });
  const payload = { ...values, quantity: Number(values.quantity), quotes };
  try {
    await fetchJson('/api/procurement/comparisons', { method: 'POST', body: JSON.stringify(payload) });
    procurementState.tab = 'comparisons';
    await loadProcurementData();
    render();
  } catch (requestError) {
    if (error) error.textContent = requestError.message;
  }
}

function showProcurementActionDialog(action, id, quoteId = '') {
  const existing = document.getElementById('procurement-action-dialog');
  existing?.remove();
  const config = {
    select: { title: 'Select supplier quote', label: 'Reason for selection', button: 'Confirm selection', required: true },
    approve: { title: 'Approve purchase order', label: 'Approval note (optional)', button: 'Approve order', required: false },
    reject: { title: 'Reject purchase order', label: 'Rejection reason', button: 'Reject order', required: true },
  }[action];
  if (!config) return;
  const dialog = document.createElement('dialog');
  dialog.id = 'procurement-action-dialog';
  dialog.className = 'procurement-action-dialog';
  dialog.innerHTML = `<form class="procurement-dialog-form"><button class="procurement-dialog-close" type="button" aria-label="Close">×</button><p class="eyebrow">Purchase control</p><h2>${config.title}</h2><p>Record a clear reason in the supplier decision history.</p><label>${config.label}<textarea name="reason" rows="3" ${config.required ? 'required' : ''} placeholder="Add context for the audit trail"></textarea></label><div class="procurement-dialog-error" role="alert"></div><button class="primary-btn" type="submit">${config.button}</button></form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form');
  dialog.querySelector('.procurement-dialog-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = form.querySelector('.procurement-dialog-error');
    const reason = new FormData(form).get('reason')?.toString().trim() || '';
    let endpoint;
    let body = { reason };
    if (action === 'select') {
      endpoint = `/api/procurement/comparisons/${encodeURIComponent(id)}/select`;
      body.quoteId = quoteId;
    } else endpoint = `/api/procurement/orders/${encodeURIComponent(id)}/${action}`;
    try {
      await fetchJson(endpoint, { method: 'POST', body: JSON.stringify(body) });
      dialog.close();
      await loadProcurementData();
      render();
    } catch (requestError) {
      error.textContent = requestError.message;
    }
  });
  dialog.showModal();
}

async function handleProcurementReceiptSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form).entries());
  const button = form.querySelector('button[type="submit"]');
  const error = form.querySelector('.procurement-form-error');
  button.disabled = true;
  try {
    await fetchJson(`/api/procurement/orders/${encodeURIComponent(form.dataset.procurementReceive)}/receive`, {
      method: 'POST',
      body: JSON.stringify({
        quantity: Number(values.quantity),
        reason: values.reason,
        productSku: values.productSku,
        warehouseId: values.warehouseId,
        idempotencyKey: values.idempotencyKey,
      }),
    });
    await loadProcurementData();
    render();
  } catch (requestError) {
    if (error) error.textContent = requestError.message;
  } finally {
    button.disabled = false;
  }
}

async function loadHrData() {
  const canReviewAttendance = hasRolePermission('hr:attendance:review');
  const canReviewLeave = hasRolePermission('hr:leave:review');
  const canReadPayroll = hasRolePermission('hr:payroll:read');
  const canReadReports = hasRolePermission('hr:payroll:report');
  const canReadEmployeeDocuments = hasRolePermission('hr:employees:documents:read');
  const [employeesData, organization, attendance, leave, payroll, reports, employeeDocuments] = await Promise.all([
    fetchJson('/api/hr/employees'),
    fetchJson('/api/hr/organization'),
    canReviewAttendance ? fetchJson('/api/hr/attendance') : Promise.resolve([]),
    canReviewLeave ? fetchJson('/api/hr/leave') : Promise.resolve({ types: [], balances: [], requests: [] }),
    canReadPayroll ? fetchJson('/api/hr/payroll') : Promise.resolve({ periods: [], settings: {}, results: [], accountingEntries: [] }),
    canReadReports ? fetchJson('/api/hr/reports') : Promise.resolve({ employees: [], attendance: [], leave: [], payroll: [] }),
    canReadEmployeeDocuments ? fetchJson('/api/hr/employee-documents') : Promise.resolve([]),
  ]);
  hrState.workspace = organization;
  applicationData.attendanceRecords = attendance;
  applicationData.employees = employeesData.map((employee) => ({
    ...employee,
    name: hrEmployeeName(employee),
    department: hrDepartmentName(employee.departmentId),
    role: hrPositionName(employee.positionId),
    attendance: employee.attendance ?? 0,
  }));
  hrState.leave = leave;
  hrState.payroll = payroll;
  hrState.reports = reports;
  hrState.employeeDocuments = employeeDocuments;
  hrState.leaveCalendar = canReviewLeave
    ? await fetchJson(`/api/hr/leave/calendar?month=${encodeURIComponent(hrState.leaveMonth)}`)
    : [];
}

async function bootstrapAuth() {
  try {
    const data = await fetchJson('/api/session');
    authState.user = data.user;
  } catch {
    authState.user = null;
  }

  if (authState.user) {
    authState.loaded = true;
    authState.dataLoading = true;
    syncNavigationFromHash();
    await refreshApplicationData();
    return;
  }

  authState.loaded = true;
  render();
}

async function refreshApplicationData() {
  authState.dataLoading = true;
  authState.dataLoadError = '';
  render();
  try {
    await loadApplicationData();
  } catch (error) {
    authState.dataLoadError = error.message;
    console.error('Unable to load application data:', error);
  } finally {
    authState.dataLoading = false;
    render();
  }
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const username = new FormData(form).get('username')?.toString().trim() || '';
  const password = new FormData(form).get('password')?.toString() || '';

  const submitButton = form.querySelector('button[type="submit"]');
  const errorBox = form.querySelector('.login-error');

  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = 'Signing in...';
  }

  try {
    const response = await fetchJson('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });

    const session = await fetchJson('/api/session');
    if (!session.user) throw new Error('Unable to load the authenticated session.');
    if (authState.user?.id !== session.user.id) {
      assistantState.messages = [];
      assistantState.error = '';
      assistantState.open = false;
      projectsState.projects = [];
      projectsState.error = '';
    }
    authState.user = session.user;
    await loadApplicationData();
    syncNavigationFromHash();
    render();
  } catch (error) {
    if (errorBox) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
    }
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = 'Log in';
    }
  }
}

async function handleLogout() {
  try {
    await fetchJson('/api/logout', { method: 'POST' });
  } finally {
    authState.user = null;
    assistantState.messages = [];
    assistantState.error = '';
    assistantState.open = false;
    projectsState.projects = [];
    projectsState.error = '';
    render();
  }
}

function renderSales() {
  const tabs = [
    ['overview', 'Overview'], ['crm', 'CRM & activity'], ['customers', 'Customers'], ['pricing', 'Customer pricing'], ['quotations', 'Quotations'],
    ['orders', 'Sales orders'], ['deliveries', 'Delivery'], ['invoices', 'Invoices'],
    ['payments', 'Payments'], ['receivables', 'Receivables'], ['reports', 'Reports'], ['creditHolds', 'Credit holds'],
  ];
  const active = tabs.some(([key]) => key === salesState.tab) ? salesState.tab : 'overview';
  const field = (label, name, type = 'text', required = true, extra = '') => `<label>${label}<input name="${name}" type="${type}" ${required ? 'required' : ''} ${type === 'number' ? 'min="0" step="0.01"' : ''} ${type === 'tel' ? 'inputmode="tel" pattern="[+0-9(). -]{7,24}" maxlength="24" title="Use 7-15 digits; standard phone punctuation is allowed."' : ''} ${name === 'contactPerson' ? 'maxlength="100" data-input-rule="person" title="Use letters, spaces, apostrophes, periods, or hyphens."' : ''} ${extra} /></label>`;
  const customerOptions = salesState.customers.map((item) => `<option value="${item.id}">${escapeHtml(item.customer_code)} · ${escapeHtml(item.legal_name)}</option>`).join('');
  const orderOptions = salesState.orders.map((item) => `<option value="${item.id}">${escapeHtml(item.order_number)} · ${escapeHtml(item.customer_name)}</option>`).join('');
  const invoiceOptions = salesState.invoices.filter((item) => ['Issued', 'Overdue'].includes(item.status)).map((item) => `<option value="${item.id}">${escapeHtml(item.invoice_number)} · ${escapeHtml(item.customer_name)} · ${formatCurrency(Number(item.total))}</option>`).join('');
  const lineJson = '[{"productSku":"SKU-001","productName":"Product name","quantity":1,"unitPrice":0,"discountPercent":0,"taxPercent":0}]';
  const priceListLineJson = '[{"productSku":"SKU-001","unitPrice":0}]';
  const form = (type, title, contents, permission) => hasRolePermission(permission)
    ? `<details class="sales-form-disclosure"><summary>${title}</summary><form class="sales-form" data-sales-form="${type}">${contents}<div class="sales-form-actions"><button class="primary-btn" type="submit">Save</button><span class="sales-form-error" role="alert"></span></div></form></details>` : '';
  const action = (id, actionName, label, permission) => hasRolePermission(permission)
    ? `<button type="button" class="small-action" data-sales-action="${actionName}" data-sales-id="${id}">${label}</button>` : '';
  const table = (headers, rows, tableClass = '') => `<div class="table-wrap"><table class="sales-table ${tableClass}"><thead><tr>${headers.map((item) => `<th>${item}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}" class="empty-state">No records yet.</td></tr>`}</tbody></table></div>`;
  const customerInsightById = new Map(salesState.customerInsights.map((item) => [item.customer_id, item]));
  const priceListRows = salesState.priceLists.map((item) => `<tr><td>${escapeHtml(item.customer_name)}</td><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.currency)}</td><td>${escapeHtml(String(item.effective_from).slice(0, 10))} – ${item.effective_to ? escapeHtml(String(item.effective_to).slice(0, 10)) : 'Open-ended'}</td><td>${item.active ? 'Active' : 'Inactive'}</td><td>${(item.lines || []).map((line) => `${escapeHtml(line.productSku)}: ${formatCurrency(Number(line.unitPrice))}`).join('<br>')}</td><td>${action(item.id, item.active ? 'price-list-deactivate' : 'price-list-activate', item.active ? 'Deactivate' : 'Activate', 'sales:customers:manage')}</td></tr>`).join('');
  const customerRows = salesState.customers.map((item) => {
    const insight = customerInsightById.get(item.id) || {};
    const creditStatus = item.credit_hold
      ? `On hold${item.credit_hold_reason ? `: ${escapeHtml(item.credit_hold_reason)}` : ''}`
      : insight.overdue_warning
        ? `Overdue: ${formatCurrency(Number(insight.overdue_amount))}`
        : 'Clear';
    const holdAction = item.credit_hold
      ? action(item.id, 'credit-release', 'Release hold', 'sales:customers:manage')
      : action(item.id, 'credit-hold', 'Place hold', 'sales:customers:manage');
    return `<tr><td>${escapeHtml(item.customer_code)}</td><td>${escapeHtml(item.legal_name)}</td><td>${escapeHtml(item.contact_person || '')}</td><td>${escapeHtml(item.phone || '')}</td><td>${escapeHtml(item.email || '')}</td><td>${escapeHtml(insight.segment || 'PROSPECT')}</td><td>${Number(insight.purchase_count || 0)}</td><td>${formatCurrency(Number(insight.lifetime_value || 0))}</td><td>${insight.last_purchase_date ? escapeHtml(String(insight.last_purchase_date).slice(0, 10)) : '—'}</td><td>${formatCurrency(Number(insight.outstanding || 0))}</td><td>${formatCurrency(Number(item.credit_limit || 0))}</td><td>${item.active ? 'Active' : 'Inactive'}</td><td>${creditStatus}</td><td>${holdAction}</td></tr>`;
  }).join('');
  const quotationRows = salesState.quotations.map((item) => `<tr><td>${escapeHtml(item.quotation_number)} · R${Number(item.revision_number || 1)}</td><td>${escapeHtml(item.customer_name)}</td><td>${escapeHtml(item.validity_date?.slice?.(0, 10) || item.validity_date)}</td><td>${renderStatus(item.status)}</td><td>${formatCurrency(Number(item.total))}</td><td>${item.status === 'Draft' ? action(item.id, 'quote-submit', 'Submit', 'sales:quotations:manage') : ''}${item.status === 'Submitted' ? action(item.id, 'quote-approve', 'Approve', 'sales:quotations:approve') + action(item.id, 'quote-reject', 'Reject', 'sales:quotations:approve') : ''}${item.status === 'Approved' ? action(item.id, 'quote-convert', 'Create order', 'sales:orders:create') : ''}${item.status !== 'Converted' ? action(item.id, 'quote-revise', 'Create revision', 'sales:quotations:manage') : ''}</td></tr>`).join('');
  const orderFilters = [
    ['ALL', 'All orders'],
    ['Draft', 'Draft'],
    ['Submitted', 'Awaiting approval'],
    ['Approved', 'Approved'],
    ['Rejected', 'Rejected'],
    ['Cancelled', 'Cancelled'],
  ];
  const normalizedOrderFilter = orderFilters.some(([value]) => value === salesState.orderFilter) ? salesState.orderFilter : 'ALL';
  const matchingOrders = salesState.orders.filter((item) => {
    const search = salesState.orderSearch.trim().toLocaleLowerCase();
    const matchesSearch = !search
      || [item.order_number, item.customer_name].some((value) => String(value || '').toLocaleLowerCase().includes(search));
    const status = String(item.status || '');
    const matchesStatus = normalizedOrderFilter === 'ALL' || status === normalizedOrderFilter;
    return matchesSearch && matchesStatus;
  });
  const orderRows = matchingOrders.map((item) => {
    const workflow = [
      item.status === 'Draft' ? action(item.id, 'order-submit', 'Submit', 'sales:orders:create') : '',
      item.status === 'Submitted' ? action(item.id, 'order-approve', 'Approve', 'sales:orders:approve') + action(item.id, 'order-reject', 'Reject', 'sales:orders:approve') : '',
      item.status === 'Draft' ? action(item.id, 'order-amend', 'Amend', 'sales:orders:manage') : '',
      ['Draft', 'Submitted'].includes(item.status) ? action(item.id, 'order-cancel', 'Cancel', 'sales:orders:manage') : '',
    ].filter(Boolean).join('') || '—';
    return `<tr><td><strong>${escapeHtml(item.order_number)}</strong></td><td>${escapeHtml(item.customer_name)}</td><td>${escapeHtml(item.delivery_date?.slice?.(0, 10) || item.delivery_date || '—')}</td><td>${renderStatus(item.status)}</td><td>${renderStatus(item.approval_status)}</td><td>${formatCurrency(Number(item.total))}</td><td class="sales-order-actions">${workflow}</td></tr>`;
  }).join('');
  const orderEmptyState = salesState.orders.length
    ? 'No sales orders match these filters. Clear the filters to see all orders.'
    : 'No sales orders have been recorded yet. Create an order above to start the approval workflow.';
  const orderFilterButtons = orderFilters.map(([value, label]) => {
    const count = value === 'ALL'
      ? salesState.orders.length
      : salesState.orders.filter((item) => item.status === value).length;
    return `<button type="button" class="sales-order-filter ${normalizedOrderFilter === value ? 'active' : ''}" data-sales-order-filter="${value}" aria-pressed="${normalizedOrderFilter === value}">${label}<span>${count}</span></button>`;
  }).join('');
  const legacyRows = applicationData.salesOrders.map((item) => `<tr><td>${escapeHtml(item.id)}</td><td>${escapeHtml(item.customer)}</td><td>${escapeHtml(item.date)}</td><td>${renderStatus(item.status)}</td><td>${formatCurrency(item.amount)}</td><td>${recordActions('sales', item.id, item.customer)}</td></tr>`).join('');
  const deliveryRows = salesState.deliveries.map((item) => {
    const next = { Pending: ['Picking', 'Start picking'], Picking: ['Packed', 'Mark packed'], Packed: ['Shipped', 'Ship'], Shipped: ['Delivered', 'Confirm delivery'] }[item.status];
    const tracking = item.tracking_url
      ? `<a href="${escapeHtml(item.tracking_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.tracking_number || 'Track')}</a>`
      : escapeHtml(item.tracking_number || '—');
    const deliveryProof = item.proof_of_delivery_ref
      ? `${escapeHtml(item.recipient_name || 'Recipient')}: ${escapeHtml(item.proof_of_delivery_ref)}`
      : '—';
    const deliveryActions = [
      next ? action(item.id, `delivery-${next[0].toLowerCase()}`, next[1], 'sales:delivery:manage') : '',
      item.status === 'Delivered' ? action(item.id, 'return-request', 'Request return', 'sales:delivery:manage') : '',
    ].filter(Boolean).join('');
    return `<tr><td>${escapeHtml(item.delivery_number)}</td><td>${escapeHtml(item.order_number)}</td><td>${escapeHtml(item.customer_name)}</td><td>${escapeHtml(item.warehouse_id)}</td><td>${renderStatus(item.status)}</td><td>${tracking}</td><td>${deliveryProof}</td><td>${deliveryActions || '—'}</td></tr>`;
  }).join('');
  const returnRequestRows = salesState.returnRequests.map((item) => {
    const inspection = item.inspected_at
      ? `${new Date(item.inspected_at).toLocaleString()} · ${item.inspection_lines.map((line) => `${escapeHtml(line.restock_quantity)} restocked, ${escapeHtml(line.quarantine_quantity)} quarantined, ${escapeHtml(line.damaged_quantity)} damaged`).join('; ')}`
      : 'Pending receipt inspection';
    const actions = item.status === 'PENDING'
      ? action(item.id, 'return-approve', 'Approve return', 'sales:delivery:manage') + action(item.id, 'return-reject', 'Reject', 'sales:delivery:manage')
      : item.status === 'APPROVED' && !item.inspected_at
        ? action(item.id, 'return-inspect', 'Receive & inspect', 'sales:delivery:manage')
        : '—';
    return `<tr><td>${escapeHtml(item.delivery_number)}</td><td>${escapeHtml(item.customer_name)}</td><td>${escapeHtml(item.reason)}</td><td>${renderStatus(item.status)}</td><td>${escapeHtml(item.resolution || '—')}</td><td>${escapeHtml(inspection)}</td><td>${actions}</td></tr>`;
  }).join('');
  const invoiceRows = salesState.invoices.map((item) => `<tr><td>${escapeHtml(item.invoice_number)}</td><td>${escapeHtml(item.customer_name)}</td><td>${escapeHtml(item.invoice_date?.slice?.(0, 10) || item.invoice_date)}</td><td>${escapeHtml(item.due_date?.slice?.(0, 10) || item.due_date)}</td><td>${renderStatus(item.status)}</td><td>${formatCurrency(Number(item.total))}</td><td>${item.status === 'Draft' ? action(item.id, 'invoice-issue', 'Issue & post', 'sales:invoices:manage') : ''}</td></tr>`).join('');
  const paymentRows = salesState.payments.map((item) => `<tr><td>${escapeHtml(item.receipt_number || item.payment_number)}</td><td>${escapeHtml(item.invoice_number)}</td><td>${escapeHtml(item.customer_name)}</td><td>${escapeHtml(item.payment_method)}</td><td>${escapeHtml(item.payment_date?.slice?.(0, 10) || item.payment_date)}</td><td>${formatCurrency(Number(item.amount))}</td><td>${escapeHtml(item.reference_number || '')}</td></tr>`).join('');
  const receivableRows = salesState.receivables.map((item) => `<tr><td>${escapeHtml(item.invoice_number)}</td><td>${escapeHtml(item.customer_name)}</td><td>${escapeHtml(item.due_date?.slice?.(0, 10) || item.due_date)}</td><td>${formatCurrency(Number(item.invoice_total))}</td><td>${formatCurrency(Number(item.payment_received))}</td><td>${formatCurrency(Number(item.outstanding))}</td><td>${escapeHtml(item.aging_bucket)}</td><td>${escapeHtml(item.current_status)}</td></tr>`).join('');
  const creditHistoryRows = salesState.audit
    .filter((item) => item.entity_type === 'customer' && ['customer_credit_hold_placed', 'customer_credit_hold_released'].includes(item.action))
    .map((item) => `<tr><td>${escapeHtml(item.created_at)}</td><td>${escapeHtml(item.action === 'customer_credit_hold_placed' ? 'Hold placed' : 'Hold released')}</td><td>${escapeHtml(salesState.customers.find((customer) => customer.id === item.entity_id)?.legal_name || item.entity_id)}</td><td>${escapeHtml(item.changes?.reason || '')}</td><td>${escapeHtml(item.user_id || '')}</td></tr>`).join('');
  const creditHoldCount = salesState.customers.filter((customer) => customer.credit_hold).length;
  const crmStages = ['NEW', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST'];
  const crmRows = salesState.crmRecords.map((item) => {
    const stage = hasRolePermission('sales:customers:manage')
      ? `<select aria-label="Update ${escapeHtml(item.name)} pipeline stage" data-crm-stage="${escapeHtml(item.id)}">${crmStages.map((value) => `<option value="${value}" ${value === item.stage ? 'selected' : ''}>${value}</option>`).join('')}</select>`
      : escapeHtml(item.stage);
    return `<tr><td>${escapeHtml(item.record_type)}</td><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.customer_name || item.contact_name || '—')}</td><td>${stage}</td><td>${formatCurrency(Number(item.estimated_value || 0))}</td><td>${item.expected_close_date ? escapeHtml(String(item.expected_close_date).slice(0, 10)) : '—'}</td></tr>`;
  }).join('');
  const activityRows = salesState.activities.map((item) => `<tr><td>${escapeHtml(String(item.activity_date).slice(0, 16).replace('T', ' '))}</td><td>${escapeHtml(item.customer_name || item.crm_record_name || '—')}</td><td>${escapeHtml(item.activity_type)}</td><td>${escapeHtml(item.subject)}</td><td>${escapeHtml(item.details || '')}</td><td>${item.next_follow_up ? escapeHtml(String(item.next_follow_up).slice(0, 10)) : '—'}</td></tr>`).join('');
  const todayKey = new Date().toISOString().slice(0, 10);
  const upcomingFollowUps = salesState.activities
    .filter((activity) => activity.next_follow_up && String(activity.next_follow_up).slice(0, 10) <= todayKey)
    .slice(0, 5);
  const followUpSuggestions = upcomingFollowUps.length
    ? `<ul>${upcomingFollowUps.map((activity) => `<li>Follow up with ${escapeHtml(activity.customer_name || activity.crm_record_name || 'the prospect')} about “${escapeHtml(activity.subject)}”.</li>`).join('')}</ul>`
    : '<p>No follow-ups are due today. Keep the pipeline current by logging the next customer touchpoint.</p>';
  const disputeRows = salesState.disputes.map((item) => `<tr><td>${escapeHtml(item.invoice_number)}</td><td>${escapeHtml(item.customer_name)}</td><td>${formatCurrency(Number(item.outstanding))}</td><td>${escapeHtml(item.reason)}</td><td>${renderStatus(item.status)}</td><td>${escapeHtml(item.resolution || '')}</td><td>${item.status === 'OPEN' ? action(item.id, 'dispute-review', 'Review', 'sales:customers:manage') + action(item.id, 'dispute-resolve', 'Resolve', 'sales:customers:manage') : ''}</td></tr>`).join('');
  const creditHoldRows = salesState.customers.map((customer) => {
    const status = customer.credit_hold
      ? `<span class="credit-hold-status held">On hold</span>`
      : `<span class="credit-hold-status clear">Clear</span>`;
    const reason = customer.credit_hold_reason
      ? escapeHtml(customer.credit_hold_reason)
      : '—';
    const holdAction = customer.credit_hold
      ? action(customer.id, 'credit-release', 'Release hold', 'sales:customers:manage')
      : action(customer.id, 'credit-hold', 'Place hold', 'sales:customers:manage');
    return `<tr><td>${escapeHtml(customer.customer_code)}</td><td>${escapeHtml(customer.legal_name)}</td><td>${status}</td><td>${reason}</td><td>${formatCurrency(Number(customer.credit_limit || 0))}</td><td>${holdAction}</td></tr>`;
  }).join('');
  const reports = salesState.reports || {};
  const performance = salesState.performance || {};
  const salespersonOptions = (performance.salespeople || [])
    .map((person) => `<option value="${escapeHtml(person.id)}">${escapeHtml(person.display_name)}</option>`).join('');
  const performanceRows = (performance.targetVsActual || []).map((item) => `<tr><td>${escapeHtml(item.salesperson_name || 'Unassigned')}</td><td>${escapeHtml(String(item.target_month).slice(0, 7))}</td><td>${formatCurrency(Number(item.target_amount || 0))}</td><td>${formatCurrency(Number(item.actual_amount || 0))}</td><td>${Number(item.target_amount) > 0 ? `${(Number(item.actual_amount) / Number(item.target_amount) * 100).toFixed(1)}%` : '—'}</td></tr>`).join('');
  const commissionRows = (performance.commissions || []).map((item) => `<tr><td>${escapeHtml(item.salesperson_name)}</td><td>${formatCurrency(Number(item.eligible_sales))}</td><td>${Number(item.rate_percent).toFixed(2)}%</td><td>${formatCurrency(Number(item.estimated_commission))}</td></tr>`).join('');
  const reportRows = (rows, firstField) => (rows || []).map((item) => `<tr><td>${escapeHtml(item[firstField] || 'Unassigned')}</td><td>${formatCurrency(Number(item.sales || 0))}</td></tr>`).join('');
  const contents = {
    overview: `<div class="sales-summary"><div><span>Customers</span><strong>${salesState.customers.length}</strong></div><div><span>Customers on credit hold</span><strong>${creditHoldCount}</strong></div><div><span>Quotations</span><strong>${salesState.quotations.length}</strong></div><div><span>Open orders</span><strong>${salesState.orders.filter((item) => !['Rejected', 'Cancelled'].includes(item.status)).length}</strong></div><div><span>Receivables</span><strong>${formatCurrency(Number(reports.receivables?.receivables || 0))}</strong></div></div><h3>Existing sales orders</h3>${table(['Order', 'Customer', 'Date', 'Status', 'Amount', 'Actions'], legacyRows)}`,
    crm: `${form('crm', 'Add lead or opportunity', `<label>Record type<select name="recordType"><option value="LEAD">Lead</option><option value="OPPORTUNITY">Opportunity</option></select></label>${field('Name / opportunity', 'name')}${field('Contact name', 'contactName', 'text', false)}<label>Existing customer<select name="customerId"><option value="">Not linked yet</option>${customerOptions}</select></label>${field('Email', 'email', 'email', false)}${field('Phone', 'phone', 'tel', false)}${field('Source', 'source', 'text', false)}<label>Stage<select name="stage"><option value="NEW">New</option><option value="QUALIFIED">Qualified</option><option value="PROPOSAL">Proposal</option><option value="NEGOTIATION">Negotiation</option></select></label>${field('Estimated value', 'estimatedValue', 'number', false)}${field('Expected close', 'expectedCloseDate', 'date', false)}${field('Notes', 'notes', 'text', false)}`, 'sales:customers:manage')}${form('activity', 'Log customer activity', `<label>Customer<select name="customerId"><option value="">Use lead/opportunity instead</option>${customerOptions}</select></label><label>Lead / opportunity<select name="crmRecordId"><option value="">Select if no customer</option>${salesState.crmRecords.map((record) => `<option value="${record.id}">${escapeHtml(record.record_type)} · ${escapeHtml(record.name)}</option>`).join('')}</select></label><label>Activity type<select name="activityType"><option value="CALL">Call</option><option value="EMAIL">Email</option><option value="MEETING">Meeting</option><option value="NOTE">Note</option><option value="FOLLOW_UP">Follow-up</option></select></label>${field('Subject', 'subject')}${field('Details', 'details', 'text', false)}${field('Next follow-up', 'nextFollowUp', 'date', false)}`, 'sales:customers:manage')}<h3>Leads and opportunities</h3>${table(['Type','Name','Customer / contact','Stage','Estimated value','Expected close'],crmRows)}<section class="sales-follow-up-suggestions"><p class="eyebrow">Rule-based follow-up suggestions from your activity log</p>${followUpSuggestions}</section><h3>Customer activity timeline</h3>${table(['Date','Customer / lead','Type','Subject','Details','Follow-up'],activityRows)}`,
    customers: `${form('customer', 'Add customer', `${field('Customer code', 'customerCode')}${field('Legal name', 'legalName')}${field('Contact person', 'contactPerson')}${field('Phone', 'phone', 'tel', false)}${field('Email', 'email', 'email', false)}${field('Tax ID', 'taxId', 'text', false)}${field('Credit limit', 'creditLimit', 'number', false)}${field('Payment terms', 'paymentTerms', 'text', false, 'value="30 days"')}${field('Currency', 'currency', 'text', false, 'value="ETB"')}${field('Billing address', 'billingAddress', 'text', false)}${field('Shipping address', 'shippingAddress', 'text', false)}${field('Delivery address', 'deliveryAddress', 'text', false)}`, 'sales:customers:create')}<p class="subtle">Customer segmentation, purchase count, lifetime billed value, last purchase, and overdue balances use posted invoice and receivable data.</p><h3>Customer register and profiles</h3>${table(['Code', 'Legal name', 'Contact', 'Phone', 'Email', 'Segment', 'Purchases', 'Lifetime value', 'Last purchase', 'Outstanding', 'Credit limit', 'Status', 'Credit status', 'Actions'], customerRows)}`,
    pricing: `${form('price-list', 'Create customer price list', `<label>Customer<select name="customerId" required>${customerOptions}</select></label>${field('Price list name', 'name')}${field('Currency', 'currency', 'text', false, 'value="ETB"')}${field('Effective from', 'effectiveFrom', 'date', false)}${field('Effective to', 'effectiveTo', 'date', false)}<label>Product prices (JSON)<textarea name="lines" rows="5" required>${escapeHtml(priceListLineJson)}</textarea></label>`, 'sales:customers:manage')}<p class="subtle">Seller-entered unit prices must match the active customer price list or the product catalogue. Price overrides are limited to users with sales order or quotation management permission.</p><h3>Customer price lists</h3>${table(['Customer', 'Price list', 'Currency', 'Effective', 'Status', 'Product prices', 'Actions'], priceListRows)}`,
    quotations: `${form('quotation', 'New quotation', `<label>Customer<select name="customerId" required>${customerOptions}</select></label>${field('Valid through', 'validityDate', 'date')}${field('Discount %', 'discountPercent', 'number', false)}<label>Product lines (JSON)<textarea name="lines" rows="5" required>${escapeHtml(lineJson)}</textarea></label>${field('Terms', 'terms', 'text', false)}`, 'sales:quotations:create')}<h3>Quotation pipeline</h3>${table(['Quotation / revision', 'Customer', 'Valid through', 'Status', 'Total', 'Workflow'], quotationRows)}`,
    orders: `${form('order', 'Create sales order', `<input type="hidden" name="idempotencyKey" value="${crypto.randomUUID()}" /><label>Customer<select name="customerId" required>${customerOptions}</select></label>${field('Delivery date', 'deliveryDate', 'date', false)}${field('Payment terms', 'paymentTerms', 'text', false)}${field('Discount %', 'discountPercent', 'number', false)}<label>Product lines (JSON)<textarea name="lines" rows="5" required>${escapeHtml(lineJson)}</textarea></label>`, 'sales:orders:create')}<div class="sales-order-list-header"><div><h3>Sales order register</h3><p>Approved orders remain in this list alongside drafts and orders awaiting review. Duplicate submit retries with the same request key return the original order.</p></div><button type="button" class="secondary-btn" data-sales-orders-refresh>Refresh list</button></div><div class="sales-order-tools"><div class="sales-order-filters" role="group" aria-label="Filter sales orders by status">${orderFilterButtons}</div><form class="sales-order-search" data-sales-order-search-form><label for="sales-order-search">Search orders</label><div><input id="sales-order-search" name="search" type="search" placeholder="Order number or customer" value="${escapeHtml(salesState.orderSearch)}" /><button type="submit" class="small-action">Search</button><button type="button" class="small-action" data-sales-order-clear>Clear</button></div></form></div>${table(['Order', 'Customer', 'Delivery date', 'Status', 'Approval', 'Total', 'Workflow'], orderRows || `<tr><td colspan="7" class="empty-state">${orderEmptyState}</td></tr>`, 'sales-order-register')}`,
    deliveries: `${form('delivery', 'Create delivery note', `<label>Approved order<select name="orderId" required>${orderOptions}</select></label><label>Warehouse<select name="warehouseId" required>${salesState.warehouses.map((item) => `<option value="${item.id}">${escapeHtml(item.code)} · ${escapeHtml(item.name)}</option>`).join('')}</select></label>${field('Delivery date', 'deliveryDate', 'date', false)}${field('Carrier', 'carrier', 'text', false)}${field('Tracking number', 'trackingNumber', 'text', false)}`, 'sales:delivery:create')}<h3>Picking, packing and shipment</h3>${table(['Delivery note', 'Order', 'Customer', 'Warehouse', 'Status', 'Tracking', 'Proof of delivery', 'Actions'], deliveryRows)}<p class="subtle">Return authorization does not change stock. Approved returns must be physically received and inspected before restockable goods enter available inventory; quarantined and damaged goods remain unavailable.</p><h3>Return requests</h3>${table(['Delivery', 'Customer', 'Reason', 'Status', 'Resolution', 'Inspection', 'Actions'], returnRequestRows)}`,
    invoices: `${form('invoice', 'Create customer invoice', `<label>Approved order<select name="orderId" required>${orderOptions}</select></label>${field('Invoice date', 'invoiceDate', 'date', false)}${field('Due date', 'dueDate', 'date')}`, 'sales:invoices:create')}<h3>Customer invoices</h3>${table(['Invoice', 'Customer', 'Invoice date', 'Due date', 'Status', 'Total', 'Posting'], invoiceRows)}`,
    payments: `${form('payment', 'Record customer payment', `<label>Issued invoice<select name="invoiceId" required>${invoiceOptions}</select></label><label>Method<select name="paymentMethod" required><option value="cash">Cash</option><option value="bank">Bank</option><option value="transfer">Transfer</option><option value="cheque">Cheque</option><option value="other">Other</option></select></label>${field('Amount', 'amount', 'number')}${field('Payment date', 'paymentDate', 'date', false)}${field('Reference / cheque number', 'referenceNumber', 'text', false)}`, 'sales:payments:create')}<h3>Receipts</h3>${table(['Receipt', 'Invoice', 'Customer', 'Method', 'Date', 'Amount', 'Reference'], paymentRows)}`,
    receivables: `<h3>Accounts receivable aging</h3>${table(['Invoice', 'Customer', 'Due date', 'Invoice total', 'Paid', 'Outstanding', 'Aging', 'Status'], receivableRows)}${form('dispute', 'Open receivable dispute', `<label>Open receivable<select name="receivableId" required>${salesState.receivables.filter((item) => Number(item.outstanding) > 0).map((item) => `<option value="${item.id}">${escapeHtml(item.invoice_number)} · ${escapeHtml(item.customer_name)} · ${formatCurrency(Number(item.outstanding))}</option>`).join('')}</select></label>${field('Reason', 'reason')}`, 'sales:customers:manage')}<h3>Dispute management</h3>${table(['Invoice','Customer','Outstanding','Reason','Status','Resolution','Action'],disputeRows)}`,
    creditHolds: `<p>Orders are blocked when a customer is on hold or the order would exceed the approved credit limit.</p><h3>Customer credit status</h3>${table(['Code', 'Customer', 'Credit status', 'Reason', 'Approved limit', 'Actions'], creditHoldRows)}<h3>Credit hold history</h3>${table(['Date', 'Action', 'Customer', 'Reason', 'Authorized by'], creditHistoryRows)}`,
    creditHistory: `<h3>Customer credit hold history</h3>${table(['Date', 'Action', 'Customer', 'Reason', 'Authorized by'], creditHistoryRows)}`,
    reports: `<div class="sales-summary"><div><span>Gross sales</span><strong>${formatCurrency(Number(reports.summary?.gross_sales || 0))}</strong></div><div><span>Discounts</span><strong>${formatCurrency(Number(reports.summary?.discounts || 0))}</strong></div><div><span>VAT</span><strong>${formatCurrency(Number(reports.summary?.vat || 0))}</strong></div><div><span>Net sales</span><strong>${formatCurrency(Number(reports.summary?.net_sales || 0))}</strong></div><div><span>Next-month statistical estimate</span><strong>${formatCurrency(Number(performance.forecast?.nextMonthNetSales || 0))}</strong></div></div><div class="sales-report-grid"><section><h3>By customer</h3>${table(['Customer', 'Sales'], reportRows(reports.byCustomer, 'legal_name'))}</section><section><h3>By product</h3>${table(['Product', 'Sales'], reportRows(reports.byProduct, 'product_name'))}</section><section><h3>By salesperson</h3>${table(['Salesperson', 'Sales'], reportRows(reports.bySalesperson, 'salesperson'))}</section><section><h3>By period</h3>${table(['Period', 'Sales'], reportRows(reports.byPeriod, 'period'))}</section></div><form class="sales-performance-range" data-sales-performance-range><label>From<input name="startDate" type="date" value="${escapeHtml(salesState.performanceStart)}" required /></label><label>Through<input name="endDate" type="date" value="${escapeHtml(salesState.performanceEnd)}" required /></label><button class="small-action" type="submit">Update performance period</button></form><h3>Target versus actual</h3>${table(['Salesperson', 'Month', 'Target', 'Actual net sales', 'Attainment'], performanceRows)}${form('commission-rule', 'Add commission rule', `<label>Salesperson<select name="salespersonId" required>${salespersonOptions}</select></label>${field('Commission rate %', 'ratePercent', 'number')}${field('Effective from', 'effectiveFrom', 'date', false)}${field('Effective through', 'effectiveTo', 'date', false)}`, 'sales:customers:manage')}${form('sales-target', 'Set monthly sales target', `<label>Salesperson<select name="salespersonId" required>${salespersonOptions}</select></label>${field('Target month', 'targetMonth', 'month')}${field('Target amount', 'targetAmount', 'number')}`, 'sales:customers:manage')}<h3>Estimated commissions</h3><p class="subtle">Estimate uses posted net invoice sales and effective commission rules. It is a report, not a payroll or accounting posting.</p>${table(['Salesperson', 'Eligible net sales', 'Rate', 'Estimated commission'], commissionRows)}`,
  };
  return `<section class="content-panel sales-workspace"><div class="panel-header"><div><p class="eyebrow">Sales process</p><h2>Customer to cash</h2></div></div>${salesState.error ? `<p class="sales-error" role="alert">${escapeHtml(salesState.error)}</p>` : ''}<nav class="sales-tabs" aria-label="Sales sections">${tabs.map(([key, label]) => `<button type="button" data-sales-tab="${key}" class="${active === key ? 'active' : ''}">${label}</button>`).join('')}</nav><div class="sales-content">${contents[active]}</div></section>`;
}

function renderInventory() {
  const alerts = getInventoryAlerts(applicationData.inventoryItems);
  const receiveAction = hasRolePermission(actionPermissions.inventory)
    ? `<button class="primary-btn" type="button" data-action-form="inventory">Receive stock</button>`
    : '';
  const activeTab = ['transfers', 'counts', 'traceability'].includes(inventoryTransferState.tab)
    ? inventoryTransferState.tab : 'overview';
  const pendingTransferCount = inventoryTransferState.transfers.filter((transfer) => transfer.status === 'REQUESTED').length;
  const inventoryOverview = `
    ${hasRolePermission('inventory:reports:view') ? `
      <div class="inventory-transfer-summary">
        <div>
          <p class="eyebrow">Inventory movement control</p>
          <strong>Stock transfer approvals</strong>
          <span>${inventoryTransferState.transfers.length} total · ${pendingTransferCount} awaiting review</span>
        </div>
        <button class="primary-btn" type="button" data-inventory-tab="transfers">View transfer history</button>
      </div>` : ''}
    <div class="grid two-column">
      ${applicationData.inventoryItems
        .map((item) => `
          <div class="metric-card compact-card">
            <div class="metric-header">
              <h3>${escapeHtml(item.name)}</h3>
              <span class="pill neutral">${escapeHtml(item.sku)}</span>
            </div>
            <div class="metric-row"><span>On hand</span><strong>${item.stock}</strong></div>
            <div class="metric-row"><span>Reorder level</span><strong>${item.reorderLevel}</strong></div>
            <div class="progress-bar">
              <span style="width: ${Math.min((item.stock / item.reorderLevel) * 100, 100)}%"></span>
            </div>
            <div class="metric-row meta-row">
              <span>${escapeHtml(item.location)}</span>
              <span>${formatCurrency(item.unitPrice)}/unit</span>
            </div>
            ${recordActions('inventory', item.sku, item.name)}
          </div>
        `).join('')}
    </div>
    <div class="mini-panel inventory-alerts">
      <h3>Stock alerts</h3>
      <ul class="kpi-list">${alerts.map((item) => `<li><span>${escapeHtml(item.name)}</span><strong>${item.risk}%</strong></li>`).join('')}</ul>
    </div>`;
  const transferTable = (headers, rows) => `<div class="table-wrap inventory-transfer-table-wrap"><table class="inventory-transfer-table"><thead><tr>${headers.map((header) => `<th>${header}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}" class="empty-state"><strong>${inventoryTransferState.transfers.length ? 'No transfers match this status.' : 'No stock transfer requests yet.'}</strong><span>${inventoryTransferState.transfers.length ? 'Choose another status or show all transfers.' : 'Request a transfer below when tracked stock is available. Approve and Reject actions appear on each request while its status is REQUESTED.'}</span>${inventoryTransferState.transfers.length && inventoryTransferState.statusFilter !== 'ALL' ? '<button type="button" class="small-action" data-transfer-filter="ALL">Show all transfers</button>' : ''}</td></tr>`}</tbody></table></div>`;
  const locationOptions = (warehouseId) => inventoryTransferState.locations
    .filter((location) => location.warehouse_id === warehouseId)
    .map((location) => `<option value="${location.id}">${escapeHtml(location.code)} · ${escapeHtml(location.name)}${location.bin_code ? ` (${escapeHtml(location.bin_code)})` : ''}</option>`)
    .join('');
  const statusFilters = {
    ALL: () => true,
    REQUESTED: (transfer) => transfer.status === 'REQUESTED',
    APPROVED: (transfer) => transfer.status === 'APPROVED',
    REJECTED: (transfer) => transfer.status === 'REJECTED',
    DISPATCHED: (transfer) => transfer.status === 'DISPATCHED',
    RECEIVED: (transfer) => ['RECEIVED', 'COMPLETED'].includes(transfer.status),
  };
  const transferRows = inventoryTransferState.transfers
    .filter(statusFilters[inventoryTransferState.statusFilter] || statusFilters.ALL)
    .map((transfer) => {
    const actions = [
      transfer.status === 'REQUESTED' && hasRolePermission('inventory:transfers:approve')
        ? `<button type="button" class="small-action" data-transfer-action="approve" data-transfer-id="${transfer.id}" data-transfer-quantity="${transfer.requested_quantity}">Approve</button><button type="button" class="small-action danger-btn" data-transfer-action="reject" data-transfer-id="${transfer.id}">Reject</button>` : '',
      transfer.status === 'APPROVED' && hasRolePermission('inventory:transfers:approve')
        ? `<button type="button" class="small-action" data-transfer-action="dispatch" data-transfer-id="${transfer.id}">Dispatch</button>` : '',
      transfer.status === 'DISPATCHED' && hasRolePermission('inventory:transfers:approve')
        ? `<button type="button" class="small-action" data-transfer-action="receive" data-transfer-id="${transfer.id}">Receive</button>` : '',
      transfer.status === 'RECEIVED' && hasRolePermission('inventory:transfers:approve')
        ? `<button type="button" class="small-action" data-transfer-action="complete" data-transfer-id="${transfer.id}">Complete</button>` : '',
    ].join('');
    const events = transfer.history || [];
    const history = events.map((event) => {
      const eventLabel = {
        REQUESTED: 'Requested',
        APPROVED: 'Approved',
        REJECTED: 'Rejected',
        DISPATCHED: 'Dispatched',
        RECEIVED: 'Received',
        COMPLETED: 'Completed',
        CANCELLED: 'Cancelled',
      }[event.eventType] || event.eventType;
      const timestamp = event.occurredAt ? new Date(event.occurredAt).toLocaleString() : 'Time unavailable';
      return `<li><strong class="transfer-history-event">${escapeHtml(eventLabel)}</strong>
        <span>By ${escapeHtml(event.actorName || 'Former user')} · ${escapeHtml(timestamp)}</span>
        ${event.reason ? `<small>Reason: ${escapeHtml(event.reason)}</small>` : ''}
      </li>`;
      }).join('');
    return `<tr>
      <td><strong>${escapeHtml(transfer.product_sku)}</strong><small>${escapeHtml(transfer.product_name)}</small></td>
      <td><span class="transfer-route"><strong>${escapeHtml(transfer.source_warehouse_name)}</strong><small>${escapeHtml(transfer.source_warehouse_code)}</small>${transfer.source_location_name ? `<small>From bin: ${escapeHtml(transfer.source_location_name)}${transfer.source_bin_code ? ` · ${escapeHtml(transfer.source_bin_code)}` : ''}</small>` : ''}</span><span aria-hidden="true"> → </span><span class="transfer-route"><strong>${escapeHtml(transfer.destination_warehouse_name)}</strong><small>${escapeHtml(transfer.destination_warehouse_code)}</small>${transfer.destination_location_name ? `<small>To bin: ${escapeHtml(transfer.destination_location_name)}${transfer.destination_bin_code ? ` · ${escapeHtml(transfer.destination_bin_code)}` : ''}</small>` : ''}</span></td>
      <td>${Number(transfer.requested_quantity)}${transfer.unit_of_measure_code ? ` ${escapeHtml(transfer.unit_of_measure_code)}` : ''}</td>
      <td>${escapeHtml(transfer.requester_name || 'Former user')}</td>
      <td><span class="transfer-status ${escapeHtml(transfer.status.toLowerCase())}">${escapeHtml(transfer.status)}</span></td>
      <td>${escapeHtml(transfer.reason || '—')}</td>
      <td><div class="transfer-history">
        ${events.length ? `<strong>Latest: ${escapeHtml(events[events.length - 1].eventType)}</strong><span>By ${escapeHtml(events[events.length - 1].actorName || 'Former user')} · ${escapeHtml(events[events.length - 1].occurredAt ? new Date(events[events.length - 1].occurredAt).toLocaleString() : 'Time unavailable')}</span>${events[events.length - 1].reason ? `<small>Reason: ${escapeHtml(events[events.length - 1].reason)}</small>` : ''}` : '<span>No history recorded</span>'}
        <details><summary>Full history (${events.length} actions)</summary><ol>${history || '<li>No history available.</li>'}</ol></details>
      </div></td>
      <td class="transfer-actions">${actions || '—'}</td>
    </tr>`;
  }).join('');
  const transferForm = hasRolePermission('inventory:stock:update')
    ? `<form class="inventory-transfer-form" data-inventory-transfer-form>
        <label>Product<select name="productId" required ${inventoryTransferState.products.length ? '' : 'disabled'}><option value="">${inventoryTransferState.products.length ? 'Select a product' : 'No tracked products yet'}</option>${inventoryTransferState.products.map((item) => `<option value="${item.id}">${escapeHtml(item.sku)} · ${escapeHtml(item.name)}</option>`).join('')}</select></label>
        <label>From warehouse<select name="sourceWarehouseId" data-transfer-warehouse="source" required ${inventoryTransferState.warehouses.length ? '' : 'disabled'}><option value="">${inventoryTransferState.warehouses.length ? 'Select source warehouse' : 'No warehouses yet'}</option>${inventoryTransferState.warehouses.map((item) => `<option value="${item.id}">${escapeHtml(item.code)} · ${escapeHtml(item.name)}</option>`).join('')}</select></label>
        <label>From location / bin<select name="sourceLocationId" data-transfer-location="source"><option value="">No specific source location</option></select></label>
        <label>To warehouse<select name="destinationWarehouseId" data-transfer-warehouse="destination" required ${inventoryTransferState.warehouses.length ? '' : 'disabled'}><option value="">${inventoryTransferState.warehouses.length ? 'Select destination warehouse' : 'No warehouses yet'}</option>${inventoryTransferState.warehouses.map((item) => `<option value="${item.id}">${escapeHtml(item.code)} · ${escapeHtml(item.name)}</option>`).join('')}</select></label>
        <label>To location / bin<select name="destinationLocationId" data-transfer-location="destination"><option value="">No specific destination location</option></select></label>
        <label>Quantity<input name="requestedQuantity" type="number" min="0.000001" step="0.000001" required /></label>
        <label class="transfer-reason-field">Request reason<input name="reason" required /></label>
        <button class="primary-btn" type="submit" ${inventoryTransferState.products.length && inventoryTransferState.warehouses.length > 1 ? '' : 'disabled'}>Request transfer</button><span class="inventory-transfer-error" role="alert"></span>
      </form>` : '';
  const canSetupProducts = hasRolePermission('inventory:products:manage');
  const canSetupWarehouses = hasRolePermission('inventory:warehouses:manage');
  const canSetupStock = hasRolePermission('inventory:stock:update');
  const needsTrackedProduct = !inventoryTransferState.products.length;
  const needsDestinationWarehouse = inventoryTransferState.warehouses.length < 2;
  const nextSetupStep = needsTrackedProduct ? 1 : needsDestinationWarehouse ? 2 : 3;
  const setupForms = canSetupProducts || canSetupWarehouses || canSetupStock
    ? `<section class="inventory-transfer-setup">
        <div class="transfer-setup-heading"><div><p class="eyebrow">Quick setup</p><h4>${nextSetupStep < 3 ? `Step ${nextSetupStep} of 2: ${needsTrackedProduct ? 'Add a tracked product' : 'Add a destination warehouse'}` : 'Ready to request a transfer'}</h4></div><span>${inventoryTransferState.products.length ? 'Product ready' : 'Product needed'} · ${inventoryTransferState.warehouses.length >= 2 ? 'Warehouses ready' : '2 warehouses needed'}</span></div>
        ${needsTrackedProduct && canSetupProducts ? `<form class="transfer-setup-form" data-inventory-setup="product">
          <label>Product name<input name="name" required placeholder="e.g. Industrial Motor" /></label>
          <label>SKU<input name="sku" required placeholder="e.g. MT-100" /></label>
          <label>Unit<select name="unitOfMeasureId" required ${inventoryTransferState.uoms.length ? '' : 'disabled'}>${inventoryTransferState.uoms.map((uom, index) => `<option value="${uom.id}" ${index === 0 ? 'selected' : ''}>${escapeHtml(uom.code)} · ${escapeHtml(uom.name)}</option>`).join('')}${inventoryTransferState.uoms.length ? '' : '<option value="">Add a unit in advanced setup first</option>'}</select></label>
          <button class="primary-btn" type="submit" ${inventoryTransferState.uoms.length ? '' : 'disabled'}>Save product and continue</button><span class="inventory-transfer-error" role="alert"></span>
        </form>` : needsTrackedProduct ? '<p class="inventory-transfer-message">Ask an inventory administrator to add a tracked product before requesting transfers.</p>' : ''}
        ${!needsTrackedProduct && needsDestinationWarehouse && canSetupWarehouses ? `<form class="transfer-setup-form" data-inventory-setup="warehouse"><label>Warehouse name<input name="name" required placeholder="e.g. East Depot" /></label><label>Warehouse code<input name="code" required placeholder="e.g. WH-02" /></label><button class="primary-btn" type="submit">Save warehouse and continue</button><span class="inventory-transfer-error" role="alert"></span></form>` : ''}
        ${!needsTrackedProduct && !needsDestinationWarehouse && canSetupStock ? `<div class="transfer-setup-stock"><p>If source stock is not recorded yet, enter it here. Already have stock in the source warehouse? You can skip this and submit a transfer request.</p>
          <form class="transfer-setup-form" data-inventory-stock-receipt>
            <label>Product<select name="productId" required>${inventoryTransferState.products.map((item, index) => `<option value="${item.id}" ${index === 0 ? 'selected' : ''}>${escapeHtml(item.sku)} · ${escapeHtml(item.name)}</option>`).join('')}</select></label>
            <label>Source warehouse<select name="warehouseId" required>${inventoryTransferState.warehouses.map((item, index) => `<option value="${item.id}" ${index === 0 ? 'selected' : ''}>${escapeHtml(item.code)} · ${escapeHtml(item.name)}</option>`).join('')}</select></label>
            <label>Available quantity<input name="quantity" type="number" min="0.000001" step="0.000001" required /></label>
            <label>Unit cost<input name="unitCost" type="number" min="0" step="0.000001" value="${Number(inventoryTransferState.products[0]?.standard_cost || 0)}" required /></label>
            <input type="hidden" name="referenceId" value="OPENING-${escapeHtml(inventoryTransferState.products[0]?.sku || 'STOCK')}" />
            <button class="small-action" type="submit">Record opening stock</button><span class="inventory-transfer-error" role="alert"></span>
          </form></div>` : ''}
        ${canSetupProducts || canSetupWarehouses ? `<details class="transfer-setup-advanced"><summary>Advanced setup (units and warehouse bins)</summary><div class="inventory-transfer-setup-grid">
          ${canSetupProducts ? `<form data-inventory-setup="uom"><h4>Add unit of measure</h4><label>Code<input name="code" required /></label><label>Name<input name="name" required /></label><label>Base unit<input name="baseUnit" required /></label><label>Conversion factor<input name="factor" type="number" min="0.000001" step="any" value="1" required /></label><button class="small-action" type="submit">Save unit</button><span class="inventory-transfer-error" role="alert"></span></form>` : ''}
          ${canSetupWarehouses ? `<form data-inventory-setup="location"><h4>Add warehouse location / bin (optional)</h4><label>Warehouse<select name="warehouseId" required ${inventoryTransferState.warehouses.length ? '' : 'disabled'}><option value="">${inventoryTransferState.warehouses.length ? 'Select warehouse' : 'Add a warehouse first'}</option>${inventoryTransferState.warehouses.map((item) => `<option value="${item.id}">${escapeHtml(item.code)} · ${escapeHtml(item.name)}</option>`).join('')}</select></label><label>Location code<input name="code" required /></label><label>Location name<input name="name" required /></label><label>Bin code<input name="binCode" /></label><label>Zone<input name="zone" /></label><button class="small-action" type="submit" ${inventoryTransferState.warehouses.length ? '' : 'disabled'}>Save location</button><span class="inventory-transfer-error" role="alert"></span></form>` : ''}
        </div></details>` : ''}
      </section>` : '';
  const transferSetupMessage = !inventoryTransferState.products.length || inventoryTransferState.warehouses.length < 2
    ? `<p class="inventory-transfer-message" role="status">Complete the quick setup above to choose a product and both warehouses. Location/bin details are optional.</p>`
    : '';
  const transferStatusSummary = [
    ['ALL', 'All transfers', inventoryTransferState.transfers.length],
    ['REQUESTED', 'Awaiting approval', pendingTransferCount],
    ['APPROVED', 'Approved', inventoryTransferState.transfers.filter((transfer) => transfer.status === 'APPROVED').length],
    ['REJECTED', 'Rejected', inventoryTransferState.transfers.filter((transfer) => transfer.status === 'REJECTED').length],
    ['DISPATCHED', 'In transit', inventoryTransferState.transfers.filter((transfer) => transfer.status === 'DISPATCHED').length],
    ['RECEIVED', 'Received', inventoryTransferState.transfers.filter((transfer) => ['RECEIVED', 'COMPLETED'].includes(transfer.status)).length],
  ];
  const transferContent = `<section class="inventory-transfer-workspace">
    <div class="inventory-transfer-heading"><div><h3>Stock transfers</h3><p>Request, review and track warehouse movements with a complete action history.</p></div>${hasRolePermission('inventory:stock:update') ? '<span class="transfer-count">' + inventoryTransferState.transfers.length + ' total</span>' : ''}</div>
    <div class="inventory-transfer-status-summary" aria-label="Filter transfers by status">${transferStatusSummary.map(([status, label, count]) => `<button type="button" data-transfer-filter="${status}" aria-pressed="${inventoryTransferState.statusFilter === status}" class="${inventoryTransferState.statusFilter === status ? 'active' : ''}"><span>${label}</span><strong>${count}</strong></button>`).join('')}</div>
    ${inventoryTransferState.error ? `<p class="inventory-transfer-message" role="alert">${escapeHtml(inventoryTransferState.error)}</p>` : ''}
    ${transferSetupMessage}
    ${transferForm}
    ${setupForms}
    ${transferTable(['Product', 'From → To warehouse', 'Requested qty', 'Requested by', 'Status', 'Request reason', 'Action history', 'Next action'], transferRows)}
  </section>`;
  const countProductOptions = inventoryTransferState.products
    .map((item) => `<option value="${item.id}">${escapeHtml(item.sku)} · ${escapeHtml(item.name)}</option>`)
    .join('');
  const countLine = `<div class="inventory-count-line">
    <label>Product<select data-count-product required>${countProductOptions}</select></label>
    <label>Counted quantity<input data-count-quantity type="number" min="0" step="any" required /></label>
    <button class="small-action danger-btn" type="button" data-count-remove-line aria-label="Remove product from count" disabled>Remove</button>
  </div>`;
  const countForm = hasRolePermission('inventory:stock:update') ? `
    <form class="inventory-count-form" data-inventory-count-form>
      <div class="inventory-count-heading"><div><h4>Start a physical count</h4><p>Record the quantities you counted. The system snapshot is saved for approval.</p></div></div>
      ${inventoryTransferState.products.length && inventoryTransferState.warehouses.length ? `
        <label>Warehouse<select name="warehouseId" required>${inventoryTransferState.warehouses.map((warehouse) => `<option value="${warehouse.id}">${escapeHtml(warehouse.code)} · ${escapeHtml(warehouse.name)}</option>`).join('')}</select></label>
        <div class="inventory-count-lines" data-count-lines>${countLine}</div>
        <div class="inventory-count-form-actions"><button class="small-action" type="button" data-count-add-line>Add product</button><button class="primary-btn" type="submit">Save draft count</button></div>
      ` : '<p class="inventory-transfer-message" role="status">Add at least one active product and warehouse before starting a count.</p>'}
      <span class="inventory-count-error" role="alert"></span>
    </form>` : '';
  const countFilters = [
    ['ALL', 'All counts', inventoryTransferState.counts.length],
    ['DRAFT', 'Draft', inventoryTransferState.counts.filter((count) => count.status === 'DRAFT').length],
    ['APPROVED', 'Approved', inventoryTransferState.counts.filter((count) => count.status === 'APPROVED').length],
    ['POSTED', 'Posted', inventoryTransferState.counts.filter((count) => count.status === 'POSTED').length],
  ];
  const visibleCounts = inventoryTransferState.counts.filter((count) => (
    inventoryTransferState.countStatusFilter === 'ALL' || count.status === inventoryTransferState.countStatusFilter
  ));
  const countRows = visibleCounts.map((count) => {
    const actions = [
      `<button class="small-action" type="button" data-count-details="${count.id}">Details</button>`,
      count.status === 'DRAFT' && hasRolePermission('inventory:counts:approve')
        ? `<button class="small-action" type="button" data-count-action="approve" data-count-id="${count.id}">Approve</button>` : '',
      count.status === 'APPROVED' && hasRolePermission('inventory:counts:approve')
        ? `<button class="small-action primary-btn" type="button" data-count-action="post" data-count-id="${count.id}">Post count</button>` : '',
    ].join('');
    const varianceLineCount = Number(count.variance_line_count || 0);
    const netVariance = Number(count.net_variance || 0);
    return `<tr><td><strong>${escapeHtml(count.warehouse_code)} · ${escapeHtml(count.warehouse_name)}</strong><small>${new Date(count.counted_at).toLocaleString()}</small></td>
      <td>${Number(count.line_count || 0)}</td>
      <td>${varianceLineCount} line${varianceLineCount === 1 ? '' : 's'} · <span class="${netVariance > 0 ? 'positive-number' : netVariance < 0 ? 'negative-number' : ''}">${netVariance > 0 ? '+' : ''}${netVariance.toLocaleString()}</span></td>
      <td><span class="transfer-status ${escapeHtml(count.status.toLowerCase())}">${escapeHtml(count.status)}</span></td>
      <td class="inventory-count-actions">${actions}</td></tr>`;
  }).join('');
  const countContent = `<section class="inventory-count-workspace">
    <div class="inventory-transfer-heading"><div><h3>Stock counts</h3><p>Compare physical quantities with system stock, review variances, then post approved changes to inventory and accounting.</p></div></div>
    ${inventoryTransferState.error ? `<p class="inventory-transfer-message" role="alert">${escapeHtml(inventoryTransferState.error)}</p>` : ''}
    ${countForm}
    <div class="inventory-count-status-summary" aria-label="Filter stock counts">${countFilters.map(([status, label, count]) => `<button type="button" data-count-filter="${status}" aria-pressed="${inventoryTransferState.countStatusFilter === status}" class="${inventoryTransferState.countStatusFilter === status ? 'active' : ''}"><span>${label}</span><strong>${count}</strong></button>`).join('')}</div>
    <div class="table-wrap inventory-transfer-table-wrap"><table class="inventory-transfer-table"><thead><tr><th>Warehouse / started</th><th>Products</th><th>Variance</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${countRows || `<tr><td colspan="5" class="empty-state"><strong>${inventoryTransferState.counts.length ? 'No counts match this status.' : 'No stock counts yet.'}</strong><span>${inventoryTransferState.counts.length ? 'Choose another status to see more counts.' : 'Start a physical count above to record and review stock variances.'}</span></td></tr>`}</tbody>
    </table></div>
  </section>`;
  const traceLotRows = inventoryTransferState.traceLots.map((lot) => {
    const actions = hasRolePermission('inventory:adjustments:approve')
      ? `<div class="inventory-trace-actions">${(lot.quality_status === 'AVAILABLE'
        ? [['QUARANTINED', 'Quarantine'], ['DAMAGED', 'Mark damaged'], ['RETURNED', 'Mark returned']]
        : [['AVAILABLE', 'Release to available']])
        .map(([status, label]) => `<button class="small-action" type="button" data-lot-quality="${status}" data-lot-id="${lot.id}">${label}</button>`).join('')}</div>`
      : '—';
    const expiry = lot.expiry_date ? String(lot.expiry_date).slice(0, 10) : '—';
    return `<tr><td><strong>${escapeHtml(lot.lot_number)}</strong><small>${escapeHtml(lot.barcode || 'No lot barcode')}</small></td>
      <td>${escapeHtml(lot.product_sku)}<small>${escapeHtml(lot.product_name)}</small></td>
      <td>${escapeHtml(lot.warehouse_code || '—')}<small>${escapeHtml(lot.location_code || 'No bin recorded')}${lot.bin_code ? ` · ${escapeHtml(lot.bin_code)}` : ''}</small></td>
      <td>${Number(lot.remaining_quantity)} ${escapeHtml(lot.unit_of_measure_code || '')}</td>
      <td>${escapeHtml(expiry)}${lot.expired ? '<small class="negative-number">Expired</small>' : ''}</td>
      <td>${escapeHtml(lot.warranty_end_date ? String(lot.warranty_end_date).slice(0, 10) : '—')}</td>
      <td><span class="transfer-status ${escapeHtml(lot.quality_status.toLowerCase())}">${escapeHtml(lot.quality_status)}</span></td>
      <td><div data-qr-label-container><button class="small-action" type="button" data-qr-label data-qr-code="${escapeHtml(lot.barcode || lot.lot_number)}">QR label</button></div>${actions}</td></tr>`;
  }).join('');
  const traceSerialRows = inventoryTransferState.serialNumbers.map((serial) => `<tr>
    <td><strong>${escapeHtml(serial.serial_number)}</strong></td>
    <td>${escapeHtml(serial.product_sku)}<small>${escapeHtml(serial.product_name)}</small></td>
    <td>${serial.status === 'IN_TRANSIT' ? 'In transit' : escapeHtml(serial.warehouse_code || '—')}
      <small>${escapeHtml(serial.location_code || (serial.status === 'IN_TRANSIT' ? 'Between warehouses' : 'No bin recorded'))}${serial.bin_code ? ` · ${escapeHtml(serial.bin_code)}` : ''}</small></td>
    <td>${escapeHtml(serial.lot_number)}</td>
    <td><span class="transfer-status ${escapeHtml(serial.status.toLowerCase())}">${escapeHtml(serial.status)}</span></td>
    <td>${escapeHtml(serial.warranty_end_date ? String(serial.warranty_end_date).slice(0, 10) : '—')}</td>
    <td><div data-qr-label-container><button class="small-action" type="button" data-qr-label data-qr-code="${escapeHtml(serial.barcode || serial.serial_number)}">QR label</button></div></td>
  </tr>`).join('');
  const reservationRows = inventoryTransferState.reservations.map((reservation) => `<tr>
    <td><strong>${escapeHtml(reservation.product_sku)}</strong><small>${escapeHtml(reservation.product_name)}</small></td>
    <td>${escapeHtml(reservation.warehouse_code)}</td>
    <td>${Number(reservation.quantity) - Number(reservation.fulfilled_quantity)} / ${Number(reservation.quantity)} ${escapeHtml(reservation.unit_of_measure_code)}</td>
    <td>${escapeHtml(reservation.reference_type || '—')}${reservation.reference_id ? `<small>${escapeHtml(reservation.reference_id)}</small>` : ''}</td>
    <td><span class="transfer-status ${escapeHtml(reservation.status.toLowerCase())}">${escapeHtml(reservation.status)}</span></td>
    <td>${reservation.status === 'ACTIVE' && hasRolePermission('inventory:stock:update')
      ? `<button class="small-action" type="button" data-reservation-release="${reservation.id}">Release</button>` : '—'}</td>
  </tr>`).join('');
  const traceProductOptions = inventoryTransferState.products.map((product) => (
    `<option value="${product.id}">${escapeHtml(product.sku)} · ${escapeHtml(product.name)}</option>`
  )).join('');
  const traceWarehouseOptions = inventoryTransferState.warehouses.map((warehouse) => (
    `<option value="${warehouse.id}">${escapeHtml(warehouse.code)} · ${escapeHtml(warehouse.name)}</option>`
  )).join('');
  const traceLocationOptions = inventoryTransferState.locations.map((location) => (
    `<option value="${location.id}" data-warehouse-id="${location.warehouse_id}">${escapeHtml(location.code)} · ${escapeHtml(location.name)}${location.bin_code ? ` (${escapeHtml(location.bin_code)})` : ''}</option>`
  )).join('');
  const traceReceiveForm = hasRolePermission('inventory:stock:update') ? `<form class="inventory-trace-form" data-inventory-trace-receive>
    <h4>Receive lot-tracked stock</h4>
    <label>Product<select name="productId" required>${traceProductOptions}</select></label>
    <label>Warehouse<select name="warehouseId" data-trace-warehouse required>${traceWarehouseOptions}</select></label>
    <label>Location / bin<select name="locationId" data-trace-location><option value="">No specific location</option>${traceLocationOptions}</select></label>
    <label>Quantity<input name="quantity" type="number" min="0.000001" step="0.000001" required /></label>
    <label>Unit cost<input name="unitCost" type="number" min="0" step="0.000001" value="0" required /></label>
    <label>Lot / batch number<input name="lotNumber" maxlength="100" required /></label>
    <label>Lot barcode / QR data<input name="lotBarcode" maxlength="128" /></label>
    <label>Expiry date<input name="expiryDate" type="date" /></label>
    <label>Warranty end date<input name="warrantyEndDate" type="date" /></label>
    <label>Quality status<select name="qualityStatus"><option value="AVAILABLE">Available</option><option value="QUARANTINED">Quarantined</option><option value="RETURNED">Returned - quarantine</option></select></label>
    <label class="inventory-trace-wide">Serial numbers <span>Enter one per unit, separated by line breaks or commas.</span><textarea name="serialNumbers" rows="2"></textarea></label>
    <label>Reference type<input name="referenceType" value="PURCHASE_RECEIPT" /></label>
    <label>Reference<input name="referenceId" required /></label>
    <span class="inventory-trace-error" role="alert"></span><button class="primary-btn" type="submit">Receive tracked stock</button>
  </form>` : '';
  const reservationForm = hasRolePermission('inventory:stock:update') ? `<form class="inventory-trace-form" data-inventory-reservation>
    <h4>Reserve stock for an order</h4>
    <label>Product<select name="productId" required>${traceProductOptions}</select></label>
    <label>Warehouse<select name="warehouseId" data-trace-warehouse required>${traceWarehouseOptions}</select></label>
    <label>Location / bin<select name="locationId" data-trace-location><option value="">Any location</option>${traceLocationOptions}</select></label>
    <label>Quantity<input name="quantity" type="number" min="0.000001" step="0.000001" required /></label>
    <label>Order type<input name="referenceType" maxlength="60" placeholder="SALES_ORDER" /></label>
    <label>Order reference<input name="referenceId" maxlength="128" /></label>
    <label class="inventory-trace-wide">Reason<input name="reason" /></label>
    <span class="inventory-trace-error" role="alert"></span><button class="primary-btn" type="submit">Reserve stock</button>
  </form>` : '';
  const trackedIssueForm = hasRolePermission('inventory:stock:issue') ? `<form class="inventory-trace-form" data-inventory-tracked-issue>
    <h4>Issue reserved or serial-tracked stock</h4>
    <label>Product<select name="productId" required>${traceProductOptions}</select></label>
    <label>Warehouse<select name="warehouseId" data-trace-warehouse required>${traceWarehouseOptions}</select></label>
    <label>Location / bin<select name="locationId" data-trace-location><option value="">Any location</option>${traceLocationOptions}</select></label>
    <label>Quantity<input name="quantity" type="number" min="0.000001" step="0.000001" required /></label>
    <label>Reservation<select name="reservationId"><option value="">Use unreserved stock</option>${inventoryTransferState.reservations.filter((item) => item.status === 'ACTIVE').map((item) => `<option value="${item.id}">${escapeHtml(item.product_sku)} · ${escapeHtml(item.warehouse_code)} · ${Number(item.quantity) - Number(item.fulfilled_quantity)} available</option>`).join('')}</select></label>
    <label>Reference type<input name="referenceType" value="MANUAL_ISSUE" /></label>
    <label>Reference<input name="referenceId" required /></label>
    <label class="inventory-trace-wide">Serial numbers <span>Required for serial-tracked stock; one per unit.</span><textarea name="serialNumbers" rows="2"></textarea></label>
    <span class="inventory-trace-error" role="alert"></span><button class="primary-btn" type="submit">Issue stock</button>
  </form>` : '';
  const traceLookupResult = inventoryTransferState.traceLookup
    ? `<div class="inventory-trace-lookup-result"><strong>${escapeHtml(inventoryTransferState.traceLookup.type)} found</strong>
      <span>${escapeHtml(inventoryTransferState.traceLookup.sku || inventoryTransferState.traceLookup.product_sku || inventoryTransferState.traceLookup.lot_number || inventoryTransferState.traceLookup.serial_number)}</span>
      <span>${escapeHtml(inventoryTransferState.traceLookup.name || inventoryTransferState.traceLookup.product_name || inventoryTransferState.traceLookup.quality_status || inventoryTransferState.traceLookup.status || '')}</span></div>`
    : '';
  const traceabilityContent = `<section class="inventory-trace-workspace">
    <div class="inventory-transfer-heading"><div><h3>Traceability, reservations &amp; quality</h3><p>Track lots, serials, expiry and warranty; scan barcodes or QR data; keep reserved and quarantined stock out of general issues.</p></div></div>
    ${inventoryTransferState.error ? `<p class="inventory-transfer-message" role="alert">${escapeHtml(inventoryTransferState.error)}</p>` : ''}
    <form class="inventory-trace-scan" data-inventory-trace-lookup><label>Scan or enter product, lot, serial, barcode, or QR data<input name="code" autocomplete="off" required autofocus /></label><button class="primary-btn" type="submit">Look up</button><span class="inventory-trace-error" role="alert">${escapeHtml(inventoryTransferState.traceLookupError)}</span>${traceLookupResult}</form>
    <div class="inventory-trace-forms">${traceReceiveForm}${reservationForm}${trackedIssueForm}</div>
    <h4>Lot and batch register</h4>
    <div class="table-wrap inventory-transfer-table-wrap"><table class="inventory-transfer-table"><thead><tr><th>Lot / barcode</th><th>Product</th><th>Warehouse / bin</th><th>Remaining</th><th>Expiry</th><th>Warranty</th><th>Quality</th><th>Disposition / QR</th></tr></thead>
      <tbody>${traceLotRows || '<tr><td colspan="8" class="empty-state"><strong>No traced lots yet.</strong><span>Receive stock with a lot number to capture expiry, warranty, barcode, and quality information.</span></td></tr>'}</tbody></table></div>
    <h4>Serial register</h4>
    <div class="table-wrap inventory-transfer-table-wrap"><table class="inventory-transfer-table"><thead><tr><th>Serial</th><th>Product</th><th>Warehouse</th><th>Lot</th><th>Status</th><th>Warranty</th><th>QR</th></tr></thead>
      <tbody>${traceSerialRows || '<tr><td colspan="7" class="empty-state"><strong>No serial-tracked stock yet.</strong><span>Add serial numbers when receiving a lot of whole-unit products.</span></td></tr>'}</tbody></table></div>
    <h4>Reservations</h4>
    <div class="table-wrap inventory-transfer-table-wrap"><table class="inventory-transfer-table"><thead><tr><th>Product</th><th>Warehouse</th><th>Remaining / reserved</th><th>Order reference</th><th>Status</th><th>Action</th></tr></thead>
      <tbody>${reservationRows || '<tr><td colspan="6" class="empty-state"><strong>No stock reservations yet.</strong><span>Reserve available stock against a sales or production order.</span></td></tr>'}</tbody></table></div>
  </section>`;

  return `
    <section class="content-panel inventory-workspace">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Operations</p>
          <h2>Inventory control</h2>
        </div>
        ${receiveAction}
      </div>
      <nav class="inventory-tabs" aria-label="Inventory sections">
        <button type="button" data-inventory-tab="overview" class="${activeTab === 'overview' ? 'active' : ''}">Overview</button>
        <button type="button" data-inventory-tab="transfers" class="${activeTab === 'transfers' ? 'active' : ''}">Stock transfers</button>
        ${hasRolePermission('inventory:reports:view') ? `<button type="button" data-inventory-tab="counts" class="${activeTab === 'counts' ? 'active' : ''}">Stock counts</button>` : ''}
        ${hasRolePermission('inventory:reports:view') ? `<button type="button" data-inventory-tab="traceability" class="${activeTab === 'traceability' ? 'active' : ''}">Traceability &amp; reservations</button>` : ''}
      </nav>
      ${activeTab === 'transfers' ? transferContent : activeTab === 'counts' ? countContent : activeTab === 'traceability' ? traceabilityContent : inventoryOverview}
    </section>
  `;
}

function renderProcurement() {
  const tabs = [['comparisons', 'Quote comparisons'], ['suppliers', 'Suppliers'], ['requisitions', 'Requisitions'], ['orders', 'Purchase orders'], ['matching', 'Invoice matching']];
  const showStatus = (status) => {
    const label = String(status || '').toLowerCase().split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
    return renderStatus(label);
  };
  const active = tabs.some(([key]) => key === procurementState.tab) ? procurementState.tab : 'comparisons';
  const canCreateComparison = hasRolePermission('procurement:comparisons:create');
  const canManageSuppliers = hasRolePermission('procurement:suppliers:manage');
  const canSelectQuote = hasRolePermission('procurement:comparisons:select');
  const canCreateOrder = hasRolePermission(actionPermissions.procurement);
  const openCount = procurementState.comparisons.filter((comparison) => comparison.status === 'OPEN').length;
  const waitingCount = procurementState.orders.filter((order) => order.status === 'PENDING_APPROVAL').length;
  const spendCount = procurementState.orders.filter((order) => order.status === 'RECEIVED').length;
  const supplierForm = canManageSuppliers ? `<details class="procurement-disclosure"><summary>+ Add supplier</summary><form class="procurement-form-grid" data-procurement-supplier-form>
    <label>Supplier name<input name="name" maxlength="180" required placeholder="e.g. Northstar Industrial" /></label>
    <label>Supplier code<input name="supplierCode" maxlength="60" required placeholder="e.g. SUP-014" /></label>
    <label>Contact person<input name="contactName" maxlength="100" data-input-rule="person" title="Use letters, spaces, apostrophes, periods, or hyphens." /></label><label>Email<input name="email" type="email" /></label>
    <label>Phone<input name="phone" type="tel" inputmode="tel" pattern="[+0-9(). -]{7,24}" maxlength="24" title="Use 7-15 digits; standard phone punctuation is allowed." /></label><label>Default payment terms<input name="paymentTerms" placeholder="Net 30" /></label>
    <label>Qualification<select name="qualificationStatus"><option value="PENDING">Pending qualification</option><option value="QUALIFIED">Qualified</option><option value="SUSPENDED">Suspended</option></select></label>
    <label>Risk level<select name="riskLevel"><option value="LOW">Low risk</option><option value="MEDIUM" selected>Medium risk</option><option value="HIGH">High risk</option></select></label>
    <label class="procurement-span">Notes<input name="notes" /></label>
    <button class="primary-btn" type="submit">Save supplier</button><span class="procurement-form-error" role="alert"></span>
  </form></details>` : '';
  const quoteEditors = procurementState.suppliers.map((supplier) => `<fieldset class="procurement-quote-editor" data-quote-editor="${supplier.id}">
    <legend><label class="procurement-include"><input type="checkbox" data-quote-include checked /> Include ${escapeHtml(supplier.name)}</label></legend>
    <div class="procurement-quote-fields">
      <label>Unit price<input data-quote-value="unitPrice" type="number" min="0" step="0.01" required /></label>
      <label>Tax %<input data-quote-value="taxRate" type="number" min="0" max="100" step="0.01" value="0" required /></label>
      <label>Delivery days<input data-quote-value="deliveryDays" type="number" min="0" step="1" required /></label>
      <label>Shipping<input data-quote-value="shippingCost" type="number" min="0" step="0.01" value="0" required /></label>
      <label>Other cost<input data-quote-value="otherCost" type="number" min="0" step="0.01" value="0" required /></label>
      <label>Payment terms<input data-quote-value="paymentTerms" required placeholder="Net 30 / advance" /></label>
      <label>Quote reference<input data-quote-value="quoteReference" /></label>
      <label>Valid until<input data-quote-value="validUntil" type="date" /></label>
    </div>
    <div class="procurement-live-total"><span>Estimated total for comparison quantity</span><strong data-quote-total>Enter a unit price</strong></div>
  </fieldset>`).join('');
  const comparisonForm = canCreateComparison ? `<details class="procurement-disclosure procurement-create-disclosure" open>
    <summary>+ Start a quotation comparison</summary>
    ${procurementState.suppliers.length < 2 ? `<p class="procurement-empty-inline">Add at least two suppliers before collecting quotes.</p>` : `<form class="procurement-comparison-form" data-procurement-comparison-form>
      <div class="procurement-form-grid procurement-request-fields">
        <label>Request / comparison name<input name="title" required placeholder="Q4 packaging supplies" /></label>
        <label>Product or service<input name="productDescription" required placeholder="Describe the item being sourced" /></label>
        <label>SKU / reference<input name="sku" /></label>
        <label>Quantity<input name="quantity" type="number" min="0.001" step="0.001" value="1" required data-comparison-quantity /></label>
        <label>Currency<select name="currency"><option>ETB</option><option>USD</option><option>EUR</option><option>GBP</option></select></label>
      </div>
      <h3 class="procurement-subheading">Supplier offers <span>Compare full landed cost, timing and terms</span></h3>
      <div class="procurement-quote-editors">${quoteEditors}</div>
      <div class="procurement-form-footer"><span class="procurement-form-error" role="alert"></span><button class="primary-btn" type="submit">Save comparison</button></div>
    </form>`}
  </details>` : '';
  const supplierContent = `<div class="procurement-section-heading"><div><h3>Supplier directory</h3><p>Maintain the suppliers used across purchasing comparisons.</p></div><span class="procurement-count">${procurementState.suppliers.length} active</span></div>
    ${supplierForm}
    ${canManageSuppliers ? `<details class="procurement-disclosure"><summary>+ Register supplier certification or document</summary><form class="procurement-form-grid" data-procurement-control="supplierDocument"><label>Supplier<select name="supplierId" required>${procurementState.suppliers.map((supplier) => `<option value="${supplier.id}">${escapeHtml(supplier.name)}</option>`).join('')}</select></label><label>Document type<input name="documentType" required maxlength="80" placeholder="Business license / certification" /></label><label>Document name<input name="documentName" required maxlength="180" /></label><label>Expiry date<input name="expiryDate" type="date" /></label><label>Document URL<input name="referenceUrl" type="url" placeholder="https://" /></label><button class="primary-btn" type="submit" ${procurementState.suppliers.length ? '' : 'disabled'}>Save document</button><span class="procurement-form-error" role="alert"></span></form></details>` : ''}
    ${procurementState.supplierDocuments.length ? `<h3>Supplier document expiry reminders</h3><div class="table-wrap"><table><thead><tr><th>Supplier</th><th>Document</th><th>Type</th><th>Expiry</th><th>Status</th><th>Reference</th></tr></thead><tbody>${procurementState.supplierDocuments.map((document) => `<tr><td>${escapeHtml(document.supplier_name)}</td><td>${escapeHtml(document.document_name)}</td><td>${escapeHtml(document.document_type)}</td><td>${escapeHtml(document.expiry_date ? String(document.expiry_date).slice(0, 10) : 'No expiry recorded')}</td><td>${escapeHtml(document.expiry_status.replaceAll('_', ' '))}</td><td>${document.reference_url ? `<a href="${escapeHtml(document.reference_url)}" target="_blank" rel="noopener noreferrer">Open document</a>` : '—'}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <div class="procurement-supplier-grid">${procurementState.suppliers.length ? procurementState.suppliers.map((supplier) => `<article class="procurement-supplier-card">
      <div class="procurement-supplier-avatar">${escapeHtml(String(supplier.name).slice(0, 1).toUpperCase())}</div><div class="procurement-supplier-info"><strong>${escapeHtml(supplier.name)}</strong><span>${escapeHtml(supplier.supplier_code)} · ${escapeHtml(supplier.qualification_status || 'PENDING')} · ${escapeHtml(supplier.risk_level || 'MEDIUM')} risk</span></div>
      <div class="procurement-supplier-meta">${supplier.contact_name ? `<span>${escapeHtml(supplier.contact_name)}</span>` : ''}${supplier.email ? `<a href="mailto:${escapeHtml(supplier.email)}">${escapeHtml(supplier.email)}</a>` : ''}${supplier.phone ? `<span>${escapeHtml(supplier.phone)}</span>` : ''}<span>${escapeHtml(supplier.payment_terms || 'Payment terms set per quotation')}</span></div>
    </article>`).join('') : `<div class="procurement-empty-state"><strong>No suppliers added yet</strong><span>Add suppliers here, then enter at least two quotations to compare.</span></div>`}</div>`;
  const comparisonContent = `<div class="procurement-section-heading"><div><h3>Supplier quotations</h3><p>Review price, tax, delivery, terms and landed cost side by side.</p></div><span class="procurement-count">${openCount} open</span></div>
    ${comparisonForm}
    ${procurementState.comparisons.length ? `<div class="procurement-comparison-list">${procurementState.comparisons.map((comparison) => {
      const quotes = comparison.quotes || [];
      const selected = quotes.find((quote) => quote.id === comparison.selected_quote_id);
      const bestQuoteId = quotes.reduce((bestId, quote) => {
        const cost = Number(quote.unit_price) * Number(comparison.quantity) + Number(quote.tax_amount) + Number(quote.shipping_cost) + Number(quote.other_cost);
        const best = quotes.find((item) => item.id === bestId);
        const bestCost = best
          ? Number(best.unit_price) * Number(comparison.quantity) + Number(best.tax_amount) + Number(best.shipping_cost) + Number(best.other_cost)
          : Infinity;
        return cost < bestCost ? quote.id : bestId;
      }, '');
      const quoteCards = quotes.map((quote) => {
        const total = Number(quote.unit_price) * Number(comparison.quantity) + Number(quote.tax_amount) + Number(quote.shipping_cost) + Number(quote.other_cost);
        const isSelected = quote.id === comparison.selected_quote_id;
        return `<article class="procurement-quote-card ${isSelected ? 'selected' : ''}">
          <div class="procurement-quote-card-head"><div><span class="procurement-quote-kicker">${escapeHtml(quote.quote_reference || 'Supplier offer')}</span><h4>${escapeHtml(quote.supplier_name)}</h4></div><div>${quote.id === bestQuoteId ? '<span class="procurement-best-badge">Lowest total</span>' : ''}${isSelected ? '<span class="procurement-selected-badge">Selected</span>' : ''}</div></div>
          <div class="procurement-quote-metrics"><div><span>Unit price</span><strong>${formatCurrency(Number(quote.unit_price))}</strong></div><div><span>Tax (${Number(quote.tax_rate)}%)</span><strong>${formatCurrency(Number(quote.tax_amount))}</strong></div><div><span>Delivery</span><strong>${Number(quote.delivery_days)} days</strong></div><div><span>Payment</span><strong>${escapeHtml(quote.payment_terms)}</strong></div><div><span>Shipping + other</span><strong>${formatCurrency(Number(quote.shipping_cost) + Number(quote.other_cost))}</strong></div></div>
          <div class="procurement-total-row"><span>Total landed cost</span><strong>${formatCurrency(total)}</strong></div>
          ${quote.valid_until ? `<p class="procurement-validity">Valid until ${escapeHtml(String(quote.valid_until).slice(0, 10))}</p>` : ''}
          ${comparison.status === 'OPEN' && canSelectQuote ? `<button class="secondary-btn procurement-select-button" type="button" data-procurement-select="${comparison.id}" data-quote-id="${quote.id}">Select supplier</button>` : ''}
        </article>`;
      }).join('');
      return `<article class="procurement-comparison-card">      <div class="procurement-comparison-header"><div><div class="procurement-comparison-title"><span class="procurement-reference">CMP-${String(comparison.comparison_number).padStart(5, '0')}</span>${showStatus(comparison.status)}</div><h3>${escapeHtml(comparison.title)}</h3><p>${escapeHtml(comparison.product_description)}${comparison.sku ? ` · ${escapeHtml(comparison.sku)}` : ''}</p></div><div class="procurement-quantity-pill">Qty <strong>${Number(comparison.quantity)}</strong></div></div>
        <div class="procurement-quote-grid">${quoteCards}</div>
        ${comparison.selection_reason ? `<p class="procurement-selection-reason"><strong>Selection reason:</strong> ${escapeHtml(comparison.selection_reason)}</p>` : ''}
        ${(comparison.history || []).length ? `<details class="procurement-history"><summary>Comparison history (${comparison.history.length})</summary>${comparison.history.map((event) => `<p><strong>${escapeHtml(event.action.replaceAll('_', ' '))}</strong> · ${escapeHtml(event.actor_name || 'System')}<br /><span>${escapeHtml(new Date(event.occurred_at).toLocaleString())}${event.reason ? ` · ${escapeHtml(event.reason)}` : ''}</span></p>`).join('')}</details>` : ''}
        ${comparison.status === 'SELECTED' && canCreateOrder ? `<div class="procurement-create-order-bar"><span>${escapeHtml(selected?.supplier_name || 'Selected supplier')} chosen · ${selected ? formatCurrency(Number(selected.unit_price) * Number(comparison.quantity) + Number(selected.tax_amount) + Number(selected.shipping_cost) + Number(selected.other_cost)) : ''}</span><button type="button" class="primary-btn" data-procurement-create-order="${comparison.id}">Create purchase order</button></div>` : ''}
      </article>`;
    }).join('')}</div>` : `<div class="procurement-empty-state"><strong>No comparisons saved yet</strong><span>Create a comparison above to see offers lined up for a clear purchasing decision.</span></div>`}`;
  const dbOrders = procurementState.orders.map((order) => {
    const total = Number(order.total_cost || 0);
    const remaining = Math.max(0, Number(order.ordered_quantity) - Number(order.received_quantity));
    const decisionActions = order.status === 'PENDING_APPROVAL' && hasRolePermission('procurement:orders:approve')
      ? `<button class="small-action" type="button" data-procurement-action="approve" data-id="${order.id}">Approve</button><button class="small-action danger-btn" type="button" data-procurement-action="reject" data-id="${order.id}">Reject</button>`
      : '';
    const receiveForm = ['APPROVED', 'ORDERED', 'PARTIALLY_RECEIVED'].includes(order.status) && hasRolePermission('procurement:orders:receive')
      ? `<form class="procurement-receive-form" data-procurement-receive="${order.id}"><input type="hidden" name="idempotencyKey" value="${crypto.randomUUID()}" /><label>Receive qty<input name="quantity" type="number" min="0.001" max="${remaining}" step="0.001" required /></label><label>Inventory SKU<input name="productSku" value="${escapeHtml(order.inventory_product_sku || order.comparison_sku || '')}" placeholder="For stocked goods" /></label><label>Receiving warehouse<select name="warehouseId"><option value="">No stock item / select warehouse</option>${procurementState.warehouses.map((warehouse) => `<option value="${warehouse.id}" ${warehouse.id === order.inventory_warehouse_id ? 'selected' : ''}>${escapeHtml(warehouse.code)} · ${escapeHtml(warehouse.name)}</option>`).join('')}</select></label><label>Receipt note<input name="reason" required placeholder="Packing slip / condition" /></label><button class="small-action" type="submit">Record receipt</button><span class="procurement-form-error" role="alert"></span></form>`
      : '';
    const history = order.history || [];
    return `<tr><td><strong>${escapeHtml(order.po_number)}</strong><span class="procurement-table-sub">${escapeHtml(order.comparison_title)}</span></td><td>${escapeHtml(order.supplier_name)}</td><td>${escapeHtml(order.expected_delivery_date ? String(order.expected_delivery_date).slice(0, 10) : '—')}</td><td>${showStatus(order.status)}</td><td>${Number(order.received_quantity)} / ${Number(order.ordered_quantity)}</td><td><strong>${formatCurrency(total)}</strong><span class="procurement-table-sub">${escapeHtml(order.payment_terms)}</span></td><td>${decisionActions}${receiveForm}<details class="procurement-history"><summary>History (${history.length})</summary>${history.map((item) => `<p><strong>${escapeHtml(item.action.replaceAll('_', ' '))}</strong> · ${escapeHtml(item.actor_name || 'System')}<br /><span>${escapeHtml(new Date(item.occurred_at).toLocaleString())}${item.reason ? ` · ${escapeHtml(item.reason)}` : ''}</span></p>`).join('')}</details></td></tr>`;
  }).join('');
  const legacyOrders = applicationData.purchaseOrders.map((order) => `<tr><td><strong>${escapeHtml(order.po)}</strong><span class="procurement-table-sub">Legacy purchase order</span></td><td>${escapeHtml(order.vendor)}</td><td>${escapeHtml(order.eta)}</td><td>${renderStatus(order.status)}</td><td>—</td><td>${formatCurrency(Number(order.amount))}</td><td>${recordActions('procurement', order.po, order.vendor)}</td></tr>`).join('');
  const ordersContent = `<div class="procurement-section-heading"><div><h3>Purchase orders</h3><p>Review selected supplier orders, approvals and receipts.</p></div><span class="procurement-count">${waitingCount} awaiting approval</span></div>
    ${procurementState.orders.length || applicationData.purchaseOrders.length ? `<div class="table-wrap procurement-orders-wrap"><table><thead><tr><th>PO / comparison</th><th>Supplier</th><th>Expected</th><th>Status</th><th>Received</th><th>Total</th><th>Actions / history</th></tr></thead><tbody>${dbOrders}${legacyOrders}</tbody></table></div>` : `<div class="procurement-empty-state"><strong>No purchase orders yet</strong><span>Select a supplier from a saved comparison to generate a purchase order.</span></div>`}`;
  const requisitionRows = procurementState.requisitions.map((item) => `<tr><td>${escapeHtml(item.requisition_number)}</td><td>${escapeHtml(item.title)}<small>${escapeHtml(item.description)}</small></td><td>${Number(item.quantity)}</td><td>${formatCurrency(Number(item.estimated_unit_cost))}</td><td>${formatCurrency(Number(item.budget_limit))}</td><td>${showStatus(item.status)}</td><td>${item.status === 'SUBMITTED' && hasRolePermission('procurement:orders:approve') ? `<button class="small-action" type="button" data-procurement-controlled-action="requisition-approve" data-id="${item.id}">Approve</button><button class="small-action danger-btn" type="button" data-procurement-controlled-action="requisition-reject" data-id="${item.id}">Reject</button>` : escapeHtml(item.decision_reason || '—')}</td></tr>`).join('');
  const requisitionContent = `${hasRolePermission('procurement:orders:create') ? `<details class="procurement-disclosure"><summary>+ Create purchase requisition</summary><form class="procurement-form-grid" data-procurement-control="requisition"><label>Title<input name="title" required maxlength="180" /></label><label>Quantity<input name="quantity" type="number" min="0.001" step="0.001" required /></label><label>Estimated unit cost<input name="estimatedUnitCost" type="number" min="0" step="0.01" required /></label><label>Budget limit<input name="budgetLimit" type="number" min="0" step="0.01" required /></label><label class="procurement-span">Description<textarea name="description" required></textarea></label><button class="primary-btn" type="submit">Submit requisition</button><span class="procurement-form-error" role="alert"></span></form></details>` : ''}<h3>Purchase requisitions · budget validation</h3><div class="table-wrap"><table><thead><tr><th>Requisition</th><th>Request</th><th>Qty</th><th>Est. unit cost</th><th>Budget</th><th>Status</th><th>Decision</th></tr></thead><tbody>${requisitionRows || '<tr><td colspan="7" class="empty-state">No requisitions yet.</td></tr>'}</tbody></table></div>`;
  const invoiceOptions = procurementState.orders.filter((order) => ['APPROVED', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED'].includes(order.status)).map((order) => `<option value="${order.id}">${escapeHtml(order.po_number)} · ${escapeHtml(order.supplier_name)} · received ${Number(order.received_quantity)} / ${Number(order.ordered_quantity)}</option>`).join('');
  const invoiceRows = procurementState.supplierInvoices.map((invoice) => `<tr><td>${escapeHtml(invoice.supplier_invoice_number)}</td><td>${escapeHtml(invoice.po_number)}</td><td>${escapeHtml(invoice.supplier_name)}</td><td>${Number(invoice.invoice_quantity)} / ${Number(invoice.ordered_quantity)}</td><td>${formatCurrency(Number(invoice.invoice_amount))} / ${formatCurrency(Number(invoice.po_total))}</td><td>${showStatus(invoice.status)}</td><td>${escapeHtml(invoice.match_notes || '—')}</td><td>${invoice.status !== 'MATCHED' && invoice.status !== 'PAID' && hasRolePermission('procurement:orders:approve') ? `<button class="small-action" type="button" data-procurement-controlled-action="invoice-match" data-id="${invoice.id}">Run 3-way match</button>` : ''}</td></tr>`).join('');
  const scorecardRows = procurementState.scorecards.map((supplier) => `<tr><td>${escapeHtml(supplier.name)}</td><td>${escapeHtml(supplier.qualification_status)}</td><td>${escapeHtml(supplier.risk_level)}</td><td>${Number(supplier.order_count)}</td><td>${Number(supplier.completed_orders)}</td><td>${Number(supplier.on_time_score).toFixed(0)}%</td><td>${formatCurrency(Number(supplier.spend))}</td></tr>`).join('');
  const matchingContent = `${hasRolePermission('procurement:orders:receive') ? `<details class="procurement-disclosure"><summary>+ Register supplier invoice</summary><form class="procurement-form-grid" data-procurement-control="supplierInvoice"><label>Purchase order<select name="purchaseOrderId" required>${invoiceOptions}</select></label><label>Supplier invoice number<input name="supplierInvoiceNumber" required /></label><label>Invoice quantity<input name="invoiceQuantity" type="number" min="0.001" step="0.001" required /></label><label>Invoice amount<input name="invoiceAmount" type="number" min="0" step="0.01" required /></label><label>Invoice date<input name="invoiceDate" type="date" value="${new Date().toISOString().slice(0,10)}" required /></label><button class="primary-btn" type="submit">Register invoice</button><span class="procurement-form-error" role="alert"></span></form></details>` : ''}<h3>Three-way PO · receipt · invoice matching</h3><div class="table-wrap"><table><thead><tr><th>Supplier invoice</th><th>PO</th><th>Supplier</th><th>Invoice / ordered qty</th><th>Invoice / PO amount</th><th>Match status</th><th>Exception</th><th>Action</th></tr></thead><tbody>${invoiceRows || '<tr><td colspan="8" class="empty-state">No supplier invoices to match.</td></tr>'}</tbody></table></div><h3>Supplier scorecards and concentration</h3><div class="table-wrap"><table><thead><tr><th>Supplier</th><th>Qualification</th><th>Risk</th><th>Orders</th><th>Received</th><th>Delivery score</th><th>Total spend</th></tr></thead><tbody>${scorecardRows || '<tr><td colspan="7" class="empty-state">No supplier spend recorded.</td></tr>'}</tbody></table></div>`;
  const tabContent = active === 'suppliers' ? supplierContent : active === 'orders' ? ordersContent : active === 'requisitions' ? requisitionContent : active === 'matching' ? matchingContent : comparisonContent;
  return `<section class="content-panel procurement-workspace">
    <div class="procurement-hero"><div class="procurement-hero-copy"><p class="eyebrow">Sourcing workspace</p><h2>Make every supplier decision with confidence.</h2><p>Compare complete landed costs, delivery commitments and payment terms before converting the winning quote into a purchase order.</p>
      <div class="procurement-hero-actions"><button type="button" class="primary-btn" data-procurement-tab="comparisons">Compare quotations</button><button type="button" class="procurement-hero-link" data-procurement-tab="suppliers">Manage suppliers <span aria-hidden="true">→</span></button></div>
    </div><div class="procurement-hero-graphic" aria-hidden="true"><div class="procurement-graphic-orbit"></div><div class="procurement-graphic-card"><span>BEST LANDED COST</span><strong>Compare. Select. Order.</strong><div class="procurement-graphic-bars"><i></i><i></i><i></i><i></i><i></i></div></div></div></div>
    <div class="procurement-kpi-row"><button type="button" data-procurement-tab="comparisons"><span>Open comparisons</span><strong>${openCount}</strong><small>Awaiting supplier selection</small></button><button type="button" data-procurement-tab="suppliers"><span>Active suppliers</span><strong>${procurementState.suppliers.length}</strong><small>In your supplier directory</small></button><button type="button" data-procurement-tab="orders"><span>Approval queue</span><strong>${waitingCount}</strong><small>Purchase orders to review</small></button><button type="button" data-procurement-tab="orders"><span>Received orders</span><strong>${spendCount}</strong><small>Completed procurement</small></button></div>
    ${procurementState.error ? `<p class="procurement-error" role="alert">${escapeHtml(procurementState.error)}</p>` : ''}
    <nav class="procurement-tabs" aria-label="Procurement sections">${tabs.map(([key, label]) => `<button type="button" data-procurement-tab="${key}" class="${active === key ? 'active' : ''}">${label}${key === 'orders' && waitingCount ? `<span class="procurement-tab-count">${waitingCount}</span>` : ''}</button>`).join('')}</nav>
    ${procurementState.loading ? '<p class="procurement-loading">Loading procurement workspace…</p>' : tabContent}
    ${active !== 'orders' && hasRolePermission(actionPermissions.procurement) ? `<details class="procurement-legacy-action"><summary>Quick-create a legacy PO</summary><p>This keeps the existing simple purchase order flow available.</p><button class="secondary-btn" type="button" data-action-form="procurement">Create legacy PO</button></details>` : ''}
  </section>`;
}

function renderHR() {
  const tabs = [
    ['employees', 'Employees'],
    ['organization', 'Organization'],
    ...(hasRolePermission('hr:employees:documents:read') ? [['documents', 'Documents']] : []),
    ...(hasRolePermission('hr:attendance:review') ? [['attendance', 'Attendance']] : []),
    ...(hasRolePermission('hr:leave:review') ? [['leave', 'Leave']] : []),
    ...(hasRolePermission('hr:payroll:read') ? [['payroll', 'Payroll']] : []),
    ...(hasRolePermission('hr:payroll:report') ? [['reports', 'Reports']] : []),
    ...(hasRolePermission('hr:payroll:settings') ? [['settings', 'Payroll rules']] : []),
  ];
  const active = tabs.some(([key]) => key === hrState.tab) ? hrState.tab : 'employees';
  const renderTab = {
    employees: renderHrEmployees,
    organization: renderHrOrganization,
    documents: renderHrEmployeeDocuments,
    attendance: renderHrAttendance,
    leave: renderHrLeave,
    payroll: renderHrPayroll,
    reports: renderHrReports,
    settings: renderHrSettings,
  }[active] || renderHrEmployees;
  const tabContent = renderTab();
  return `
    <section class="content-panel hr-workspace">
      <div class="panel-header"><div><p class="eyebrow">Human Resources</p><h2>People and payroll</h2></div></div>
      <nav class="hr-tabs" aria-label="HR sections">${tabs.map(([key, label]) => `<button type="button" data-hr-tab="${key}" class="${active === key ? 'active' : ''}">${label}</button>`).join('')}</nav>
      ${tabContent}
    </section>
  `;
}

function hrEmployeeName(employee) {
  return `${employee.personal?.firstName || ''} ${employee.personal?.lastName || ''}`.trim() || employee.employeeNumber;
}

function hrDepartmentName(id) {
  return hrState.workspace.departments.find((item) => item.id === id)?.name || '—';
}

function hrPositionName(id) {
  return hrState.workspace.positions.find((item) => item.id === id)?.name || '—';
}

function hrTable(headers, rows, emptyText = 'No records yet.') {
  return `<div class="table-wrap"><table class="hr-table"><thead><tr>${headers.map((item) => `<th>${item}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}" class="empty-state">${emptyText}</td></tr>`}</tbody></table></div>`;
}

function hrGenderOptions(currentValue = '') {
  const options = [['', 'Select gender'], ['Female', 'Female'], ['Male', 'Male'], ['Non-binary', 'Non-binary'], ['Other', 'Other'], ['Prefer not to say', 'Prefer not to say']];
  if (currentValue && !options.some(([value]) => value === currentValue)) options.push([currentValue, `${currentValue} (legacy)`]);
  return options;
}

function bindHrInputRules(root = document) {
  root.querySelectorAll('[data-input-rule]').forEach((input) => {
    input.addEventListener('input', () => {
      if (input.dataset.inputRule === 'digits') input.value = input.value.replace(/\D/g, '').slice(0, 20);
      if (input.dataset.inputRule === 'national-id') input.value = input.value.replace(/\D/g, '').slice(0, 20);
      if (input.dataset.inputRule === 'person') input.value = input.value.replace(/[^\p{L}\p{M} .'-]/gu, '').slice(0, 100);
    });
  });
}

function hrFormField(label, name, type = 'text', options = null, required = true, value = '', validationRule = '') {
  const validationAttributes = validationRule === 'digits'
    ? 'inputmode="numeric" pattern="[0-9]{1,20}" maxlength="20" data-input-rule="digits" title="Use digits only."'
    : validationRule === 'digits-edit'
      ? 'inputmode="numeric" maxlength="20" data-input-rule="digits" title="Use digits only."'
        : validationRule === 'national-id'
          ? 'inputmode="numeric" pattern="[0-9]{6,20}" maxlength="20" data-input-rule="national-id" title="Use 6-20 digits only."'
          : validationRule === 'national-id-edit'
            ? 'inputmode="numeric" maxlength="20" data-input-rule="national-id" title="Use 6-20 digits only."'
            : validationRule === 'person'
              ? 'maxlength="100" data-input-rule="person" title="Use letters, spaces, apostrophes, periods, or hyphens."'
              : '';
  const control = options
    ? `<select name="${name}" ${required ? 'required' : ''}>${options.map(([optionValue, optionLabel]) => `<option value="${escapeHtml(optionValue)}" ${String(value) === String(optionValue) ? 'selected' : ''}>${escapeHtml(optionLabel)}</option>`).join('')}</select>`
    : `<input name="${name}" type="${type}" value="${escapeHtml(value)}" ${required ? 'required' : ''} ${type === 'number' ? 'step="0.01"' : ''} ${type === 'tel' ? 'inputmode="tel" pattern="[+0-9(). -]{7,24}" maxlength="24" title="Use 7-15 digits; standard phone punctuation is allowed."' : ''} ${validationAttributes} />`;
  return `<label>${label}${control}</label>`;
}

function renderHrEmployees() {
  const rows = applicationData.employees.map((employee) => `<tr>
    <td>${escapeHtml(employee.employeeNumber)}</td><td>${escapeHtml(hrEmployeeName(employee))}</td>
    <td>${escapeHtml(hrDepartmentName(employee.departmentId))}</td><td>${escapeHtml(hrPositionName(employee.positionId))}</td>
    <td>${escapeHtml(employee.employmentType)}</td><td>${escapeHtml(employee.hireDate)}</td>
    <td>${formatCurrency(employee.salary)}</td><td>${renderStatus(employee.status)}</td>
    <td>${hasRolePermission('hr:employees:manage') ? `<button type="button" class="small-action" data-hr-edit-employee="${employee.id}">Edit</button>` : ''}</td>
  </tr>`).join('');
  const departments = hrState.workspace.departments.map((item) => [item.id, item.name]);
  const positions = hrState.workspace.positions.map((item) => [item.id, item.name]);
  const form = hasRolePermission('hr:employees:create') ? `<details class="hr-form-disclosure"><summary>Add employee</summary><form class="hr-form" data-hr-form="employee">
    ${hrFormField('Employee number (digits only)', 'employeeNumber', 'text', null, true, '', 'digits')}${hrFormField('First name', 'firstName', 'text', null, true, '', 'person')}${hrFormField('Last name', 'lastName', 'text', null, true, '', 'person')}
    ${hrFormField('Date of birth', 'dateOfBirth', 'date', null, false)}${hrFormField('Gender', 'gender', 'text', hrGenderOptions(), false)}
    ${hrFormField('National ID', 'nationalId', 'text', null, false, '', 'national-id')}${hrFormField('Address', 'address', 'text', null, false)}
    ${hrFormField('Email', 'email', 'email', null, false)}${hrFormField('Phone', 'phone', 'tel', null, false)}
    ${hrFormField('Emergency contact', 'emergencyName', 'text', null, false, '', 'person')}${hrFormField('Emergency phone', 'emergencyPhone', 'tel', null, false)}
    ${hrFormField('Relationship', 'emergencyRelationship', 'text', null, false)}
    ${hrFormField('Department', 'departmentId', 'text', departments)}${hrFormField('Position', 'positionId', 'text', positions)}
    ${hrFormField('Employment type', 'employmentType', 'text', [['Full-time', 'Full-time'], ['Part-time', 'Part-time'], ['Contract', 'Contract'], ['Temporary', 'Temporary']])}
    ${hrFormField('Hire date', 'hireDate', 'date')}${hrFormField('Contract', 'contract', 'text', [['Permanent', 'Permanent'], ['Fixed-term', 'Fixed-term'], ['Probation', 'Probation']])}
    ${hrFormField('Monthly salary (ETB)', 'salary', 'number')}${hrFormField('Monthly allowances (ETB)', 'allowances', 'number', null, false)}
    ${hrFormField('Advance deduction (ETB)', 'advanceDeduction', 'number', null, false)}${hrFormField('Other deductions (ETB)', 'otherDeductions', 'number', null, false)}
    ${hrFormField('Status', 'status', 'text', [['Active', 'Active'], ['On leave', 'On leave'], ['Terminated', 'Terminated']])}
    <div class="hr-form-actions"><button class="primary-btn" type="submit">Save employee</button><span class="hr-form-error" role="alert"></span></div>
  </form></details>` : '';
  return `<div class="hr-section-heading"><div><h3>Employee register</h3><p>${applicationData.employees.length} employee records</p></div><button class="secondary-btn" type="button" data-hr-export="employees">Export CSV</button></div>${form}${hrTable(['Number', 'Employee', 'Department', 'Position', 'Type', 'Hire date', 'Salary', 'Status', 'Actions'], rows)}`;
}

function renderHrEmployeeDocuments() {
  const employees = applicationData.employees;
  const form = hasRolePermission('hr:employees:documents:manage') ? `<details class="hr-form-disclosure" open><summary>Register employee document</summary><form class="hr-form" data-hr-form="employee-document">
    <label>Employee<select name="employeeId" required>${employees.map((employee) => `<option value="${escapeHtml(employee.id)}">${escapeHtml(hrEmployeeName(employee))} · ${escapeHtml(employee.employeeNumber)}</option>`).join('')}</select></label>
    ${hrFormField('Document type', 'documentType', 'text')}
    ${hrFormField('Document name', 'documentName', 'text')}
    ${hrFormField('Expiry date', 'expiryDate', 'date', null, false)}
    ${hrFormField('Document reference URL', 'referenceUrl', 'url', null, false)}
    <div class="hr-form-actions"><button class="primary-btn" type="submit" ${employees.length ? '' : 'disabled'}>Save document details</button><span class="hr-form-error" role="alert"></span></div>
  </form></details>` : '';
  const rows = hrState.employeeDocuments.map((document) => {
    const employee = employees.find((item) => item.id === document.employee_id);
    return `<tr><td>${escapeHtml(employee ? hrEmployeeName(employee) : 'Employee record unavailable')}</td><td>${escapeHtml(document.document_type)}</td><td>${escapeHtml(document.document_name)}</td><td>${escapeHtml(document.expiry_date ? String(document.expiry_date).slice(0, 10) : 'No expiry recorded')}</td><td>${escapeHtml(document.expiry_status.replaceAll('_', ' '))}</td><td>${document.reference_url ? `<a href="${escapeHtml(document.reference_url)}" target="_blank" rel="noopener noreferrer">Open reference</a>` : '—'}</td></tr>`;
  }).join('');
  return `<div class="hr-section-heading"><div><h3>Employee documents</h3><p>Restricted document metadata and expiry alerts</p></div></div>${form}<h3>Expiry status</h3>${hrTable(['Employee', 'Type', 'Document', 'Expiry date', 'Status', 'Reference'], rows, 'No employee document records.')}`;
}

function renderHrOrganization() {
  const canManage = hasRolePermission('hr:organizations:manage');
  const forms = canManage ? `<div class="hr-form-grid">
    <form class="hr-form" data-hr-form="department"><h4>Add department</h4>${hrFormField('Name', 'name')}${hrFormField('Code', 'code')}${hrFormField('Description', 'description', 'text', null, false)}${hrFormField('Branch', 'branchId', 'text', [['', 'None'], ...hrState.workspace.branches.map((item) => [item.id, item.name])], false)}<button class="primary-btn" type="submit">Save department</button><span class="hr-form-error"></span></form>
    <form class="hr-form" data-hr-form="position"><h4>Add position</h4>${hrFormField('Name', 'name')}${hrFormField('Code', 'code')}${hrFormField('Department', 'departmentId', 'text', hrState.workspace.departments.map((item) => [item.id, item.name]))}${hrFormField('Level', 'level', 'number')}${hrFormField('Salary range', 'salary', 'number', null, false)}<button class="primary-btn" type="submit">Save position</button><span class="hr-form-error"></span></form>
    <form class="hr-form" data-hr-form="branch"><h4>Add branch</h4>${hrFormField('Name', 'name')}${hrFormField('Code', 'code')}${hrFormField('City', 'city')}${hrFormField('Country', 'country', 'text', null, false, 'Ethiopia')}${hrFormField('Phone', 'phone', 'tel', null, false)}<button class="primary-btn" type="submit">Save branch</button><span class="hr-form-error"></span></form>
    <form class="hr-form" data-hr-form="hierarchy"><h4>Add hierarchy node</h4>${hrFormField('Name', 'name')}${hrFormField('Parent', 'parentId', 'text', [['', 'Top level'], ...hrState.workspace.organizationHierarchy.map((item) => [item.id, item.name])], false)}${hrFormField('Employee', 'employeeId', 'text', [['', 'None'], ...applicationData.employees.map((item) => [item.id, hrEmployeeName(item)])], false)}<button class="primary-btn" type="submit">Add node</button><span class="hr-form-error"></span></form>
  </div>` : '';
  const departments = hrTable(['Department', 'Code', 'Branch', 'Description'], hrState.workspace.departments.map((item) => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.code)}</td><td>${escapeHtml(hrState.workspace.branches.find((branch) => branch.id === item.branchId)?.name || '—')}</td><td>${escapeHtml(item.description || '')}</td></tr>`).join(''));
  const positions = hrTable(['Position', 'Code', 'Department', 'Level', 'Salary'], hrState.workspace.positions.map((item) => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.code)}</td><td>${escapeHtml(hrDepartmentName(item.departmentId))}</td><td>${item.level}</td><td>${formatCurrency(item.salary || 0)}</td></tr>`).join(''));
  const branches = hrTable(['Branch', 'Code', 'City', 'Country', 'Phone'], hrState.workspace.branches.map((item) => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.code)}</td><td>${escapeHtml(item.city)}</td><td>${escapeHtml(item.country)}</td><td>${escapeHtml(item.phone || '')}</td></tr>`).join(''));
  const hierarchy = hrTable(['Unit', 'Parent', 'Employee', 'Level'], hrState.workspace.organizationHierarchy.map((item) => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(hrState.workspace.organizationHierarchy.find((node) => node.id === item.parentId)?.name || '—')}</td><td>${escapeHtml(applicationData.employees.find((employee) => employee.id === item.employeeId) ? hrEmployeeName(applicationData.employees.find((employee) => employee.id === item.employeeId)) : '—')}</td><td>${item.level}</td></tr>`).join(''));
  return `${forms}<h3>Departments</h3>${departments}<h3>Positions</h3>${positions}<h3>Branches</h3>${branches}<h3>Organization hierarchy</h3>${hierarchy}`;
}

function attendanceDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Addis_Ababa',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function formatAttendanceDate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return String(value || '—');
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return String(value || '—');
  return new Intl.DateTimeFormat('en-US', {
    calendar: 'gregory',
    timeZone: 'Africa/Addis_Ababa',
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function formatAttendanceTime(value) {
  const match = String(value || '').match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return value ? String(value) : '—';
  const hour = Number(match[1]);
  return `${hour % 12 || 12}:${match[2]} ${hour < 12 ? 'AM' : 'PM'} EAT`;
}

function getFilteredAttendanceRecords() {
  const today = attendanceDateKey();
  const filter = hrState.attendancePeriod;
  let startDate = '';
  let endDate = '';
  if (filter === 'today') {
    startDate = today;
    endDate = today;
  } else if (filter === '7' || filter === '30') {
    const days = Number(filter);
    startDate = attendanceDateKey(new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000));
    endDate = today;
  } else if (filter === 'custom') {
    startDate = hrState.attendanceStartDate;
    endDate = hrState.attendanceEndDate;
  }
  const search = hrState.attendanceSearch.trim().toLocaleLowerCase();
  return applicationData.attendanceRecords.filter((record) => {
    const date = String(record.date || '').slice(0, 10);
    const employee = applicationData.employees.find((item) => item.id === record.employeeId);
    const employeeLabel = employee ? `${hrEmployeeName(employee)} ${employee.employeeNumber || ''}` : record.employeeId;
    return (!startDate || date >= startDate)
      && (!endDate || date <= endDate)
      && (hrState.attendanceEmployeeId === 'ALL' || record.employeeId === hrState.attendanceEmployeeId)
      && (hrState.attendanceStatus === 'ALL'
        || (hrState.attendanceStatus === 'OPEN' ? Boolean(record.checkIn && !record.checkOut) : String(record.status || '').toLowerCase() === hrState.attendanceStatus.toLowerCase()))
      && (!search || employeeLabel.toLocaleLowerCase().includes(search));
  });
}

function renderAttendanceCalendar(today) {
  const month = /^\d{4}-\d{2}$/.test(hrState.attendanceMonth) ? hrState.attendanceMonth : today.slice(0, 7);
  const [year, monthNumber] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const firstWeekday = new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay();
  const attendanceByDate = new Map();
  for (const record of applicationData.attendanceRecords) {
    const date = String(record.date || '').slice(0, 10);
    if (!date.startsWith(`${month}-`)) continue;
    const items = attendanceByDate.get(date) || [];
    items.push(record);
    attendanceByDate.set(date, items);
  }

  const cells = Array.from({ length: firstWeekday }, () => '<div class="attendance-calendar-empty" aria-hidden="true"></div>');
  const fastingPeriods = new Set();
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${month}-${String(day).padStart(2, '0')}`;
    const calendarDay = getAttendanceCalendarDay(date);
    const records = attendanceByDate.get(date) || [];
    const present = records.filter((record) => record.checkIn && String(record.status || '').toLowerCase() !== 'absent').length;
    const absent = records.filter((record) => String(record.status || '').toLowerCase() === 'absent').length;
    calendarDay.fasting.forEach((period) => fastingPeriods.add(period));
    const classes = [
      'attendance-calendar-day',
      calendarDay.isSunday ? 'is-rest-day' : '',
      calendarDay.events.length ? 'is-holiday' : '',
      date === today ? 'is-today' : '',
      calendarDay.fasting.length ? 'is-fasting' : '',
    ].filter(Boolean).join(' ');
    const labels = [
      ...(calendarDay.isSunday ? ['Weekly rest day'] : []),
      ...calendarDay.events,
      ...(calendarDay.fasting.length ? ['Fasting period'] : []),
    ].map((label) => `<span class="attendance-calendar-label">${escapeHtml(label)}</span>`).join('');
    const attendanceCount = records.length
      ? `<small class="attendance-calendar-count">${present} present · ${absent} absent</small>`
      : '';
    cells.push(`<div class="${classes}" aria-label="${escapeHtml(`${date}, ${calendarDay.ethiopianDate}${calendarDay.events.length ? `, ${calendarDay.events.join(', ')}` : ''}${calendarDay.isSunday ? ', weekly rest day' : ''}`)}">
      <time datetime="${date}" class="attendance-calendar-date">${day}</time>
      <small class="attendance-calendar-ethiopian">${escapeHtml(calendarDay.ethiopianDate)}</small>
      <div class="attendance-calendar-labels">${labels}</div>${attendanceCount}
    </div>`);
  }

  const fastingNote = fastingPeriods.size
    ? `<p class="attendance-fasting-note">${escapeHtml([...fastingPeriods].join(' and '))}: allow a meal or iftar break around local sunset (EAT), according to the employee's observance. Break timing is not deducted automatically.</p>`
    : '';
  return `<section class="attendance-calendar" aria-label="Attendance calendar">
    <div class="attendance-calendar-heading"><div><h4>Attendance calendar</h4><p>Gregorian dates with Ethiopian calendar observances</p></div><label>Month<input type="month" id="hr-attendance-month" value="${escapeHtml(month)}" /></label></div>
    <div class="attendance-calendar-legend" aria-label="Calendar legend"><span class="legend-rest">Weekly rest day</span><span class="legend-holiday">Holiday</span><span class="legend-fasting">Fasting period</span></div>
    <p class="attendance-calendar-note">Islamic holiday dates are estimates and may vary with local moon sightings.</p>
    ${fastingNote}
    <div class="attendance-calendar-scroll"><div class="attendance-calendar-grid" role="grid" aria-label="${escapeHtml(month)} attendance calendar">
      ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((weekday) => `<div class="attendance-calendar-weekday" role="columnheader">${weekday}</div>`).join('')}
      ${cells.join('')}
    </div></div>
  </section>`;
}

function renderHrAttendance() {
  const canManage = hasRolePermission('hr:attendance:manage');
  const today = attendanceDateKey();
  const records = getFilteredAttendanceRecords();
  const presentCount = records.filter((record) => record.checkIn && String(record.status || '').toLowerCase() !== 'absent').length;
  const absentCount = records.filter((record) => String(record.status || '').toLowerCase() === 'absent').length;
  const openCount = records.filter((record) => record.date === today && record.checkIn && !record.checkOut).length;
  const hoursTotal = records.reduce((total, record) => total + (Number(record.workingHours) || 0), 0);
  const rows = records.map((record) => {
    const employee = applicationData.employees.find((item) => item.id === record.employeeId);
    const actions = canManage && record.date === today && record.checkIn && !record.checkOut
      ? `<button class="small-action" data-hr-attendance="check-out" data-employee="${escapeHtml(record.employeeId)}">Check out</button>`
      : '';
    const date = String(record.date || '').slice(0, 10);
    return `<tr>
      <td><time datetime="${escapeHtml(date)}">${escapeHtml(formatAttendanceDate(date))}</time></td>
      <td>${escapeHtml(employee ? hrEmployeeName(employee) : record.employeeId)}</td>
      <td>${record.checkIn ? `<time datetime="${escapeHtml(date)}T${escapeHtml(record.checkIn)}:00+03:00">${escapeHtml(formatAttendanceTime(record.checkIn))}</time>` : '—'}</td>
      <td>${record.checkOut ? `<time datetime="${escapeHtml(date)}T${escapeHtml(record.checkOut)}:00+03:00">${escapeHtml(formatAttendanceTime(record.checkOut))}</time>` : record.checkIn ? '<span class="attendance-pending">Not checked out</span>' : '—'}</td>
      <td>${Number(record.workingHours || 0).toFixed(2)}</td><td>${Number(record.overtime || 0).toFixed(2)}</td><td>${Number(record.lateArrival || 0)} min</td><td>${renderStatus(record.status)}</td><td>${actions}</td></tr>`;
  }).join('');
  const activeEmployees = applicationData.employees.filter((employee) => employee.status === 'Active');
  const selectedEmployee = activeEmployees.find((employee) => employee.id === hrState.attendanceEmployeeId) || activeEmployees[0];
  const selectedTodayRecord = applicationData.attendanceRecords.find((record) => record.employeeId === selectedEmployee?.id && record.date === today);
  const selectedAction = !selectedTodayRecord
    ? { action: 'check-in', label: 'Check in', disabled: !selectedEmployee }
    : selectedTodayRecord.checkIn && !selectedTodayRecord.checkOut
      ? { action: 'check-out', label: 'Check out', disabled: false }
      : { action: '', label: selectedTodayRecord.status === 'Absent' ? 'Absence recorded today' : 'Checked out today', disabled: true };
  const checkActions = canManage ? `<div class="attendance-action-panel">
    <div><strong>Today · ${escapeHtml(formatAttendanceDate(today))}</strong><span>Times use East Africa Time (EAT, UTC+3).</span></div>
    <label>Employee<select id="hr-attendance-employee">${activeEmployees.map((employee) => `<option value="${escapeHtml(employee.id)}" ${employee.id === selectedEmployee?.id ? 'selected' : ''}>${escapeHtml(hrEmployeeName(employee))} · ${escapeHtml(employee.employeeNumber)}</option>`).join('')}</select></label>
    <button class="primary-btn" type="button" data-hr-attendance="${selectedAction.action}" data-employee="${escapeHtml(selectedEmployee?.id || '')}" ${selectedAction.disabled ? 'disabled' : ''}>${escapeHtml(selectedAction.label)}</button>
    <button class="secondary-btn" type="button" data-hr-attendance="absence">Record absence</button>
  </div>` : '<p class="attendance-timezone-note">Dates and times are shown in East Africa Time (EAT, UTC+3).</p>';
  const filters = `<form class="attendance-filters" data-attendance-filters>
    <label>Date range<select name="period"><option value="today" ${hrState.attendancePeriod === 'today' ? 'selected' : ''}>Today</option><option value="7" ${hrState.attendancePeriod === '7' ? 'selected' : ''}>Last 7 days</option><option value="30" ${hrState.attendancePeriod === '30' ? 'selected' : ''}>Last 30 days</option><option value="all" ${hrState.attendancePeriod === 'all' ? 'selected' : ''}>All dates</option><option value="custom" ${hrState.attendancePeriod === 'custom' ? 'selected' : ''}>Custom dates</option></select></label>
    ${hrState.attendancePeriod === 'custom' ? `<label>From<input name="startDate" type="date" value="${escapeHtml(hrState.attendanceStartDate)}" /></label><label>To<input name="endDate" type="date" value="${escapeHtml(hrState.attendanceEndDate)}" /></label>` : ''}
    <label>Employee<select name="employeeId"><option value="ALL">All employees</option>${applicationData.employees.map((employee) => `<option value="${escapeHtml(employee.id)}" ${hrState.attendanceEmployeeId === employee.id ? 'selected' : ''}>${escapeHtml(hrEmployeeName(employee))}</option>`).join('')}</select></label>
    <label>Status<select name="status"><option value="ALL">All statuses</option>${[['Present', 'Present'], ['Absent', 'Absent'], ['OPEN', 'Needs check-out']].map(([value, label]) => `<option value="${value}" ${hrState.attendanceStatus === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    <label class="attendance-search">Search employee<input name="search" type="search" value="${escapeHtml(hrState.attendanceSearch)}" placeholder="Name or employee number" /></label>
    <button class="primary-btn" type="submit">Apply filters</button><button class="secondary-btn" type="button" data-attendance-clear>Clear filters</button>
  </form>`;
  return `<div class="hr-section-heading"><div><h3>Attendance</h3><p>Review daily attendance, check-in/out, worked time, overtime and lateness.</p></div><button class="secondary-btn" type="button" data-hr-export="attendance">Export CSV</button></div>
    ${checkActions}
    <div class="attendance-summary" aria-label="Attendance summary">
      <article><span>Present</span><strong>${presentCount}</strong><small>in selected date range</small></article>
      <article><span>Absent</span><strong>${absentCount}</strong><small>in selected date range</small></article>
      <article><span>Awaiting check-out</span><strong>${openCount}</strong><small>today, East Africa Time</small></article>
      <article><span>Hours recorded</span><strong>${hoursTotal.toFixed(2)}</strong><small>in selected date range</small></article>
    </div>
    ${renderAttendanceCalendar(today)}
    ${filters}
    <p class="attendance-result-count">Showing ${records.length} of ${applicationData.attendanceRecords.length} attendance records.</p>
    ${hrTable(['Date (EAT)', 'Employee', 'Check in (EAT)', 'Check out (EAT)', 'Hours', 'Overtime', 'Late', 'Status', 'Actions'], rows, 'No attendance records match these filters.')}`;
}

function renderHrLeave() {
  const leaveTypes = hrState.leave.types;
  const canRequest = hasRolePermission('hr:leave:manage');
  const requestForm = canRequest ? `<form class="hr-form hr-form-inline" data-hr-form="leave-request"><h4>Request leave</h4>${hrFormField('Employee', 'employeeId', 'text', applicationData.employees.map((item) => [item.id, hrEmployeeName(item)]))}${hrFormField('Leave type', 'leaveTypeId', 'text', leaveTypes.map((item) => [item.id, item.name]))}${hrFormField('Start', 'startDate', 'date')}${hrFormField('End', 'endDate', 'date')}${hrFormField('Reason', 'reason', 'text', null, false)}<button class="primary-btn" type="submit">Submit request</button><span class="hr-form-error"></span></form>` : '';
  const typeForm = hasRolePermission('hr:leave:manage') ? `<details class="hr-form-disclosure"><summary>Configure leave type</summary><form class="hr-form" data-hr-form="leave-type">${hrFormField('Name', 'name')}${hrFormField('Code', 'code')}${hrFormField('Days per year', 'daysPerYear', 'number')}${hrFormField('Accrual per month', 'accrualRate', 'number', null, false)}<label><input type="checkbox" name="paid" checked /> Paid leave</label><button class="primary-btn" type="submit">Save leave type</button><span class="hr-form-error"></span></form></details>` : '';
  const balances = hrTable(['Employee', 'Leave type', 'Entitled', 'Used', 'Remaining'], hrState.leave.balances.map((item) => {
    const entitled = Number(item.entitled ?? leaveTypes.find((type) => type.id === item.leaveTypeId)?.daysPerYear ?? 0);
    const used = Number(item.used || 0);
    const remaining = Number(item.remaining ?? Math.max(0, entitled - used));
    return `<tr><td>${escapeHtml(hrEmployeeName(applicationData.employees.find((employee) => employee.id === item.employeeId) || { employeeNumber: item.employeeId }))}</td><td>${escapeHtml(leaveTypes.find((type) => type.id === item.leaveTypeId)?.name || '—')}</td><td>${entitled}</td><td>${used}</td><td>${remaining}</td></tr>`;
  }).join(''));
  const requests = hrState.leave.requests.map((item) => `<tr><td>${escapeHtml(hrEmployeeName(applicationData.employees.find((employee) => employee.id === item.employeeId) || { employeeNumber: item.employeeId }))}</td><td>${escapeHtml(leaveTypes.find((type) => type.id === item.leaveTypeId)?.name || '—')}</td><td>${escapeHtml(item.startDate)} – ${escapeHtml(item.endDate)}</td><td>${Number(item.days || 0)}</td><td>${escapeHtml(item.reason || '')}</td><td>${renderStatus(item.status)}</td><td>${item.status === 'Pending' && hasRolePermission('hr:leave:approve') ? `<button class="small-action" data-hr-leave-decision="Approved" data-request="${item.id}">Approve</button><button class="small-action danger-btn" data-hr-leave-decision="Rejected" data-request="${item.id}">Reject</button>` : ''}</td></tr>`).join('');
  const calendarRows = (Array.isArray(hrState.leaveCalendar) ? hrState.leaveCalendar : []).map((item) => `<li><strong>${escapeHtml(item.startDate)} – ${escapeHtml(item.endDate)}</strong> · ${escapeHtml(hrEmployeeName(applicationData.employees.find((employee) => employee.id === item.employeeId) || { employeeNumber: item.employeeId }))} · ${escapeHtml(leaveTypes.find((type) => type.id === item.leaveTypeId)?.name || 'Leave')}</li>`).join('');
  return `<div class="hr-section-heading"><div><h3>Leave management</h3><p>Balances, requests, approvals and calendar</p></div><button class="secondary-btn" type="button" data-hr-export="leave">Export CSV</button></div>${requestForm}${typeForm}<h4>Leave balances</h4>${balances}<h4>Leave requests</h4>${hrTable(['Employee', 'Type', 'Dates', 'Days', 'Reason', 'Status', 'Decision'], requests)}<div class="hr-calendar"><label>Leave calendar month<input type="month" id="hr-leave-month" value="${escapeHtml(hrState.leaveMonth)}" /></label><ul>${calendarRows || '<li>No approved leave this month.</li>'}</ul></div>`;
}

function renderHrPayroll() {
  const canCalculate = hasRolePermission('hr:payroll:calculate');
  const periods = Array.isArray(hrState.payroll?.periods) ? hrState.payroll.periods : [];
  const create = canCalculate ? `<form class="hr-form hr-form-inline" data-hr-form="payroll-period"><h4>Create payroll period</h4>${hrFormField('Label', 'label')}${hrFormField('Start date', 'startDate', 'date')}${hrFormField('End date', 'endDate', 'date')}<button class="primary-btn" type="submit">Create draft</button><span class="hr-form-error"></span></form>` : '';
  const rows = periods.map((period) => {
    const action = (permission, stage, label) => hasRolePermission(permission) ? `<button class="small-action" data-hr-payroll="${stage}" data-period="${period.id}">${label}</button>` : '';
    const actions = [
      period.status === 'Draft' || period.status === 'Calculated' ? action('hr:payroll:calculate', 'calculate', 'Calculate') : '',
      period.status === 'Calculated' ? action('hr:payroll:calculate', 'review', 'Submit for review') : '',
      period.status === 'Review' ? action('hr:payroll:approve', 'approve', 'Approve') : '',
      period.status === 'Approved' ? action('hr:payroll:post', 'post', 'Post') : '',
      period.status === 'Posted' ? action('hr:payroll:post', 'pay', 'Mark paid') : '',
    ].join(' ');
    return `<tr><td>${escapeHtml(period.label)}</td><td>${escapeHtml(period.startDate)} – ${escapeHtml(period.endDate)}</td><td>${renderStatus(period.status)}</td><td>${period.entries?.length || 0}</td><td>${formatCurrency((period.entries || []).reduce((sum, entry) => sum + Number(entry.grossSalary || 0), 0))}</td><td>${formatCurrency((period.entries || []).reduce((sum, entry) => sum + Number(entry.netSalary || 0), 0))}</td><td>${actions}</td></tr>`;
  }).join('');
  const entries = periods.flatMap((period) => (period.entries || []).map((entry) => `<tr><td>${escapeHtml(period.label)}</td><td>${escapeHtml(entry.employeeName)}</td><td>${formatCurrency(entry.basicSalary)}</td><td>${formatCurrency(entry.allowances)}</td><td>${Number(entry.overtimeHours || 0).toFixed(2)}</td><td>${formatCurrency(entry.tax)}</td><td>${formatCurrency(entry.employeePension)}</td><td>${formatCurrency(entry.advances + entry.otherDeductions + entry.absenceDeduction)}</td><td><strong>${formatCurrency(entry.netSalary)}</strong></td><td>${period.status === 'Paid' ? `<button class="small-action" data-hr-payslip="${entry.employeeId}" data-period="${period.id}">Payslip</button>` : ''}</td></tr>`)).join('');
  return `${create}<div class="hr-section-heading"><div><h3>Payroll workflow</h3><p>Draft → Calculate → Review → Approve → Post → Paid</p></div><button class="secondary-btn" type="button" data-hr-export="payroll">Export report</button></div>${hrTable(['Period', 'Dates', 'Status', 'Employees', 'Gross', 'Net payable', 'Actions'], rows)}<h4>Calculated payroll detail</h4>${hrTable(['Period', 'Employee', 'Basic', 'Allowances', 'OT hours', 'Tax', 'Pension', 'Other deductions', 'Net pay', 'Payslip'], entries)}`;
}

function renderHrSettings() {
  const settings = hrState.payroll?.settings || {};
  const bands = settings.taxBands || [];
  return `<div class="hr-section-heading"><div><h3>Payroll and Ethiopian tax rules</h3><p>Rates are organization-configurable; confirm current legal values before use.</p></div></div><form class="hr-form hr-settings-form" data-hr-form="payroll-settings">
    ${hrFormField('Currency', 'currency', 'text', null, true, settings.currency || 'ETB')}
    ${hrFormField('Employee pension rate (decimal)', 'employeePensionRate', 'number', null, true, settings.employeePensionRate)}
    ${hrFormField('Employer pension rate (decimal)', 'employerPensionRate', 'number', null, true, settings.employerPensionRate)}
    ${hrFormField('Overtime multiplier', 'overtimeMultiplier', 'number', null, true, settings.overtimeMultiplier)}
    ${hrFormField('Standard hours per month', 'standardHoursPerMonth', 'number', null, true, settings.standardHoursPerMonth)}
    ${hrFormField('Standard hours per day', 'standardHoursPerDay', 'number', null, true, settings.standardHoursPerDay)}
    ${hrFormField('Working days per month', 'workingDaysPerMonth', 'number', null, true, settings.workingDaysPerMonth)}
    ${hrFormField('Scheduled start time (Ethiopia local)', 'scheduledStartTime', 'time', null, true, settings.scheduledStartTime)}
    <label class="hr-tax-bands">Monthly progressive tax bands (JSON: [{ "upTo": 600, "rate": 0 }, …, { "upTo": null, "rate": 0.35 }])<textarea name="taxBands" rows="10" required>${escapeHtml(JSON.stringify(bands, null, 2))}</textarea></label>
    <button class="primary-btn" type="submit">Save payroll rules</button><span class="hr-form-error"></span>
  </form>`;
}

function renderHrReports() {
  const type = hrState.reportType;
  const data = Array.isArray(hrState.reports[type]) ? hrState.reports[type] : [];
  const reportHeaders = {
    employees: ['Number', 'Employee', 'Department', 'Position', 'Hire date', 'Status', 'Salary'],
    attendance: ['Date', 'Employee', 'Check in', 'Check out', 'Hours', 'Overtime', 'Late', 'Status'],
    leave: ['Employee', 'Type', 'Start', 'End', 'Days', 'Status'],
    payroll: ['Period', 'Status', 'Employees', 'Gross salary', 'Net salary'],
  };
  const rows = data.map((item) => {
    if (type === 'employees') return `<tr><td>${escapeHtml(item.employeeNumber)}</td><td>${escapeHtml(hrEmployeeName(item))}</td><td>${escapeHtml(hrDepartmentName(item.departmentId))}</td><td>${escapeHtml(hrPositionName(item.positionId))}</td><td>${escapeHtml(item.hireDate)}</td><td>${renderStatus(item.status)}</td><td>${formatCurrency(item.salary)}</td></tr>`;
    if (type === 'attendance') return `<tr><td>${escapeHtml(item.date)}</td><td>${escapeHtml(hrEmployeeName(applicationData.employees.find((employee) => employee.id === item.employeeId) || { employeeNumber: item.employeeId }))}</td><td>${escapeHtml(item.checkIn || '—')}</td><td>${escapeHtml(item.checkOut || '—')}</td><td>${Number(item.workingHours || 0).toFixed(2)}</td><td>${Number(item.overtime || 0).toFixed(2)}</td><td>${Number(item.lateArrival || 0)}</td><td>${escapeHtml(item.status)}</td></tr>`;
    if (type === 'leave') return `<tr><td>${escapeHtml(hrEmployeeName(applicationData.employees.find((employee) => employee.id === item.employeeId) || { employeeNumber: item.employeeId }))}</td><td>${escapeHtml(hrState.leave.types.find((leaveType) => leaveType.id === item.leaveTypeId)?.name || '—')}</td><td>${escapeHtml(item.startDate)}</td><td>${escapeHtml(item.endDate)}</td><td>${Number(item.days || 0)}</td><td>${escapeHtml(item.status)}</td></tr>`;
    return `<tr><td>${escapeHtml(item.label)}</td><td>${escapeHtml(item.status)}</td><td>${item.employeeCount}</td><td>${formatCurrency(item.grossSalary)}</td><td>${formatCurrency(item.netSalary)}</td></tr>`;
  }).join('');
  return `<div class="hr-section-heading"><div><h3>HR reports</h3><p>Employees, attendance, leave and payroll</p></div><button class="secondary-btn" type="button" data-hr-export="${type}">Export CSV</button></div><div class="hr-report-select"><label>Report<select id="hr-report-type">${[['employees', 'Employee report'], ['attendance', 'Attendance report'], ['leave', 'Leave report'], ['payroll', 'Payroll report']].map(([value, label]) => `<option value="${value}" ${type === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div>${hrTable(reportHeaders[type], rows)}`;
}

function renderAccountingWorkspace() {
  const accounts = accountingState.accounts;
  const periods = accountingState.periods;
  const journals = accountingState.journals;
  const canCreateJournal = hasRolePermission('accounting:journals:create');
  const canManageAccounts = hasRolePermission('accounting:accounts:manage');
  const canManagePeriods = hasRolePermission('accounting:periods:manage');
  const canReopenPeriods = hasRolePermission('accounting:periods:reopen');
  const canManageBudgets = hasRolePermission('accounting:budgets:manage');
  const table = (headers, rows) => `<div class="table-wrap"><table class="accounting-table"><thead><tr>${headers.map((header) => `<th>${header}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}" class="empty-state">No records available.</td></tr>`}</tbody></table></div>`;
  const action = (journal, key, label, permission) => hasRolePermission(permission)
    ? `<button class="small-action" type="button" data-accounting-action="${key}" data-journal="${journal.id}">${label}</button>` : '';
  const accountRows = accounts.map((account) => {
    const balance = accountingState.reports.trialBalance?.accounts?.find((item) => item.accountCode === account.account_code);
    return `<tr><td>${escapeHtml(account.account_code)}</td><td>${escapeHtml(account.parent_account_id ? `↳ ${account.account_name}` : account.account_name)}</td><td>${escapeHtml(account.account_type)}</td><td>${escapeHtml(account.normal_balance)}</td><td>${account.active ? 'Active' : 'Inactive'}</td><td>${formatCurrency(Number(balance?.closingBalance ?? account.opening_balance ?? 0))}</td><td>${canManageAccounts ? `<button class="small-action" type="button" data-accounting-account="${account.id}">${account.active ? 'Deactivate' : 'Activate'}</button>` : ''}</td></tr>`;
  }).join('');
  const journalRows = journals.map((journal) => `<tr><td>${escapeHtml(journal.journal_number)}</td><td>${escapeHtml(String(journal.transaction_date).slice(0, 10))}</td><td>${escapeHtml(journal.description)}</td><td>${escapeHtml(journal.source_module)}</td><td>${renderStatus(journal.status)}</td><td><button class="small-action" type="button" data-accounting-detail="${journal.id}">Details</button>${journal.status === 'DRAFT' ? action(journal, 'submit', 'Submit', 'accounting:journals:create') + action(journal, 'cancel', 'Cancel', 'accounting:journals:cancel') : ''}${journal.status === 'SUBMITTED' ? action(journal, 'approve', 'Approve', 'accounting:journals:approve') + action(journal, 'cancel', 'Cancel', 'accounting:journals:cancel') : ''}${journal.status === 'APPROVED' ? action(journal, 'post', 'Post', 'accounting:journals:post') : ''}${journal.status === 'POSTED' ? action(journal, 'reverse', 'Reverse', 'accounting:journals:reverse') : ''}</td></tr>`).join('');
  const selectedAccountId = accountingState.ledger?.account?.id || accounts[0]?.id || '';
  const ledgerRows = (accountingState.ledger?.movements || []).map((line) => `<tr><td>${escapeHtml(line.transaction_date?.slice?.(0, 10) || line.transaction_date)}</td><td>${escapeHtml(line.journal_number)}</td><td>${escapeHtml(line.reference || '')}</td><td>${escapeHtml(line.line_description || line.description)}</td><td>${formatCurrency(Number(line.debit))}</td><td>${formatCurrency(Number(line.credit))}</td><td>${formatCurrency(Number(line.running_balance))}</td></tr>`).join('');
  const report = accountingState.reports;
  const reportRows = (report.trialBalance?.accounts || []).map((account) => `<tr><td>${escapeHtml(account.accountCode)}</td><td>${escapeHtml(account.accountName)}</td><td>${escapeHtml(account.accountType)}</td><td>${formatCurrency(Number(account.debit))}</td><td>${formatCurrency(Number(account.credit))}</td><td>${formatCurrency(Number(account.closingBalance))}</td></tr>`).join('');
  const year = new Date().getFullYear();
  const monthStart = `${year}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`;
  const defaultLines = accounts.length > 1
    ? [{ accountId: accounts[0].id, debit: 100, credit: 0, description: 'Debit line', costCenter: '', profitCenter: '' }, { accountId: accounts[1].id, debit: 0, credit: 100, description: 'Credit line', costCenter: '', profitCenter: '' }]
    : [];
  const budgetRows = accountingState.budgets.filter((line) => line.line_id).map((line) => `<tr><td>${escapeHtml(line.budget_code)} · ${escapeHtml(line.budget_name)}</td><td>${line.fiscal_year}</td><td>${escapeHtml(String(line.period_start).slice(0, 7))}</td><td>${escapeHtml(line.account_code)} · ${escapeHtml(line.account_name)}</td><td>${escapeHtml(line.cost_center_code || '—')}</td><td>${escapeHtml(line.profit_center_code || '—')}</td><td>${formatCurrency(Number(line.budget_amount))}</td><td>${formatCurrency(Number(line.actual_amount))}</td><td>${formatCurrency(Number(line.variance))}</td></tr>`).join('');
  const forms = `
    ${canManageBudgets ? `<details class="accounting-form-disclosure"><summary>Plan a monthly budget</summary><form class="accounting-form" data-accounting-form="budget-line">
      <label>Budget code<input name="budgetCode" maxlength="40" required placeholder="FY2026-OPS" /></label><label>Budget name<input name="budgetName" maxlength="160" required placeholder="Operating budget" /></label>
      <label>Fiscal year<input name="fiscalYear" type="number" min="2000" max="9999" value="${year}" required /></label><label>Month<input name="periodStart" type="month" value="${monthStart.slice(0, 7)}" required /></label>
      <label>Account<select name="accountId" required>${accounts.filter((account) => account.active).map((account) => `<option value="${account.id}">${escapeHtml(account.account_code)} · ${escapeHtml(account.account_name)}</option>`).join('')}</select></label>
      <label>Cost center code<input name="costCenterCode" maxlength="40" placeholder="Optional governance code" /></label><label>Profit center code<input name="profitCenterCode" maxlength="40" placeholder="Optional governance code" /></label>
      <label>Budget amount<input name="amount" type="number" min="0" step="0.01" required /></label>
      <button class="primary-btn" type="submit">Save budget line</button><span class="accounting-error" role="alert"></span>
    </form></details>` : ''}
    ${canManageAccounts ? `<details class="accounting-form-disclosure"><summary>New account</summary><form class="accounting-form" data-accounting-form="account">
      <label>Code<input name="accountCode" required /></label><label>Name<input name="accountName" required /></label>
      <label>Type<select name="accountType">${[['ASSET','Asset'],['LIABILITY','Liability'],['EQUITY','Equity'],['REVENUE','Revenue'],['COGS','Cost of goods sold'],['OPERATING_EXPENSE','Operating expense'],['OTHER_INCOME','Other income'],['OTHER_EXPENSE','Other expense']].map(([value,label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
      <label>Normal balance<select name="normalBalance"><option>DEBIT</option><option>CREDIT</option></select></label>
      <label>Parent account<select name="parentAccountId"><option value="">Top-level account</option>${accounts.map((account) => `<option value="${account.id}">${escapeHtml(account.account_code)} · ${escapeHtml(account.account_name)}</option>`).join('')}</select></label>
      <label>Opening balance<input name="openingBalance" type="number" min="0" step="0.000001" value="0" /></label><label>Description<input name="description" /></label>
      <button class="primary-btn" type="submit">Create account</button><span class="accounting-error" role="alert"></span>
    </form></details>` : ''}
    ${canCreateJournal ? `<details class="accounting-form-disclosure"><summary>New journal draft</summary><form class="accounting-form" data-accounting-form="journal">
      <label>Transaction date<input name="transactionDate" type="date" value="${new Date().toISOString().slice(0, 10)}" required /></label><label>Reference<input name="reference" /></label><label>Description<input name="description" required /></label><label>Source module<input name="sourceModule" value="manual" required /></label><label>Source transaction ID<input name="sourceTransactionId" /></label>
      <label class="accounting-wide">Journal lines JSON<textarea name="lines" rows="6" required>${escapeHtml(JSON.stringify(defaultLines, null, 2))}</textarea></label>
      <button class="primary-btn" type="submit">Save draft</button><span class="accounting-error" role="alert"></span>
    </form></details>` : ''}
    ${canManagePeriods ? `<details class="accounting-form-disclosure"><summary>Create accounting period</summary><form class="accounting-form" data-accounting-form="period">
      <label>Fiscal year<input name="fiscalYear" type="number" min="2000" max="9999" value="${year}" required /></label><label>Month<input name="periodNumber" type="number" min="1" max="12" value="${new Date().getMonth() + 1}" required /></label><label>Start date<input name="periodStart" type="date" value="${year}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01" required /></label><label>End date<input name="periodEnd" type="date" value="${new Date(year, new Date().getMonth() + 1, 0).toISOString().slice(0, 10)}" required /></label><button class="primary-btn" type="submit">Create period</button><span class="accounting-error" role="alert"></span>
    </form></details>` : ''}
  `;
  const contents = {
    ledger: `<div class="accounting-ledger-header"><label>Account<select id="accounting-ledger-account">${accounts.map((account) => `<option value="${account.id}" ${account.id === selectedAccountId ? 'selected' : ''}>${escapeHtml(account.account_code)} · ${escapeHtml(account.account_name)}</option>`).join('')}</select></label><div><span>Opening</span><strong>${formatCurrency(Number(accountingState.ledger?.openingBalance || 0))}</strong></div><div><span>Closing</span><strong>${formatCurrency(Number(accountingState.ledger?.closingBalance || 0))}</strong></div></div>${table(['Date','Journal','Reference','Description','Debit','Credit','Running balance'], ledgerRows)}`,
    accounts: `${forms}<h3>Chart of accounts</h3>${table(['Code','Account','Type','Normal balance','Status','Closing balance','Action'], accountRows)}`,
    journals: `${forms}<h3>Journal entries</h3>${table(['Number','Date','Description','Source','Status','Workflow'], journalRows)}`,
    periods: `${forms}<div class="accounting-section-heading"><h3>Accounting periods</h3>${canManagePeriods ? `<form class="accounting-year-close" data-accounting-form="year-close"><label>Fiscal year<input name="fiscalYear" type="number" value="${year}" required /></label><label>Retained earnings code<input name="retainedEarningsCode" value="3100" required /></label><button class="danger-btn" type="submit">Close fiscal year</button><span class="accounting-error" role="alert"></span></form>` : ''}</div>${table(['Fiscal year','Period','Start','End','Status','Action'], periods.map((period) => `<tr><td>${period.fiscal_year}</td><td>${period.period_number}</td><td>${String(period.period_start).slice(0,10)}</td><td>${String(period.period_end).slice(0,10)}</td><td>${renderStatus(period.status)}</td><td>${period.status === 'OPEN' && canManagePeriods ? `<button class="small-action" data-accounting-close-period="${period.id}">Close period</button>` : period.status === 'CLOSED' && canReopenPeriods ? `<button class="small-action" data-accounting-reopen-period="${period.id}">Reopen period</button>` : ''}</td></tr>`).join(''))}`,
    reports: `<div class="accounting-report-summary"><article><span>Revenue</span><strong>${formatCurrency(Number(report.profitAndLoss?.revenue || 0))}</strong></article><article><span>Expenses</span><strong>${formatCurrency(Number(report.profitAndLoss?.expenses || 0))}</strong></article><article><span>Net income</span><strong>${formatCurrency(Number(report.profitAndLoss?.netIncome || 0))}</strong></article><article><span>Cash movement</span><strong>${formatCurrency(Number(report.cashFlow?.netCashFlow || 0))}</strong></article><article><span>Assets</span><strong>${formatCurrency(Number(report.balanceSheet?.assets || 0))}</strong></article><article><span>Liabilities + equity</span><strong>${formatCurrency(Number(report.balanceSheet?.totalLiabilitiesAndEquity || 0))}</strong></article></div><h3>Trial balance</h3>${table(['Code','Account','Type','Debits','Credits','Balance'], reportRows)}`,
    budgets: `${forms}<h3>Monthly budget versus posted actuals</h3><p>Actuals include posted general-ledger journals only and are matched by account, month, cost center, and profit center. Positive variance means budget is above actual.</p>${table(['Budget','Year','Month','Account','Cost center','Profit center','Budget','Actual','Variance'], budgetRows)}`,
  };
  const tabs = [['ledger','General ledger'],['accounts','Chart of accounts'],['journals','Journals'],['periods','Periods'],['budgets','Budgets'],['reports','Financial reports']];
  return `<section class="content-panel accounting-workspace"><div class="panel-header"><div><p class="eyebrow">General ledger</p><h2>Accounting engine</h2></div><button class="secondary-btn" type="button" data-accounting-refresh>Refresh</button></div><nav class="finance-tabs" aria-label="Finance sections"><button type="button" data-finance-tab="overview">Transactions</button><button type="button" data-finance-tab="accounting" class="active">Accounting</button></nav>${accountingState.error ? `<p class="accounting-error" role="alert">${escapeHtml(accountingState.error)}</p>` : ''}<nav class="accounting-tabs" aria-label="Accounting sections">${tabs.map(([key,label]) => `<button type="button" data-accounting-tab="${key}" class="${accountingState.tab === key ? 'active' : ''}">${label}</button>`).join('')}</nav><div class="accounting-content">${contents[accountingState.tab] || contents.ledger}</div></section>`;
}

function renderFinance() {
  if (financeState.tab === 'accounting') return renderAccountingWorkspace();
  const summary = getFinanceSummary(applicationData.financeLedger, applicationData.salesOrders);
  const addAction = hasRolePermission(actionPermissions.finance)
    ? `<button class="primary-btn" type="button" data-action-form="finance">Add transaction</button>`
    : '';

  return `
    <section class="content-panel finance-workspace">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Finance Process</p>
          <h2>Cash flow and ledger</h2>
        </div>
        ${addAction}
      </div>

      ${hasRolePermission('accounting:reports:view') ? `<nav class="finance-tabs" aria-label="Finance sections"><button type="button" data-finance-tab="overview" class="${financeState.tab === 'overview' ? 'active' : ''}">Transactions</button><button type="button" data-finance-tab="accounting">Accounting</button></nav>` : ''}

      <div class="stats-grid compact-grid">
        <div class="metric-card neutral">
          <div class="metric-header"><span>Revenue</span></div>
          <h3>${formatCurrency(summary.revenue)}</h3>
        </div>
        <div class="metric-card warning">
          <div class="metric-header"><span>Expenses</span></div>
          <h3>${formatCurrency(summary.expenses)}</h3>
        </div>
        <div class="metric-card positive">
          <div class="metric-header"><span>Net</span></div>
          <h3>${formatCurrency(summary.net)}</h3>
        </div>
      </div>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Type</th>
              <th>Date</th>
              <th>Amount</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${applicationData.financeLedger
              .map(
                (entry) => `
                  <tr>
                    <td>${entry.title}</td>
                    <td>${entry.type}</td>
                    <td>${entry.date}</td>
                    <td class="${entry.amount > 0 ? 'positive-number' : 'negative-number'}">${formatCurrency(entry.amount)}</td>
                    <td>${recordActions('finance', entry.title, entry.title)}</td>
                  </tr>
                `,
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function formatBankAmount(value, currency) {
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)} ${currency}`;
}

function renderBanking() {
  const currencies = [...new Set(bankingState.accounts.map((account) => account.currency))].join(' / ');
  const canCreate = hasRolePermission('finance:transactions:create');
  const canApprove = hasRolePermission('finance:transactions:approve');
  const canReject = hasRolePermission('finance:transactions:reject');
  const bankingActions = canCreate
    ? `<div class="button-row">${hasRolePermission('finance:accounts:manage') ? '<button class="secondary-btn" type="button" data-bank-action="account">Add account</button>' : ''}<button class="primary-btn" type="button" data-bank-action="transaction">Record transaction</button><button class="ghost-btn" type="button" data-bank-action="transfer">Transfer funds</button><button class="secondary-btn" type="button" data-bank-action="reconcile">Reconcile</button></div>`
    : '';

  const reconciliation = bankingState.statementTransactions.length
    ? (() => {
        const matchedCount = bankingState.reconciliationHistory.filter((entry) => bankingState.transactions.some((transaction) => transaction.id === entry.cashbookTransactionId)).length;
        const pendingCount = bankingState.statementTransactions.filter((transaction) => transaction.status !== 'Matched').length;
        return `
          <div class="content-panel bank-reconciliation-panel">
            <div class="panel-header">
              <div>
                <p class="eyebrow">Bank reconciliation</p>
                <h2>Statement matching</h2>
              </div>
              ${canCreate ? '<button class="primary-btn" type="button" data-bank-reconcile="auto">Auto match</button>' : ''}
            </div>
            <div class="stats-grid compact-grid">
              <div class="metric-card positive"><div class="metric-header"><span>Matched items</span></div><h3>${matchedCount}</h3><p>Cashbook and bank statement entries linked</p></div>
              <div class="metric-card warning"><div class="metric-header"><span>Unmatched</span></div><h3>${pendingCount}</h3><p>Items still need review</p></div>
              <div class="metric-card neutral"><div class="metric-header"><span>Difference</span></div><h3>${pendingCount ? 'Open' : '0.00'}</h3><p>Balance variance review</p></div>
            </div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Bank statement</th><th>Cashbook item</th><th>Description</th><th>Amount</th><th>Match method</th><th>Status</th></tr></thead>
                <tbody>
                  ${bankingState.reconciliationHistory.length
                    ? bankingState.reconciliationHistory.map((entry) => {
                        const statement = bankingState.statementTransactions.find((transaction) => transaction.id === entry.statementTransactionId);
                        const cashbook = bankingState.transactions.find((transaction) => transaction.id === entry.cashbookTransactionId);
                        const cashbookLabel = cashbook?.reference || cashbook?.id || (entry.legacyCashbookTransactionId ? `Missing legacy record ${entry.legacyCashbookTransactionId}` : '—');
                        return `<tr><td>${statement?.reference || statement?.legacyId || statement?.id || '—'}</td><td>${escapeHtml(cashbookLabel)}</td><td>${statement?.description || cashbook?.description || '—'}</td><td>${formatCurrency(Number(entry.amount || 0))}</td><td>${entry.method || 'manual'}</td><td>${renderStatus(entry.status || 'Matched')}</td></tr>`;
                      }).join('')
                    : '<tr><td colspan="6" class="empty-state">No matching history recorded yet.</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>
        `;
      })()
    : '';

  return `
    <section class="banking-page">
      <div class="panel-header banking-header">
        <div>
          <p class="eyebrow">Treasury Process</p>
          <h2>Banking and cash management</h2>
          <p class="subtle">Monitor accounts, record cash movements, and reconcile transfers.</p>
        </div>
        ${bankingActions}
      </div>

      ${bankingState.error ? `<p class="bank-form-error" role="alert">${escapeHtml(bankingState.error)}</p>` : ''}

      <div class="stats-grid compact-grid bank-summary-grid">
        <div class="metric-card neutral"><div class="metric-header"><span>Bank accounts</span></div><h3>${bankingState.accounts.length}</h3><p>${currencies || 'No currencies'}</p></div>
        <div class="metric-card warning"><div class="metric-header"><span>Pending review</span></div><h3>${bankingState.summary.pending || 0}</h3><p>transactions to reconcile</p></div>
        <div class="metric-card positive"><div class="metric-header"><span>Cash controls</span></div><h3>Active</h3><p>Balance validation enabled</p></div>
      </div>

      <div class="grid two-column bank-account-grid">
        ${bankingState.accounts
          .map(
            (account) => `
              <article class="metric-card bank-account-card">
                <div class="metric-header"><span>${account.type} account</span><span class="pill positive">${account.status}</span></div>
                <h3>${account.name}</h3>
                <p class="subtle">${account.bank} · ${account.accountNumber}</p>
                <div class="bank-balance">${formatBankAmount(account.balance, account.currency)}</div>
              </article>
            `,
          )
          .join('')}
      </div>

      ${reconciliation}

      <div class="content-panel bank-transactions-panel">
        <div class="panel-header"><div><p class="eyebrow">Cash activity</p><h2>Recent transactions</h2></div><span class="pill neutral">${bankingState.transactions.length} records</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Description</th><th>Account</th><th>Type</th><th>Status</th><th>Amount</th><th>Actions</th></tr></thead>
            <tbody>
              ${bankingState.transactions
                .map((transaction) => {
                  const account = bankingState.accounts.find((item) => item.id === transaction.accountId);
                  const approvalActions = transaction.status === 'Pending' && (canApprove || canReject)
                    ? `<div class="approval-actions">${canApprove ? `<button type="button" data-bank-approval="approve" data-transaction-id="${transaction.id}">Approve</button>` : ''}${canReject ? `<button type="button" data-bank-approval="reject" data-transaction-id="${transaction.id}">Reject</button>` : ''}</div>`
                    : '';
                  return `<tr><td>${transaction.date}</td><td><strong>${transaction.description}</strong><small class="table-note">${transaction.reference || transaction.category}</small></td><td>${account?.name || transaction.accountId}</td><td><span class="bank-type ${transaction.type.toLowerCase()}">${transaction.type}</span></td><td>${renderStatus(transaction.status)}${approvalActions}</td><td class="${transaction.type === 'Credit' ? 'positive-number' : 'negative-number'}">${transaction.type === 'Credit' ? '+' : '-'}${formatBankAmount(transaction.amount, account?.currency || '')}</td><td>${recordActions('banking', transaction.id, transaction.description)}</td></tr>`;
                })
                .join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div id="bank-form-panel" class="content-panel bank-form-panel" hidden></div>
    </section>
  `;
}

function renderManufacturingOverview() {
  const summary = manufacturingState.summary;
  const createAction = hasRolePermission('manufacturing:orders:create')
    ? `<button class="primary-btn" type="button" data-manufacturing-action="new-order">New production order</button>`
    : '';

  return `
    <section class="manufacturing-page">
      <div class="panel-header manufacturing-header">
        <div>
          <p class="eyebrow">Factory Operations</p>
          <h2>Manufacturing control center</h2>
          <p class="subtle">Plan production, balance capacity, and track material readiness.</p>
        </div>
        ${createAction}
      </div>

      <div class="stats-grid compact-grid manufacturing-summary-grid">
        <div class="metric-card neutral"><div class="metric-header"><span>Planned units</span></div><h3>${summary.plannedUnits}</h3><p>across active orders</p></div>
        <div class="metric-card positive"><div class="metric-header"><span>Completion rate</span></div><h3>${summary.completionRate}%</h3><p>${summary.completedUnits} units completed</p></div>
        <div class="metric-card warning"><div class="metric-header"><span>Average utilization</span></div><h3>${summary.averageUtilization}%</h3><p>${summary.blockedOrders} blocked orders</p></div>
      </div>

      <div class="content-panel manufacturing-orders-panel">
        <div class="panel-header"><div><p class="eyebrow">Production planning</p><h2>Manufacturing orders</h2></div><span class="pill neutral">${manufacturingState.productionOrders.length} orders</span></div>
        <div class="table-wrap"><table><thead><tr><th>Order</th><th>Product</th><th>Progress</th><th>Work center</th><th>Due date</th><th>Status</th><th>Actions</th></tr></thead><tbody>
          ${manufacturingState.productionOrders.map((order) => {
            const progress = Math.min(Math.round((order.completed / order.quantity) * 100), 100);
            return `<tr><td><strong>${order.id}</strong><small class="table-note">${order.priority} priority</small></td><td>${order.product}</td><td><div class="production-progress"><span style="width: ${progress}%"></span></div><small class="table-note">${order.completed} / ${order.quantity} units</small></td><td>${order.workCenter}</td><td>${order.dueDate}</td><td>${renderStatus(order.status)}</td><td>${recordActions('manufacturing', order.id, order.product)}</td></tr>`;
          }).join('')}
        </tbody></table></div>
      </div>

      <div class="grid two-column">
        <div class="content-panel"><div class="panel-header"><div><p class="eyebrow">Capacity planning</p><h2>Work centers</h2></div></div><div class="work-center-list">
          ${manufacturingState.workCenters.map((center) => `<div class="work-center-row"><div><strong>${center.name}</strong><small>${center.department} · ${center.openJobs} open jobs</small></div><div class="work-center-meter"><span style="width: ${center.utilization}%"></span></div><b>${center.utilization}%</b></div>`).join('')}
        </div></div>
        <div class="content-panel"><div class="panel-header"><div><p class="eyebrow">Engineering control</p><h2>Bill of materials</h2></div></div><div class="bom-list">
          ${manufacturingState.billOfMaterials.map((bom) => `<div class="bom-row"><div><strong>${bom.product}</strong><small>Revision ${bom.revision} · ${bom.components} components</small></div><span class="pill ${bom.materialReadiness >= 90 ? 'positive' : 'warning'}">${bom.materialReadiness}% ready</span></div>`).join('')}
        </div></div>
      </div>
      <div id="manufacturing-form-panel" class="content-panel manufacturing-form-panel" hidden></div>
    </section>
  `;
}

function renderManufacturing() {
  const workspace = manufacturingState.workspace;
  if (!workspace) return renderManufacturingOverview();
  const tabs = [['overview', 'Overview'], ['boms', 'BOM'], ['routing', 'Routing & centers'], ['orders', 'Work orders'], ['quality', 'Quality'], ['planning', 'Forecast & maintenance'], ['mrp', 'MRP'], ['reports', 'Reports']];
  const active = tabs.some(([key]) => key === manufacturingState.tab) ? manufacturingState.tab : 'overview';
  const products = workspace.products || [];
  const warehouses = workspace.warehouses || [];
  const bomOptions = (workspace.boms || []).filter((bom) => bom.status === 'ACTIVE').map((bom) => `<option value="${bom.id}">${escapeHtml(bom.bom_code)} v${escapeHtml(bom.version)} · ${escapeHtml(bom.finished_name)}</option>`).join('');
  const routingOptions = (workspace.routings || []).filter((routing) => routing.active).map((routing) => `<option value="${routing.id}">${escapeHtml(routing.routing_code)} v${escapeHtml(routing.version)}</option>`).join('');
  const productOptions = (types = null) => products.filter((product) => !types || types.includes(product.product_type)).map((product) => `<option value="${product.id}">${escapeHtml(product.sku)} · ${escapeHtml(product.name)}</option>`).join('');
  const lotOptions = (workspace.lots || []).map((lot) => `<option value="${lot.id}">${escapeHtml(lot.lot_number)} · ${escapeHtml(lot.sku)} · ${escapeHtml(lot.lot_type)}</option>`).join('');
  const table = (headers, rows) => `<div class="table-wrap"><table class="manufacturing-table"><thead><tr>${headers.map((header) => `<th>${header}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}" class="empty-state">No records available.</td></tr>`}</tbody></table></div>`;
  const form = (kind, title, fields, permission) => hasRolePermission(permission)
    ? `<details class="manufacturing-form-disclosure"><summary>${title}</summary><form class="manufacturing-data-form" data-manufacturing-form="${kind}">${fields}<div class="manufacturing-form-actions"><button class="primary-btn" type="submit">Save</button><span class="manufacturing-form-error" role="alert"></span></div></form></details>` : '';
  const bomLineSample = [{ rawMaterialProductId: products.find((product) => product.product_type === 'RAW_MATERIAL')?.id || '', quantityPer: 1, scrapPercent: 0, operationSequence: 10 }];
  const operationSample = [{ sequenceNumber: 10, operationName: 'Assembly', workCenterId: workspace.workCenters?.[0]?.id || '', setupMinutes: 0, machineMinutesPerUnit: 10, laborHoursPerUnit: 0.1 }];
  const bomRows = (workspace.boms || []).map((bom) => `<tr><td>${escapeHtml(bom.bom_code)}</td><td>${escapeHtml(bom.version)}</td><td>${escapeHtml(bom.finished_sku)} · ${escapeHtml(bom.finished_name)}</td><td>${bom.material_count}</td><td>${Number(bom.scrap_percent)}%</td><td>${escapeHtml(String(bom.effective_from).slice(0,10))} – ${escapeHtml(bom.effective_to ? String(bom.effective_to).slice(0,10) : 'Open')}</td><td>${renderStatus(bom.status)}</td><td>${bom.status !== 'ACTIVE' && hasRolePermission('manufacturing:bom:manage') ? `<button class="small-action" data-manufacturing-action="activate-bom" data-id="${bom.id}">Activate version</button>` : ''}</td></tr>`).join('');
  const centerRows = (workspace.workCenters || []).map((center) => `<tr><td>${escapeHtml(center.code)}</td><td>${escapeHtml(center.name)}</td><td>${escapeHtml(center.machine_name || '')}</td><td>${center.machine_capacity}</td><td>${center.labor_capacity}</td><td>${formatCurrency(Number(center.machine_hour_rate))}</td><td>${formatCurrency(Number(center.labor_hour_rate))}</td><td>${formatCurrency(Number(center.overhead_hour_rate))}</td><td>${center.active ? 'Active' : 'Inactive'}</td></tr>`).join('');
  const routingRows = (workspace.routings || []).map((routing) => `<tr><td>${escapeHtml(routing.routing_code)}</td><td>${escapeHtml(routing.version)}</td><td>${escapeHtml(routing.finished_sku)} · ${escapeHtml(routing.finished_name)}</td><td>${routing.operation_count}</td><td>${escapeHtml(String(routing.effective_from).slice(0,10))}</td><td>${routing.active ? 'Active' : 'Inactive'}</td></tr>`).join('');
  const orderRows = (workspace.orders || []).map((order) => `<tr><td><button class="link-action" data-manufacturing-select-order="${order.id}">${escapeHtml(order.order_number)}</button></td><td>${escapeHtml(order.finished_sku)} · ${escapeHtml(order.finished_name)}</td><td>${Number(order.planned_quantity)}</td><td>${Number(order.completed_quantity)} good / ${Number(order.rejected_quantity)} rejected</td><td>${escapeHtml(order.warehouse_name)}</td><td>${escapeHtml(order.due_date ? String(order.due_date).slice(0,10) : '—')}</td><td>${renderStatus(order.status)}</td><td>${order.status === 'PLANNED' && hasRolePermission('manufacturing:orders:release') ? `<button class="small-action" data-manufacturing-action="release" data-id="${order.id}">Reserve & release</button>` : ''}${order.status === 'RELEASED' && hasRolePermission('manufacturing:orders:release') ? `<button class="small-action" data-manufacturing-action="start" data-id="${order.id}">Start</button>` : ''}${order.status === 'COMPLETED' && hasRolePermission('manufacturing:orders:release') ? `<button class="small-action" data-manufacturing-action="close" data-id="${order.id}">Close</button>` : ''}</td></tr>`).join('');
  const qualityRows = (manufacturingState.qualityInspections || []).map((inspection) => `<tr><td>${escapeHtml(inspection.lot_number)}</td><td>${escapeHtml(inspection.sku)} · ${escapeHtml(inspection.product_name)}</td><td>${escapeHtml(inspection.order_number || inspection.lot_type)}</td><td>${escapeHtml(inspection.inspection_stage)}</td><td>${Number(inspection.inspected_quantity)}</td><td>${Number(inspection.passed_quantity)}</td><td>${Number(inspection.failed_quantity)}</td><td>${renderStatus(inspection.result)}</td><td>${escapeHtml(inspection.defect_code || '')}</td><td>${escapeHtml(inspection.inspector_username || '')}</td><td>${escapeHtml(String(inspection.inspected_at).slice(0, 16).replace('T', ' '))}</td></tr>`).join('');
  const forecastRows = (workspace.forecasts || []).map((item) => `<tr><td>${escapeHtml(item.sku)} · ${escapeHtml(item.product_name)}</td><td>${escapeHtml(String(item.forecast_date).slice(0, 10))}</td><td>${Number(item.quantity)}</td><td>${escapeHtml(item.notes || '')}</td></tr>`).join('');
  const maintenanceRows = (workspace.maintenance || []).map((item) => `<tr><td>${escapeHtml(item.work_center_code)} · ${escapeHtml(item.work_center_name)}</td><td>${escapeHtml(item.maintenance_type)}</td><td>${escapeHtml(item.description)}</td><td>${escapeHtml(String(item.scheduled_date).slice(0, 10))}</td><td>${item.next_due_date ? escapeHtml(String(item.next_due_date).slice(0, 10)) : '—'}</td><td>${Number(item.downtime_minutes)} min</td><td>${renderStatus(item.status)}</td><td>${item.status === 'PLANNED' && hasRolePermission('manufacturing:routing:manage') ? `<button class="small-action" data-manufacturing-action="maintenance-complete" data-id="${item.id}">Complete</button>` : ''}</td></tr>`).join('');
  const downtimeRows = (workspace.downtimeEvents || []).map((event) => `<tr><td>${escapeHtml(String(event.downtime_date).slice(0, 10))}</td><td>${escapeHtml(event.work_center_code)} · ${escapeHtml(event.work_center_name)}</td><td>${escapeHtml(event.order_number || 'Not linked')}</td><td>${Number(event.downtime_minutes)} min</td><td>${escapeHtml(event.reason)}</td><td>${escapeHtml(event.notes || '')}</td></tr>`).join('');
  const createOrderFields = `<label>Finished product<select name="finishedProductId" required>${productOptions(['FINISHED_GOOD','SEMI_FINISHED_GOOD'])}</select></label><label>Active BOM<select name="bomId" required>${bomOptions}</select></label><label>Routing<select name="routingId"><option value="">No routing</option>${routingOptions}</select></label><label>Warehouse<select name="warehouseId" required>${warehouses.map((warehouse) => `<option value="${warehouse.id}">${escapeHtml(warehouse.code)} · ${escapeHtml(warehouse.name)}</option>`).join('')}</select></label><label>Planned quantity<input name="plannedQuantity" type="number" min="0.000001" step="0.001" required /></label><label>Planned start<input name="plannedStart" type="date" /></label><label>Due date<input name="dueDate" type="date" /></label>`;
  const selectedOrder = manufacturingState.selectedOrder;
  const orderDetail = selectedOrder ? `<section class="manufacturing-detail"><div class="manufacturing-detail-header"><div><p class="eyebrow">${escapeHtml(selectedOrder.order_number)}</p><h3>${escapeHtml(selectedOrder.finished_name)} · ${renderStatus(selectedOrder.status)}</h3></div><button class="small-action" data-manufacturing-refresh-order="${selectedOrder.id}">Refresh detail</button></div><h4>Material plan and actual consumption</h4>${table(['Material','Required','Reserved','Consumed','Unit','Material cost'],selectedOrder.materials.map((material) => `<tr><td>${escapeHtml(material.sku)} · ${escapeHtml(material.name)}</td><td>${Number(material.required_quantity)}</td><td>${Number(material.reserved_quantity)}</td><td>${Number(material.consumed_quantity)}</td><td>${escapeHtml(material.uom_code)}</td><td>${formatCurrency(Number(material.consumed_quantity)*Number(material.unit_cost))}</td></tr>`).join(''))}<h4>Routing execution</h4>${table(['Seq','Operation','Work center','Status','Planned machine/labor h','Actual machine/labor h','Action'],selectedOrder.operations.map((operation) => `<tr><td>${operation.sequence_number}</td><td>${escapeHtml(operation.operation_name)}</td><td>${escapeHtml(operation.work_center_name)}</td><td>${renderStatus(operation.status)}</td><td>${Number(operation.planned_machine_hours).toFixed(2)} / ${Number(operation.planned_labor_hours).toFixed(2)}</td><td>${Number(operation.actual_machine_hours).toFixed(2)} / ${Number(operation.actual_labor_hours).toFixed(2)}</td><td>${operation.status === 'PLANNED' && selectedOrder.status === 'IN_PROGRESS' && hasRolePermission('manufacturing:orders:release') ? `<button class="small-action" data-manufacturing-action="start-operation" data-order="${selectedOrder.id}" data-id="${operation.id}">Start</button>` : ''}${operation.status === 'IN_PROGRESS' && hasRolePermission('manufacturing:output:record') ? `<form class="manufacturing-inline-operation" data-manufacturing-form="complete-operation" data-order="${selectedOrder.id}" data-operation="${operation.id}"><label>Machine h<input name="actualMachineHours" type="number" min="0" step="0.01" value="${Number(operation.planned_machine_hours)}" required /></label><label>Labor h<input name="actualLaborHours" type="number" min="0" step="0.01" value="${Number(operation.planned_labor_hours)}" required /></label><button class="small-action" type="submit">Complete</button><span class="manufacturing-form-error" role="alert"></span></form>` : ''}</td></tr>`).join(''))}<h4>Production batches</h4>${table(['Batch','Production date','Good quantity','Rejected','Unit cost'],selectedOrder.outputs.map((output) => `<tr><td>${escapeHtml(output.lot_number)}</td><td>${String(output.production_date).slice(0,10)}</td><td>${Number(output.produced_quantity)}</td><td>${Number(output.rejected_quantity)}</td><td>${formatCurrency(Number(output.unit_cost))}</td></tr>`).join(''))}${selectedOrder.status === 'IN_PROGRESS' && hasRolePermission('manufacturing:materials:consume') ? `<form class="manufacturing-data-form compact-manufacturing-form" data-manufacturing-form="consume" data-order="${selectedOrder.id}"><h4>Consume reserved material</h4><label>Material<select name="productId">${selectedOrder.materials.map((material) => `<option value="${material.raw_material_product_id}">${escapeHtml(material.sku)} · ${escapeHtml(material.name)}</option>`).join('')}</select></label><label>Quantity<input name="quantity" type="number" min="0.000001" step="0.001" required /></label><label>Raw lot number<input name="lotNumber" required /></label><button class="primary-btn" type="submit">Record consumption</button><span class="manufacturing-form-error" role="alert"></span></form>` : ''}${selectedOrder.status === 'IN_PROGRESS' && hasRolePermission('manufacturing:output:record') ? `<form class="manufacturing-data-form compact-manufacturing-form" data-manufacturing-form="output" data-order="${selectedOrder.id}"><h4>Record finished output</h4><label>Good quantity<input name="producedQuantity" type="number" min="0.000001" step="0.001" required /></label><label>Rejected quantity<input name="rejectedQuantity" type="number" min="0" step="0.001" value="0" /></label><label>Batch number<input name="batchNumber" /></label><label>Production date<input name="productionDate" type="date" value="${today()}" required /></label><button class="primary-btn" type="submit">Post finished output</button><span class="manufacturing-form-error" role="alert"></span></form>` : ''}</section>` : '';
  const reportRows = manufacturingState.reportRows || [];
  const reportHeaders = reportRows.length ? Object.keys(reportRows[0]).filter((key) => !['id','organization_id'].includes(key)) : ['Result'];
  const reportTable = table(reportHeaders, reportRows.map((row) => `<tr>${reportHeaders.map((header) => `<td>${escapeHtml(row[header] ?? '')}</td>`).join('')}</tr>`).join(''));
  const mrp = workspace.latestMrp;
  const contents = {
    overview: renderManufacturingOverview(),
    boms: `${form('bom','Create BOM version',`<label>Finished product<select name="finishedProductId" required>${productOptions(['FINISHED_GOOD','SEMI_FINISHED_GOOD'])}</select></label><label>BOM code<input name="bomCode" required /></label><label>Version<input name="version" required /></label><label>Effective from<input name="effectiveFrom" type="date" value="${today()}" required /></label><label>Effective to<input name="effectiveTo" type="date" /></label><label>Scrap %<input name="scrapPercent" type="number" min="0" max="99.999" step="0.01" value="0" /></label><label class="manufacturing-wide">Material lines JSON<textarea name="lines" rows="5" required>${escapeHtml(JSON.stringify(bomLineSample,null,2))}</textarea></label><label class="manufacturing-wide">Notes<input name="notes" /></label>`,'manufacturing:bom:manage')}<h3>BOM versions</h3>${table(['Code','Version','Finished product','Materials','Scrap','Effective dates','Status','Action'],bomRows)}`,
    routing: `${form('work-center','Create work center',`<label>Code<input name="code" required /></label><label>Name<input name="name" required /></label><label>Machine<input name="machineName" /></label><label>Machine capacity<input name="machineCapacity" type="number" min="0.001" step="0.1" value="1" required /></label><label>Labor capacity<input name="laborCapacity" type="number" min="0.001" step="0.1" value="1" required /></label><label>Machine hourly cost<input name="machineHourRate" type="number" min="0" step="0.01" value="0" /></label><label>Labor hourly cost<input name="laborHourRate" type="number" min="0" step="0.01" value="0" /></label><label>Overhead hourly cost<input name="overheadHourRate" type="number" min="0" step="0.01" value="0" /></label><label class="manufacturing-wide">Calendar JSON<textarea name="calendar" rows="3">{"workingDays":[1,2,3,4,5],"hoursPerDay":8}</textarea></label>`,'manufacturing:routing:manage')}${form('routing','Create routing version',`<label>Finished product<select name="finishedProductId" required>${productOptions(['FINISHED_GOOD','SEMI_FINISHED_GOOD'])}</select></label><label>Routing code<input name="routingCode" required /></label><label>Version<input name="version" required /></label><label>Effective from<input name="effectiveFrom" type="date" value="${today()}" required /></label><label class="manufacturing-wide">Operations JSON<textarea name="operations" rows="5" required>${escapeHtml(JSON.stringify(operationSample,null,2))}</textarea></label>`,'manufacturing:routing:manage')}<h3>Work centers</h3>${table(['Code','Center','Machine','Machine capacity','Labor capacity','Machine cost/h','Labor cost/h','Overhead/h','Status'],centerRows)}<h3>Routings</h3>${table(['Code','Version','Finished product','Operations','Effective','Active'],routingRows)}`,
    orders: `${form('order','Plan manufacturing order',createOrderFields,'manufacturing:orders:create')}<h3>Production orders</h3>${table(['Order','Finished product','Planned','Output','Warehouse','Due','Status','Action'],orderRows)}${orderDetail}`,
    quality: `${form('quality','Record lot inspection',`<label>Lot<select name="lotId" required>${lotOptions}</select></label><label>Inspection stage<select name="inspectionStage"><option value="INCOMING">Incoming</option><option value="IN_PROCESS">In process</option><option value="FINAL">Final</option></select></label><label>Inspected quantity<input name="inspectedQuantity" type="number" min="0.000001" step="0.000001" required /></label><label>Passed quantity<input name="passedQuantity" type="number" min="0" step="0.000001" value="0" required /></label><label>Failed quantity<input name="failedQuantity" type="number" min="0" step="0.000001" value="0" required /></label><label>Defect code<input name="defectCode" maxlength="80" /></label><label class="manufacturing-wide">Notes<textarea name="notes" rows="2"></textarea></label>`,'manufacturing:quality:manage')}<h3>Inspection history</h3>${table(['Lot','Product','Order / lot type','Stage','Inspected','Passed','Failed','Result','Defect','Inspector','Inspected at'],qualityRows)}`,
    planning: `${form('forecast','Add demand forecast',`<label>Product<select name="productId" required>${productOptions(['FINISHED_GOOD','SEMI_FINISHED_GOOD'])}</select></label><label>Forecast date<input name="forecastDate" type="date" value="${today()}" required /></label><label>Forecast quantity<input name="quantity" type="number" min="0.000001" step="0.001" required /></label><label>Notes<input name="notes" maxlength="500" /></label>`,'manufacturing:mrp:run')}<h3>Demand forecast</h3>${table(['Product','Date','Quantity','Notes'],forecastRows)}${form('maintenance','Schedule equipment maintenance',`<label>Work center<select name="workCenterId" required>${(workspace.workCenters || []).filter((center)=>center.active).map((center)=>`<option value="${center.id}">${escapeHtml(center.code)} · ${escapeHtml(center.name)}</option>`).join('')}</select></label><label>Type<select name="maintenanceType"><option value="PREVENTIVE">Preventive</option><option value="CORRECTIVE">Corrective / downtime</option></select></label><label>Description<input name="description" maxlength="240" required /></label><label>Scheduled date<input name="scheduledDate" type="date" value="${today()}" required /></label><label>Next due date<input name="nextDueDate" type="date" /></label><label class="manufacturing-wide">Notes<textarea name="notes" rows="2"></textarea></label>`,'manufacturing:routing:manage')}<h3>Maintenance schedule and downtime</h3>${table(['Work center','Type','Description','Scheduled','Next due','Downtime','Status','Action'],maintenanceRows)}${form('downtime','+ Record unplanned production stoppage',`<label>Work center<select name="workCenterId" required>${(workspace.workCenters || []).filter((center)=>center.active).map((center)=>`<option value="${center.id}">${escapeHtml(center.code)} · ${escapeHtml(center.name)}</option>`).join('')}</select></label><label>Production order<select name="manufacturingOrderId"><option value="">Not linked to an order</option>${(workspace.orders || []).filter((order)=>['RELEASED','IN_PROGRESS'].includes(order.status)).map((order)=>`<option value="${order.id}">${escapeHtml(order.order_number)} · ${escapeHtml(order.finished_sku)}</option>`).join('')}</select></label><label>Date<input name="downtimeDate" type="date" value="${today()}" required /></label><label>Downtime minutes<input name="downtimeMinutes" type="number" min="0.01" step="0.01" required /></label><label>Stop reason<input name="reason" maxlength="120" required placeholder="Breakdown, material shortage, quality hold…" /></label><label class="manufacturing-wide">Notes<textarea name="notes" rows="2"></textarea></label>`,'manufacturing:orders:release')}<h3>Unplanned production stoppages</h3>${table(['Date','Work center','Production order','Downtime','Reason','Notes'],downtimeRows)}`,
    mrp: `${form('mrp','Run MRP',`<label>Demand source<select name="demandSource"><option value="SALES_ORDERS">Approved sales orders</option><option value="FORECAST">Demand forecast</option><option value="COMBINED">Sales orders + forecast</option></select></label><label>Planning date<input name="planningDate" type="date" value="${today()}" required /></label><label>Demand horizon end<input name="endDate" type="date" /></label><label class="manufacturing-wide">Override demand JSON (optional)<textarea name="demands" rows="3" placeholder='[{"productId":"...","quantity":100}]'></textarea></label>`,'manufacturing:mrp:run')}${form('purchase-supply','Register open purchase supply',`<label>PO number<input name="purchaseOrderNumber" required /></label><label>Material<select name="productId" required>${productOptions(['RAW_MATERIAL','SEMI_FINISHED_GOOD'])}</select></label><label>Ordered quantity<input name="orderedQuantity" type="number" min="0.000001" step="0.001" required /></label><label>Due date<input name="dueDate" type="date" /></label>`,'manufacturing:mrp:run')}${form('raw-lot','Register raw material lot',`<label>Receipt transaction<select name="inventoryTransactionId" required>${workspace.inventoryReceipts.map((receipt) => { const product=products.find((item)=>item.id===receipt.product_id); return `<option value="${receipt.id}">${escapeHtml(product?.sku || receipt.product_id)} · ${Number(receipt.quantity)} · ${escapeHtml(String(receipt.transaction_date).slice(0,10))}</option>`; }).join('')}</select></label><label>Lot number<input name="lotNumber" required /></label><label>Lot quantity<input name="quantity" type="number" min="0.000001" step="0.001" required /></label>`,'manufacturing:materials:consume')}<div class="manufacturing-mrp-results"><div class="manufacturing-section-heading"><h3>Latest material requirements</h3>${hasRolePermission('manufacturing:reports:read') ? '<button type="button" class="secondary-btn" data-manufacturing-action="mrp-refresh">Refresh</button>' : ''}</div>${mrp ? table(['Material','Gross required','Safety','On hand','Reserved','Open purchase','Open production','Net requirement','Suggested'],mrp.requirements.map((item)=>`<tr><td>${escapeHtml(item.sku)} · ${escapeHtml(item.product_name)}</td><td>${Number(item.gross_required)}</td><td>${Number(item.safety_stock)}</td><td>${Number(item.on_hand)}</td><td>${Number(item.reserved)}</td><td>${Number(item.open_purchase)}</td><td>${Number(item.open_production)}</td><td>${Number(item.net_requirement)}</td><td>${Number(item.suggested_quantity)}</td></tr>`).join('')) : '<p>No MRP run yet.</p>'}</div><h3>Open purchase supply</h3>${table(['Purchase order','Material','Ordered','Received','Due','Status'],workspace.openPurchaseSupply.map((item)=>`<tr><td>${escapeHtml(item.purchase_order_number)}</td><td>${escapeHtml(products.find((product)=>product.id===item.product_id)?.sku || item.product_id)}</td><td>${Number(item.ordered_quantity)}</td><td>${Number(item.received_quantity)}</td><td>${item.due_date ? String(item.due_date).slice(0,10) : '—'}</td><td>${escapeHtml(item.status)}</td></tr>`).join(''))}`,
    reports: `<label class="manufacturing-report-select">Report<select id="manufacturing-report-type">${[['production-plan','Production plan'],['orders','Production orders'],['consumption','Material consumption'],['variance','Production variance'],['wip','WIP'],['production-cost','Production cost'],['machine-utilization','Machine utilization'],['yield','Yield and scrap'],['scrap','Scrap']].map(([value,label])=>`<option value="${value}" ${manufacturingState.reportType===value?'selected':''}>${label}</option>`).join('')}</select></label><div class="manufacturing-section-heading"><h3>${escapeHtml(manufacturingState.reportType)}</h3><button type="button" class="secondary-btn" data-manufacturing-action="load-report">Refresh</button></div>${reportTable}<h3>Batch traceability</h3><form class="manufacturing-data-form compact-manufacturing-form" data-manufacturing-form="trace"><label>Batch / lot number<input name="lotNumber" required /></label><button class="primary-btn" type="submit">Trace lot</button><span class="manufacturing-form-error" role="alert"></span></form>${manufacturingState.trace ? `<pre class="manufacturing-trace">${escapeHtml(JSON.stringify(manufacturingState.trace,null,2))}</pre>` : ''}`,
  };
  return `<section class="content-panel manufacturing-workspace"><div class="panel-header"><div><p class="eyebrow">Production operations</p><h2>Manufacturing control</h2></div><button type="button" class="secondary-btn" data-manufacturing-action="refresh">Refresh</button></div>${manufacturingState.error ? `<p class="manufacturing-error" role="alert">${escapeHtml(manufacturingState.error)}</p>` : ''}<nav class="manufacturing-tabs" aria-label="Manufacturing sections">${tabs.map(([key,label])=>`<button type="button" data-manufacturing-tab="${key}" class="${active===key?'active':''}">${label}</button>`).join('')}</nav><div class="manufacturing-content">${contents[active]}</div></section>`;
}

function showRecordEditDialog(module, identifier) {
  const source = module === 'sales' ? applicationData.salesOrders
    : module === 'inventory' ? applicationData.inventoryItems
    : module === 'procurement' ? applicationData.purchaseOrders
    : module === 'employee' ? applicationData.employees
    : module === 'finance' ? applicationData.financeLedger
    : module === 'manufacturing' ? manufacturingState.productionOrders
    : bankingState.transactions;
  const record = source.find((item) => String(item.id || item.sku || item.po || item.name || item.title) === String(identifier));
  if (!record) return;

  const dialog = document.createElement('div');
  dialog.className = 'modal-backdrop';
  dialog.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="edit-record-title"><div class="modal-header"><div><p class="eyebrow">Record update</p><h2 id="edit-record-title">Edit ${module}</h2></div><button type="button" class="modal-close" aria-label="Close">×</button></div><form id="edit-record-form" class="action-form"><div class="form-error" hidden></div></form></div>`;
  document.body.appendChild(dialog);
  const form = dialog.querySelector('#edit-record-form');
  const fields = {
    sales: [['customer', 'Customer', 'text'], ['date', 'Date', 'date'], ['amount', 'Amount', 'number'], ['status', 'Status', 'select', [['Pending', 'Pending'], ['Processing', 'Processing'], ['Paid', 'Paid'], ['Cancelled', 'Cancelled']]]],
    inventory: [['sku', 'SKU', 'text'], ['name', 'Name', 'text'], ['stock', 'Stock', 'number'], ['reorderLevel', 'Reorder level', 'number'], ['location', 'Location', 'text'], ['unitPrice', 'Unit price', 'number']],
    procurement: [['vendor', 'Vendor', 'text'], ['eta', 'ETA', 'date'], ['amount', 'Amount', 'number'], ['status', 'Status', 'select', [['Pending', 'Pending'], ['In Transit', 'In Transit'], ['Delivered', 'Delivered'], ['Cancelled', 'Cancelled']]]],
    employee: [['name', 'Name', 'text'], ['role', 'Role', 'text'], ['department', 'Department', 'text'], ['attendance', 'Attendance %', 'number']],
    finance: [['title', 'Title', 'text'], ['type', 'Type', 'select', [['Revenue', 'Revenue'], ['Expense', 'Expense']]], ['date', 'Date', 'date'], ['amount', 'Amount', 'number']],
    manufacturing: [['product', 'Product', 'text'], ['quantity', 'Quantity', 'number'], ['completed', 'Completed', 'number'], ['dueDate', 'Due date', 'date'], ['workCenter', 'Work center', 'text'], ['status', 'Status', 'select', [['Scheduled', 'Scheduled'], ['In Progress', 'In Progress'], ['Completed', 'Completed'], ['Blocked', 'Blocked']]], ['priority', 'Priority', 'select', [['Normal', 'Normal'], ['High', 'High'], ['Critical', 'Critical']]]],
    banking: [['accountId', 'Account', 'select', bankingState.accounts.map((account) => [account.id, `${account.name} (${account.currency})`])], ['date', 'Date', 'date'], ['description', 'Description', 'text'], ['category', 'Category', 'select', [['Customer receipt', 'Customer receipt'], ['Supplier payment', 'Supplier payment'], ['Payroll', 'Payroll'], ['Bank charge', 'Bank charge'], ['Other', 'Other']]], ['type', 'Type', 'select', [['Credit', 'Credit'], ['Debit', 'Debit']]], ['amount', 'Amount', 'number'], ['status', 'Status', 'select', [['Pending', 'Pending'], ['Cleared', 'Cleared'], ['Rejected', 'Rejected']]], ['reference', 'Reference', 'text']],
  };

  const fieldMarkup = fields[module] || [];
  form.innerHTML = fieldMarkup.map(([name, label, type, options]) => {
    const value = record[name] ?? '';
    if (type === 'select') {
      return `<label>${label}<select name="${name}" required>${options.map((option) => Array.isArray(option) ? `<option value="${option[0]}" ${String(value) === String(option[0]) ? 'selected' : ''}>${option[1]}</option>` : `<option value="${option}">${option}</option>`).join('')}</select></label>`;
    }
    return `<label>${label}<input name="${name}" type="${type}" value="${escapeHtml(value)}" ${type === 'number' ? 'step="0.01"' : ''} required /></label>`;
  }).join('') + '<div class="modal-actions"><button type="button" class="ghost-btn modal-close">Cancel</button><button type="submit" class="primary-btn">Save changes</button></div>';
  dialog.querySelectorAll('.modal-close').forEach((button) => button.addEventListener('click', () => dialog.remove()));
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.remove(); });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    const payload = { ...values };
    if (['sales', 'procurement', 'finance', 'banking'].includes(module)) payload.amount = Number(values.amount);
    if (['inventory', 'employee', 'manufacturing'].includes(module)) payload.quantity = Number(values.quantity);
    if (module === 'employee') payload.attendance = Number(values.attendance);
    if (module === 'manufacturing') payload.completed = Number(values.completed);
    try {
      const endpoint = module === 'banking'
        ? `/api/banking/transactions/${encodeURIComponent(identifier)}`
        : module === 'employee'
          ? `/api/hr/${encodeURIComponent(identifier)}`
          : `/api/${module}/${encodeURIComponent(identifier)}`;
      await fetchJson(endpoint, { method: 'PUT', body: JSON.stringify(payload) });
      await loadApplicationData();
      dialog.remove();
      render();
    } catch (error) {
      form.querySelector('.form-error').textContent = error.message;
      form.querySelector('.form-error').hidden = false;
    }
  });
  document.body.appendChild(dialog);
  dialog.querySelector('input')?.focus();
}

function confirmRecordDelete(module, identifier) {
  const source = module === 'sales' ? applicationData.salesOrders
    : module === 'inventory' ? applicationData.inventoryItems
    : module === 'procurement' ? applicationData.purchaseOrders
    : module === 'employee' ? applicationData.employees
    : module === 'finance' ? applicationData.financeLedger
    : module === 'manufacturing' ? manufacturingState.productionOrders
    : bankingState.transactions;
  const record = source.find((item) => String(item.id || item.sku || item.po || item.name || item.title) === String(identifier));
  if (!record) return;
  const label = record.name || record.customer || record.vendor || record.title || record.product || record.id || record.sku || record.po;
  const dialog = document.createElement('div');
  dialog.className = 'modal-backdrop';
  dialog.innerHTML = `<div class="modal-card confirm-card" role="alertdialog" aria-modal="true"><div class="modal-header"><div><p class="eyebrow">Delete record</p><h2>Confirm deletion</h2></div><button type="button" class="modal-close" aria-label="Close">×</button></div><p>Delete <strong>${escapeHtml(label)}</strong> from ${module}? This action cannot be undone.</p><div class="modal-actions"><button type="button" class="ghost-btn modal-close">Cancel</button><button type="button" class="danger-btn" id="confirm-delete">Delete record</button></div></div>`;
  document.body.appendChild(dialog);
  const close = () => dialog.remove();
  dialog.querySelectorAll('.modal-close').forEach((button) => button.addEventListener('click', close));
  dialog.addEventListener('click', (event) => { if (event.target === dialog) close(); });
  dialog.querySelector('#confirm-delete').addEventListener('click', async () => {
    const endpoint = module === 'banking'
      ? `/api/banking/transactions/${encodeURIComponent(identifier)}`
      : module === 'employee'
        ? `/api/hr/${encodeURIComponent(identifier)}`
        : `/api/${module}/${encodeURIComponent(identifier)}`;
    try {
      await fetchJson(endpoint, { method: 'DELETE' });
      await loadApplicationData();
      dialog.remove();
      render();
    } catch (error) {
      dialog.querySelector('p').textContent = error.message;
    }
  });
}

async function loadManufacturingReport() {
  try {
    manufacturingState.reportRows = await fetchJson(`/api/manufacturing/reports/${encodeURIComponent(manufacturingState.reportType)}`);
    manufacturingState.error = '';
  } catch (error) {
    manufacturingState.error = error.message;
  }
}

async function handleManufacturingDataForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const type = form.dataset.manufacturingForm;
  const values = Object.fromEntries(new FormData(form).entries());
  const error = form.querySelector('.manufacturing-form-error');
  if (error) { error.textContent = ''; error.hidden = true; }
  try {
    let endpoint;
    let method = 'POST';
    let payload = { ...values };
    if (type === 'bom') {
      endpoint = '/api/manufacturing/boms';
      payload.scrapPercent = Number(values.scrapPercent || 0);
      try { payload.lines = JSON.parse(values.lines); } catch { throw new Error('BOM material lines must be valid JSON.'); }
    } else if (type === 'work-center') {
      endpoint = '/api/manufacturing/work-centers';
      for (const field of ['machineCapacity','laborCapacity','machineHourRate','laborHourRate','overheadHourRate']) payload[field] = Number(values[field] || 0);
      try { payload.calendar = JSON.parse(values.calendar); } catch { throw new Error('Work-center calendar must be valid JSON.'); }
    } else if (type === 'routing') {
      endpoint = '/api/manufacturing/routings';
      try { payload.operations = JSON.parse(values.operations); } catch { throw new Error('Routing operations must be valid JSON.'); }
    } else if (type === 'order') {
      endpoint = '/api/manufacturing/work-orders';
      payload.plannedQuantity = Number(values.plannedQuantity);
      payload.routingId = values.routingId || null;
    } else if (type === 'mrp') {
      endpoint = '/api/manufacturing/mrp/run';
      if (values.demands.trim()) {
        try { payload.demands = JSON.parse(values.demands); } catch { throw new Error('MRP demand override must be valid JSON.'); }
      } else delete payload.demands;
    } else if (type === 'forecast') {
      endpoint = '/api/manufacturing/forecasts';
      payload.quantity = Number(values.quantity);
    } else if (type === 'maintenance') {
      endpoint = '/api/manufacturing/maintenance';
      } else if (type === 'downtime') {
        endpoint = '/api/manufacturing/downtime';
        payload.downtimeMinutes = Number(values.downtimeMinutes);
        payload.manufacturingOrderId = values.manufacturingOrderId || null;
      } else if (type === 'purchase-supply') {
      endpoint = '/api/manufacturing/mrp/open-supply';
      payload.orderedQuantity = Number(values.orderedQuantity);
    } else if (type === 'raw-lot') {
      endpoint = '/api/manufacturing/lots/raw';
      payload.quantity = Number(values.quantity);
    } else if (type === 'quality') {
      endpoint = '/api/manufacturing/quality-inspections';
      payload.inspectedQuantity = Number(values.inspectedQuantity);
      payload.passedQuantity = Number(values.passedQuantity);
      payload.failedQuantity = Number(values.failedQuantity);
    } else if (type === 'consume') {
      endpoint = `/api/manufacturing/work-orders/${encodeURIComponent(form.dataset.order)}/consume`;
      payload.quantity = Number(values.quantity);
    } else if (type === 'output') {
      endpoint = `/api/manufacturing/work-orders/${encodeURIComponent(form.dataset.order)}/output`;
      payload.producedQuantity = Number(values.producedQuantity);
      payload.rejectedQuantity = Number(values.rejectedQuantity || 0);
    } else if (type === 'complete-operation') {
      endpoint = `/api/manufacturing/work-orders/${encodeURIComponent(form.dataset.order)}/operations/${encodeURIComponent(form.dataset.operation)}/complete`;
      payload.actualMachineHours = Number(values.actualMachineHours);
      payload.actualLaborHours = Number(values.actualLaborHours);
    } else if (type === 'trace') {
      manufacturingState.trace = await fetchJson(`/api/manufacturing/lots/${encodeURIComponent(values.lotNumber)}/trace`);
      render();
      return;
    } else return;
    const result = await fetchJson(endpoint, { method, body: JSON.stringify(payload) });
    if (type === 'order') {
      manufacturingState.selectedOrderId = result.id;
      manufacturingState.tab = 'orders';
    }
    if (type === 'mrp') manufacturingState.tab = 'mrp';
    await loadManufacturingData();
    if (type === 'mrp') await loadManufacturingReport();
    render();
  } catch (requestError) {
    if (error) { error.textContent = requestError.message; error.hidden = false; }
    else { manufacturingState.error = requestError.message; render(); }
  }
}

async function handleManufacturingAction(action, id, orderId) {
  try {
    let endpoint;
    let body = {};
    let method = 'POST';
    if (action === 'activate-bom') endpoint = `/api/manufacturing/boms/${encodeURIComponent(id)}/activate`;
    else if (action === 'maintenance-complete') {
      const downtime = window.prompt('Actual equipment downtime in minutes:', '0');
      if (downtime === null) return;
      if (!Number.isFinite(Number(downtime)) || Number(downtime) < 0) throw new Error('Downtime must be a non-negative number of minutes.');
      endpoint = `/api/manufacturing/maintenance/${encodeURIComponent(id)}/complete`;
      body = { downtimeMinutes: Number(downtime) };
    }
    else if (['release','start','close'].includes(action)) endpoint = `/api/manufacturing/work-orders/${encodeURIComponent(id)}/${action}`;
    else if (action === 'start-operation') endpoint = `/api/manufacturing/work-orders/${encodeURIComponent(orderId)}/operations/${encodeURIComponent(id)}/start`;
    else if (action === 'complete-operation') endpoint = `/api/manufacturing/work-orders/${encodeURIComponent(orderId)}/operations/${encodeURIComponent(id)}/complete`;
    else if (action === 'load-report') { await loadManufacturingReport(); render(); return; }
    else if (action === 'mrp-refresh' || action === 'refresh') { await loadManufacturingData(); render(); return; }
    else return;
    await fetchJson(endpoint, { method, body: JSON.stringify(body) });
    await loadManufacturingData();
    if (manufacturingState.reportType) await loadManufacturingReport();
    render();
  } catch (error) {
    manufacturingState.error = error.message;
    render();
  }
}

function showManufacturingForm() {
  const panel = document.getElementById('manufacturing-form-panel');
  if (!panel) return;
  const workCenterOptions = manufacturingState.workCenters.map((center) => `<option>${center.name}</option>`).join('');
  panel.innerHTML = `<div class="panel-header"><div><p class="eyebrow">Production planning</p><h2>New production order</h2></div><button class="ghost-btn" type="button" data-manufacturing-close>Close</button></div><form id="manufacturing-form" class="manufacturing-form"><label>Product<input name="product" required /></label><label>Quantity<input name="quantity" type="number" min="1" step="1" required /></label><label>Due date<input name="dueDate" type="date" required /></label><label>Work center<select name="workCenter">${workCenterOptions}</select></label><label>Priority<select name="priority"><option>Normal</option><option>High</option><option>Critical</option></select></label><button class="primary-btn" type="submit">Create order</button><div class="manufacturing-form-error" hidden></div></form>`;
  panel.hidden = false;
  panel.querySelector('[data-manufacturing-close]')?.addEventListener('click', () => { panel.hidden = true; });
  panel.querySelector('#manufacturing-form')?.addEventListener('submit', handleManufacturingSubmit);
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function handleManufacturingSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = form.querySelector('.manufacturing-form-error');
  const formData = Object.fromEntries(new FormData(form).entries());
  try {
    await fetchJson('/api/manufacturing/orders', { method: 'POST', body: JSON.stringify({ ...formData, quantity: Number(formData.quantity) }) });
    const manufacturing = await fetchJson('/api/manufacturing');
    manufacturingState.productionOrders = manufacturing.productionOrders;
    manufacturingState.workCenters = manufacturing.workCenters;
    manufacturingState.billOfMaterials = manufacturing.billOfMaterials;
    manufacturingState.summary = manufacturing.summary;
    render();
  } catch (error) {
    if (errorBox) { errorBox.textContent = error.message; errorBox.hidden = false; }
  }
}

function showActionForm(action) {
  let panel = document.getElementById('action-form-panel');
  if (!panel) {
    panel = document.createElement('section');
    panel.id = 'action-form-panel';
    panel.className = 'content-panel action-form-panel';
    document.querySelector('.main-panel')?.prepend(panel);
  }

  const forms = {
    sales: { title: 'New sales order', endpoint: '/api/sales', fields: '<label>Customer<input name="customer" required /></label><label>Date<input name="date" type="date" required /></label><label>Amount<input name="amount" type="number" min="0.01" step="0.01" required /></label><label>Status<select name="status"><option>Pending</option><option>Processing</option><option>Paid</option></select></label>' },
    inventory: { title: 'Inventory movement', endpoint: '/api/inventory', fields: `<label>Operation<select name="operation"><option value="receive">Receive stock</option><option value="issue">Stock out</option><option value="send">Send / dispatch</option></select></label><label>Item<select name="sku">${applicationData.inventoryItems.map((item) => `<option value="${item.sku}">${item.name} (${item.sku})</option>`).join('')}</select></label><label>Quantity<input name="quantity" type="number" min="1" step="1" required /></label><label>Destination / reference<input name="destination" placeholder="Customer, work order, or warehouse" /></label>` },
    procurement: { title: 'Create purchase order', endpoint: '/api/procurement', fields: '<label>Vendor<input name="vendor" required /></label><label>ETA<input name="eta" type="date" required /></label><label>Amount<input name="amount" type="number" min="0.01" step="0.01" required /></label><label>Status<select name="status"><option>Pending</option><option>In Transit</option></select></label>' },
    employee: { title: 'Add employee', endpoint: '/api/employees', fields: '<label>Name<input name="name" required /></label><label>Role<input name="role" required /></label><label>Department<input name="department" required /></label><label>Attendance %<input name="attendance" type="number" min="0" max="100" value="100" required /></label>' },
    finance: { title: 'Add finance transaction', endpoint: '/api/finance', fields: '<label>Title<input name="title" required /></label><label>Type<select name="type"><option>Revenue</option><option>Expense</option></select></label><label>Date<input name="date" type="date" required /></label><label>Amount<input name="amount" type="number" min="0.01" step="0.01" required /></label>' },
  };
  const config = forms[action];
  if (!config) return;
  panel.innerHTML = `<div class="panel-header"><div><p class="eyebrow">Quick action</p><h2>${config.title}</h2></div><button class="ghost-btn" type="button" data-action-close>Close</button></div><form class="action-form" data-action-type="${action}" data-action-endpoint="${config.endpoint}">${config.fields}<button class="primary-btn" type="submit">Save</button><div class="action-form-error" hidden></div></form>`;
  panel.hidden = false;
  panel.querySelector('[data-action-close]')?.addEventListener('click', () => { panel.hidden = true; });
  panel.querySelector('.action-form')?.addEventListener('submit', handleActionFormSubmit);
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function handleActionFormSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const action = form.dataset.actionType;
  const values = Object.fromEntries(new FormData(form).entries());
  const errorBox = form.querySelector('.action-form-error');
  const payload = { ...values };
  if (['sales', 'procurement', 'finance'].includes(action)) payload.amount = Number(values.amount);
  if (action === 'inventory' || action === 'employee') payload.quantity = Number(values.quantity);
  if (action === 'employee') payload.attendance = Number(values.attendance);
  const url = action === 'inventory' ? `${form.dataset.actionEndpoint}/${encodeURIComponent(values.sku)}/${values.operation === 'receive' ? 'restock' : values.operation}` : form.dataset.actionEndpoint;

  try {
    await fetchJson(url, { method: 'POST', body: JSON.stringify(payload) });
    await loadApplicationData();
    render();
  } catch (error) {
    if (errorBox) { errorBox.textContent = error.message; errorBox.hidden = false; }
  }
}

async function showAccountingJournal(journalId) {
  try {
    const journal = await fetchJson(`/api/accounting/journals/${encodeURIComponent(journalId)}`);
    const dialog = document.createElement('div');
    dialog.className = 'modal-backdrop';
    dialog.innerHTML = `<div class="modal-card accounting-detail-modal" role="dialog" aria-modal="true"><div class="modal-header"><div><p class="eyebrow">${escapeHtml(journal.journal_number)}</p><h2>${escapeHtml(journal.description)}</h2></div><button class="modal-close" type="button" aria-label="Close">×</button></div><p>${escapeHtml(String(journal.transaction_date).slice(0, 10))} · ${escapeHtml(journal.status)} · ${escapeHtml(journal.source_module)}</p><div class="table-wrap"><table><thead><tr><th>Account</th><th>Description</th><th>Debit</th><th>Credit</th></tr></thead><tbody>${journal.lines.map((line) => `<tr><td>${escapeHtml(line.account_code)} · ${escapeHtml(line.account_name)}</td><td>${escapeHtml(line.description)}</td><td>${formatCurrency(Number(line.debit))}</td><td>${formatCurrency(Number(line.credit))}</td></tr>`).join('')}</tbody></table></div></div>`;
    dialog.addEventListener('click', (event) => { if (event.target === dialog || event.target.closest('.modal-close')) dialog.remove(); });
    document.body.appendChild(dialog);
  } catch (error) {
    accountingState.error = error.message;
    render();
  }
}

async function toggleAccountingAccount(accountId) {
  const account = accountingState.accounts.find((item) => item.id === accountId);
  if (!account) return;
  try {
    await fetchJson(`/api/accounting/accounts/${encodeURIComponent(accountId)}`, {
      method: 'PUT',
      body: JSON.stringify({
        accountName: account.account_name,
        accountType: account.account_type,
        parentAccountId: account.parent_account_id,
        active: !account.active,
        description: account.description,
        normalBalance: account.normal_balance,
        openingBalance: Number(account.opening_balance),
      }),
    });
    await loadAccountingData();
    render();
  } catch (error) {
    accountingState.error = error.message;
    render();
  }
}

async function handleAccountingFormSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = form.querySelector('.accounting-error');
  if (errorBox) { errorBox.textContent = ''; errorBox.hidden = true; }
  const values = Object.fromEntries(new FormData(form).entries());
  const type = form.dataset.accountingForm;
  try {
    let endpoint;
    let payload = { ...values };
    if (type === 'account') {
      endpoint = '/api/accounting/accounts';
      payload.openingBalance = Number(values.openingBalance || 0);
      payload.parentAccountId = values.parentAccountId || null;
    } else if (type === 'journal') {
      endpoint = '/api/accounting/journals';
      try { payload.lines = JSON.parse(values.lines); }
      catch { throw new Error('Journal lines must be valid JSON.'); }
    } else if (type === 'period') {
      endpoint = '/api/accounting/periods';
      payload.fiscalYear = Number(values.fiscalYear);
      payload.periodNumber = Number(values.periodNumber);
    } else if (type === 'budget-line') {
      endpoint = '/api/accounting/budgets/lines';
      payload.fiscalYear = Number(values.fiscalYear);
      payload.periodStart = `${values.periodStart}-01`;
      payload.amount = Number(values.amount);
      payload.costCenterCode = values.costCenterCode.trim();
      payload.profitCenterCode = values.profitCenterCode.trim();
    } else if (type === 'year-close') {
      endpoint = `/api/accounting/years/${encodeURIComponent(values.fiscalYear)}/close`;
      payload = { retainedEarningsCode: values.retainedEarningsCode };
    } else return;
    await fetchJson(endpoint, { method: type === 'year-close' ? 'POST' : 'POST', body: JSON.stringify(payload) });
    await loadAccountingData();
    render();
  } catch (error) {
    if (errorBox) { errorBox.textContent = error.message; errorBox.hidden = false; }
    else accountingState.error = error.message;
  }
}

async function handleAccountingAction(journalId, action) {
  try {
    await fetchJson(`/api/accounting/journals/${encodeURIComponent(journalId)}/${action}`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    await loadAccountingData();
    render();
  } catch (error) {
    accountingState.error = error.message;
    render();
  }
}

async function closeAccountingPeriodInUi(periodId) {
  try {
    await fetchJson(`/api/accounting/periods/${encodeURIComponent(periodId)}/close`, { method: 'POST', body: '{}' });
    await loadAccountingData();
    render();
  } catch (error) {
    accountingState.error = error.message;
    render();
  }
}

async function reopenAccountingPeriodInUi(periodId) {
  const reason = window.prompt('Enter the reason for reopening this accounting period (required):');
  if (reason === null) return;
  if (!reason.trim()) {
    accountingState.error = 'A reopening reason is required.';
    render();
    return;
  }
  try {
    await fetchJson(`/api/accounting/periods/${encodeURIComponent(periodId)}/reopen`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason.trim() }),
    });
    await loadAccountingData();
    render();
  } catch (error) {
    accountingState.error = error.message;
    render();
  }
}

async function handleSalesFormSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = form.querySelector('.sales-form-error');
  if (error) { error.textContent = ''; }
  const values = Object.fromEntries(new FormData(form).entries());
  const type = form.dataset.salesForm;
  const routes = {
    customer: ['/api/sales/customers', 'POST'],
    quotation: ['/api/sales/quotations', 'POST'],
    order: ['/api/sales/orders', 'POST'],
    delivery: ['/api/sales/deliveries', 'POST'],
    invoice: ['/api/sales/invoices', 'POST'],
    payment: ['/api/sales/payments', 'POST'],
    crm: ['/api/sales/crm', 'POST'],
    activity: ['/api/sales/activities', 'POST'],
    dispute: ['/api/sales/disputes', 'POST'],
    'price-list': ['/api/sales/price-lists', 'POST'],
    'commission-rule': ['/api/sales/commission-rules', 'POST'],
    'sales-target': ['/api/sales/targets', 'POST'],
  };
  const route = routes[type];
  if (!route) return;
  const payload = { ...values };
  if (type === 'customer') {
    payload.creditLimit = Number(values.creditLimit || 0);
    payload.addresses = [
      ['billing', values.billingAddress], ['shipping', values.shippingAddress], ['delivery', values.deliveryAddress],
    ].filter(([, addressLine]) => addressLine).map(([addressType, addressLine]) => ({ addressType, addressLine, country: 'Ethiopia' }));
    delete payload.billingAddress;
    delete payload.shippingAddress;
    delete payload.deliveryAddress;
  }
  if (['quotation', 'order', 'price-list'].includes(type)) {
    try { payload.lines = JSON.parse(values.lines); }
    catch { if (error) error.textContent = 'Product lines must be valid JSON.'; return; }
    if (['quotation', 'order'].includes(type)) payload.discountPercent = Number(values.discountPercent || 0);
    delete payload.linesText;
  }
  if (type === 'payment') payload.amount = Number(values.amount);
  if (type === 'commission-rule') payload.ratePercent = Number(values.ratePercent);
  if (type === 'sales-target') {
    payload.targetAmount = Number(values.targetAmount);
    payload.targetMonth = `${values.targetMonth}-01`;
  }
  try {
    await fetchJson(route[0], { method: route[1], body: JSON.stringify(payload) });
    await loadSalesData();
    render();
  } catch (requestError) {
    if (error) error.textContent = requestError.message;
  }
}

async function handleSalesAction(recordId, action) {
  let url = '';
  let body = {};
  if (action === 'order-amend') {
    const order = salesState.orders.find((item) => item.id === recordId);
    if (!order) {
      window.alert('The selected sales order is no longer available.');
      return;
    }
    const reason = window.prompt('Reason for amending this draft sales order:');
    if (!reason?.trim()) return;
    const currentDeliveryDate = String(order.delivery_date || '').slice(0, 10);
    const deliveryDate = window.prompt('Revised delivery date (YYYY-MM-DD), or leave blank to clear it:', currentDeliveryDate);
    if (deliveryDate === null) return;
    const paymentTerms = window.prompt('Payment terms:', order.payment_terms || '');
    if (paymentTerms === null) return;
    url = `/api/sales/orders/${encodeURIComponent(recordId)}/amend`;
    body = { reason: reason.trim(), deliveryDate: deliveryDate.trim() || null, paymentTerms: paymentTerms.trim() };
  }
  if (action === 'order-cancel') {
    const reason = window.prompt('Reason for cancelling this draft or submitted sales order:');
    if (!reason?.trim()) return;
    url = `/api/sales/orders/${encodeURIComponent(recordId)}/cancel`;
    body.reason = reason.trim();
  }
  if (action === 'price-list-activate' || action === 'price-list-deactivate') {
    url = `/api/sales/price-lists/${encodeURIComponent(recordId)}/status`;
    body.active = action === 'price-list-activate';
  }
  if (action === 'credit-hold' || action === 'credit-release') {
    const reason = window.prompt(action === 'credit-hold' ? 'Reason for placing the customer on credit hold:' : 'Reason for releasing the customer credit hold:');
    if (!reason?.trim()) return;
    url = `/api/sales/customers/${encodeURIComponent(recordId)}/${action}`;
    body.reason = reason.trim();
  }
  if (action === 'quote-submit') url = `/api/sales/quotations/${encodeURIComponent(recordId)}/submit`;
  if (action === 'quote-revise') url = `/api/sales/quotations/${encodeURIComponent(recordId)}/revise`;
  if (action === 'quote-approve' || action === 'quote-reject') {
    url = `/api/sales/quotations/${encodeURIComponent(recordId)}/decision`;
    body.status = action === 'quote-approve' ? 'Approved' : 'Rejected';
  }
  if (action === 'quote-convert') url = `/api/sales/quotations/${encodeURIComponent(recordId)}/convert`;
  if (action === 'order-submit') url = `/api/sales/orders/${encodeURIComponent(recordId)}/submit`;
  if (action === 'order-approve' || action === 'order-reject') {
    url = `/api/sales/orders/${encodeURIComponent(recordId)}/${action === 'order-approve' ? 'approve' : 'reject'}`;
  }
  if (action.startsWith('delivery-')) {
    url = `/api/sales/deliveries/${encodeURIComponent(recordId)}/status`;
    body.status = action.slice('delivery-'.length).replace(/^[a-z]/, (character) => character.toUpperCase());
    if (body.status === 'Delivered') {
      const recipientName = window.prompt('Name of the person receiving this delivery (optional):');
      if (recipientName === null) return;
      const proofOfDeliveryRef = window.prompt('Proof-of-delivery reference (optional):');
      if (proofOfDeliveryRef === null) return;
      body.recipientName = recipientName.trim();
      body.proofOfDeliveryRef = proofOfDeliveryRef.trim();
    }
    if (body.status === 'Shipped') {
      const trackingUrl = window.prompt('Shipment tracking URL (optional):');
      if (trackingUrl === null) return;
      body.trackingUrl = trackingUrl.trim();
    }
  }
  if (action === 'return-request') {
    const reason = window.prompt('Reason for requesting return of this delivery:');
    if (!reason?.trim()) return;
    url = `/api/sales/deliveries/${encodeURIComponent(recordId)}/return-requests`;
    body.reason = reason.trim();
  }
  if (action === 'return-approve' || action === 'return-reject') {
    const resolution = window.prompt(action === 'return-approve' ? 'Approval note for this return:' : 'Reason for rejecting this return:');
    if (!resolution?.trim()) return;
    url = `/api/sales/return-requests/${encodeURIComponent(recordId)}/decision`;
    body = { decision: action === 'return-approve' ? 'APPROVED' : 'REJECTED', resolution: resolution.trim() };
  }
  if (action === 'return-inspect') {
    const request = salesState.returnRequests.find((item) => item.id === recordId);
    if (!request) return;
    const defaultLines = request.delivery_lines.map((line) => ({
      deliveryLineId: line.deliveryLineId,
      receivedQuantity: Number(line.deliveredQuantity),
      restockQuantity: Number(line.deliveredQuantity),
      quarantineQuantity: 0,
      damagedQuantity: 0,
    }));
    const linesInput = window.prompt(
      'Enter the inspected quantities as JSON. For each line, receivedQuantity must equal restockQuantity + quarantineQuantity + damagedQuantity.',
      JSON.stringify(defaultLines),
    );
    if (linesInput === null) return;
    let lines;
    try {
      lines = JSON.parse(linesInput);
    } catch {
      window.alert('Inspection quantities must be valid JSON.');
      return;
    }
    const notes = window.prompt('Inspection notes (optional):');
    if (notes === null) return;
    url = `/api/sales/return-requests/${encodeURIComponent(recordId)}/inspection`;
    body = { lines, notes };
  }
  if (action === 'invoice-issue') url = `/api/sales/invoices/${encodeURIComponent(recordId)}/issue`;
  if (action === 'dispute-review' || action === 'dispute-resolve') {
    url = `/api/sales/disputes/${encodeURIComponent(recordId)}/status`;
    body.status = action === 'dispute-review' ? 'UNDER_REVIEW' : 'RESOLVED';
    if (action === 'dispute-resolve') {
      const resolution = window.prompt('Resolution note for this receivable dispute:');
      if (!resolution?.trim()) return;
      body.resolution = resolution.trim();
    }
  }
  if (!url) return;
  try {
    await fetchJson(url, { method: action.startsWith('price-list-') ? 'PUT' : 'POST', body: JSON.stringify(body) });
    await loadSalesData();
    render();
  } catch (error) {
    window.alert(error.message);
  }
}

function showBankForm(action) {
  const panel = document.getElementById('bank-form-panel');
  if (!panel) return;

  const matchedStatementIds = new Set(bankingState.reconciliationHistory.map((entry) => entry.statementTransactionId));
  const matchedCashbookIds = new Set(bankingState.reconciliationHistory.map((entry) => entry.cashbookTransactionId));
  const accountOptions = bankingState.accounts
    .map((account) => `<option value="${account.id}">${account.name} (${account.currency})</option>`)
    .join('');

  if (action === 'account') {
    panel.innerHTML = `
      <div class="panel-header"><div><p class="eyebrow">Banking setup</p><h2>Add bank account</h2></div><button class="ghost-btn" type="button" data-bank-close>Close</button></div>
      <form id="bank-form" class="bank-form" data-bank-form="account">
        <label>Account code<input name="code" maxlength="40" required /></label>
        <label>Account name<input name="name" maxlength="160" required /></label>
        <label>Bank<input name="bank" maxlength="160" /></label>
        <label>Account number / masked number<input name="accountNumber" maxlength="80" required /></label>
        <label>Currency<input name="currency" maxlength="3" pattern="[A-Za-z]{3}" required value="ETB" /></label>
        <label>Opening balance<input name="openingBalance" type="number" min="0" step="0.01" required value="0" /></label>
        <label>Account type<input name="type" maxlength="40" required /></label>
        <button class="primary-btn" type="submit">Save account</button>
        <div class="bank-form-error" hidden></div>
      </form>
    `;
  } else if (action === 'reconcile') {
    const statementOptions = bankingState.statementTransactions
      .filter((transaction) => !matchedStatementIds.has(transaction.id))
      .map((transaction) => {
        const currency = bankingState.accounts.find((account) => account.id === transaction.accountId)?.currency || '';
        return `<option value="${escapeHtml(transaction.id)}">${escapeHtml(transaction.reference || transaction.description)} · ${formatBankAmount(transaction.amount, currency)}</option>`;
      })
      .join('');
    const cashbookOptions = bankingState.transactions
      .filter((transaction) => !matchedCashbookIds.has(transaction.id))
      .map((transaction) => {
        const currency = bankingState.accounts.find((account) => account.id === transaction.accountId)?.currency || '';
        return `<option value="${escapeHtml(transaction.id)}">${escapeHtml(transaction.reference || transaction.description)} · ${formatBankAmount(transaction.amount, currency)}</option>`;
      })
      .join('');
    panel.innerHTML = `
      <div class="panel-header"><div><p class="eyebrow">Cash matching</p><h2>Bank reconciliation</h2></div><button class="ghost-btn" type="button" data-bank-close>Close</button></div>
      <form id="bank-form" class="bank-form reconciliation-form" data-bank-form="reconcile">
        <label>Statement transaction<select name="statementTransactionId" required><option value="">Select an unmatched statement item</option>${statementOptions}</select></label>
        <label>Cashbook transaction<select name="cashbookTransactionId" required><option value="">Select an unmatched cashbook item</option>${cashbookOptions}</select></label>
        <label>Match method<select name="method" required><option value="reference">Reference</option><option value="manual">Manual</option><option value="amount">Amount</option></select></label>
        <button class="primary-btn" type="submit">Match items</button>
        <div class="bank-form-error" hidden></div>
      </form>
    `;
  } else {
    panel.innerHTML = action === 'transfer'
      ? `
        <div class="panel-header"><div><p class="eyebrow">Internal movement</p><h2>Transfer funds</h2></div><button class="ghost-btn" type="button" data-bank-close>Close</button></div>
        <form id="bank-form" class="bank-form" data-bank-form="transfer">
          <label>From account<select name="fromAccountId" required>${accountOptions}</select></label>
          <label>To account<select name="toAccountId" required>${accountOptions}</select></label>
          <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required /></label>
          <label>Description<input name="description" required value="Internal transfer" /></label>
          <button class="primary-btn" type="submit">Create transfer</button>
          <div class="bank-form-error" hidden></div>
        </form>
      `
      : `
        <div class="panel-header"><div><p class="eyebrow">Cash activity</p><h2>Record transaction</h2></div><button class="ghost-btn" type="button" data-bank-close>Close</button></div>
        <form id="bank-form" class="bank-form" data-bank-form="transaction">
          <label>Account<select name="accountId" required>${accountOptions}</select></label>
          <label>Type<select name="type" required><option value="Credit">Credit / money in</option><option value="Debit">Debit / money out</option></select></label>
          <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required /></label>
          <label>Description<input name="description" required /></label>
          <label>Category<select name="category"><option>Customer receipt</option><option>Supplier payment</option><option>Payroll</option><option>Bank charge</option><option>Other</option></select></label>
          <label>Reference<input name="reference" placeholder="Invoice, PO, or cheque number" /></label>
          <button class="primary-btn" type="submit">Save transaction</button>
          <div class="bank-form-error" hidden></div>
        </form>
      `;
  }

  panel.hidden = false;
  panel.querySelector('[data-bank-close]')?.addEventListener('click', () => {
    panel.hidden = true;
  });
  panel.querySelector('#bank-form')?.addEventListener('submit', handleBankFormSubmit);
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function handleBankFormSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = form.querySelector('.bank-form-error');
  const formData = Object.fromEntries(new FormData(form).entries());
  const isTransfer = form.dataset.bankForm === 'transfer';
  const isReconciliation = form.dataset.bankForm === 'reconcile';
  const isAccount = form.dataset.bankForm === 'account';

  try {
    const endpoint = isAccount
      ? '/api/banking/accounts'
      : isReconciliation
      ? '/api/banking/reconciliation/matches'
      : isTransfer ? '/api/banking/transfers' : '/api/banking/transactions';
    const payload = isAccount
      ? { ...formData, openingBalance: Number(formData.openingBalance) }
      : isReconciliation ? formData : { ...formData, amount: Number(formData.amount) };
    await fetchJson(endpoint, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    updateBankingData(await fetchJson('/api/banking'));
    render();
  } catch (error) {
    if (errorBox) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
    }
  }
}

async function handleBankAutoMatch(button) {
  button.disabled = true;
  bankingState.error = '';
  try {
    const result = await fetchJson('/api/banking/reconciliation/auto-match', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    updateBankingData(await fetchJson('/api/banking'));
    bankingState.error = result.created.length
      ? `Matched ${result.created.length} statement ${result.created.length === 1 ? 'item' : 'items'}.`
      : 'No additional exact matches were found.';
    render();
  } catch (error) {
    bankingState.error = error.message;
    render();
  }
}

async function handleBankApproval(button) {
  const action = button.dataset.bankApproval;
  const transactionId = button.dataset.transactionId;
  try {
    await fetchJson(`/api/banking/transactions/${encodeURIComponent(transactionId)}/${action}`, { method: 'POST' });
    updateBankingData(await fetchJson('/api/banking'));
    render();
  } catch (error) {
    window.alert(error.message);
  }
}

function exportReport() {
  void exportLiveReport();
}

const reportColumnLabels = Object.freeze({
  module: 'Module',
  report: 'Report',
  current: 'Current period',
  previous: 'Previous period',
  change: 'Change',
  count: 'Transactions',
});

function getFilteredReportRows() {
  const query = reportsState.filter.trim().toLowerCase();
  return reportsState.rows
    .filter((row) => !query || `${row.module} ${row.label} ${row.source}`.toLowerCase().includes(query))
    .sort((left, right) => {
      const a = left[reportsState.sortBy === 'report' ? 'label' : reportsState.sortBy];
      const b = right[reportsState.sortBy === 'report' ? 'label' : reportsState.sortBy];
      const comparison = typeof a === 'number' && typeof b === 'number'
        ? a - b
        : String(a ?? '').localeCompare(String(b ?? ''));
      return reportsState.sortDirection === 'asc' ? comparison : -comparison;
    });
}

function formatReportValue(value, row) {
  if (value === null || value === undefined) return '—';
  if (typeof value !== 'number') return escapeHtml(value);
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: row.currency || 'ETB',
    maximumFractionDigits: 2,
  }).format(value);
}

async function exportLiveReport() {
  const rows = getFilteredReportRows();
  if (!rows.length) {
    reportsState.error = 'There are no report rows to export with the current filter.';
    render();
    return;
  }
  try {
    await fetchJson('/api/reports/exports', {
      method: 'POST',
      body: JSON.stringify({
        reportKey: 'dashboard-summary',
        format: 'csv',
        range: reportsState.range,
        filter: reportsState.filter,
      }),
    });
    const columns = reportsState.columns;
    const csvCell = (value) => {
      let text = String(value ?? '');
      if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
      return `"${text.replaceAll('"', '""')}"`;
    };
    const values = (row, key) => {
      if (key === 'module') return row.module;
      if (key === 'report') return row.label;
      if (key === 'current') return row.current;
      if (key === 'previous') return row.previous ?? '';
      if (key === 'change') return row.change ?? '';
      if (key === 'count') return row.count ?? '';
      return '';
    };
    const csv = [
      ['Report', 'Dashboard summary'],
      ['Reporting period', reportsState.period ? `${reportsState.period.start} to ${reportsState.period.end}` : reportsState.range],
      ['Filter', reportsState.filter || 'None'],
      ['Generated at', reportsState.generatedAt || new Date().toISOString()],
      [],
      columns.map((column) => reportColumnLabels[column]),
      ...rows.map((row) => columns.map((column) => values(row, column))),
    ].map((line) => line.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `plc-reports-${reportsState.range}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    reportsState.error = '';
  } catch (error) {
    reportsState.error = error.message;
    render();
  }
}

function renderReports() {
  const rows = getFilteredReportRows();
  const pageCount = Math.max(1, Math.ceil(rows.length / reportsState.pageSize));
  reportsState.page = Math.min(reportsState.page, pageCount);
  const pageRows = rows.slice((reportsState.page - 1) * reportsState.pageSize, reportsState.page * reportsState.pageSize);
  const tableColumns = reportsState.columns;
  const heading = (key) => `<th><button type="button" class="report-sort" data-report-sort="${key}">${reportColumnLabels[key]}${reportsState.sortBy === key ? (reportsState.sortDirection === 'asc' ? ' ↑' : ' ↓') : ''}</button></th>`;
  const tableRows = pageRows.map((row) => `<tr>
    ${tableColumns.map((column) => {
      if (column === 'module') return `<td>${escapeHtml(row.module)}</td>`;
      if (column === 'report') return `<td><span>${escapeHtml(row.label)}</span><small class="report-source">Source: ${escapeHtml(row.source)}</small></td>`;
      if (column === 'count') return `<td>${row.count == null ? '—' : Number(row.count).toLocaleString()}</td>`;
      return `<td>${formatReportValue(row[column], row)}</td>`;
    }).join('')}
    <td><button type="button" class="small-action" data-report-drilldown="${escapeHtml(row.module.toLowerCase())}">Open module</button></td>
  </tr>`).join('');
  const currentPeriod = reportsState.period
    ? `${reportsState.period.start} to ${reportsState.period.end}`
    : 'Loading report period';
  return `
    <section class="content-panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Performance · live data</p>
          <h2>Management reports</h2>
        </div>
        <button class="primary-btn" id="export-report">Export report</button>
      </div>
      <p class="subtle">Date range: ${escapeHtml(currentPeriod)} · Period-based metrics compare with the preceding equal-length period. Cash, receivables, payables, and inventory values are point-in-time balances.</p>
      ${reportsState.error ? `<p class="accounting-error" role="alert">${escapeHtml(reportsState.error)}</p>` : ''}
      <h3>Existing snapshot KPIs (preserved)</h3>
      <div class="grid two-column">
        ${applicationData.reportMetrics
          .map(
            (metric) => `
              <div class="metric-card compact-card">
                <div class="metric-header">
                  <h3>${metric.label}</h3>
                  <span class="pill ${metric.tone}">${metric.value}</span>
                </div>
                <div class="progress-bar">
                  <span style="width: ${metric.progress}%"></span>
                </div>
              </div>
            `,
          )
          .join('')}
      </div>
      <section class="report-catalog" aria-labelledby="report-catalog-title">
        <div class="panel-header">
          <div><p class="eyebrow">Authorized report catalog</p><h3 id="report-catalog-title">Operational and financial summary</h3></div>
          <label>Period<select id="report-period">
            ${rangeOptions.map((option) => `<option value="${option.value}" ${reportsState.range === option.value ? 'selected' : ''}>${option.label}</option>`).join('')}
          </select></label>
        </div>
        <div class="report-toolbar">
          <form data-report-filter-form><label>Filter reports<input name="filter" value="${escapeHtml(reportsState.filter)}" maxlength="120" placeholder="Search module, report, or source" /></label><button class="secondary-btn" type="submit">Apply</button></form>
          <label>Rows per page<select id="report-page-size">${[5, 10, 25, 50, 100].map((size) => `<option value="${size}" ${reportsState.pageSize === size ? 'selected' : ''}>${size}</option>`).join('')}</select></label>
          <details class="report-column-picker"><summary>Columns</summary>${Object.entries(reportColumnLabels).map(([key, label]) => `<label><input type="checkbox" data-report-column="${key}" ${tableColumns.includes(key) ? 'checked' : ''} />${label}</label>`).join('')}</details>
        </div>
        <div class="report-saved-controls">
          <form data-report-save-form><label>Save current view<input name="name" maxlength="80" required placeholder="Monthly management summary" /></label><button class="secondary-btn" type="submit">Save view</button></form>
          <label>Saved views<select id="report-saved-view"><option value="">Choose a saved view</option>${reportsState.saved.map((saved) => `<option value="${saved.id}">${escapeHtml(saved.name)}</option>`).join('')}</select></label>
          <button class="small-action" type="button" data-report-delete-saved ${reportsState.saved.length ? '' : 'disabled'}>Delete selected view</button>
        </div>
        <div class="table-wrap"><table class="accounting-table"><thead><tr>${tableColumns.map(heading).join('')}<th>Drill-down</th></tr></thead><tbody>${tableRows || `<tr><td colspan="${tableColumns.length + 1}" class="empty-state">No authorized live report rows match this filter.</td></tr>`}</tbody></table></div>
        <div class="report-pagination"><span>${rows.length ? `Showing ${(reportsState.page - 1) * reportsState.pageSize + 1}–${Math.min(reportsState.page * reportsState.pageSize, rows.length)} of ${rows.length}` : 'No rows'}</span><div><button class="small-action" type="button" data-report-page="-1" ${reportsState.page <= 1 ? 'disabled' : ''}>Previous</button><span>Page ${reportsState.page} of ${pageCount}</span><button class="small-action" type="button" data-report-page="1" ${reportsState.page >= pageCount ? 'disabled' : ''}>Next</button></div></div>
        <p class="subtle">CSV exports are audited. Excel, PDF, scheduled delivery, custom queries, and AI reporting are not enabled unless an approved integration is configured.</p>
      </section>
    </section>
  `;
}

function updateSettingsStatus() {
  const status = document.querySelector('.settings-status');
  if (!status) return;
  status.textContent = settingsUiState.message;
  status.classList.toggle('error', settingsUiState.error);
  status.setAttribute('role', settingsUiState.error ? 'alert' : 'status');
}

async function toggleApplicationSetting(button) {
  const settingName = button.dataset.setting;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  settingsUiState.message = `Saving ${settingName}…`;
  settingsUiState.error = false;
  updateSettingsStatus();
  try {
    const result = await fetchJson(`/api/settings/${encodeURIComponent(settingName)}/toggle`, { method: 'POST' });
    const setting = applicationData.settings.find((item) => item.name === result.name);
    if (!setting) throw new Error(`The updated setting "${result.name}" was not found.`);
    setting.enabled = result.enabled;
    settingsUiState.message = `${result.name} is now ${result.enabled ? 'enabled' : 'disabled'}.`;
    render();
  } catch (error) {
    settingsUiState.message = error.message;
    settingsUiState.error = true;
    render();
  }
}

async function refreshSettings(button) {
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  settingsUiState.message = 'Loading saved settings…';
  settingsUiState.error = false;
  updateSettingsStatus();
  try {
    const settingsData = await fetchJson('/api/settings');
    if (!Array.isArray(settingsData)) throw new Error('The saved settings response is invalid.');
    applicationData.settings = settingsData;
    settingsUiState.message = 'Saved settings loaded.';
    render();
  } catch (error) {
    settingsUiState.message = error.message;
    settingsUiState.error = true;
    render();
  }
}

function renderSettings() {
  const roleOptions = userAccessState.roles.map((role) => `<option value="${escapeHtml(role.code)}">${escapeHtml(role.name)}</option>`).join('');
  const userRows = userAccessState.users.map((user) => `<tr>
    <td>${escapeHtml(user.name)}</td>
    <td>${escapeHtml(user.username)}</td>
    <td><select data-access-role data-user-id="${escapeHtml(user.id)}" data-active="${Boolean(user.active)}" aria-label="Role for ${escapeHtml(user.username)}">${userAccessState.roles.map((role) => `<option value="${escapeHtml(role.code)}" ${role.code === user.role ? 'selected' : ''}>${escapeHtml(role.name)}</option>`).join('')}</select></td>
    <td>${user.active ? 'Active' : 'Disabled'}</td>
    <td><button class="small-action" type="button" data-access-toggle data-user-id="${escapeHtml(user.id)}" data-active="${Boolean(user.active)}">${user.active ? 'Disable' : 'Enable'}</button></td>
  </tr>`).join('');
  return `
    <section class="content-panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">System Configuration</p>
          <h2>Business settings</h2>
        </div>
        <button class="secondary-btn" id="refresh-settings" type="button">Refresh settings</button>
      </div>
      <p class="settings-status ${settingsUiState.error ? 'error' : ''}" role="${settingsUiState.error ? 'alert' : 'status'}">${escapeHtml(settingsUiState.message)}</p>
      <div class="grid two-column">
        ${applicationData.settings
          .map(
            (item) => `
              <div class="metric-card compact-card settings-item">
                <div>
                  <h3>${item.name}</h3>
                  <p>${item.description}</p>
                </div>
                <button class="toggle ${item.enabled ? 'on' : ''}" type="button" data-setting="${escapeHtml(item.name)}" aria-label="${escapeHtml(item.name)}: ${item.enabled ? 'Enabled' : 'Disabled'}" aria-pressed="${Boolean(item.enabled)}">${item.enabled ? 'Enabled' : 'Disabled'}</button>
              </div>
            `,
          )
          .join('')}
      </div>
    </section>
    ${hasRolePermission('users:manage') ? `<section class="content-panel user-access-panel">
      <div class="panel-header"><div><p class="eyebrow">Access control</p><h2>User accounts and module roles</h2></div><span>${userAccessState.users.length} users</span></div>
      <p class="subtle">Each person uses the same sign-in page. Their role controls which modules and actions are available.</p>
      <form class="action-form user-access-form" method="post" data-user-access-form>
        <label>Full name<input name="name" maxlength="160" required /></label>
        <label>Username<input name="username" minlength="2" maxlength="64" autocomplete="username" required /></label>
        <label>Initial password<input name="password" type="password" minlength="12" maxlength="256" autocomplete="new-password" required /></label>
        <label>Module role<select name="roleCode" required><option value="" selected disabled>Select a role</option>${roleOptions}</select></label>
        <button class="primary-btn" type="submit" ${userAccessState.roles.length ? '' : 'disabled'}>Create user</button>
        <span class="user-access-message ${userAccessState.error ? 'error' : ''}" role="status">${escapeHtml(userAccessState.message)}</span>
      </form>
      <div class="table-wrap"><table class="user-access-table"><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th>Action</th></tr></thead><tbody>${userRows || '<tr><td colspan="5" class="empty-state">No user accounts found.</td></tr>'}</tbody></table></div>
    </section>` : ''}
  `;
}

function setUserAccessMessage(message, error = false) {
  userAccessState.message = message;
  userAccessState.error = error;
  const status = document.querySelector('.user-access-message');
  if (status) {
    status.textContent = message;
    status.classList.toggle('error', error);
    status.setAttribute('role', error ? 'alert' : 'status');
  }
}

async function handleUserAccessSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector('button[type="submit"]');
  const payload = Object.fromEntries(new FormData(form).entries());
  submitButton.disabled = true;
  setUserAccessMessage('Creating user…');

  try {
    const user = await fetchJson('/api/access/users', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    userAccessState.users.push(user);
    form.reset();
    setUserAccessMessage(`User ${user.username} created.`);
  } catch (error) {
    setUserAccessMessage(error.message, true);
  } finally {
    render();
  }
}

async function updateUserAccess(userId, roleCode, active) {
  try {
    const updatedUser = await fetchJson(`/api/access/users/${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ roleCode, active }),
    });
    const userIndex = userAccessState.users.findIndex((user) => user.id === userId);
    if (userIndex < 0) throw new Error('The updated user was not found in the access list.');
    userAccessState.users[userIndex] = updatedUser;
    setUserAccessMessage(`Access updated for ${updatedUser.username}.`);
  } catch (error) {
    setUserAccessMessage(error.message, true);
  } finally {
    render();
  }
}

async function handleUserAccessRoleChange(event) {
  const select = event.currentTarget;
  const user = userAccessState.users.find((entry) => entry.id === select.dataset.userId);
  if (!user) {
    setUserAccessMessage('The selected user was not found.', true);
    render();
    return;
  }
  await updateUserAccess(user.id, select.value, user.active);
}

async function handleUserAccessToggle(event) {
  const button = event.currentTarget;
  const user = userAccessState.users.find((entry) => entry.id === button.dataset.userId);
  if (!user) {
    setUserAccessMessage('The selected user was not found.', true);
    render();
    return;
  }
  await updateUserAccess(user.id, user.role, !user.active);
}

function getDashboardRolePresets() {
  const role = String(authState.user?.role || 'ADMIN').toUpperCase();
  return {
    ADMIN: ['sales', 'purchases', 'cash', 'receivables', 'payables', 'inventory', 'forecast', 'inventory-health', 'procurement', 'workforce', 'budget', 'ai-summary'],
    MANAGER: ['sales', 'purchases', 'cash', 'inventory', 'procurement', 'forecast', 'inventory-health', 'ai-summary'],
    FINANCE: ['cash', 'receivables', 'payables', 'budget', 'forecast', 'ai-summary'],
    HR: ['workforce', 'cash', 'inventory', 'ai-summary'],
    SELLER: ['sales', 'receivables', 'forecast', 'ai-summary'],
    default: ['sales', 'purchases', 'cash', 'inventory', 'forecast', 'ai-summary'],
  }[role] || ['sales', 'purchases', 'cash', 'inventory', 'forecast', 'ai-summary'];
}

function getDashboardConfig() {
  const fallback = {
    role: authState.user?.role || 'ADMIN',
    enabled: getDashboardRolePresets(),
    showConfig: false,
  };

  try {
    const stored = localStorage.getItem('erp-dashboard-config');
    if (!stored) return fallback;
    const parsed = JSON.parse(stored) || {};
    const enabled = Array.isArray(parsed.enabled) && parsed.enabled.length
      ? parsed.enabled
      : fallback.enabled;
    return {
      ...fallback,
      ...parsed,
      enabled,
      role: authState.user?.role || parsed.role || 'ADMIN',
    };
  } catch {
    return fallback;
  }
}

function saveDashboardConfig(config) {
  localStorage.setItem('erp-dashboard-config', JSON.stringify(config));
}

function buildDashboardIntelligence() {
  const metrics = dashboardState.metrics || {};
  const trend = dashboardState.trend || [];
  const inventoryItems = applicationData.inventoryItems || [];
  const purchaseOrders = applicationData.purchaseOrders || [];
  const productionOrders = applicationData.productionOrders || [];
  const employees = applicationData.employees || [];
  const attendanceRecords = applicationData.attendanceRecords || [];
  const bankAccounts = applicationData.bankAccounts || [];
  const financeLedger = applicationData.financeLedger || [];

  const moneyFormatter = (value) => new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: dashboardState.currency || 'ETB',
    maximumFractionDigits: 0,
  }).format(Number(value) || 0);

  const salesRevenue = Number(metrics.sales?.value || 0);
  const salesPrevious = Number(metrics.sales?.previousValue || 0);
  const salesGrowth = salesPrevious > 0 ? ((salesRevenue - salesPrevious) / salesPrevious) * 100 : salesRevenue > 0 ? 100 : 0;
  const salesForecast = trend.length > 1
    ? Number(trend[trend.length - 1]?.sales || 0) * (1 + (salesGrowth > 0 ? salesGrowth : 0) / 100)
    : salesRevenue;

  const purchaseValue = purchaseOrders.reduce((sum, order) => sum + Number(order.amount || 0), 0);
  const onHandUnits = inventoryItems.reduce((sum, item) => sum + Number(item.stock || 0), 0);
  const lowStockItems = inventoryItems.filter((item) => Number(item.stock || 0) <= Number(item.reorderLevel || 0));
  const slowMoving = inventoryItems.filter((item) => Number(item.stock || 0) > 0 && Number(item.stock || 0) < Number(item.reorderLevel || 0) * 1.25);
  const inventoryTurnover = Number(Math.max(0, salesRevenue / Math.max(onHandUnits || 1, 1)).toFixed(2));
  const stockoutRisk = Math.min(100, Math.round((lowStockItems.length / Math.max(inventoryItems.length, 1)) * 100));

  const procurementSpend = purchaseOrders.reduce((sum, order) => sum + Number(order.amount || 0), 0);
  const supplierHealth = purchaseOrders.length
    ? Math.min(100, Math.round((procurementSpend / Math.max(salesRevenue || 1, 1)) * 100))
    : 0;

  const completedProduction = productionOrders.filter((order) => Number(order.completed || 0) >= Number(order.quantity || 0)).length;
  const productionCompletion = productionOrders.length
    ? Math.round((productionOrders.reduce((sum, order) => sum + Number(order.completed || 0), 0) / productionOrders.reduce((sum, order) => sum + Number(order.quantity || 0), 0)) * 100)
    : 0;
  const manufacturingVariance = productionOrders.length
    ? Math.round((productionOrders.reduce((sum, order) => sum + (Number(order.quantity || 0) - Number(order.completed || 0)), 0) / productionOrders.reduce((sum, order) => sum + Number(order.quantity || 0), 0)) * 100)
    : 0;

  const attendanceRate = attendanceRecords.length
    ? Math.round((attendanceRecords.filter((record) => String(record.status || '').toLowerCase() === 'present').length / attendanceRecords.length) * 100)
    : 0;
  const workforceUtilization = employees.length
    ? Math.min(100, Math.round((employees.filter((employee) => String(employee.status || '').toLowerCase() === 'active').length / employees.length) * 100))
    : 0;
  const leaveBalance = employees.length
    ? employees.reduce((sum, employee) => sum + Number(employee.leaveBalance || 0), 0)
    : 0;

  const bankBalance = bankAccounts.reduce((sum, account) => sum + Number(account.balance || account.openingBalance || 0), 0);
  const cashFlow = financeLedger.reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  const receivables = Number(metrics.receivables?.value || 0);
  const payables = Number(metrics.payables?.value || 0);
  const budgetVariance = salesRevenue > 0 ? Math.max(0, Math.round(((salesRevenue - purchaseValue) / Math.max(salesRevenue, 1)) * 100)) : 0;

  const alerts = [
    ...(lowStockItems.length ? [{ label: `${lowStockItems.length} items require replenishment`, menu: 'inventory', tone: 'warning' }] : []),
    ...(receivables > 0 ? [{ label: `Receivables outstanding: ${moneyFormatter(receivables)}`, menu: 'sales', tone: 'critical' }] : []),
    ...(stockoutRisk >= 40 ? [{ label: 'Inventory risk is rising across key stock lines', menu: 'inventory', tone: 'warning' }] : []),
    ...(attendanceRate < 85 ? [{ label: 'Attendance is below target for the selected period', menu: 'hr', tone: 'critical' }] : []),
  ];

  const aiSummary = `AI-generated summary: revenue is ${salesGrowth >= 0 ? 'up' : 'down'} by ${Math.abs(salesGrowth).toFixed(1)}% versus the prior period. ${lowStockItems.length} stock lines are at or below reorder thresholds, while ${completedProduction} production orders are on track. Recommended action: prioritize replenishment and cash collection from the outstanding receivables pipeline.`;

  return {
    salesForecast,
    inventoryTurnover,
    stockoutRisk,
    slowMoving: slowMoving.length,
    supplierHealth,
    procurementSpend,
    utilization: productionCompletion,
    manufacturingVariance,
    attendanceRate,
    workforceUtilization,
    leaveBalance,
    cashFlow,
    bankBalance,
    budgetVariance,
    alerts,
    aiSummary,
    widgets: [
      { key: 'forecast', label: 'Forecast', value: moneyFormatter(salesForecast), note: 'Projected revenue' },
      { key: 'inventory-health', label: 'Inventory health', value: `${stockoutRisk}%`, note: `${lowStockItems.length} risk items` },
      { key: 'procurement', label: 'Procurement', value: moneyFormatter(procurementSpend), note: `${purchaseOrders.length} active orders` },
      { key: 'workforce', label: 'Workforce', value: `${attendanceRate}%`, note: `${employees.length} employees` },
      { key: 'budget', label: 'Budget vs actual', value: `${budgetVariance}%`, note: 'vs planned run-rate' },
    ],
    receivables,
    payables,
  };
}

function renderDashboard() {
  const currency = (value) => new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: dashboardState.currency,
    maximumFractionDigits: 0,
  }).format(Number(value) || 0);
  const definitions = [
    ['sales', 'Sales', 'sales', 'Orders excluding drafts and cancellations', '↗'],
    ['purchases', 'Purchases', 'procurement', 'Received stock at recorded cost', '↙'],
    ['cash', 'Cash balances', canAccessMenu('banking') ? 'banking' : 'finance', 'Active bank accounts', '$'],
    ['receivables', 'Receivables', 'sales', 'Outstanding customer invoices', '◷'],
    ['payables', 'Payables', 'finance', 'Posted Accounts Payable ledger balance', '◷'],
    ['inventory', 'Inventory value', 'inventory', 'Posted stock movements at recorded cost', '▦'],
  ];
  const dashboardConfig = getDashboardConfig();
  const dashboardIntelligence = buildDashboardIntelligence();
  const availableWidgetKeys = ['forecast', 'inventory-health', 'procurement', 'workforce', 'budget'];
  const dashboardWidgets = dashboardIntelligence.widgets.filter((widget) => dashboardConfig.enabled.includes(widget.key));
  const cards = definitions.filter(([key]) => dashboardState.metrics[key]).map(([key, title, menu, note, icon]) => {
    const metric = dashboardState.metrics[key];
    const hasComparison = ['sales', 'purchases'].includes(key);
    const previous = Number(metric.previousValue || 0);
    const current = Number(metric.value || 0);
    const change = previous > 0 ? ((current - previous) / previous) * 100 : null;
    const changeLabel = change === null
      ? (current > 0 ? 'New activity' : 'No prior activity')
      : `${change >= 0 ? '+' : ''}${change.toFixed(1)}% vs prior period`;
    const changeTone = change === null || change >= 0 ? 'positive' : 'negative';
    const detail = hasComparison
      ? `${Number(metric.count || 0).toLocaleString()} ${key === 'sales' ? 'orders' : 'receipts'} · ${note}`
      : note;
    return `<button class="module-snapshot dashboard-kpi-card" type="button" data-menu="${menu}">
      <span class="dashboard-kpi-icon">${icon}</span>
      <span class="dashboard-kpi-title">${title}</span>
      <strong>${currency(metric.value)}</strong>
      <small>${escapeHtml(detail)}</small>
      ${hasComparison ? `<span class="dashboard-kpi-change ${changeTone}">${changeLabel}</span>` : ''}
      <span class="dashboard-kpi-open">Open ${escapeHtml(menu)} <span aria-hidden="true">↗</span></span>
    </button>`;
  }).join('');
  const moduleDefinitions = [
    ['sales', 'Sales', 'Customers, orders, delivery, and receivables', 'SA'],
    ['inventory', 'Inventory', 'Items, stock movements, transfers, and warehouses', 'IN'],
    ['procurement', 'Procurement', 'Suppliers, quotations, purchase orders, and receipts', 'PR'],
    ['manufacturing', 'Manufacturing', 'Production planning, work orders, and quality', 'MF'],
    ['hr', 'Human resources', 'Employees, attendance, leave, and payroll', 'HR'],
    ['finance', 'Finance', 'Accounts, journals, periods, and financial reports', 'FN'],
    ['banking', 'Banking', 'Bank accounts, transactions, and reconciliation', 'BK'],
    ['reports', 'Reports', 'Cross-module operational and financial reports', 'RP'],
  ];
  const moduleCards = moduleDefinitions.map(([menu, label, description, icon]) => `
    <button class="module-snapshot dashboard-module-card" type="button" data-menu="${menu}" ${canAccessMenu(menu) ? '' : 'disabled aria-disabled="true" title="You do not have access to this module"'} aria-label="${canAccessMenu(menu) ? 'Open' : 'Unavailable'} ${escapeHtml(label)}: ${escapeHtml(description)}">
      <span class="dashboard-module-icon" aria-hidden="true">${icon}</span>
      <span class="dashboard-module-name">${escapeHtml(label)}</span>
    </button>
  `).join('');
  const seriesOptions = [
    ['sales', 'Sales'],
    ['purchases', 'Purchases'],
  ].filter(([key]) => dashboardState.metrics[key]);
  const selectedSeries = seriesOptions.some(([key]) => key === dashboardState.chartMetric)
    ? dashboardState.chartMetric
    : seriesOptions[0]?.[0];
  const values = dashboardState.trend.map((point) => Number(point[selectedSeries] || 0));
  const peak = Math.max(...values, 1);
  const bars = dashboardState.trend.map((point) => {
    const date = new Date(`${String(point.date).slice(0, 10)}T00:00:00`);
    const label = Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const amount = Number(point[selectedSeries] || 0);
    const height = Math.max(3, (amount / peak) * 100);
    return `<div class="dashboard-chart-column" title="${escapeHtml(`${label}: ${currency(amount)}`)}">
      <span class="dashboard-chart-value">${currency(amount)}</span>
      <span class="dashboard-chart-bar ${selectedSeries}" style="height:${height}%"></span>
      <span class="dashboard-chart-label">${escapeHtml(label)}</span>
    </div>`;
  }).join('');
  const updatedLabel = dashboardState.updatedAt
    ? `Updated ${dashboardState.updatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : 'Waiting for live data';

  return `<section class="dashboard-page">
    <div class="dashboard-hero">
      <div><p class="eyebrow">Business at a glance</p><h2>Welcome back, ${escapeHtml(authState.user.name)}</h2><p>Your key business numbers, live from PostgreSQL.</p></div>
      <div class="dashboard-hero-actions">
        <button class="secondary-btn dashboard-config-toggle" type="button" data-dashboard-config-toggle>${dashboardConfig.showConfig ? 'Hide widgets' : 'Customize dashboard'}</button>
        <button class="primary-btn dashboard-refresh" type="button" data-dashboard-refresh ${dashboardState.loading ? 'disabled' : ''}>${dashboardState.loading ? 'Refreshing…' : '↻ Refresh data'}</button>
      </div>
    </div>
    ${dashboardConfig.showConfig ? `<section class="dashboard-config-panel">
      <div class="dashboard-panel-heading"><div><p class="eyebrow">Dashboard setup</p><h3>Widget visibility</h3></div><span>${dashboardConfig.enabled.length} active</span></div>
      <div class="dashboard-config-grid">
        ${availableWidgetKeys.map((key) => {
          const widget = dashboardIntelligence.widgets.find((item) => item.key === key) || { label: key, note: '' };
          const checked = dashboardConfig.enabled.includes(key) ? 'checked' : '';
          return `<label class="dashboard-config-option">
            <input type="checkbox" value="${key}" data-dashboard-widget-toggle ${checked} />
            <span>
              <strong>${escapeHtml(widget.label)}</strong>
              <small>${escapeHtml(widget.note || 'Visible on the dashboard')}</small>
            </span>
          </label>`;
        }).join('')}
      </div>
    </section>` : ''}
    ${moduleCards ? `<section class="dashboard-module-launcher" aria-labelledby="dashboard-modules-title"><div class="dashboard-module-heading"><div><p class="eyebrow">Your workspace</p><h3 id="dashboard-modules-title">Modules</h3></div><span>${moduleDefinitions.filter(([menu]) => canAccessMenu(menu)).length} available</span></div><div class="dashboard-module-grid">${moduleCards}</div></section>` : ''}
    ${dashboardState.error ? `<p class="dashboard-error" role="alert">Live dashboard data could not be loaded: ${escapeHtml(dashboardState.error)}</p>` : ''}
    ${cards ? `<div class="dashboard-kpi-grid">${cards}</div>` : `<section class="dashboard-empty"><strong>No dashboard metrics are available for this account.</strong><span>Ask your administrator for access to the relevant finance, sales, inventory, or procurement reports.</span></section>`}
    <div class="dashboard-content-grid">
      <section class="dashboard-panel dashboard-trend-panel">
        <div class="dashboard-panel-heading"><div><p class="eyebrow">Performance</p><h3>Activity trend</h3><span>Six time buckets · ${escapeHtml(state.selectedRange)}</span></div>
          <div class="dashboard-series-tabs" role="group" aria-label="Choose chart data">${seriesOptions.map(([key, label]) => `<button type="button" data-dashboard-series="${key}" class="${selectedSeries === key ? 'active' : ''}" aria-pressed="${selectedSeries === key}">${label}</button>`).join('')}</div>
        </div>
        ${dashboardState.error ? '<div class="dashboard-chart-empty">Trend is unavailable until the database connection is restored.</div>' : bars ? `<div class="dashboard-chart" role="img" aria-label="${selectedSeries} activity across six time buckets">${bars}</div>` : '<div class="dashboard-chart-empty">No sales or purchase reporting permission is available for this account.</div>'}
        <p class="dashboard-data-note">Sales uses non-draft sales orders. Purchases uses posted purchase stock receipts.</p>
      </section>
      <aside class="dashboard-panel dashboard-health-panel">
        <div class="dashboard-panel-heading"><div><p class="eyebrow">Data connection</p><h3>Live business snapshot</h3></div><span class="dashboard-live-indicator"><i></i>${dashboardState.error ? 'Unavailable' : dashboardState.loading ? 'Updating' : 'Live'}</span></div>
        <div class="dashboard-snapshot-list">
          ${definitions.filter(([key]) => dashboardState.metrics[key]).map(([key, title]) => `<div><span>${title}</span><strong>${currency(dashboardState.metrics[key].value)}</strong></div>`).join('') || '<p>Metrics are hidden when your account lacks access.</p>'}
        </div>
        <p class="dashboard-data-note">${escapeHtml(updatedLabel)} · Currency: ${escapeHtml(dashboardState.currency)}</p>
      </aside>
    </div>
    ${dashboardWidgets.length ? `<section class="dashboard-intelligence">
      <div class="dashboard-panel-heading dashboard-intelligence-head"><div><p class="eyebrow">Intelligence</p><h3>Business insights</h3></div><span>${dashboardConfig.enabled.length} configured widgets</span></div>
      <div class="dashboard-intelligence-grid">
        ${dashboardWidgets.map((widget) => `
          <div class="dashboard-intel-card">
            <span class="dashboard-intel-label">${escapeHtml(widget.label)}</span>
            <strong>${escapeHtml(widget.value)}</strong>
            <small>${escapeHtml(widget.note)}</small>
          </div>
        `).join('')}
      </div>
      <div class="dashboard-ai-summary">
        <p class="eyebrow">AI-generated business summary</p>
        <p>${escapeHtml(dashboardIntelligence.aiSummary)}</p>
      </div>
      ${dashboardIntelligence.alerts.length ? `<div class="dashboard-alerts">
        ${dashboardIntelligence.alerts.map((alert) => `
          <button type="button" class="dashboard-alert-item ${alert.tone}" data-menu="${alert.menu}">
            <span>${escapeHtml(alert.label)}</span>
            <i>↗</i>
          </button>
        `).join('')}
      </div>` : ''}
    </section>` : ''}
  </section>`;
}

function canUseAssistant() {
  return ['sales:orders:read', 'sales:reports:read', 'inventory:reports:view', 'procurement:orders:read',
    'manufacturing:read', 'hr:employees:read', 'accounting:reports:view', 'finance:transactions:create']
    .some(hasRolePermission);
}

function renderAssistantPanel() {
  if (!canUseAssistant()) return '';
  const messages = assistantState.messages.map((message) => `<article class="assistant-message ${message.role}" aria-label="${message.role === 'assistant' ? 'AI-assisted response' : 'Your question'}">
    <strong>${message.role === 'assistant' ? 'AI-assisted' : 'You'}</strong>
    <p>${escapeHtml(message.text)}</p>
    ${message.details ? `<small>${escapeHtml(message.details)}</small>` : ''}
  </article>`).join('');
  return `<aside class="erp-assistant ${assistantState.open ? 'open' : ''}" aria-label="Optional ERP assistant">
    ${assistantState.open ? `<section class="assistant-panel" aria-labelledby="assistant-title">
      <header><div><p class="eyebrow">Optional · permission-aware</p><h2 id="assistant-title">ERP assistant</h2></div><button type="button" class="assistant-close" data-assistant-close aria-label="Close assistant">×</button></header>
      <p class="assistant-disclaimer">Suggestions only. No transaction, approval, payment, stock change, or posting can be executed here. Private business data is sent externally only when an administrator explicitly configures an AI provider.</p>
      <div class="assistant-quick-prompts"><button type="button" data-assistant-prompt="Summarize my authorized business performance">Summarize performance</button><button type="button" data-assistant-prompt="How do I navigate my available modules?">Help me navigate</button></div>
      <div class="assistant-messages" role="log" aria-live="polite" aria-relevant="additions">${messages || '<p class="assistant-empty">Ask about your authorized business metrics or how to use an available module.</p>'}${assistantState.loading ? '<p class="assistant-loading" role="status">Preparing a permission-filtered response…</p>' : ''}</div>
      ${assistantState.error ? `<p class="assistant-error" role="alert">${escapeHtml(assistantState.error)}</p>` : ''}
      <form data-assistant-form><label for="assistant-question">Question</label><textarea id="assistant-question" name="question" maxlength="1500" rows="3" required placeholder="Ask about sales, stock, workflows, or a report…"></textarea><button class="primary-btn" type="submit" ${assistantState.loading ? 'disabled' : ''}>${assistantState.loading ? 'Working…' : 'Ask assistant'}</button></form>
      <small class="assistant-privacy">Only authorized aggregate metrics are sent to an explicitly configured provider. Prompts and answers are not stored in the ERP database.</small>
    </section>` : ''}
    <button type="button" class="assistant-launcher" data-assistant-toggle aria-expanded="${assistantState.open}" aria-label="${assistantState.open ? 'Close ERP assistant' : 'Open ERP assistant'}" title="${assistantState.open ? 'Close ERP assistant' : 'Open ERP assistant'}">
      ${assistantState.open
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-3 2v-6.5a7.5 7.5 0 1 1 17-3Z" /><path d="M8 11h.01M12 11h.01M16 11h.01" /></svg>'}
    </button>
  </aside>`;
}

async function sendAssistantMessage(question) {
  const normalized = String(question || '').trim();
  if (!normalized || assistantState.loading) return;
  assistantState.messages.push({ role: 'user', text: normalized });
  assistantState.messages = assistantState.messages.slice(-20);
  assistantState.loading = true;
  assistantState.error = '';
  render();
  try {
    const response = await fetchJson('/api/assistant/chat', {
      method: 'POST',
      body: JSON.stringify({ question: normalized, range: state.selectedRange }),
    });
    const source = response.sourceMetrics?.length
      ? `Sources: ${response.sourceMetrics.join(', ')} · Period: ${response.period?.start || ''} to ${response.period?.end || response.reportingRange}`
      : `Workflow help · Available modules: ${response.authorizedModules.join(', ') || 'none'}`;
    assistantState.messages.push({
      role: 'assistant',
      text: response.answer,
      details: `AI-assisted · ${response.providerMode === 'external_configured' ? 'Configured provider' : 'Local mode'} · ${source} · No action performed`,
    });
    assistantState.messages = assistantState.messages.slice(-20);
  } catch (error) {
    assistantState.error = error.message;
    assistantState.messages.push({ role: 'assistant', text: `Unable to answer: ${error.message}`, details: 'No ERP action was performed.' });
  } finally {
    assistantState.loading = false;
    render();
  }
}

function renderLogin() {
  return `
    <div class="auth-shell">
      <div class="auth-layout">
        <section class="auth-intro" aria-labelledby="auth-welcome-title">
          <div class="auth-brand"><span class="brand-mark">P</span><span>PLC ERP <small>Business Suite</small></span></div>
          <div class="auth-intro-copy">
            <p class="auth-kicker">One workspace. Clear control.</p>
            <h1 id="auth-welcome-title">Your operations, connected.</h1>
            <p>Bring your teams, processes, and business insight together in one secure workspace.</p>
          </div>
          <div class="auth-feature-list" aria-label="Platform capabilities">
            <span><i aria-hidden="true">✓</i> Role-based access</span>
            <span><i aria-hidden="true">✓</i> Connected operations</span>
            <span><i aria-hidden="true">✓</i> Live business insight</span>
          </div>
        </section>

        <section class="auth-card" aria-labelledby="auth-signin-title">
          <div class="auth-header">
            <p class="eyebrow">Secure access</p>
            <h2 id="auth-signin-title">Welcome back</h2>
            <p>Sign in with the account provided by your administrator.</p>
          </div>
          <form id="login-form" class="login-form" method="post">
            <label>
              <span>Username</span>
              <input type="text" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="Enter your username" required />
            </label>
            <label>
              <span>Password</span>
              <span class="login-password-field">
                <input id="login-password" type="password" name="password" autocomplete="current-password" placeholder="Enter your password" required />
                <button class="login-password-toggle" type="button" aria-controls="login-password" aria-label="Show password" title="Show password" aria-pressed="false">
                  <svg class="password-eye-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.7" /></svg>
                </button>
              </span>
            </label>
            <div class="login-error" role="alert" aria-live="polite" hidden></div>
            <button class="login-submit" type="submit"><span>Sign in</span><span aria-hidden="true">→</span></button>
          </form>
          <p class="auth-footnote"><span aria-hidden="true">▣</span> Your access is protected by your assigned role.</p>
        </section>
      </div>
    </div>
  `;
}

function renderProjects() {
  const canManage = hasRolePermission('projects:manage');
  const projectStatusOptions = ['PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED'];
  const taskStatusOptions = ['OPEN', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED'];
  return `
    <section class="content-panel">
      <div class="panel-header">
        <div><p class="eyebrow">Project delivery</p><h2>Projects and tasks</h2></div>
        <button type="button" class="secondary-btn" data-project-refresh>Refresh</button>
      </div>
      <p class="subtle">Projects and tasks are stored within your organization. Project status changes and new records are audited.</p>
      ${projectsState.error ? `<p class="accounting-error" role="alert">${escapeHtml(projectsState.error)}</p>` : ''}
      ${canManage ? `
        <form class="report-saved-controls" data-project-form>
          <label>Project code<input name="code" required maxlength="40" pattern="[A-Za-z0-9][A-Za-z0-9._-]*" /></label>
          <label>Project name<input name="name" required maxlength="160" /></label>
          <label>Start date<input name="startDate" type="date" /></label>
          <label>Due date<input name="dueDate" type="date" /></label>
          <label>Description<input name="description" maxlength="1000" /></label>
          <button class="primary-btn" type="submit">Create project</button>
        </form>` : ''}
      ${projectsState.loading ? '<p class="subtle" role="status">Loading projects…</p>' : ''}
      ${projectsState.projects.length ? projectsState.projects.map((project) => `
        <article class="content-panel">
          <div class="panel-header">
            <div><p class="eyebrow">${escapeHtml(project.code)}</p><h3>${escapeHtml(project.name)}</h3></div>
            ${canManage ? `<form class="button-row" data-project-status-form data-project-id="${escapeHtml(project.id)}">
              <label class="subtle">Status<select name="status">${projectStatusOptions.map((status) => `<option value="${status}" ${status === project.status ? 'selected' : ''}>${status.replaceAll('_', ' ')}</option>`).join('')}</select></label>
              <button class="small-action" type="submit">Update</button>
            </form>` : `<span class="pill neutral">${escapeHtml(project.status)}</span>`}
          </div>
          <p>${escapeHtml(project.description || 'No project description provided.')}</p>
          <p class="subtle">Start: ${escapeHtml(project.startDate || 'Not set')} · Due: ${escapeHtml(project.dueDate || 'Not set')} · ${project.tasks.length} task${project.tasks.length === 1 ? '' : 's'}</p>
          <div class="table-wrap"><table>
            <thead><tr><th>Task</th><th>Due date</th><th>Status</th></tr></thead>
            <tbody>${project.tasks.length ? project.tasks.map((task) => `<tr>
              <td><strong>${escapeHtml(task.title)}</strong>${task.description ? `<small class="table-note">${escapeHtml(task.description)}</small>` : ''}</td>
              <td>${escapeHtml(task.dueDate || 'Not set')}</td>
              <td>${canManage ? `<form class="button-row" data-project-status-form data-project-id="${escapeHtml(project.id)}" data-task-id="${escapeHtml(task.id)}">
                <label class="subtle"><span class="sr-only">Task status</span><select name="status">${taskStatusOptions.map((status) => `<option value="${status}" ${status === task.status ? 'selected' : ''}>${status.replaceAll('_', ' ')}</option>`).join('')}</select></label>
                <button class="small-action" type="submit">Update</button>
              </form>` : escapeHtml(task.status)}</td>
            </tr>`).join('') : '<tr><td colspan="3" class="empty-state">No tasks have been added yet.</td></tr>'}</tbody>
          </table></div>
          ${canManage ? `<form class="report-saved-controls" data-project-form data-project-id="${escapeHtml(project.id)}">
            <label>Task title<input name="title" required maxlength="160" /></label>
            <label>Due date<input name="dueDate" type="date" /></label>
            <label>Description<input name="description" maxlength="1000" /></label>
            <button class="secondary-btn" type="submit">Add task</button>
          </form>` : ''}
        </article>
      `).join('') : '<p class="empty-state">No projects have been created for this organization.</p>'}
    </section>
  `;
}

function renderPage() {
  switch (state.activeMenu) {
    case 'sales':
      return renderSales();
    case 'inventory':
      return renderInventory();
    case 'procurement':
      return renderProcurement();
    case 'hr':
      return renderHR();
    case 'finance':
      return renderFinance();
    case 'banking':
      return renderBanking();
    case 'manufacturing':
      return renderManufacturing();
    case 'projects':
      return renderProjects();
    case 'reports':
      return renderReports();
    case 'settings':
      return renderSettings();
    case 'governance':
      return renderGovernancePage(
        governanceState,
        hasRolePermission('governance:manage'),
        escapeHtml,
        formatCurrency,
      );
    case 'dashboard':
    default:
      return renderDashboard();
  }
}

function render() {
  if (!root) return;

  if (!authState.loaded) {
    root.innerHTML = '<div class="auth-shell"><div class="auth-card"><p>Loading ERP environment...</p></div></div>';
    return;
  }

  if (!authState.user) {
    root.innerHTML = renderLogin();
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
      loginForm.addEventListener('submit', handleLoginSubmit);
      const passwordInput = loginForm.querySelector('#login-password');
      const passwordToggle = loginForm.querySelector('.login-password-toggle');
      passwordToggle?.addEventListener('click', () => {
        const showingPassword = passwordInput.type === 'password';
        passwordInput.type = showingPassword ? 'text' : 'password';
        passwordToggle.innerHTML = showingPassword
          ? '<svg class="password-eye-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m3 3 18 18M10.6 6.2A10.8 10.8 0 0 1 12 6c6.1 0 9.5 6 9.5 6a15.8 15.8 0 0 1-3 3.5M6.2 6.2C3.8 7.8 2.5 12 2.5 12s3.4 6 9.5 6c1.1 0 2.1-.2 3-.5M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>'
          : '<svg class="password-eye-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.7" /></svg>';
        passwordToggle.setAttribute('aria-label', `${showingPassword ? 'Hide' : 'Show'} password`);
        passwordToggle.title = `${showingPassword ? 'Hide' : 'Show'} password`;
        passwordToggle.setAttribute('aria-pressed', String(showingPassword));
      });
    }
    return;
  }

  const [pageEyebrow, pageTitle] = pageTitles[state.activeMenu] || pageTitles.dashboard;
  const navSections = getNavigationForDisplay(authState.user.permissions || [])
    .map((section) => {
      return `
        <section class="nav-section">
          <p class="nav-section-label">${section.name}</p>
          <div class="nav-list">
            ${section.items.map((item) => `
              <div class="nav-entry">
                <button type="button" class="nav-item ${state.activeMenu === item.menu ? 'active' : ''}" data-route-key="${item.key}" ${item.allowed ? '' : 'disabled aria-disabled="true" title="You do not have access to this module"'} aria-current="${navigationState.key === item.key ? 'page' : 'false'}">
                  <span class="nav-icon">${item.icon}</span>
                  <span>${item.label}</span>
                  <span class="nav-chevron">›</span>
                </button>
                ${item.children.length ? `<div class="nav-sublist" aria-label="${item.label} sections">${item.children.map((child) => `
                  <button type="button" class="nav-subitem ${navigationState.key === child.key ? 'active' : ''}" data-route-key="${child.key}" ${child.allowed ? '' : 'disabled aria-disabled="true" title="You do not have access to this section"'} aria-current="${navigationState.key === child.key ? 'page' : 'false'}">
                    <span class="nav-subicon">${child.icon}</span><span>${child.label}</span>
                  </button>`).join('')}</div>` : ''}
              </div>
            `).join('')}
          </div>
        </section>
      `;
    })
    .join('');

  root.innerHTML = `
    <div class="erp-shell">
      <div class="sidebar-overlay" data-sidebar-close></div>
      <aside class="sidebar" id="sidebar">
        <div class="sidebar-top">
          <div class="brand-block">
            <div class="brand-mark">P</div>
            <div>
              <p class="brand-name">PLC ERP</p>
              <small>Business Suite</small>
            </div>
          </div>
          <button class="sidebar-close" type="button" data-sidebar-close aria-label="Close navigation">×</button>
        </div>

        <nav class="nav-menu" aria-label="Primary navigation">
          ${navSections}
        </nav>
        ${renderQuickNavigation()}

        <div class="sidebar-footer">
          <span class="status-dot"></span>
          <div><strong>System online</strong><small>All services connected</small></div>
        </div>
      </aside>

      <main class="main-panel">
        <header class="topbar">
          <div class="topbar-title">
            <button class="menu-toggle" type="button" id="menu-toggle" aria-label="Open navigation" aria-controls="sidebar" aria-expanded="false">☰</button>
            <div>
              <p class="eyebrow">${pageEyebrow}</p>
              <h1>${pageTitle}</h1>
            </div>
          </div>
          <div class="top-actions">
            <div class="user-badge"><span class="user-avatar">${authState.user.name.charAt(0).toUpperCase()}</span><span>${authState.user.name} · ${authState.user.role}</span></div>
            <button type="button" class="favorite-current-page" data-favorite-toggle aria-pressed="${getNavigationPreferences('favorites').includes(navigationState.key)}" aria-label="${getNavigationPreferences('favorites').includes(navigationState.key) ? 'Remove page from favorites' : 'Add page to favorites'}">${getNavigationPreferences('favorites').includes(navigationState.key) ? '★' : '☆'} Favorite</button>
            <select id="range-select" aria-label="Reporting period">
              ${rangeOptions
                .map(
                  (option) => `
                    <option value="${option.value}" ${option.value === state.selectedRange ? 'selected' : ''}>${option.label}</option>
                  `,
                )
                .join('')}
            </select>
            <button id="logout-button" class="ghost-btn" type="button">Logout</button>
          </div>
        </header>

        ${state.activeMenu === 'dashboard'
          ? `${authState.dataLoading ? '<p class="dashboard-load-notice" role="status">Refreshing module data. Your module shortcuts are ready.</p>' : ''}${authState.dataLoadError ? `<section class="dashboard-load-error" role="alert"><span>Some live data is unavailable: ${escapeHtml(authState.dataLoadError)}</span><button class="secondary-btn" type="button" data-app-retry>Retry</button></section>` : ''}${renderDashboard()}`
          : authState.dataLoading
            ? '<section class="content-panel erp-loading" role="status"><p class="eyebrow">Connected workspace</p><h2>Loading ERP workspace…</h2><p class="subtle">Your role-specific navigation is ready. Business data will appear when the workspace finishes loading.</p></section>'
            : authState.dataLoadError
              ? `<section class="content-panel" role="alert"><p class="eyebrow">Workspace unavailable</p><h2>Unable to load ERP data</h2><p class="subtle">${escapeHtml(authState.dataLoadError)}</p><button class="primary-btn" type="button" data-app-retry>Retry</button></section>`
              : renderPage()}
      </main>
      ${renderAssistantPanel()}
    </div>
  `;

  document.querySelector('[data-assistant-toggle]')?.addEventListener('click', () => {
    assistantState.open = !assistantState.open;
    render();
    if (assistantState.open) document.getElementById('assistant-question')?.focus();
  });
  document.querySelector('[data-assistant-close]')?.addEventListener('click', () => {
    assistantState.open = false;
    render();
  });
  document.querySelector('[data-assistant-form]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const question = new FormData(form).get('question');
    void sendAssistantMessage(question);
  });
  document.querySelectorAll('[data-assistant-prompt]').forEach((button) => {
    button.addEventListener('click', () => sendAssistantMessage(button.dataset.assistantPrompt));
  });
  document.querySelector('[data-favorite-toggle]')?.addEventListener('click', () => toggleFavoritePage(navigationState.key));
  document.querySelectorAll('[data-remove-recent]').forEach((button) => {
    button.addEventListener('click', () => removeRecentPage(button.dataset.removeRecent));
  });
  document.querySelector('.assistant-panel')?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      assistantState.open = false;
      render();
    }
  });

  document.querySelectorAll('[data-route-key]').forEach((button) => {
    button.addEventListener('click', () => {
      navigateTo(button.dataset.routeKey);
    });
  });

  document.querySelectorAll('[data-governance-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      governanceState.tab = button.dataset.governanceTab;
      render();
    });
  });
  document.querySelectorAll('[data-governance-form]').forEach((form) => {
    form.addEventListener('submit', handleGovernanceFormSubmit);
  });
  document.querySelectorAll('[data-governance-status]').forEach((button) => {
    button.addEventListener('click', () => handleGovernanceStatus(button));
  });
  document.querySelector('[data-governance-refresh]')?.addEventListener('click', async () => {
    await loadGovernanceData();
    render();
  });
  document.querySelectorAll('[data-project-form]').forEach((form) => {
    form.addEventListener('submit', handleProjectFormSubmit);
  });
  document.querySelectorAll('[data-project-status-form]').forEach((form) => {
    form.addEventListener('submit', handleProjectStatusSubmit);
  });
  document.querySelector('[data-project-refresh]')?.addEventListener('click', async () => {
    await loadProjectsData();
    render();
  });

  const menuToggle = document.getElementById('menu-toggle');
  const sidebar = document.getElementById('sidebar');
  menuToggle?.addEventListener('click', () => openSidebar());
  document.querySelector('[data-app-retry]')?.addEventListener('click', refreshApplicationData);
  document.querySelectorAll('[data-sidebar-close]').forEach((button) => {
    button.addEventListener('click', closeSidebar);
  });

  document.querySelectorAll('.module-snapshot').forEach((button) => {
    button.addEventListener('click', () => {
      navigateTo(button.dataset.menu);
    });
  });

  document.querySelectorAll('.alert-item').forEach((button) => {
    button.addEventListener('click', () => {
      navigateTo(button.dataset.menu);
    });
  });

  const rangeSelect = document.getElementById('range-select');
  if (rangeSelect) {
    rangeSelect.addEventListener('change', async (event) => {
      state.selectedRange = event.target.value;
      reportsState.range = state.selectedRange;
      const requests = [loadDashboardData()];
      if (canAccessMenu('reports')) requests.push(loadReportsData());
      render();
      await Promise.all(requests);
      if (['dashboard', 'reports'].includes(state.activeMenu)) render();
    });
  }

  document.querySelector('[data-dashboard-refresh]')?.addEventListener('click', async () => {
    const request = loadDashboardData();
    render();
    await request;
    if (state.activeMenu === 'dashboard') render();
  });
  document.querySelector('[data-dashboard-config-toggle]')?.addEventListener('click', () => {
    const config = getDashboardConfig();
    config.showConfig = !config.showConfig;
    saveDashboardConfig(config);
    render();
  });
  document.querySelectorAll('[data-dashboard-widget-toggle]').forEach((checkbox) => {
    checkbox.addEventListener('change', (event) => {
      const config = getDashboardConfig();
      const key = event.currentTarget.value;
      const enabled = new Set(config.enabled || []);
      if (event.currentTarget.checked) {
        enabled.add(key);
      } else {
        enabled.delete(key);
      }
      config.enabled = [...enabled];
      saveDashboardConfig(config);
      render();
    });
  });
  document.querySelectorAll('[data-dashboard-series]').forEach((button) => {
    button.addEventListener('click', () => {
      dashboardState.chartMetric = button.dataset.dashboardSeries;
      render();
    });
  });

  document.querySelectorAll('[data-setting]').forEach((button) => {
    button.addEventListener('click', () => toggleApplicationSetting(button));
  });

  const exportButton = document.getElementById('export-report');
  if (exportButton) exportButton.addEventListener('click', exportReport);
  document.querySelector('[data-report-filter-form]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    reportsState.filter = String(new FormData(event.currentTarget).get('filter') || '').trim();
    reportsState.page = 1;
    render();
  });
  document.querySelector('[data-report-save-form]')?.addEventListener('submit', saveReportConfiguration);
  document.getElementById('report-period')?.addEventListener('change', async (event) => {
    reportsState.range = event.currentTarget.value;
    reportsState.page = 1;
    await loadReportsData();
    render();
  });
  document.getElementById('report-page-size')?.addEventListener('change', (event) => {
    reportsState.pageSize = Number(event.currentTarget.value);
    reportsState.page = 1;
    render();
  });
  document.querySelectorAll('[data-report-column]').forEach((checkbox) => {
    checkbox.addEventListener('change', (event) => {
      const column = event.currentTarget.dataset.reportColumn;
      const selected = new Set(reportsState.columns);
      if (event.currentTarget.checked) selected.add(column);
      else selected.delete(column);
      if (!selected.size) {
        reportsState.error = 'Select at least one report column.';
        event.currentTarget.checked = true;
        render();
        return;
      }
      reportsState.columns = [...selected];
      reportsState.error = '';
      render();
    });
  });
  document.querySelectorAll('[data-report-sort]').forEach((button) => {
    button.addEventListener('click', () => {
      const column = button.dataset.reportSort;
      reportsState.sortDirection = reportsState.sortBy === column && reportsState.sortDirection === 'asc' ? 'desc' : 'asc';
      reportsState.sortBy = column;
      render();
    });
  });
  document.querySelectorAll('[data-report-page]').forEach((button) => {
    button.addEventListener('click', () => {
      reportsState.page += Number(button.dataset.reportPage);
      render();
    });
  });
  document.querySelectorAll('[data-report-drilldown]').forEach((button) => {
    button.addEventListener('click', () => navigateTo(button.dataset.reportDrilldown));
  });
  document.getElementById('report-saved-view')?.addEventListener('change', applySavedReportConfiguration);
  document.querySelector('[data-report-delete-saved]')?.addEventListener('click', deleteSavedReportConfiguration);

  document.getElementById('refresh-settings')?.addEventListener('click', (event) => refreshSettings(event.currentTarget));
  document.querySelector('[data-user-access-form]')?.addEventListener('submit', handleUserAccessSubmit);
  document.querySelectorAll('[data-access-role]').forEach((select) => {
    select.addEventListener('change', handleUserAccessRoleChange);
  });
  document.querySelectorAll('[data-access-toggle]').forEach((button) => {
    button.addEventListener('click', handleUserAccessToggle);
  });

  document.querySelectorAll('[data-bank-action]').forEach((button) => {
    button.addEventListener('click', () => showBankForm(button.dataset.bankAction));
  });

  document.querySelectorAll('[data-bank-reconcile="auto"]').forEach((button) => {
    button.addEventListener('click', () => handleBankAutoMatch(button));
  });

  document.querySelectorAll('[data-bank-approval]').forEach((button) => {
    button.addEventListener('click', () => handleBankApproval(button));
  });

  document.querySelectorAll('[data-manufacturing-action]').forEach((button) => {
    button.addEventListener('click', () => button.dataset.manufacturingAction === 'new-order'
      ? showManufacturingForm()
      : handleManufacturingAction(button.dataset.manufacturingAction, button.dataset.id, button.dataset.order));
  });
  document.querySelectorAll('[data-manufacturing-tab]').forEach((button) => {
    button.addEventListener('click', async () => {
      manufacturingState.tab = button.dataset.manufacturingTab;
      if (manufacturingState.tab === 'reports') await loadManufacturingReport();
      render();
    });
  });
  document.querySelectorAll('[data-manufacturing-form]').forEach((form) => form.addEventListener('submit', handleManufacturingDataForm));
  document.querySelectorAll('[data-manufacturing-select-order]').forEach((button) => {
    button.addEventListener('click', async () => {
      manufacturingState.selectedOrderId = button.dataset.manufacturingSelectOrder;
      await loadManufacturingData();
      render();
    });
  });
  document.querySelectorAll('[data-manufacturing-refresh-order]').forEach((button) => {
    button.addEventListener('click', async () => { await loadManufacturingData(); render(); });
  });
  document.getElementById('manufacturing-report-type')?.addEventListener('change', async (event) => {
    manufacturingState.reportType = event.currentTarget.value;
    await loadManufacturingReport();
    render();
  });

  document.querySelectorAll('[data-action-form]').forEach((button) => {
    button.addEventListener('click', () => showActionForm(button.dataset.actionForm));
  });

  document.querySelectorAll('[data-procurement-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      procurementState.tab = button.dataset.procurementTab;
      render();
    });
  });
  document.querySelectorAll('[data-procurement-supplier-form]').forEach((form) => {
    form.addEventListener('submit', handleProcurementSupplierSubmit);
  });
  document.querySelectorAll('[data-procurement-control]').forEach((form) => {
    form.addEventListener('submit', handleProcurementControlSubmit);
  });
  document.querySelectorAll('[data-procurement-controlled-action]').forEach((button) => {
    button.addEventListener('click', () => handleProcurementControlledAction({
      dataset: { action: button.dataset.procurementControlledAction, id: button.dataset.id },
    }));
  });
  document.querySelectorAll('[data-procurement-comparison-form]').forEach((form) => {
    form.addEventListener('submit', handleProcurementComparisonSubmit);
    const updateTotals = () => {
      const quantity = Number(form.querySelector('[data-comparison-quantity]').value || 0);
      form.querySelectorAll('[data-quote-editor]').forEach((editor) => {
        const read = (name) => Number(editor.querySelector(`[data-quote-value="${name}"]`)?.value || 0);
        const subtotal = quantity * read('unitPrice');
        const total = subtotal + subtotal * read('taxRate') / 100 + read('shippingCost') + read('otherCost');
        const target = editor.querySelector('[data-quote-total]');
        target.textContent = read('unitPrice') ? formatCurrency(total) : 'Enter a unit price';
      });
    };
    form.addEventListener('input', updateTotals);
    form.querySelectorAll('[data-quote-include]').forEach((toggle) => {
      toggle.addEventListener('change', () => {
        const editor = toggle.closest('[data-quote-editor]');
        editor.querySelectorAll('[data-quote-value]').forEach((input) => { input.disabled = !toggle.checked; });
      });
    });
  });
  document.querySelectorAll('[data-procurement-select]').forEach((button) => {
    button.addEventListener('click', () => showProcurementActionDialog('select', button.dataset.procurementSelect, button.dataset.quoteId));
  });
  document.querySelectorAll('[data-procurement-action]').forEach((button) => {
    button.addEventListener('click', () => showProcurementActionDialog(button.dataset.procurementAction, button.dataset.id));
  });
  document.querySelectorAll('[data-procurement-create-order]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await fetchJson(`/api/procurement/comparisons/${encodeURIComponent(button.dataset.procurementCreateOrder)}/orders`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        procurementState.tab = 'orders';
        await loadProcurementData();
        render();
      } catch (requestError) {
        procurementState.error = requestError.message;
        render();
      }
    });
  });
  document.querySelectorAll('[data-procurement-receive]').forEach((form) => {
    form.addEventListener('submit', handleProcurementReceiptSubmit);
  });

  document.querySelectorAll('[data-inventory-tab]').forEach((button) => {
    button.addEventListener('click', async () => {
      inventoryTransferState.tab = button.dataset.inventoryTab;
      if (['transfers', 'counts', 'traceability'].includes(inventoryTransferState.tab)) await loadInventoryTransferData();
      render();
    });
  });
  document.querySelectorAll('[data-inventory-trace-receive]').forEach((form) => {
    form.addEventListener('submit', handleInventoryTraceReceiveSubmit);
  });
  document.querySelectorAll('[data-inventory-tracked-issue]').forEach((form) => {
    form.addEventListener('submit', handleInventoryTrackedIssueSubmit);
  });
  document.querySelectorAll('[data-inventory-reservation]').forEach((form) => {
    form.addEventListener('submit', handleInventoryReservationSubmit);
  });
  document.querySelectorAll('[data-inventory-trace-lookup]').forEach((form) => {
    form.addEventListener('submit', handleInventoryTraceLookupSubmit);
  });
  document.querySelectorAll('[data-reservation-release]').forEach((button) => {
    button.addEventListener('click', () => handleInventoryReservationRelease(button.dataset.reservationRelease));
  });
  document.querySelectorAll('[data-lot-quality]').forEach((button) => {
    button.addEventListener('click', () => handleInventoryLotQuality(button.dataset.lotId, button.dataset.lotQuality));
  });
  document.querySelectorAll('[data-qr-label]').forEach((button) => {
    button.addEventListener('click', () => handleInventoryQrLabel(button));
  });
  document.querySelectorAll('[data-trace-warehouse]').forEach((warehouseSelect) => {
    const form = warehouseSelect.closest('form');
    const locationSelect = form?.querySelector('[data-trace-location]');
    if (!locationSelect) return;
    const emptyOption = locationSelect.querySelector('option[value=""]')?.cloneNode(true);
    const updateTraceLocations = () => {
      const previousLocationId = locationSelect.value;
      const options = inventoryTransferState.locations
        .filter((location) => location.warehouse_id === warehouseSelect.value)
        .map((location) => `<option value="${location.id}">${escapeHtml(location.code)} · ${escapeHtml(location.name)}${location.bin_code ? ` (${escapeHtml(location.bin_code)})` : ''}</option>`)
        .join('');
      locationSelect.innerHTML = `${emptyOption?.outerHTML || '<option value="">Any location</option>'}${options}`;
      if (inventoryTransferState.locations.some((location) => (
        location.id === previousLocationId && location.warehouse_id === warehouseSelect.value
      ))) locationSelect.value = previousLocationId;
    };
    warehouseSelect.addEventListener('change', updateTraceLocations);
    updateTraceLocations();
  });
  document.querySelectorAll('[data-inventory-count-form]').forEach((form) => {
    form.addEventListener('submit', handleInventoryCountSubmit);
    const updateRemoveButtons = () => {
      const lines = form.querySelector('[data-count-lines]');
      lines.querySelectorAll('[data-count-remove-line]').forEach((button) => { button.disabled = lines.children.length <= 1; });
    };
    const bindRemoveButton = (button) => {
      button.addEventListener('click', () => {
        const lines = form.querySelector('[data-count-lines]');
        if (lines.children.length > 1) button.closest('.inventory-count-line').remove();
        else lines.querySelector('[data-count-quantity]').value = '';
        updateRemoveButtons();
      });
    };
    form.querySelectorAll('[data-count-remove-line]').forEach(bindRemoveButton);
    form.querySelector('[data-count-add-line]')?.addEventListener('click', () => {
      const lines = form.querySelector('[data-count-lines]');
      const newLine = lines.querySelector('.inventory-count-line').cloneNode(true);
      newLine.querySelector('[data-count-product]').selectedIndex = 0;
      newLine.querySelector('[data-count-quantity]').value = '';
      lines.append(newLine);
      bindRemoveButton(newLine.querySelector('[data-count-remove-line]'));
      updateRemoveButtons();
    });
  });
  document.querySelectorAll('[data-count-action]').forEach((button) => {
    button.addEventListener('click', () => handleInventoryCountAction(button.dataset.countId, button.dataset.countAction));
  });
  document.querySelectorAll('[data-count-details]').forEach((button) => {
    button.addEventListener('click', () => showInventoryCountDetails(button.dataset.countDetails));
  });
  document.querySelectorAll('[data-count-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      inventoryTransferState.countStatusFilter = button.dataset.countFilter;
      render();
    });
  });
  document.querySelectorAll('[data-inventory-transfer-form]').forEach((form) => {
    form.addEventListener('submit', handleInventoryTransferSubmit);
    form.querySelectorAll('[data-transfer-warehouse]').forEach((warehouseSelect) => {
      warehouseSelect.addEventListener('change', () => {
        const side = warehouseSelect.dataset.transferWarehouse;
        const locationSelect = form.querySelector(`[data-transfer-location="${side}"]`);
        if (!locationSelect) return;
        const locations = inventoryTransferState.locations.filter((location) => location.warehouse_id === warehouseSelect.value);
        locationSelect.innerHTML = `<option value="">No specific ${side} location</option>${locations.map((location) => `<option value="${location.id}">${escapeHtml(location.code)} · ${escapeHtml(location.name)}${location.bin_code ? ` (${escapeHtml(location.bin_code)})` : ''}</option>`).join('')}`;
      });
    });
  });
  document.querySelectorAll('[data-inventory-setup]').forEach((form) => {
    form.addEventListener('submit', handleInventorySetupSubmit);
  });
  document.querySelectorAll('[data-inventory-stock-receipt]').forEach((form) => {
    form.addEventListener('submit', handleInventoryStockReceiptSubmit);
  });
  document.querySelectorAll('[data-transfer-action]').forEach((button) => {
    button.addEventListener('click', () => handleInventoryTransferAction(
      button.dataset.transferId,
      button.dataset.transferAction,
      button.dataset.transferQuantity,
    ));
  });
  document.querySelectorAll('[data-transfer-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      inventoryTransferState.statusFilter = button.dataset.transferFilter;
      render();
    });
  });

  document.querySelectorAll('[data-sales-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      salesState.tab = button.dataset.salesTab;
      if (salesState.tab !== 'orders') {
        salesState.orderFilter = 'ALL';
        salesState.orderSearch = '';
      }
      render();
    });
  });
  document.querySelectorAll('[data-sales-order-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      salesState.orderFilter = button.dataset.salesOrderFilter;
      render();
    });
  });
  document.querySelector('[data-sales-order-search-form]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    salesState.orderSearch = new FormData(event.currentTarget).get('search')?.toString() || '';
    render();
  });
  document.querySelector('[data-sales-order-clear]')?.addEventListener('click', () => {
    salesState.orderFilter = 'ALL';
    salesState.orderSearch = '';
    render();
  });
  document.querySelector('[data-sales-orders-refresh]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Refreshing…';
    await loadSalesData();
    render();
  });
  document.querySelectorAll('[data-sales-form]').forEach((form) => form.addEventListener('submit', handleSalesFormSubmit));
  document.querySelector('[data-sales-performance-range]')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    if (values.startDate > values.endDate) {
      window.alert('The start date must be on or before the end date.');
      return;
    }
    salesState.performanceStart = values.startDate;
    salesState.performanceEnd = values.endDate;
    await loadSalesData();
    render();
  });
  document.querySelectorAll('[data-sales-action]').forEach((button) => {
    button.addEventListener('click', () => handleSalesAction(button.dataset.salesId, button.dataset.salesAction));
  });
  document.querySelectorAll('[data-crm-stage]').forEach((select) => {
    select.addEventListener('change', async (event) => {
      const control = event.currentTarget;
      control.disabled = true;
      try {
        await fetchJson(`/api/sales/crm/${encodeURIComponent(control.dataset.crmStage)}`, {
          method: 'PUT',
          body: JSON.stringify({ stage: control.value }),
        });
        await loadSalesData();
        render();
      } catch (error) {
        window.alert(error.message);
        render();
      }
    });
  });
  document.querySelectorAll('[data-finance-tab]').forEach((button) => {
    button.addEventListener('click', async () => {
      financeState.tab = button.dataset.financeTab;
      if (financeState.tab === 'accounting') await loadAccountingData();
      render();
    });
  });
  document.querySelectorAll('[data-accounting-tab]').forEach((button) => {
    button.addEventListener('click', () => { accountingState.tab = button.dataset.accountingTab; render(); });
  });
  document.querySelectorAll('[data-accounting-form]').forEach((form) => form.addEventListener('submit', handleAccountingFormSubmit));
  document.querySelectorAll('[data-accounting-action]').forEach((button) => {
    button.addEventListener('click', () => handleAccountingAction(button.dataset.journal, button.dataset.accountingAction));
  });
  document.querySelectorAll('[data-accounting-detail]').forEach((button) => {
    button.addEventListener('click', () => showAccountingJournal(button.dataset.accountingDetail));
  });
  document.querySelectorAll('[data-accounting-account]').forEach((button) => {
    button.addEventListener('click', () => toggleAccountingAccount(button.dataset.accountingAccount));
  });
  document.querySelectorAll('[data-accounting-close-period]').forEach((button) => {
    button.addEventListener('click', () => closeAccountingPeriodInUi(button.dataset.accountingClosePeriod));
  });
  document.querySelectorAll('[data-accounting-reopen-period]').forEach((button) => {
    button.addEventListener('click', () => reopenAccountingPeriodInUi(button.dataset.accountingReopenPeriod));
  });
  document.querySelector('[data-accounting-refresh]')?.addEventListener('click', async () => {
    await loadAccountingData();
    render();
  });
  document.getElementById('accounting-ledger-account')?.addEventListener('change', async (event) => {
    try {
      accountingState.ledger = await fetchJson(`/api/accounting/ledger?accountId=${encodeURIComponent(event.currentTarget.value)}`);
      accountingState.error = '';
    } catch (error) {
      accountingState.error = error.message;
    }
    render();
  });

  document.querySelectorAll('[data-record-edit]').forEach((button) => {
    button.addEventListener('click', () => showRecordEditDialog(button.dataset.recordEdit, button.dataset.recordId));
  });

  document.querySelectorAll('[data-record-delete]').forEach((button) => {
    button.addEventListener('click', () => confirmRecordDelete(button.dataset.recordDelete, button.dataset.recordId));
  });

  document.querySelectorAll('[data-hr-tab]').forEach((button) => {
    button.addEventListener('click', () => { hrState.tab = button.dataset.hrTab; render(); });
  });
  document.querySelectorAll('[data-hr-form]').forEach((form) => form.addEventListener('submit', handleHrFormSubmit));
  bindHrInputRules();
  document.querySelectorAll('[data-hr-edit-employee]').forEach((button) => {
    button.addEventListener('click', () => showEmployeeEditForm(button.dataset.hrEditEmployee));
  });
  document.querySelectorAll('[data-hr-attendance]').forEach((button) => {
    if (!button.dataset.hrAttendance) return;
    button.addEventListener('click', () => handleHrAttendance(button.dataset.hrAttendance, button.dataset.employee));
  });
  document.getElementById('hr-attendance-employee')?.addEventListener('change', (event) => {
    hrState.attendanceEmployeeId = event.currentTarget.value;
    render();
  });
  document.getElementById('hr-attendance-month')?.addEventListener('change', (event) => {
    hrState.attendanceMonth = event.currentTarget.value;
    render();
  });
  document.querySelector('[data-attendance-filters]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    hrState.attendancePeriod = values.period || '30';
    hrState.attendanceStartDate = values.startDate || '';
    hrState.attendanceEndDate = values.endDate || '';
    hrState.attendanceEmployeeId = values.employeeId || 'ALL';
    hrState.attendanceStatus = values.status || 'ALL';
    hrState.attendanceSearch = values.search || '';
    render();
  });
  document.querySelector('[data-attendance-filters] select[name="period"]')?.addEventListener('change', (event) => {
    const form = event.currentTarget.form;
    const values = Object.fromEntries(new FormData(form).entries());
    hrState.attendancePeriod = event.currentTarget.value;
    hrState.attendanceStartDate = values.startDate || '';
    hrState.attendanceEndDate = values.endDate || '';
    hrState.attendanceEmployeeId = values.employeeId || 'ALL';
    hrState.attendanceStatus = values.status || 'ALL';
    hrState.attendanceSearch = values.search || '';
    render();
  });
  document.querySelector('[data-attendance-clear]')?.addEventListener('click', () => {
    hrState.attendancePeriod = '30';
    hrState.attendanceStartDate = '';
    hrState.attendanceEndDate = '';
    hrState.attendanceEmployeeId = 'ALL';
    hrState.attendanceStatus = 'ALL';
    hrState.attendanceSearch = '';
    render();
  });
  document.querySelectorAll('[data-hr-leave-decision]').forEach((button) => {
    button.addEventListener('click', () => handleHrLeaveDecision(button.dataset.request, button.dataset.hrLeaveDecision));
  });
  document.querySelectorAll('[data-hr-payroll]').forEach((button) => {
    button.addEventListener('click', () => handleHrPayrollAction(button.dataset.period, button.dataset.hrPayroll));
  });
  document.querySelectorAll('[data-hr-payslip]').forEach((button) => {
    button.addEventListener('click', () => openHrPayslip(button.dataset.hrPayslip, button.dataset.period));
  });
  document.querySelectorAll('[data-hr-export]').forEach((button) => {
    button.addEventListener('click', () => exportHrReport(button.dataset.hrExport));
  });
  document.getElementById('hr-report-type')?.addEventListener('change', (event) => {
    hrState.reportType = event.currentTarget.value;
    render();
  });
  document.getElementById('hr-leave-month')?.addEventListener('change', async (event) => {
    hrState.leaveMonth = event.currentTarget.value;
    try {
      hrState.leaveCalendar = await fetchJson(`/api/hr/leave/calendar?month=${encodeURIComponent(hrState.leaveMonth)}`);
      render();
    } catch (error) {
      window.alert(error.message);
    }
  });

  const logoutButton = document.getElementById('logout-button');
  if (logoutButton) {
    logoutButton.addEventListener('click', handleLogout);
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSidebar();
  });

  if (sidebar) sidebar.dataset.mobile = window.innerWidth < 980 ? 'true' : 'false';
}

async function handleHrFormSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const type = form.dataset.hrForm;
  const values = Object.fromEntries(new FormData(form).entries());
  const error = form.querySelector('.hr-form-error');
  if (error) { error.hidden = true; error.textContent = ''; }
  const numericFields = ['salary', 'allowances', 'advanceDeduction', 'otherDeductions', 'daysPerYear', 'accrualRate', 'level', 'employeePensionRate', 'employerPensionRate', 'overtimeMultiplier', 'standardHoursPerMonth', 'standardHoursPerDay', 'workingDaysPerMonth'];
  for (const field of numericFields) if (values[field] !== undefined && values[field] !== '') values[field] = Number(values[field]);
  if (type === 'payroll-settings') {
    try { values.taxBands = JSON.parse(values.taxBands); }
    catch { if (error) { error.textContent = 'Tax bands must be valid JSON.'; error.hidden = false; } return; }
  }
  if (type === 'leave-type') values.paid = form.elements.paid.checked;
  const routes = {
    employee: ['/api/employees', 'POST'],
    'employee-edit': [`/api/hr/employees/${encodeURIComponent(form.dataset.employeeId)}`, 'PUT'],
    department: ['/api/hr/departments', 'POST'],
    position: ['/api/hr/positions', 'POST'],
    branch: ['/api/hr/branches', 'POST'],
    hierarchy: ['/api/hr/hierarchy', 'POST'],
    'leave-type': ['/api/hr/leave/types', 'POST'],
    'leave-request': ['/api/hr/leave/requests', 'POST'],
    'payroll-period': ['/api/hr/payroll/periods', 'POST'],
    'payroll-settings': ['/api/hr/payroll/settings', 'PUT'],
    'employee-document': ['/api/hr/employee-documents', 'POST'],
  };
  const route = routes[type];
  if (!route) return;
  try {
    await fetchJson(route[0], { method: route[1], body: JSON.stringify(values) });
    await loadHrData();
    if (hasRolePermission('hr:payroll:report')) {
      hrState.reports = await fetchJson('/api/hr/reports');
    }
    if (type === 'employee-edit') form.closest('.modal-backdrop')?.remove();
    else if (form.closest('details')) form.closest('details').open = false;
    form.reset();
    render();
  } catch (requestError) {
    if (error) { error.textContent = requestError.message; error.hidden = false; }
  }
}

function showEmployeeEditForm(employeeId) {
  const employee = applicationData.employees.find((item) => item.id === employeeId);
  if (!employee) return;
  const dialog = document.createElement('div');
  dialog.className = 'modal-backdrop';
  dialog.innerHTML = `<div class="modal-card hr-edit-modal"><div class="modal-header"><div><p class="eyebrow">Employee record</p><h2>Edit ${escapeHtml(hrEmployeeName(employee))}</h2></div><button type="button" class="modal-close">×</button></div><form class="hr-form" data-hr-form="employee-edit" data-employee-id="${escapeHtml(employee.id)}"></form></div>`;
  const form = dialog.querySelector('form');
  const fields = [
    ['employeeNumber', 'Employee number (digits only)', employee.employeeNumber, 'text', 'digits-edit'],
    ['firstName', 'First name', employee.personal?.firstName, 'text', 'person'],
    ['lastName', 'Last name', employee.personal?.lastName, 'text', 'person'],
    ['dateOfBirth', 'Date of birth', employee.personal?.dateOfBirth, 'date'],
    ['gender', 'Gender', employee.personal?.gender, 'gender'],
    ['nationalId', 'National ID', employee.personal?.nationalId, 'text', 'national-id-edit'],
    ['address', 'Address', employee.personal?.address],
    ['email', 'Email', employee.contact?.email, 'email'],
    ['phone', 'Phone', employee.contact?.phone, 'tel'],
    ['emergencyName', 'Emergency contact', employee.emergencyContact?.name, 'text', 'person'],
    ['emergencyPhone', 'Emergency phone', employee.emergencyContact?.phone, 'tel'],
    ['emergencyRelationship', 'Relationship', employee.emergencyContact?.relationship],
    ['hireDate', 'Hire date', employee.hireDate, 'date'],
    ['contract', 'Contract', employee.contract],
    ['salary', 'Monthly salary', employee.salary, 'number'],
    ['allowances', 'Monthly allowances', employee.allowances || 0, 'number'],
    ['advanceDeduction', 'Advance deduction', employee.advanceDeduction || 0, 'number'],
    ['otherDeductions', 'Other deductions', employee.otherDeductions || 0, 'number'],
  ];
  form.innerHTML = fields.map(([name, label, value, type = 'text', validationRule = '']) => type === 'gender'
    ? hrFormField(label, name, 'text', hrGenderOptions(value), false, value)
    : hrFormField(label, name, type, null, false, value, validationRule)).join('')
    + hrFormField('Department', 'departmentId', 'text', hrState.workspace.departments.map((item) => [item.id, item.name]), true, employee.departmentId)
    + hrFormField('Position', 'positionId', 'text', hrState.workspace.positions.map((item) => [item.id, item.name]), true, employee.positionId)
    + hrFormField('Employment type', 'employmentType', 'text', [['Full-time', 'Full-time'], ['Part-time', 'Part-time'], ['Contract', 'Contract'], ['Temporary', 'Temporary']], true, employee.employmentType)
    + hrFormField('Status', 'status', 'text', [['Active', 'Active'], ['On leave', 'On leave'], ['Terminated', 'Terminated']], true, employee.status)
    + '<div class="hr-form-actions"><button class="primary-btn" type="submit">Save changes</button><span class="hr-form-error" role="alert"></span></div>';
  dialog.querySelector('.modal-close').addEventListener('click', () => dialog.remove());
  dialog.addEventListener('click', (clickEvent) => { if (clickEvent.target === dialog) dialog.remove(); });
  document.body.appendChild(dialog);
  bindHrInputRules(form);
  form.addEventListener('submit', handleHrFormSubmit);
}

async function handleHrAttendance(action, employeeId) {
  const selectedEmployee = employeeId || document.getElementById('hr-attendance-employee')?.value;
  if (action !== 'absence' && !selectedEmployee) return;
  try {
    if (action === 'absence') {
      const dialog = document.createElement('div');
      dialog.className = 'modal-backdrop';
      dialog.innerHTML = `<div class="modal-card"><div class="modal-header"><div><h2>Record absence</h2><p>${escapeHtml(formatAttendanceDate(attendanceDateKey()))} · East Africa Time</p></div><button class="modal-close" type="button">×</button></div><form class="hr-form"><label>Employee<select name="employeeId" required>${applicationData.employees.map((employee) => `<option value="${employee.id}">${escapeHtml(hrEmployeeName(employee))}</option>`).join('')}</select></label>${hrFormField('Date', 'date', 'date', null, true, attendanceDateKey())}${hrFormField('Reason', 'reason', 'text', null, false)}<button class="primary-btn" type="submit">Save absence</button><span class="hr-form-error"></span></form></div>`;
      document.body.appendChild(dialog);
      dialog.querySelector('.modal-close').addEventListener('click', () => dialog.remove());
      dialog.querySelector('form').addEventListener('submit', async (submitEvent) => {
        submitEvent.preventDefault();
        const values = Object.fromEntries(new FormData(submitEvent.currentTarget).entries());
        try {
          await fetchJson('/api/hr/attendance/absence', { method: 'POST', body: JSON.stringify(values) });
          await loadHrData();
          dialog.remove();
          render();
        } catch (requestError) { dialog.querySelector('.hr-form-error').textContent = requestError.message; }
      });
      return;
    }
    await fetchJson(`/api/hr/attendance/${action}/${encodeURIComponent(selectedEmployee)}`, { method: 'POST', body: '{}' });
    await loadHrData();
    render();
  } catch (error) {
    window.alert(error.message);
  }
}

async function handleHrLeaveDecision(requestId, status) {
  try {
    await fetchJson(`/api/hr/leave/requests/${encodeURIComponent(requestId)}/approve`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    });
    await loadHrData();
    render();
  } catch (error) { window.alert(error.message); }
}

async function handleHrPayrollAction(periodId, action) {
  try {
    const result = await fetchJson(`/api/hr/payroll/periods/${encodeURIComponent(periodId)}/${action}`, { method: 'POST', body: '{}' });
    if (action === 'calculate' && result.entries?.length) {
      window.alert(`Payroll calculated for ${result.entries.length} active employees.`);
    }
    await loadHrData();
    render();
  } catch (error) { window.alert(error.message); }
}

async function openHrPayslip(employeeId, periodId) {
  try {
    const result = await fetchJson(`/api/hr/payroll/payslip/${encodeURIComponent(employeeId)}?periodId=${encodeURIComponent(periodId)}`);
    const payslip = result.payslip;
    const printWindow = window.open('', '_blank');
    if (!printWindow) throw new Error('Allow pop-ups to open the payslip.');
    printWindow.document.write(`<!doctype html><html><head><title>Payslip</title><style>body{font:14px Arial;margin:40px;color:#14213d}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccd5e2;padding:9px;text-align:left}h1{color:#1565e8}@media print{button{display:none}}</style></head><body><h1>PLC ERP — Payslip</h1><p>${escapeHtml(payslip.employeeName)} · ${escapeHtml(payslip.employeeNumber)}</p><p>${escapeHtml(payslip.periodLabel)}</p><table>${[['Basic salary', payslip.basicSalary], ['Allowances', payslip.allowances], ['Overtime', payslip.overtimePay], ['Tax', -payslip.tax], ['Employee pension', -payslip.employeePension], ['Advances', -payslip.advances], ['Other deductions', -payslip.otherDeductions], ['Absence deduction', -payslip.absenceDeduction], ['Net salary', payslip.netSalary]].map(([label, amount]) => `<tr><th>${label}</th><td>${formatCurrency(amount)}</td></tr>`).join('')}</table><button onclick="window.print()">Print</button></body></html>`);
    printWindow.document.close();
  } catch (error) { window.alert(error.message); }
}

function exportHrReport(type) {
  const rowsByType = {
    employees: [ ['Employee number', 'First name', 'Last name', 'Department', 'Position', 'Hire date', 'Employment type', 'Contract', 'Salary', 'Status'], ...applicationData.employees.map((item) => [item.employeeNumber, item.personal?.firstName, item.personal?.lastName, hrDepartmentName(item.departmentId), hrPositionName(item.positionId), item.hireDate, item.employmentType, item.contract, item.salary, item.status]) ],
    attendance: [ ['Date (Gregorian, EAT)', 'Employee number', 'Check in (EAT)', 'Check out (EAT)', 'Working hours', 'Overtime', 'Late minutes', 'Status'], ...getFilteredAttendanceRecords().map((item) => [item.date, applicationData.employees.find((employee) => employee.id === item.employeeId)?.employeeNumber, item.checkIn, item.checkOut, item.workingHours, item.overtime, item.lateArrival, item.status]) ],
    leave: [ ['Employee', 'Leave type', 'Start date', 'End date', 'Days', 'Status'], ...hrState.leave.requests.map((item) => [hrEmployeeName(applicationData.employees.find((employee) => employee.id === item.employeeId) || { employeeNumber: item.employeeId }), hrState.leave.types.find((leaveType) => leaveType.id === item.leaveTypeId)?.name, item.startDate, item.endDate, item.days, item.status]) ],
    payroll: [ ['Period', 'Status', 'Employees', 'Gross salary', 'Net salary'], ...hrState.reports.payroll.map((item) => [item.label, item.status, item.employeeCount, item.grossSalary, item.netSalary]) ],
  };
  const rows = rowsByType[type] || [];
  const csv = rows.map((row) => row.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  link.download = `hr-${type}-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function openSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.querySelector('.sidebar-overlay');
  const toggle = document.getElementById('menu-toggle');
  sidebar?.classList.add('open');
  overlay?.classList.add('visible');
  toggle?.setAttribute('aria-expanded', 'true');
  document.body.classList.add('sidebar-open');
}

function closeSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.querySelector('.sidebar-overlay');
  const toggle = document.getElementById('menu-toggle');
  sidebar?.classList.remove('open');
  overlay?.classList.remove('visible');
  toggle?.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('sidebar-open');
}

window.addEventListener('hashchange', () => {
  if (authState.loaded && authState.user) syncNavigationFromHash();
});

bootstrapAuth();
