export const navigation = [
  { key: 'dashboard', menu: 'dashboard', label: 'Dashboard', icon: '▣', section: 'Workspace' },
  {
    key: 'sales', menu: 'sales', label: 'Sales', icon: '◫', section: 'Workspace',
    permissions: ['sales:orders:read'],
    children: [
      { key: 'customers', menu: 'sales', tab: 'customers', label: 'Customers', icon: '◉', permission: 'sales:customers:read' },
    ],
  },
  {
    key: 'inventory', menu: 'inventory', label: 'Inventory', icon: '▤', section: 'Operations',
    permissions: ['inventory:reports:view', 'inventory:stock:update', 'inventory:warehouses:manage'],
    children: [
      { key: 'warehouses', menu: 'inventory', tab: 'transfers', label: 'Warehouses', icon: '▥', permissions: ['inventory:reports:view', 'inventory:warehouses:manage'] },
    ],
  },
  {
    key: 'procurement', menu: 'procurement', label: 'Procurement', icon: '◧', section: 'Operations',
    permissions: ['procurement:comparisons:read', 'procurement:orders:read', 'procurement:orders:create'],
    children: [
      { key: 'suppliers', menu: 'procurement', tab: 'suppliers', label: 'Suppliers', icon: '♙', permissions: ['procurement:comparisons:read', 'procurement:suppliers:manage'] },
    ],
  },
  { key: 'manufacturing', menu: 'manufacturing', label: 'Manufacturing', icon: '▦', section: 'Operations', permissions: ['manufacturing:read'] },
  {
    key: 'hr', menu: 'hr', label: 'HR', icon: '◎', section: 'Operations',
    permissions: ['hr:employees:read', 'hr:payroll:read'],
    children: [
      { key: 'payroll', menu: 'hr', tab: 'payroll', label: 'Payroll', icon: '$', permission: 'hr:payroll:read' },
    ],
  },
  {
    key: 'finance', menu: 'finance', label: 'Finance', icon: '◬', section: 'Finance',
    permissions: ['finance:transactions:create', 'finance:transactions:approve', 'accounting:reports:view'],
    children: [
      { key: 'accounting', menu: 'finance', tab: 'accounting', label: 'Accounting', icon: '▤', permission: 'accounting:reports:view' },
    ],
  },
  { key: 'banking', menu: 'banking', label: 'Banking', icon: '▥', section: 'Finance', permissions: ['finance:transactions:create', 'finance:transactions:approve'] },
  { key: 'reports', menu: 'reports', label: 'Reports', icon: '◭', section: 'Insights', permissions: ['accounting:reports:view'] },
  { key: 'settings', menu: 'settings', label: 'Settings', icon: '⚙', section: 'System', permissions: ['settings:toggle', 'users:manage'] },
];

export const navigationSections = [
  { name: 'Workspace', keys: ['dashboard', 'sales'] },
  { name: 'Operations', keys: ['inventory', 'procurement', 'manufacturing', 'hr'] },
  { name: 'Finance', keys: ['finance', 'banking'] },
  { name: 'Insights', keys: ['reports'] },
  { name: 'System', keys: ['settings'] },
];

export const rangeOptions = [
  { value: '7d', label: '7 Days' },
  { value: '30d', label: '30 Days' },
  { value: '90d', label: '90 Days' },
  { value: '1y', label: '1 Year' },
];

export const salesOrders = [
  { id: 'SO-1024', customer: 'Luna Retail', date: '2026-09-12', status: 'Paid', amount: 24800 },
  { id: 'SO-1025', customer: 'Apex Motors', date: '2026-09-15', status: 'Processing', amount: 52800 },
  { id: 'SO-1026', customer: 'Metro Foods', date: '2026-09-18', status: 'Pending', amount: 18400 },
  { id: 'SO-1027', customer: 'Crest Homes', date: '2026-09-21', status: 'Paid', amount: 36250 },
  { id: 'SO-1028', customer: 'Northwest Labs', date: '2026-09-24', status: 'Paid', amount: 29120 },
];

