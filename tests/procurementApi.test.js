import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';

import { app, databasePool } from '../server.js';
import { inventoryService } from '../services/inventoryService.js';

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
  let requisitionId;
  let supplierInvoiceId;
  let inventoryClient;
  let inventoryFixture;

  try {
    const cookie = await login(baseUrl);
    const suffix = `${Date.now()}`;
    inventoryClient = await databasePool.connect();
    const organizationId = (await inventoryClient.query(
      'SELECT id FROM organizations WHERE code=$1',
      ['DEFAULT'],
    )).rows[0].id;
    const actorId = (await inventoryClient.query(
      'SELECT id FROM users WHERE organization_id=$1 AND LOWER(username)=LOWER($2)',
      [organizationId, process.env.ADMIN_USERNAME || 'admin'],
    )).rows[0].id;
    const uom = await inventoryService.createUom(inventoryClient, organizationId, actorId, {
      code: `PR-${suffix}`, name: 'Procurement receipt test unit', baseUnit: 'each', factor: 1,
    });
    const product = await inventoryService.createProduct(inventoryClient, organizationId, actorId, {
      sku: `PR-${suffix}`, name: `Procurement stock fixture ${suffix}`, productType: 'TRADING_PRODUCT',
      unitOfMeasureId: uom.id, standardCost: 100, inventoryAccountCode: '1200',
      cogsAccountCode: '5000', grniAccountCode: '2000',
    });
    const warehouse = await inventoryService.createWarehouse(inventoryClient, organizationId, actorId, {
      code: `PR-${suffix}`, name: `Procurement receipt warehouse ${suffix}`,
    });
    inventoryFixture = { organizationId, actorId, uom, product, warehouse };
    const supplierOne = await request(baseUrl, cookie, '/api/procurement/suppliers', 'POST', {
      supplierCode: `TST-A-${suffix}`,
      name: `Test Supplier A ${suffix}`,
      paymentTerms: 'Net 30',
      qualificationStatus: 'QUALIFIED',
      riskLevel: 'LOW',
    });
    assert.equal(supplierOne.response.status, 201);
    assert.equal(supplierOne.body.qualification_status, 'QUALIFIED');
    createdSupplierIds.push(supplierOne.body.id);

    const supplierTwo = await request(baseUrl, cookie, '/api/procurement/suppliers', 'POST', {
      supplierCode: `TST-B-${suffix}`,
      name: `Test Supplier B ${suffix}`,
      paymentTerms: 'Net 15',
    });
    assert.equal(supplierTwo.response.status, 201);
    createdSupplierIds.push(supplierTwo.body.id);
    const supplierDocument = await request(baseUrl, cookie, '/api/procurement/supplier-documents', 'POST', {
      supplierId: supplierOne.body.id,
      documentType: 'Certification',
      documentName: 'Test quality certification',
      expiryDate: '2027-12-31',
      referenceUrl: 'https://example.org/certification',
    });
    assert.equal(supplierDocument.response.status, 201, supplierDocument.body.error);

    const overBudget = await request(baseUrl, cookie, '/api/procurement/requisitions', 'POST', {
      title: 'Over budget request', description: 'Budget guard test', quantity: 5, estimatedUnitCost: 100, budgetLimit: 400,
    });
    assert.equal(overBudget.response.status, 409);
    const requisition = await request(baseUrl, cookie, '/api/procurement/requisitions', 'POST', {
      title: `Test request ${suffix}`, description: 'Budget validated requisition', quantity: 5, estimatedUnitCost: 100, budgetLimit: 500,
    });
    assert.equal(requisition.response.status, 201, requisition.body.error);
    requisitionId = requisition.body.id;
    const requisitionDecision = await request(baseUrl, cookie, `/api/procurement/requisitions/${requisitionId}/decision`, 'POST', {
      decision: 'APPROVED', reason: 'Within approved budget',
    });
    assert.equal(requisitionDecision.response.status, 200, requisitionDecision.body.error);

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
      sku: `PR-${suffix}`,
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

    const firstReceiptInput = {
      quantity: 2, productSku: product.sku, warehouseId: warehouse.id,
      reason: 'First delivery', idempotencyKey: randomUUID(),
    };
    const partialReceipt = await request(baseUrl, cookie, `/api/procurement/orders/${orderId}/receive`, 'POST', firstReceiptInput);
    assert.equal(partialReceipt.response.status, 200, partialReceipt.body.error);
    assert.equal(partialReceipt.body.status, 'PARTIALLY_RECEIVED');
    assert.equal(Number((await inventoryService.getStockBalance(inventoryClient, organizationId, product.id, warehouse.id)).quantity), 2);
    const retriedReceipt = await request(baseUrl, cookie, `/api/procurement/orders/${orderId}/receive`, 'POST', firstReceiptInput);
    assert.equal(retriedReceipt.response.status, 200, retriedReceipt.body.error);
    assert.equal(retriedReceipt.body.idempotentReplay, true);
    assert.equal(Number((await inventoryService.getStockBalance(inventoryClient, organizationId, product.id, warehouse.id)).quantity), 2);

    const finalReceipt = await request(baseUrl, cookie, `/api/procurement/orders/${orderId}/receive`, 'POST', {
      quantity: 3, productSku: product.sku, warehouseId: warehouse.id,
      reason: 'Balance delivered', idempotencyKey: randomUUID(),
    });
    assert.equal(finalReceipt.response.status, 200, finalReceipt.body.error);
    assert.equal(finalReceipt.body.status, 'RECEIVED');
    assert.equal(Number((await inventoryService.getStockBalance(inventoryClient, organizationId, product.id, warehouse.id)).quantity), 5);
    const postedReceiptJournals = await inventoryClient.query(
      `SELECT journal.status
       FROM procurement_purchase_order_receipts receipt
       JOIN accounting_journals journal
         ON journal.organization_id=receipt.organization_id
        AND journal.source_module='inventory'
        AND journal.source_transaction_id=receipt.inventory_transaction_id::text
       WHERE receipt.purchase_order_id=$1`,
      [orderId],
    );
    assert.equal(postedReceiptJournals.rowCount, 2);
    assert.ok(postedReceiptJournals.rows.every((journal) => journal.status === 'POSTED'));
    const supplierInvoice = await request(baseUrl, cookie, '/api/procurement/supplier-invoices', 'POST', {
      purchaseOrderId: orderId, supplierInvoiceNumber: `INV-${suffix}`, invoiceQuantity: 5, invoiceAmount: 580,
    });
    assert.equal(supplierInvoice.response.status, 201, supplierInvoice.body.error);
    supplierInvoiceId = supplierInvoice.body.id;
    const invoiceMatch = await request(baseUrl, cookie, `/api/procurement/supplier-invoices/${supplierInvoiceId}/match`, 'POST', {});
    assert.equal(invoiceMatch.response.status, 200, invoiceMatch.body.error);
    assert.equal(invoiceMatch.body.status, 'MATCHED');

    const workspace = await request(baseUrl, cookie, '/api/procurement/workspace');
    const savedDocument = workspace.body.supplierDocuments.find((item) => item.id === supplierDocument.body.id);
    assert.equal(savedDocument.expiry_status, 'CURRENT');
    assert.equal(savedDocument.supplier_id, supplierOne.body.id);
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
      if (orderId) {
        const transactionIds = (await databasePool.query(
          'SELECT inventory_transaction_id FROM procurement_purchase_order_receipts WHERE purchase_order_id=$1 AND inventory_transaction_id IS NOT NULL',
          [orderId],
        )).rows.map((row) => row.inventory_transaction_id);
        if (transactionIds.length) {
          const journalIds = (await databasePool.query(
            `SELECT id FROM accounting_journals
             WHERE organization_id=$1 AND source_module='inventory'
               AND source_transaction_id=ANY($2::text[])`,
            [inventoryFixture.organizationId, transactionIds],
          )).rows.map((row) => row.id);
          if (journalIds.length) {
            await databasePool.query("DELETE FROM audit_events WHERE entity_type='accounting_journal' AND entity_id=ANY($1::text[])", [journalIds]);
            await databasePool.query('DELETE FROM accounting_journals WHERE id=ANY($1::uuid[])', [journalIds]);
          }
          await databasePool.query('DELETE FROM procurement_purchase_order_receipts WHERE purchase_order_id=$1', [orderId]);
          await databasePool.query('DELETE FROM inventory_stock_transactions WHERE id=ANY($1::uuid[])', [transactionIds]);
        }
      }
      if (supplierInvoiceId) {
        await databasePool.query('DELETE FROM procurement_audit_history WHERE entity_id=$1', [supplierInvoiceId]);
        await databasePool.query('DELETE FROM procurement_supplier_invoices WHERE id=$1', [supplierInvoiceId]);
      }
      await databasePool.query(
        'DELETE FROM procurement_audit_history WHERE entity_id = ANY($1::uuid[])',
        [[comparisonId, orderId].filter(Boolean)],
      );
      await databasePool.query('DELETE FROM procurement_purchase_orders WHERE comparison_id = $1', [comparisonId]);
      await databasePool.query('DELETE FROM procurement_comparisons WHERE id = $1', [comparisonId]);
    }
    if (databasePool && requisitionId) {
      await databasePool.query('DELETE FROM procurement_audit_history WHERE entity_id=$1', [requisitionId]);
      await databasePool.query('DELETE FROM procurement_requisitions WHERE id=$1', [requisitionId]);
    }
    if (databasePool && createdSupplierIds.length) {
      await databasePool.query(
        `DELETE FROM procurement_audit_history WHERE entity_id = ANY($1::uuid[])`,
        [createdSupplierIds],
      );
      await databasePool.query('DELETE FROM procurement_suppliers WHERE id = ANY($1::uuid[])', [createdSupplierIds]);
    }
    if (inventoryFixture) {
      await databasePool.query('DELETE FROM inventory_warehouses WHERE id=$1', [inventoryFixture.warehouse.id]);
      await databasePool.query('DELETE FROM inventory_products WHERE id=$1', [inventoryFixture.product.id]);
      await databasePool.query('DELETE FROM inventory_uoms WHERE id=$1', [inventoryFixture.uom.id]);
    }
    inventoryClient?.release();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

after(async () => {
  if (databasePool) await databasePool.end();
});
