const tabs = [
  ['overview', 'Executive overview'],
  ['entities', 'Companies & plants'],
  ['centers', 'Business & centers'],
  ['fiscal-years', 'Fiscal years'],
  ['approval-rules', 'Approval matrix'],
  ['policies', 'Policies & retention'],
  ['audit', 'Governance audit'],
];

function value(record, key, escapeHtml, fallback = '—') {
  const recordValue = record?.[key];
  return recordValue === null || recordValue === undefined || recordValue === ''
    ? fallback
    : escapeHtml(recordValue);
}

function optionList(items, valueKey, labelKey, escapeHtml, emptyLabel = 'Company root') {
  return `<option value="">${escapeHtml(emptyLabel)}</option>${items.map((item) => (
    `<option value="${escapeHtml(item[valueKey])}">${escapeHtml(item[labelKey])}</option>`
  )).join('')}`;
}

function table(headers, rows, emptyMessage = 'No records yet.') {
  return `<div class="table-wrap"><table><thead><tr>${headers.map((header) => `<th>${header}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}" class="empty-state">${emptyMessage}</td></tr>`}</tbody></table></div>`;
}

function statusAction(record, collection, escapeHtml, canManage) {
  const current = collection === 'approval-rules'
    ? (record.active ? 'ACTIVE' : 'INACTIVE')
    : record.status;
  if (!canManage) return escapeHtml(current || '—');
  let next = '';
  if (collection === 'fiscal-years') next = current === 'DRAFT' ? 'OPEN' : current === 'OPEN' ? 'CLOSED' : '';
  else if (collection === 'policies') next = current === 'DRAFT' ? 'ACTIVE' : current === 'ACTIVE' ? 'RETIRED' : '';
  else if (collection === 'approval-rules') next = record.active ? 'false' : 'true';
  else next = current === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
  if (!next) return escapeHtml(current || '—');
  const label = collection === 'approval-rules'
    ? (record.active ? 'Deactivate' : 'Activate')
    : next.charAt(0) + next.slice(1).toLowerCase();
  return `<button type="button" class="small-action" data-governance-status="${collection}" data-id="${escapeHtml(record.id)}" data-next-status="${escapeHtml(next)}">${label}</button>`;
}

function renderOverview(data, escapeHtml, formatCurrency) {
  const metrics = [
    ['Subsidiaries & plants', data.dashboard?.subsidiaryAndPlantCount ?? data.entities.length],
    ['Business units', data.dashboard?.businessUnitCount ?? data.businessUnits.length],
    ['Cost centers', data.dashboard?.costCenterCount ?? data.costCenters.length],
    ['Profit centers', data.dashboard?.profitCenterCount ?? data.profitCenters.length],
    ['Open fiscal years', data.dashboard?.openFiscalYearCount ?? 0],
    ['Active approval rules', data.dashboard?.activeApprovalRuleCount ?? 0],
    ['Active policies', data.dashboard?.activePolicyCount ?? 0],
    ['Policies due for review', data.dashboard?.policiesDueForReview ?? 0],
  ];
  const metricCards = metrics.map(([label, count]) => (
    `<article class="metric-card compact-card"><div class="metric-header"><h3>${escapeHtml(label)}</h3><span class="pill neutral">${escapeHtml(count)}</span></div></article>`
  )).join('');
  const rootName = data.organization?.legalName || data.organization?.name || 'Company';
  const financeMessage = data.dashboard?.financialConsolidationReason
    || 'Financial consolidation is unavailable until transactions are tagged to legal entities.';
  return `
    <section class="governance-overview">
      <div class="content-panel"><p class="eyebrow">Company scope</p><h2>${escapeHtml(rootName)}</h2><p class="subtle">Company code ${escapeHtml(data.organization?.code || '')} · Reporting currency ${escapeHtml(data.organization?.currency || '—')}</p></div>
      <div class="grid two-column governance-metrics">${metricCards}</div>
      <div class="content-panel governance-notice"><p class="eyebrow">Consolidated reporting</p><h3>Financial consolidation is not enabled yet</h3><p>${escapeHtml(financeMessage)}</p><p class="subtle">Existing accounting screens and reports are unchanged. Governance metrics above are consolidated across this company’s governance records.</p></div>
    </section>`;
}