export const inventoryItems = [
  { sku: 'MT-100', name: 'Industrial Motor', stock: 420, reorderLevel: 120, location: 'WH-A1', unitPrice: 1260 },
  { sku: 'BR-220', name: 'Bearing Kit', stock: 86, reorderLevel: 60, location: 'WH-B3', unitPrice: 320 },
  { sku: 'EL-330', name: 'Control Panel', stock: 45, reorderLevel: 40, location: 'WH-C2', unitPrice: 2140 },
  { sku: 'PL-410', name: 'Safety Valve', stock: 210, reorderLevel: 90, location: 'WH-A5', unitPrice: 890 },
  { sku: 'TX-510', name: 'Thermal Sensor', stock: 18, reorderLevel: 35, location: 'WH-D1', unitPrice: 260 },
];

export const purchaseOrders = [
  { po: 'PO-5021', vendor: 'Prime Supply Co.', eta: '2026-09-30', status: 'In Transit', amount: 32800 },
  { po: 'PO-5023', vendor: 'North East Traders', eta: '2026-10-02', status: 'Pending', amount: 21450 },
  { po: 'PO-5025', vendor: 'Global Parts Ltd.', eta: '2026-09-27', status: 'Delivered', amount: 42110 },
];

export const productionOrders = [
  { id: 'MO-3001', product: 'Industrial Motor Assembly', quantity: 120, completed: 84, dueDate: '2026-10-03', workCenter: 'Assembly Line A', status: 'In Progress', priority: 'High' },
  { id: 'MO-3002', product: 'Control Panel X4', quantity: 60, completed: 60, dueDate: '2026-09-29', workCenter: 'Electrical Cell', status: 'Completed', priority: 'Normal' },
  { id: 'MO-3003', product: 'Safety Valve Series 4', quantity: 200, completed: 40, dueDate: '2026-10-08', workCenter: 'Machining Cell', status: 'Scheduled', priority: 'Normal' },
  { id: 'MO-3004', product: 'Thermal Sensor Pack', quantity: 500, completed: 125, dueDate: '2026-10-01', workCenter: 'Calibration Lab', status: 'Blocked', priority: 'Critical' },
];

export const workCenters = [
  { name: 'Assembly Line A', department: 'Assembly', utilization: 82, availability: 96, openJobs: 3, status: 'Running' },
  { name: 'Electrical Cell', department: 'Electrical', utilization: 68, availability: 91, openJobs: 2, status: 'Running' },
  { name: 'Machining Cell', department: 'Machining', utilization: 91, availability: 87, openJobs: 5, status: 'At Capacity' },
  { name: 'Calibration Lab', department: 'Quality', utilization: 47, availability: 73, openJobs: 1, status: 'Blocked' },
];

export const billOfMaterials = [
  { product: 'Industrial Motor Assembly', revision: 'B', components: 14, materialReadiness: 88, nextReview: '2026-10-15' },
  { product: 'Control Panel X4', revision: 'A', components: 22, materialReadiness: 100, nextReview: '2026-11-02' },
  { product: 'Safety Valve Series 4', revision: 'C', components: 9, materialReadiness: 72, nextReview: '2026-10-20' },
];

export const departments = [
  { id: 'dept-sales', name: 'Sales', code: 'SAL', description: 'Customer acquisition and account management', branchId: 'branch-hq', managerId: 'emp-001' },
  { id: 'dept-operations', name: 'Operations', code: 'OPS', description: 'Warehouse, logistics, and service delivery', branchId: 'branch-hq', managerId: 'emp-002' },
  { id: 'dept-finance', name: 'Finance', code: 'FIN', description: 'Accounting, treasury, and financial controls', branchId: 'branch-hq', managerId: 'emp-003' },
  { id: 'dept-hr', name: 'Human Resources', code: 'HR', description: 'People operations and workforce administration', branchId: 'branch-hq', managerId: 'emp-004' },
];

