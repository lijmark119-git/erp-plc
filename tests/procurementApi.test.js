import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { app, databasePool } from '../server.js';

async function startServer() {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function login(baseUrl) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: process.env.ADMIN_USERNAME,
      password: process.env.ADMIN_PASSWORD,
    }),
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

async function request(baseUrl, cookie, endpoint, method = 'GET', payload) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return { response, body: await response.json() };
}

test('procurement comparisons persist quotes, selection, approvals, receipts, and audit history', async () => {
  const { server, baseUrl } = await startServer();
  const createdSupplierIds = [];
  let comparisonId;
  let orderId;

  try {
    const cookie = await login(baseUrl);
    const suffix = `${Date.now()}`;
    const supplierOne = await request(baseUrl, cookie, '/api/procurement/suppliers', 'POST', {
      supplierCode: `TST-A-${suffix}`,
      name: `Test Supplier A ${suffix}`,
      paymentTerms: 'Net 30',
    });
    assert.equal(supplierOne.response.status, 201);
    createdSupplierIds.push(supplierOne.body.id);

    const supplierTwo = await request(baseUrl, cookie, '/api/procurement/suppliers', 'POST', {
      supplierCode: `TST-B-${suffix}`,
      name: `Test Supplier B ${suffix}`,
      paymentTerms: 'Net 15',
    });
    assert.equal(supplierTwo.response.status, 201);
    createdSupplierIds.push(supplierTwo.body.id);

    const sellerLogin = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: process.env.SELLER_USERNAME, password: process.env.SELLER_PASSWORD }),
    });
    const sellerCookie = sellerLogin.headers.get('set-cookie').split(';')[0];
    const denied = await request(baseUrl, sellerCookie, '/api/procurement/workspace');
    assert.equal(denied.response.status, 403);

    const comparison = await request(baseUrl, cookie, '/api/procurement/comparisons', 'POST', {
      title: `Procurement test ${suffix}`,
      productDescription: 'Comparison fixture',
      quantity: 5,
      currency: 'ETB',
      quotes: [
        { supplierId: supplierOne.body.id, unitPrice: 100, taxRate: 15, deliveryDays: 7, shippingCost: 5, otherCost: 0, paymentTerms: 'Net 30' },
        { supplierId: supplierTwo.body.id, unitPrice: 120, taxRate: 0, deliveryDays: 3, shippingCost: 0, otherCost: 0, paymentTerms: 'Net 15' },
      ],
    });
    assert.equal(comparison.response.status, 201, comparison.body.error);
    comparisonId = comparison.body.id;

    const selectedQuoteId = comparison.body.selected_quote_id || (
      await request(baseUrl, cookie, '/api/procurement/workspace')
    ).body.comparisons.find((item) => item.id === comparisonId).quotes
      .find((quote) => quote.supplier_id === supplierOne.body.id).id;
    const selection = await request(baseUrl, cookie, `/api/procurement/comparisons/${comparisonId}/select`, 'POST', {
      quoteId: selectedQuoteId,
      reason: 'Lowest landed cost within acceptable lead time',
    });
    assert.equal(selection.response.status, 200, selection.body.error);
    assert.equal(selection.body.status, 'SELECTED');

    const createdOrder = await request(baseUrl, cookie, `/api/procurement/comparisons/${comparisonId}/orders`, 'POST', {});
    assert.equal(createdOrder.response.status, 201, createdOrder.body.error);
    orderId = createdOrder.body.id;

    const approval = await request(baseUrl, cookie, `/api/procurement/orders/${orderId}/approve`, 'POST', {
      reason: 'Budget and supplier terms approved',
    });
    assert.equal(approval.response.status, 200, approval.body.error);
    assert.equal(approval.body.status, 'APPROVED');

    const partialReceipt = await request(baseUrl, cookie, `/api/procurement/orders/${orderId}/receive`, 'POST', {
      quantity: 2,
      reason: 'First delivery',
    });
    assert.equal(partialReceipt.response.status, 200, partialReceipt.body.error);
    assert.equal(partialReceipt.body.status, 'PARTIALLY_RECEIVED');

    const finalReceipt = await request(baseUrl, cookie, `/api/procurement/orders/${orderId}/receive`, 'POST', {
      quantity: 3,
      reason: 'Balance delivered',
    });
    assert.equal(finalReceipt.response.status, 200, finalReceipt.body.error);
    assert.equal(finalReceipt.body.status, 'RECEIVED');

    const workspace = await request(baseUrl, cookie, '/api/procurement/workspace');
    const savedComparison = workspace.body.comparisons.find((item) => item.id === comparisonId);
    const savedOrder = workspace.body.orders.find((item) => item.id === orderId);
    assert.equal(savedComparison.status, 'ORDERED');
    assert.equal(Number(savedComparison.quotes[0].tax_amount), 75);
    assert.equal(Number(savedOrder.total_cost), 580);
    assert.equal(Number(savedOrder.received_quantity), 5);
    assert.deepEqual(
      savedOrder.history.map((event) => event.action).sort(),
      ['GOODS_RECEIVED', 'GOODS_RECEIVED', 'PURCHASE_ORDER_CREATED', 'APPROVED'].sort(),
    );
  } finally {
    if (databasePool && comparisonId) {
      await databasePool.query(
        'DELETE FROM procurement_audit_history WHERE entity_id = ANY($1::uuid[])',
        [[comparisonId, orderId].filter(Boolean)],
      );
      await databasePool.query('DELETE FROM procurement_purchase_orders WHERE comparison_id = $1', [comparisonId]);
      await databasePool.query('DELETE FROM procurement_comparisons WHERE id = $1', [comparisonId]);
    }
    if (databasePool && createdSupplierIds.length) {
      await databasePool.query(
        `DELETE FROM procurement_audit_history WHERE entity_id = ANY($1::uuid[])`,
        [createdSupplierIds],
      );
      await databasePool.query('DELETE FROM procurement_suppliers WHERE id = ANY($1::uuid[])', [createdSupplierIds]);
    }
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

after(async () => {
  if (databasePool) await databasePool.end();
});