function renderEntities(data, canManage, escapeHtml) {
  const form = canManage ? `
    <form class="governance-form" data-governance-form="entities">
      <h3>Add subsidiary or plant</h3>
      <label>Type<select name="entityType" required><option value="SUBSIDIARY">Subsidiary</option><option value="PLANT">Plant</option></select></label>
      <label>Code<input name="code" maxlength="40" required /></label>
      <label>Name<input name="name" maxlength="160" required /></label>
      <label>Parent entity<select name="parentEntityId">${optionList(data.entities, 'id', 'name', escapeHtml)}</select></label>
      <label>Local currency<input name="currency" maxlength="3" value="${escapeHtml(data.organization?.currency || 'ETB')}" /></label>
      <button class="primary-btn" type="submit">Add entity</button><span class="governance-form-error" role="alert"></span>
    </form>` : '';
  const rows = data.entities.map((item) => `<tr><td>${value(item, 'code', escapeHtml)}</td><td>${value(item, 'name', escapeHtml)}</td><td>${value(item, 'entityType', escapeHtml)}</td><td>${value(item, 'parentName', escapeHtml)}</td><td>${value(item, 'currency', escapeHtml)}</td><td>${statusAction(item, 'entities', escapeHtml, canManage)}</td></tr>`).join('');
  return `${form}<h3>Subsidiaries and plants</h3>${table(['Code', 'Name', 'Type', 'Parent', 'Currency', 'Status'], rows)}<p class="subtle">The company itself is the parent scope. Existing branches and departments remain managed in the HR organization screen.</p>`;
}

function renderCenters(data, canManage, escapeHtml) {
  const entityOptions = optionList(data.entities, 'id', 'name', escapeHtml);
  const unitOptions = optionList(data.businessUnits, 'id', 'name', escapeHtml, 'No business unit');
  const forms = canManage ? `
    <div class="governance-form-grid">
      <form class="governance-form" data-governance-form="business-units"><h3>Add business unit</h3>
        <label>Code<input name="code" maxlength="40" required /></label><label>Name<input name="name" required /></label>
        <label>Entity<select name="entityId">${entityOptions}</select></label><label>Department code<input name="departmentCode" maxlength="40" /></label>
        <button class="primary-btn" type="submit">Add business unit</button><span class="governance-form-error" role="alert"></span>
      </form>
      ${[['cost-centers', 'cost center'], ['profit-centers', 'profit center']].map(([collection, label]) => `
        <form class="governance-form" data-governance-form="${collection}"><h3>Add ${label}</h3>
          <label>Code<input name="code" maxlength="40" required /></label><label>Name<input name="name" required /></label>
          <label>Entity<select name="entityId">${entityOptions}</select></label><label>Business unit<select name="businessUnitId">${unitOptions}</select></label>
          <label>Department code<input name="departmentCode" maxlength="40" /></label>
          <button class="primary-btn" type="submit">Add ${label}</button><span class="governance-form-error" role="alert"></span>
        </form>`).join('')}
    </div>` : '';
  const unitRows = data.businessUnits.map((item) => `<tr><td>${value(item, 'code', escapeHtml)}</td><td>${value(item, 'name', escapeHtml)}</td><td>${value(item, 'entityName', escapeHtml)}</td><td>${value(item, 'departmentCode', escapeHtml)}</td><td>${statusAction(item, 'business-units', escapeHtml, canManage)}</td></tr>`).join('');
  const centerRows = (items, collection) => items.map((item) => `<tr><td>${value(item, 'code', escapeHtml)}</td><td>${value(item, 'name', escapeHtml)}</td><td>${value(item, 'entityName', escapeHtml)}</td><td>${value(item, 'businessUnitName', escapeHtml)}</td><td>${value(item, 'departmentCode', escapeHtml)}</td><td>${statusAction(item, collection, escapeHtml, canManage)}</td></tr>`).join('');
  return `${forms}<h3>Business units</h3>${table(['Code', 'Name', 'Entity', 'Department', 'Status'], unitRows)}<h3>Cost centers</h3>${table(['Code', 'Name', 'Entity', 'Business unit', 'Department', 'Status'], centerRows(data.costCenters, 'cost-centers'))}<h3>Profit centers</h3>${table(['Code', 'Name', 'Entity', 'Business unit', 'Department', 'Status'], centerRows(data.profitCenters, 'profit-centers'))}`;
}