export const positions = [
  { id: 'pos-sm', name: 'Sales Manager', code: 'SM', departmentId: 'dept-sales', level: 3, salary: 42000, employmentType: 'Full-time' },
  { id: 'pos-ws', name: 'Warehouse Supervisor', code: 'WS', departmentId: 'dept-operations', level: 3, salary: 26000, employmentType: 'Full-time' },
  { id: 'pos-fa', name: 'Finance Analyst', code: 'FA', departmentId: 'dept-finance', level: 2, salary: 24000, employmentType: 'Full-time' },
  { id: 'pos-hr', name: 'HR Officer', code: 'HRO', departmentId: 'dept-hr', level: 2, salary: 22000, employmentType: 'Full-time' },
];

export const branches = [
  { id: 'branch-hq', name: 'Headquarters', code: 'HQ', city: 'Addis Ababa', country: 'Ethiopia', phone: '+251 11 234 5678', managerId: 'emp-001' },
  { id: 'branch-dk', name: 'Dire Dawa Branch', code: 'DD', city: 'Dire Dawa', country: 'Ethiopia', phone: '+251 57 234 5678', managerId: 'emp-002' },
];

export const organizationHierarchy = [
  { id: 'org-001', name: 'Executive Office', parentId: null, employeeId: 'emp-001', level: 1 },
  { id: 'org-002', name: 'Sales Department', parentId: 'org-001', employeeId: 'emp-001', level: 2 },
  { id: 'org-003', name: 'Operations Department', parentId: 'org-001', employeeId: 'emp-002', level: 2 },
  { id: 'org-004', name: 'Finance Department', parentId: 'org-001', employeeId: 'emp-003', level: 2 },
  { id: 'org-005', name: 'Human Resources', parentId: 'org-001', employeeId: 'emp-004', level: 2 },
];

export const employees = [
  { id: 'emp-001', employeeNumber: 'EMP-2026-001', personal: { firstName: 'Aster', lastName: 'Bekele', dateOfBirth: '1991-06-14', gender: 'Female', nationalId: 'NID-123456789', address: 'Addis Ababa, Woreda 01' }, contact: { email: 'aster.bekele@plc.local', phone: '+251 91 234 5678' }, emergencyContact: { name: 'Mikael Bekele', phone: '+251 92 987 6543', relationship: 'Spouse' }, departmentId: 'dept-sales', positionId: 'pos-sm', employmentType: 'Full-time', hireDate: '2022-01-10', contract: 'Permanent', salary: 42000, status: 'Active', attendance: 96 },
  { id: 'emp-002', employeeNumber: 'EMP-2026-002', personal: { firstName: 'Daniel', lastName: 'Meles', dateOfBirth: '1989-03-22', gender: 'Male', nationalId: 'NID-987654321', address: 'Addis Ababa, Bole' }, contact: { email: 'daniel.meles@plc.local', phone: '+251 91 111 2222' }, emergencyContact: { name: 'Tewabech Meles', phone: '+251 92 333 4444', relationship: 'Wife' }, departmentId: 'dept-operations', positionId: 'pos-ws', employmentType: 'Full-time', hireDate: '2021-08-01', contract: 'Permanent', salary: 26000, status: 'Active', attendance: 92 },
  { id: 'emp-003', employeeNumber: 'EMP-2026-003', personal: { firstName: 'Selam', lastName: 'Tadesse', dateOfBirth: '1994-11-03', gender: 'Female', nationalId: 'NID-555444333', address: 'Addis Ababa, Meskel' }, contact: { email: 'selam.tadesse@plc.local', phone: '+251 91 555 6666' }, emergencyContact: { name: 'Kassa Tadesse', phone: '+251 92 777 8888', relationship: 'Brother' }, departmentId: 'dept-finance', positionId: 'pos-fa', employmentType: 'Full-time', hireDate: '2023-03-15', contract: 'Permanent', salary: 24000, status: 'Active', attendance: 98 },
  { id: 'emp-004', employeeNumber: 'EMP-2026-004', personal: { firstName: 'Habtamu', lastName: 'Fikre', dateOfBirth: '1992-08-28', gender: 'Male', nationalId: 'NID-444333222', address: 'Addis Ababa, Woreda 02' }, contact: { email: 'habtamu.fikre@plc.local', phone: '+251 91 999 0000' }, emergencyContact: { name: 'Hirut Fikre', phone: '+251 92 111 0000', relationship: 'Sister' }, departmentId: 'dept-hr', positionId: 'pos-hr', employmentType: 'Full-time', hireDate: '2022-11-20', contract: 'Permanent', salary: 22000, status: 'Active', attendance: 94 },
];

