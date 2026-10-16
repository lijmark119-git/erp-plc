import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';

import { createDatabasePool } from '../database.js';
import { app } from '../server.js';
import { inventoryService } from '../services/inventoryService.js';

const pool = createDatabasePool();
const organizationId = (await pool.query('SELECT id FROM organizations WHERE code=$1', ['DEFAULT'])).rows[0].id;
const client = await pool.connect();
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const references = [`SALES-TEST-${suffix}`, `SALES-RECEIPT-${suffix}`];
let server;
let fixture;
let customerId;
let quotationId;
let orderId;
let deliveryId;
let invoiceId;
let paymentId;

function request(method, url, options = {}, cookie = '') {
  return fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: options.body,
  }).then(async (response) => ({
    status: response.status,
    body: await response.json(),
    headers: response.headers,
  }));
}

async function login(username, password) {
  const response = await request('POST', '/api/login', {
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200);
  return (response.headers.get('set-cookie') || '').split(';')[0];
}

const adminUsername = process.env.ADMIN_USERNAME || 'admin';
const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
const sellerUsername = process.env.SELLER_USERNAME || 'seller';
const sellerPassword = process.env.SELLER_PASSWORD || 'seller123';

async function cleanSalesFixture() {
  if (customerId) {
    await client.query('DELETE FROM sales_receivable_disputes WHERE organization_id=$1 AND receivable_id IN (SELECT id FROM accounts_receivable WHERE customer_id=$2)', [organizationId, customerId]);
    await client.query('DELETE FROM sales_customer_activities WHERE organization_id=$1 AND (customer_id=$2 OR crm_record_id IN (SELECT id FROM sales_crm_records WHERE customer_id=$2))', [organizationId, customerId]);
    await client.query('DELETE FROM sales_crm_records WHERE organization_id=$1 AND customer_id=$2', [organizationId, customerId]);
    await client.query('DELETE FROM sales_audit_trail WHERE organization_id=$1 AND entity_id IN (SELECT id FROM quotations WHERE customer_id=$2 UNION SELECT id FROM sales_orders WHERE customer_id=$2 UNION SELECT id FROM delivery_notes WHERE customer_id=$2 UNION SELECT id FROM customer_invoices WHERE customer_id=$2 UNION SELECT id FROM customer_payments WHERE customer_id=$2 UNION SELECT id FROM customers WHERE id=$2)', [organizationId, customerId]);
    await client.query('DELETE FROM invoice_lines WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE customer_id=$1)', [customerId]);
    await client.query('DELETE FROM accounts_receivable WHERE customer_id=$1', [customerId]);
    await client.query('DELETE FROM customer_payments WHERE customer_id=$1', [customerId]);
    await client.query('DELETE FROM customer_invoices WHERE customer_id=$1', [customerId]);
    await client.query('DELETE FROM delivery_line_items WHERE delivery_id IN (SELECT id FROM delivery_notes WHERE customer_id=$1)', [customerId]);
    await client.query('DELETE FROM delivery_notes WHERE customer_id=$1', [customerId]);
    await client.query('DELETE FROM sales_order_lines WHERE sales_order_id IN (SELECT id FROM sales_orders WHERE customer_id=$1)', [customerId]);
    await client.query('DELETE FROM sales_orders WHERE customer_id=$1', [customerId]);
    await client.query('DELETE FROM quotation_lines WHERE quotation_id IN (SELECT id FROM quotations WHERE customer_id=$1)', [customerId]);
    await client.query('DELETE FROM quotations WHERE customer_id=$1', [customerId]);
    await client.query('DELETE FROM customer_addresses WHERE customer_id=$1', [customerId]);
    await client.query('DELETE FROM customers WHERE id=$1', [customerId]);
  }
  const inventoryTransactions = fixture
    ? (await client.query('SELECT id FROM inventory_stock_transactions WHERE organization_id=$1 AND reference_id=ANY($2::text[])', [organizationId, references])).rows.map((row) => row.id)
    : [];
  const sourceIds = [...references, ...inventoryTransactions, ...(invoiceId ? [`invoice:${invoiceId}`] : []), ...(paymentId ? [`payment:${paymentId}`] : [])];
  if (sourceIds.length) {
    const journalIds = (await client.query("SELECT id FROM accounting_journals WHERE organization_id=$1 AND ((source_module='inventory' AND source_transaction_id=ANY($2::text[])) OR (source_module='sales' AND source_transaction_id=ANY($3::text[])))", [organizationId, inventoryTransactions, sourceIds])).rows.map((row) => row.id);
    if (journalIds.length) {
      await client.query("DELETE FROM audit_events WHERE entity_type='accounting_journal' AND entity_id=ANY($1::text[])", [journalIds]);
      await client.query('DELETE FROM accounting_journals WHERE id=ANY($1::uuid[])', [journalIds]);
    }
  }
  if (fixture) {
    await client.query('DELETE FROM inventory_stock_transactions WHERE organization_id=$1 AND (reference_id=ANY($2::text[]) OR product_id=$3)', [organizationId, references, fixture.product.id]);
    await client.query('DELETE FROM inventory_locations WHERE warehouse_id=$1', [fixture.warehouse.id]);
    await client.query('DELETE FROM inventory_warehouses WHERE id=$1', [fixture.warehouse.id]);
    await client.query('DELETE FROM inventory_products WHERE id=$1', [fixture.product.id]);
    await client.query('DELETE FROM inventory_uoms WHERE id=$1', [fixture.uom.id]);
  }
}

test('sales quote-to-cash workflow posts inventory, invoice, payment, reports, and enforces RBAC', async (t) => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close((error) => error ? resolve() : resolve()));
    await cleanSalesFixture();
    client.release();
    await pool.end();
  });

  const adminCookie = await login(adminUsername, adminPassword);
  const adminUser = (await client.query("SELECT id FROM users WHERE organization_id=$1 AND LOWER(username)=LOWER($2)", [organizationId, adminUsername])).rows[0];
  const uom = await inventoryService.createUom(client, organizationId, adminUser.id, {
    code: `SAL-${suffix}`, name: 'Sales test unit', baseUnit: 'each', factor: 1,
  });
  const product = await inventoryService.createProduct(client, organizationId, adminUser.id, {
    sku: `SAL-${suffix}`, name: `Sales fixture ${suffix}`, productType: 'TRADING_PRODUCT',
    unitOfMeasureId: uom.id, salesPrice: 120, standardCost: 30, reorderQuantity: 1,
    inventoryAccountCode: '1200', cogsAccountCode: '5000',
  });
  const warehouse = await inventoryService.createWarehouse(client, organizationId, adminUser.id, {
    code: `SAL-${suffix}`, name: `Sales warehouse ${suffix}`,
  });
  fixture = { uom, product, warehouse };
  await inventoryService.receive(client, organizationId, adminUser.id, {
    productId: product.id, warehouseId: warehouse.id, quantity: 20, unitCost: 30,
    transactionType: 'PURCHASE_RECEIPT', referenceType: 'SALES_TEST', referenceId: references[0],
  });

  const customerInput = {
    customerCode: `C-${suffix}`, legalName: `Sales customer ${suffix}`, contactPerson: 'Test Contact',
    phone: '+251900000000', email: `${suffix}@example.test`, taxId: `T-${suffix}`,
    creditLimit: 10000, paymentTerms: '30 days', currency: 'ETB',
    addresses: [{ addressType: 'billing', addressLine: 'Billing Street', city: 'Addis Ababa' }, { addressType: 'delivery', addressLine: 'Delivery Street', city: 'Addis Ababa' }],
  };
  const invalidCustomer = await request('POST', '/api/sales/customers', {
    body: JSON.stringify({ ...customerInput, customerCode: `INVALID-${suffix}`, phone: 'phone123' }),
  }, adminCookie);
  assert.equal(invalidCustomer.status, 400);
  const customer = await request('POST', '/api/sales/customers', {
    body: JSON.stringify(customerInput),
  }, adminCookie);
  assert.equal(customer.status, 201);
  customerId = customer.body.id;
  const addresses = await request('GET', `/api/sales/customers/${customerId}/addresses`, {}, adminCookie);
  assert.equal(addresses.status, 200);
  assert.equal(addresses.body.length, 2);
  const crmRecord = await request('POST', '/api/sales/crm', {
    body: JSON.stringify({ recordType: 'OPPORTUNITY', name: `Opportunity ${suffix}`, customerId, stage: 'QUALIFIED', estimatedValue: 1500 }),
  }, adminCookie);
  assert.equal(crmRecord.status, 201);
  const crmActivity = await request('POST', '/api/sales/activities', {
    body: JSON.stringify({ crmRecordId: crmRecord.body.id, activityType: 'CALL', subject: 'Discovery call', nextFollowUp: new Date(Date.now() + 86400000).toISOString().slice(0, 10) }),
  }, adminCookie);
  assert.equal(crmActivity.status, 201);
  const crmWorkspace = await request('GET', '/api/sales/crm', {}, adminCookie);
  assert.ok(crmWorkspace.body.records.some((record) => record.id === crmRecord.body.id));
  assert.ok(crmWorkspace.body.activities.some((activity) => activity.id === crmActivity.body.id));

  const line = { productSku: product.sku, productName: product.name, quantity: 4, unitPrice: 120, discountPercent: 10, taxPercent: 15 };
  const held = await request('POST', `/api/sales/customers/${customerId}/credit-hold`, {
    body: JSON.stringify({ reason: 'Past due balance under review' }),
  }, adminCookie);
  assert.equal(held.status, 200);
  assert.equal(held.body.credit_hold, true);
  assert.equal(held.body.credit_hold_reason, 'Past due balance under review');
  const heldOrder = await request('POST', '/api/sales/orders', {
    body: JSON.stringify({ customerId, lines: [line] }),
  }, adminCookie);
  assert.equal(heldOrder.status, 409);
  assert.match(heldOrder.body.error, /credit hold/i);
  const sellerCookie = await login(sellerUsername, sellerPassword);
  const unauthorizedRelease = await request('POST', `/api/sales/customers/${customerId}/credit-release`, {
    body: JSON.stringify({ reason: 'Unauthorized test' }),
  }, sellerCookie);
  assert.equal(unauthorizedRelease.status, 403);
  const released = await request('POST', `/api/sales/customers/${customerId}/credit-release`, {
    body: JSON.stringify({ reason: 'Payment plan approved' }),
  }, adminCookie);
  assert.equal(released.status, 200);
  assert.equal(released.body.credit_hold, false);

  await request('PUT', `/api/sales/customers/${customerId}`, {
    body: JSON.stringify({ creditLimit: 1000 }),
  }, adminCookie);
  const overLimitOrder = await request('POST', '/api/sales/orders', {
    body: JSON.stringify({ customerId, lines: [{ ...line, quantity: 100 }] }),
  }, adminCookie);
  assert.equal(overLimitOrder.status, 409);
  assert.match(overLimitOrder.body.error, /credit limit exceeded/i);
  await request('PUT', `/api/sales/customers/${customerId}`, {
    body: JSON.stringify({ creditLimit: 10000 }),
  }, adminCookie);
  const creditAudit = await request('GET', '/api/sales/audit', {}, adminCookie);
  assert.ok(creditAudit.body.some((entry) => entry.entity_id === customerId && entry.action === 'customer_credit_hold_placed' && entry.changes.reason === 'Past due balance under review'));
  assert.ok(creditAudit.body.some((entry) => entry.entity_id === customerId && entry.action === 'customer_credit_hold_released' && entry.changes.reason === 'Payment plan approved'));
  const validityDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const quote = await request('POST', '/api/sales/quotations', {
    body: JSON.stringify({ customerId, validityDate, lines: [line], terms: 'Net 30' }),
  }, adminCookie);
  assert.equal(quote.status, 201);
  assert.equal(Number(quote.body.total), 496.8);
  quotationId = quote.body.id;
  assert.equal((await request('POST', `/api/sales/quotations/${quotationId}/submit`, {}, adminCookie)).status, 200);
  assert.equal((await request('POST', `/api/sales/quotations/${quotationId}/decision`, { body: JSON.stringify({ status: 'Approved' }) }, sellerCookie)).status, 403);
  const quoteApproval = await request('POST', `/api/sales/quotations/${quotationId}/decision`, { body: JSON.stringify({ status: 'Approved' }) }, adminCookie);
  assert.equal(quoteApproval.status, 200);

  const converted = await request('POST', `/api/sales/quotations/${quotationId}/convert`, {
    body: JSON.stringify({ deliveryDate: validityDate, paymentTerms: '30 days' }),
  }, adminCookie);
  assert.equal(converted.status, 201);
  orderId = converted.body.id;
  assert.equal((await request('POST', `/api/sales/orders/${orderId}/submit`, {}, adminCookie)).status, 200);
  const approval = await request('POST', `/api/sales/orders/${orderId}/approve`, {}, adminCookie);
  assert.equal(approval.status, 200);
  assert.equal(approval.body.approval_status, 'Approved');

  const delivery = await request('POST', '/api/sales/deliveries', {
    body: JSON.stringify({ orderId, warehouseId: warehouse.id }),
  }, adminCookie);
  assert.equal(delivery.status, 201);
  deliveryId = delivery.body.id;
  for (const status of ['Picking', 'Packed', 'Shipped', 'Delivered']) {
    const result = await request('POST', `/api/sales/deliveries/${deliveryId}/status`, { body: JSON.stringify({ status }) }, adminCookie);
    assert.equal(result.status, 200);
  }
  assert.equal(Number((await inventoryService.getStockBalance(client, organizationId, product.id, warehouse.id)).quantity), 16);

  const dueDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const invoice = await request('POST', '/api/sales/invoices', {
    body: JSON.stringify({ orderId, dueDate }),
  }, adminCookie);
  assert.equal(invoice.status, 201);
  invoiceId = invoice.body.id;
  const issued = await request('POST', `/api/sales/invoices/${invoiceId}/issue`, {}, adminCookie);
  assert.equal(issued.status, 200);
  const invoiceJournal = await client.query("SELECT j.id FROM accounting_journals j WHERE j.organization_id=$1 AND j.source_module='sales' AND j.source_transaction_id=$2", [organizationId, `invoice:${invoiceId}`]);
  assert.ok(invoiceJournal.rows[0]);
  const invoiceReceivable = (await client.query('SELECT id FROM accounts_receivable WHERE invoice_id=$1 AND organization_id=$2', [invoiceId, organizationId])).rows[0];
  const dispute = await request('POST', '/api/sales/disputes', {
    body: JSON.stringify({ receivableId: invoiceReceivable.id, reason: 'Quantity under review' }),
  }, adminCookie);
  assert.equal(dispute.status, 201);
  const disputeReview = await request('POST', `/api/sales/disputes/${dispute.body.id}/status`, {
    body: JSON.stringify({ status: 'UNDER_REVIEW' }),
  }, adminCookie);
  assert.equal(disputeReview.status, 200);
  const disputeResolve = await request('POST', `/api/sales/disputes/${dispute.body.id}/status`, {
    body: JSON.stringify({ status: 'RESOLVED', resolution: 'Confirmed invoice quantity' }),
  }, adminCookie);
  assert.equal(disputeResolve.status, 200);
  assert.equal(disputeResolve.body.status, 'RESOLVED');
  assert.equal((await request('GET', '/api/sales/disputes', {}, adminCookie)).body.some((item) => item.id === dispute.body.id), true);

  const payment = await request('POST', '/api/sales/payments', {
    body: JSON.stringify({ invoiceId, amount: Number(invoice.body.total), paymentMethod: 'bank', referenceNumber: `BANK-${suffix}` }),
  }, adminCookie);
  assert.equal(payment.status, 201);
  paymentId = payment.body.id;
  assert.ok(payment.body.receiptNumber);
  assert.equal(Number(payment.body.outstanding), 0);
  const receivables = await request('GET', '/api/sales/receivables', {}, adminCookie);
  assert.equal(receivables.status, 200);
  assert.ok(receivables.body.some((entry) => entry.invoice_id === invoiceId && entry.current_status === 'Paid'));
  const reports = await request('GET', '/api/sales/reports', {}, adminCookie);
  assert.equal(reports.status, 200);
  assert.ok(Number(reports.body.summary.gross_sales) >= Number(invoice.body.subtotal));
  assert.ok(reports.body.byCustomer.some((entry) => entry.id === customerId));
});