function renderFiscalYears(data, canManage, escapeHtml) {
  const form = canManage ? `
    <form class="governance-form" data-governance-form="fiscal-years"><h3>Create fiscal year</h3>
      <label>Code<input name="code" maxlength="40" required /></label><label>Name<input name="name" required /></label>
      <label>Entity<select name="entityId">${optionList(data.entities, 'id', 'name', escapeHtml)}</select></label>
      <label>Start date<input name="startDate" type="date" required /></label><label>End date<input name="endDate" type="date" required /></label>
      <button class="primary-btn" type="submit">Create fiscal year</button><span class="governance-form-error" role="alert"></span>
    </form>` : '';
  const rows = data.fiscalYears.map((item) => `<tr><td>${value(item, 'code', escapeHtml)}</td><td>${value(item, 'name', escapeHtml)}</td><td>${value(item, 'entityName', escapeHtml)}</td><td>${value(item, 'startDate', escapeHtml).slice(0, 10)}</td><td>${value(item, 'endDate', escapeHtml).slice(0, 10)}</td><td>${statusAction(item, 'fiscal-years', escapeHtml, canManage)}</td></tr>`).join('');
  return `${form}<h3>Fiscal years</h3>${table(['Code', 'Name', 'Entity', 'Start date', 'End date', 'Lifecycle'], rows)}<p class="subtle">Fiscal years cannot overlap for the same company or entity. Lifecycle: Draft → Open → Closed.</p>`;
}