export const attendanceRecords = [
  { id: 'att-001', employeeId: 'emp-001', date: '2026-10-07', checkIn: '08:02', checkOut: '16:42', workingHours: 8.7, overtime: 0.7, lateArrival: 2, absence: 0, status: 'Present' },
  { id: 'att-002', employeeId: 'emp-002', date: '2026-10-07', checkIn: '08:15', checkOut: '16:28', workingHours: 8.2, overtime: 0, lateArrival: 15, absence: 0, status: 'Present' },
  { id: 'att-003', employeeId: 'emp-003', date: '2026-10-07', checkIn: '08:00', checkOut: '16:30', workingHours: 8.5, overtime: 0.5, lateArrival: 0, absence: 0, status: 'Present' },
  { id: 'att-004', employeeId: 'emp-004', date: '2026-10-07', checkIn: null, checkOut: null, workingHours: 0, overtime: 0, lateArrival: 0, absence: 1, status: 'Absent' },
];

export const financeLedger = [
  { title: 'Product Sales', type: 'Revenue', date: '2026-09-20', amount: 54200 },
  { title: 'Service Contracts', type: 'Revenue', date: '2026-09-22', amount: 28650 },
  { title: 'Raw Material Purchase', type: 'Expense', date: '2026-09-18', amount: -21400 },
  { title: 'Payroll', type: 'Expense', date: '2026-09-24', amount: -18600 },
  { title: 'Logistics', type: 'Expense', date: '2026-09-25', amount: -7200 },
];

export const bankAccounts = [
  { id: 'bank-main', name: 'Commercial Bank - Main', bank: 'Commercial Bank of Ethiopia', accountNumber: '**** 4821', currency: 'ETB', balance: 4825000, type: 'Operating', status: 'Active' },
  { id: 'bank-payroll', name: 'Payroll Account', bank: 'Awash Bank', accountNumber: '**** 1904', currency: 'ETB', balance: 1268000, type: 'Payroll', status: 'Active' },
  { id: 'bank-usd', name: 'USD Reserve Account', bank: 'Dashen Bank', accountNumber: '**** 7712', currency: 'USD', balance: 38450, type: 'Reserve', status: 'Active' },
];

export const bankTransactions = [
  { id: 'BT-1001', accountId: 'bank-main', date: '2026-09-26', description: 'Customer payment - Luna Retail', category: 'Customer receipt', type: 'Credit', amount: 24800, status: 'Cleared', reference: 'SO-1024' },
  { id: 'BT-1002', accountId: 'bank-main', date: '2026-09-25', description: 'Supplier payment - Prime Supply Co.', category: 'Supplier payment', type: 'Debit', amount: 21400, status: 'Cleared', reference: 'PO-5021' },
  { id: 'BT-1003', accountId: 'bank-payroll', date: '2026-09-24', description: 'September payroll', category: 'Payroll', type: 'Debit', amount: 18600, status: 'Pending', reference: 'PAY-0926' },
  { id: 'BT-1004', accountId: 'bank-main', date: '2026-09-23', description: 'Service contract receipt', category: 'Customer receipt', type: 'Credit', amount: 28650, status: 'Cleared', reference: 'INV-2048' },
];

export const reportMetrics = [
  { label: 'Fulfillment Rate', value: '94%', progress: 94, tone: 'positive' },
  { label: 'On-Time Delivery', value: '89%', progress: 89, tone: 'neutral' },
  { label: 'Inventory Turnover', value: '6.2x', progress: 62, tone: 'positive' },
  { label: 'Expense Control', value: '76%', progress: 76, tone: 'warning' },
];

export const settings = [
  { name: 'Multi-branch access', description: 'Allow all sites to share central data', enabled: true },
  { name: 'Workflow approvals', description: 'Require approval on purchase requests', enabled: true },
  { name: 'Auto inventory sync', description: 'Sync stock across warehouses automatically', enabled: false },
  { name: 'Audit logging', description: 'Track financial and operational events', enabled: true },
];