function renderApprovalRules(data, canManage, escapeHtml, formatCurrency) {
  const form = canManage ? `
    <form class="governance-form governance-form-wide" data-governance-form="approval-rules"><h3>Add approval rule</h3>
      <label>Rule code<input name="code" maxlength="40" required /></label><label>Transaction type<input name="transactionType" maxlength="80" placeholder="Purchase order" required /></label>
      <label>Department code<input name="departmentCode" maxlength="40" /></label><label>Requester role<input name="requesterRole" maxlength="80" placeholder="Any role if blank" /></label>
      <label>Entity<select name="entityId">${optionList(data.entities, 'id', 'name', escapeHtml, 'Any entity')}</select></label>
      <label>Minimum amount<input name="minAmount" type="number" min="0" step="0.01" value="0" required /></label><label>Maximum amount<input name="maxAmount" type="number" min="0.01" step="0.01" /></label>
      <label>Currency<input name="currency" maxlength="3" value="${escapeHtml(data.organization?.currency || 'ETB')}" required /></label><label>Approver role<input name="approverRole" maxlength="80" required /></label>
      <label>Delegated from role<input name="delegatedFromRole" maxlength="80" /></label><label>Priority<input name="priority" type="number" min="0" step="1" value="100" required /></label>
      <button class="primary-btn" type="submit">Add approval rule</button><span class="governance-form-error" role="alert"></span>
    </form>` : '';
  const amount = (record, amountValue) => `${escapeHtml(record.currency)} ${Number(amountValue).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const rows = data.approvalRules.map((item) => `<tr><td>${value(item, 'code', escapeHtml)}</td><td>${value(item, 'transactionType', escapeHtml)}</td><td>${value(item, 'departmentCode', escapeHtml)}</td><td>${value(item, 'requesterRole', escapeHtml, 'Any')}</td><td>${amount(item, item.minAmount)} – ${item.maxAmount === null ? 'No upper limit' : amount(item, item.maxAmount)}</td><td>${value(item, 'approverRole', escapeHtml)}</td><td>${value(item, 'delegatedFromRole', escapeHtml)}</td><td>${statusAction(item, 'approval-rules', escapeHtml, canManage)}</td></tr>`).join('');
  return `${form}<h3>Approval matrix</h3>${table(['Rule', 'Transaction', 'Department', 'Requester role', 'Amount range', 'Approver role', 'Delegated from', 'Status'], rows)}<p class="subtle">Rules are company-scoped configuration. Existing transaction approval behavior remains unchanged until each workflow is explicitly connected to this matrix.</p>`;
}

function renderPolicies(data, canManage, escapeHtml) {
  const form = canManage ? `
    <form class="governance-form governance-form-wide" data-governance-form="policies"><h3>Register corporate policy</h3>
      <label>Policy code<input name="code" maxlength="40" required /></label><label>Title<input name="title" maxlength="200" required /></label>
      <label>Entity<select name="entityId">${optionList(data.entities, 'id', 'name', escapeHtml, 'Company-wide')}</select></label><label>Owner department<input name="ownerDepartment" maxlength="80" required /></label>
      <label>Classification<select name="classification"><option>INTERNAL</option><option>PUBLIC</option><option>CONFIDENTIAL</option><option>RESTRICTED</option></select></label>
      <label>Effective date<input name="effectiveDate" type="date" required /></label><label>Review date<input name="reviewDate" type="date" /></label>
      <label>Retention (days)<input name="retentionDays" type="number" min="0" step="1" value="0" required /></label>
      <label>Document reference<input name="documentReference" maxlength="500" placeholder="Document ID or approved repository reference" /></label>
      <button class="primary-btn" type="submit">Register policy</button><span class="governance-form-error" role="alert"></span>
    </form>` : '';
  const rows = data.policies.map((item) => `<tr><td>${value(item, 'code', escapeHtml)}</td><td>${value(item, 'title', escapeHtml)}</td><td>${value(item, 'ownerDepartment', escapeHtml)}</td><td>${value(item, 'classification', escapeHtml)}</td><td>${value(item, 'effectiveDate', escapeHtml).slice(0, 10)}</td><td>${value(item, 'reviewDate', escapeHtml).slice(0, 10)}</td><td>${value(item, 'retentionDays', escapeHtml)} days</td><td>${value(item, 'documentReference', escapeHtml)}</td><td>${statusAction(item, 'policies', escapeHtml, canManage)}</td></tr>`).join('');
  return `${form}<h3>Corporate policies & document retention</h3>${table(['Code', 'Policy', 'Owner', 'Classification', 'Effective', 'Review', 'Retention', 'Document reference', 'Lifecycle'], rows)}<p class="subtle">Retention periods and document references are recorded as governance metadata. This module does not upload files or automatically delete documents.</p>`;
}

function renderAudit(data, escapeHtml) {
  const rows = data.auditTrail.map((item) => `<tr><td>${value(item, 'occurredAt', escapeHtml)}</td><td>${value(item, 'action', escapeHtml)}</td><td>${value(item, 'entityType', escapeHtml)}</td><td>${value(item, 'entityId', escapeHtml)}</td><td>${escapeHtml(item.details ? JSON.stringify(item.details) : '')}</td></tr>`).join('');
  return `<h3>Recent governance changes</h3>${table(['When', 'Action', 'Record type', 'Record ID', 'Details'], rows, 'No governance changes have been recorded.')}`;
}

export function renderGovernancePage(state, canManage, escapeHtml, formatCurrency) {
  if (state.error) return `<section class="content-panel" role="alert"><h2>Governance data unavailable</h2><p>${escapeHtml(state.error)}</p><button class="primary-btn" type="button" data-governance-refresh>Retry</button></section>`;
  if (state.loading || !state.data) return '<section class="content-panel" role="status"><h2>Loading enterprise governance…</h2></section>';

  const selectedTab = tabs.some(([key]) => key === state.tab) ? state.tab : 'overview';
  const content = {
    overview: renderOverview(state.data, escapeHtml, formatCurrency),
    entities: renderEntities(state.data, canManage, escapeHtml),
    centers: renderCenters(state.data, canManage, escapeHtml),
    'fiscal-years': renderFiscalYears(state.data, canManage, escapeHtml),
    'approval-rules': renderApprovalRules(state.data, canManage, escapeHtml, formatCurrency),
    policies: renderPolicies(state.data, canManage, escapeHtml),
    audit: renderAudit(state.data, escapeHtml),
  }[selectedTab];
  return `<section class="governance-workspace">
    <div class="governance-intro"><p class="eyebrow">Enterprise controls</p><h2>Enterprise management & governance</h2><p>Expand the company structure and controls without changing existing HR, finance, or operational workflows.</p></div>
    ${state.message ? `<p class="governance-message" role="status">${escapeHtml(state.message)}</p>` : ''}
    <nav class="governance-tabs" aria-label="Governance sections">${tabs.map(([key, label]) => `<button type="button" data-governance-tab="${key}" class="${key === selectedTab ? 'active' : ''}" aria-current="${key === selectedTab ? 'page' : 'false'}">${label}</button>`).join('')}</nav>
    <section class="content-panel governance-content">${content}</section>
  </section>`;
}
