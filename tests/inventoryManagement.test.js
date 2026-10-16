import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';

import { createDatabasePool } from '../database.js';
import { inventoryService } from '../services/inventoryService.js';

const pool = createDatabasePool();
const organizationId = (await pool.query('SELECT id FROM organizations WHERE code = $1', ['DEFAULT'])).rows[0].id;
const client = await pool.connect();
const actorId = (await client.query('SELECT id FROM users WHERE organization_id = $1 AND active = TRUE ORDER BY created_at LIMIT 1', [organizationId])).rows[0].id;
const testResources = { products: [], warehouses: [], locations: [], uoms: [] };

after(async () => {
  try {
    await client.query(
    `DELETE FROM accounting_journal_lines WHERE journal_id IN (
       SELECT id FROM accounting_journals
       WHERE source_transaction_id IN (
         SELECT id::text FROM inventory_stock_transactions
         WHERE organization_id = $1 AND product_id = ANY($2::uuid[])
       )
     )`,
    [organizationId, testResources.products],
    );
    await client.query(
    `DELETE FROM accounting_journals
     WHERE source_transaction_id IN (
       SELECT id::text FROM inventory_stock_transactions
       WHERE organization_id = $1 AND product_id = ANY($2::uuid[])
     )`,
    [organizationId, testResources.products],
    );
    await client.query(
    'DELETE FROM inventory_count_lines WHERE organization_id = $1 AND product_id = ANY($2::uuid[])',
    [organizationId, testResources.products],
    );
    await client.query(
    'DELETE FROM inventory_count_sessions WHERE organization_id = $1 AND warehouse_id = ANY($2::uuid[])',
    [organizationId, testResources.warehouses],
    );
    await client.query(
    'DELETE FROM inventory_adjustments WHERE organization_id = $1 AND product_id = ANY($2::uuid[])',
    [organizationId, testResources.products],
    );
    await client.query(
    'DELETE FROM inventory_transfer_requests WHERE organization_id = $1 AND product_id = ANY($2::uuid[])',
    [organizationId, testResources.products],
    );
    await client.query(
    'DELETE FROM inventory_audit_events WHERE organization_id = $1 AND inventory_entity_id = ANY($2::uuid[])',
    [organizationId, [...testResources.products, ...testResources.warehouses, ...testResources.locations, ...testResources.uoms]],
    );
    await client.query(
    'DELETE FROM inventory_stock_transactions WHERE organization_id = $1 AND product_id = ANY($2::uuid[])',
    [organizationId, testResources.products],
    );
    await client.query(
    'DELETE FROM inventory_locations WHERE organization_id = $1 AND id = ANY($2::uuid[])',
    [organizationId, testResources.locations],
    );
    await client.query(
    'DELETE FROM inventory_products WHERE organization_id = $1 AND id = ANY($2::uuid[])',
    [organizationId, testResources.products],
    );
    await client.query(
    'DELETE FROM inventory_warehouses WHERE organization_id = $1 AND id = ANY($2::uuid[])',
    [organizationId, testResources.warehouses],
    );
    await client.query(
    'DELETE FROM inventory_uom_conversions WHERE organization_id = $1 AND (from_uom_id = ANY($2::uuid[]) OR to_uom_id = ANY($2::uuid[]))',
    [organizationId, testResources.uoms],
    );
    await client.query(
    'DELETE FROM inventory_uoms WHERE organization_id = $1 AND id = ANY($2::uuid[])',
    [organizationId, testResources.uoms],
    );
  } finally {
    client.release();
    await pool.end();
  }
});

async function createTestFixture() {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const uom = await inventoryService.createUom(client, organizationId, actorId, {
    code: `EA-${suffix}`, name: 'Test Each', baseUnit: `EA-${suffix}`, factor: 1,
  });
  const product = await inventoryService.createProduct(client, organizationId, actorId, {
    sku: `INV-${suffix}`, name: 'Inventory Test Product', productType: 'RAW_MATERIAL',
    unitOfMeasureId: uom.id, standardCost: 25, minimumStock: 5, reorderLevel: 5,
    reorderQuantity: 5, inventoryAccountCode: '1200', cogsAccountCode: '5000',
    wipAccountCode: '1300', finishedGoodsAccountCode: '1400', grniAccountCode: '2000',
    valuationMethod: 'FIFO',
  });
  const source = await inventoryService.createWarehouse(client, organizationId, actorId, {
    code: `SRC-${suffix}`, name: 'Source Warehouse',
  });
  const destination = await inventoryService.createWarehouse(client, organizationId, actorId, {
    code: `DST-${suffix}`, name: 'Destination Warehouse',
  });
  const sourceLocation = await inventoryService.createLocation(client, organizationId, actorId, {
    warehouseId: source.id, code: `S-${suffix}`, name: 'Source Bin', binCode: 'A-01',
  });
  const destinationLocation = await inventoryService.createLocation(client, organizationId, actorId, {
    warehouseId: destination.id, code: `D-${suffix}`, name: 'Destination Bin', binCode: 'B-01',
  });
  testResources.products.push(product.id);
  testResources.warehouses.push(source.id, destination.id);
  testResources.locations.push(sourceLocation.id, destinationLocation.id);
  testResources.uoms.push(uom.id);
  return { product, source, destination, sourceLocation, destinationLocation };
}

test('stock transfer history persists requested, approved, rejected, dispatched, and received actions', async () => {
  const fixture = await createTestFixture();
  await inventoryService.receive(client, organizationId, actorId, {
    productId: fixture.product.id, warehouseId: fixture.source.id, locationId: fixture.sourceLocation.id,
    quantity: 10, unitCost: 10, referenceType: 'PURCHASE_RECEIPT', referenceId: `TRANSFER-HISTORY-${randomUUID()}`,
  });

  const transfer = await inventoryService.createTransfer(client, organizationId, actorId, {
    productId: fixture.product.id, sourceWarehouseId: fixture.source.id, destinationWarehouseId: fixture.destination.id,
    sourceLocationId: fixture.sourceLocation.id, destinationLocationId: fixture.destinationLocation.id,
    requestedQuantity: 4, reason: 'Replenish destination stock',
  });
  await inventoryService.approveTransfer(client, organizationId, actorId, transfer.id, 4, 'Request approved for replenishment');
  await inventoryService.dispatchTransfer(client, organizationId, actorId, transfer.id, 'Dispatched on route 5');
  await inventoryService.receiveTransfer(client, organizationId, actorId, transfer.id, 'Quantity checked on arrival');

  const rejectedTransfer = await inventoryService.createTransfer(client, organizationId, actorId, {
    productId: fixture.product.id, sourceWarehouseId: fixture.source.id, destinationWarehouseId: fixture.destination.id,
    requestedQuantity: 1, reason: 'Urgent replenishment',
  });
  await inventoryService.rejectTransfer(client, organizationId, actorId, rejectedTransfer.id, 'Destination is at capacity');

  const history = await inventoryService.getTransferHistory(client, organizationId, transfer.id);
  assert.deepEqual(history.map((event) => event.event_type), ['REQUESTED', 'APPROVED', 'DISPATCHED', 'RECEIVED']);
  assert.ok(history.every((event) => event.actor_user_id === actorId && event.occurred_at));
  assert.deepEqual(history.map((event) => event.reason), [
    'Replenish destination stock',
    'Request approved for replenishment',
    'Dispatched on route 5',
    'Quantity checked on arrival',
  ]);
  const listedTransfer = (await inventoryService.getTransfers(client, organizationId))
    .find((item) => item.id === transfer.id);
  assert.equal(listedTransfer.history.length, 4);
  assert.ok(listedTransfer.history.every((event) => event.actorName));
  assert.equal(listedTransfer.requester_name, listedTransfer.history[0].actorName);
  assert.ok(listedTransfer.unit_of_measure_code);
  assert.equal(listedTransfer.source_location_code, fixture.sourceLocation.code);
  assert.equal(listedTransfer.destination_location_code, fixture.destinationLocation.code);
  assert.equal(listedTransfer.source_bin_code, fixture.sourceLocation.bin_code);
  assert.equal(listedTransfer.destination_bin_code, fixture.destinationLocation.bin_code);
  const rejectedHistory = await inventoryService.getTransferHistory(client, organizationId, rejectedTransfer.id);
  assert.deepEqual(rejectedHistory.map((event) => event.event_type), ['REQUESTED', 'REJECTED']);
  assert.equal(rejectedHistory[1].reason, 'Destination is at capacity');
  assert.equal(rejectedHistory[1].actor_user_id, actorId);
  const listedRejectedTransfer = (await inventoryService.getTransfers(client, organizationId))
    .find((item) => item.id === rejectedTransfer.id);
  assert.equal(listedRejectedTransfer.history[1].actorName, listedRejectedTransfer.requester_name);
  await assert.rejects(
    inventoryService.createTransfer(client, organizationId, actorId, {
      productId: fixture.product.id,
      sourceWarehouseId: fixture.source.id,
      destinationWarehouseId: fixture.destination.id,
      sourceLocationId: fixture.destinationLocation.id,
      requestedQuantity: 1,
      reason: 'Invalid source location',
    }),
    /Source location must be active and belong to its selected warehouse/,
  );
});

test('inventory movements create immutable ledger entries and balanced journals', async () => {
  const fixture = await createTestFixture();
  const receipt = await inventoryService.receive(client, organizationId, actorId, {
    productId: fixture.product.id, warehouseId: fixture.source.id, locationId: fixture.sourceLocation.id,
    quantity: 20, unitCost: 10, referenceType: 'PURCHASE_RECEIPT', referenceId: `PO-${randomUUID()}`,
  });
  assert.equal(Number(receipt.transaction.quantity), 20);
  assert.equal(Number(receipt.transaction.total_cost), 200);
  assert.equal(receipt.journal.status, 'APPROVED');
  assert.equal(receipt.journal.lines.length, 2);
  const receiptLines = (await client.query(
    `SELECT account.account_code,line.debit,line.credit FROM accounting_journal_lines line
     JOIN accounting_accounts account ON account.id=line.account_id WHERE line.journal_id=$1`,
    [receipt.journal.id],
  )).rows;
  assert.equal(Number(receiptLines.find((line) => line.account_code === '1200').debit), 200);
  assert.equal(Number(receiptLines.find((line) => line.account_code === '2000').credit), 200);

  const issue = await inventoryService.issue(client, organizationId, actorId, {
    productId: fixture.product.id, warehouseId: fixture.source.id, locationId: fixture.sourceLocation.id,
    quantity: 7, unitCost: 10, referenceType: 'MANUFACTURING_ISSUE', referenceId: `MO-${randomUUID()}`,
  });
  assert.equal(Number(issue.transaction.quantity), 7);
  const issueLines = (await client.query(
    `SELECT account.account_code,line.debit,line.credit FROM accounting_journal_lines line
     JOIN accounting_accounts account ON account.id=line.account_id WHERE line.journal_id=$1`,
    [issue.journal.id],
  )).rows;
  assert.equal(Number(issueLines.find((line) => line.account_code === '1300').debit), 70);
  assert.equal(Number(issueLines.find((line) => line.account_code === '1200').credit), 70);
  assert.equal(Number((await inventoryService.getStockBalance(client, organizationId, fixture.product.id, fixture.source.id)).quantity), 13);

  const transfer = await inventoryService.createTransfer(client, organizationId, actorId, {
    productId: fixture.product.id, sourceWarehouseId: fixture.source.id, destinationWarehouseId: fixture.destination.id,
    sourceLocationId: fixture.sourceLocation.id, destinationLocationId: fixture.destinationLocation.id,
    requestedQuantity: 5, reason: 'Warehouse replenishment',
  });
  const approved = await inventoryService.approveTransfer(client, organizationId, actorId, transfer.id, 5, 'Stock available for replenishment');
  const dispatched = await inventoryService.dispatchTransfer(client, organizationId, actorId, transfer.id, 'Loaded on vehicle 12');
  const received = await inventoryService.receiveTransfer(client, organizationId, actorId, transfer.id, 'Count verified at destination');
  const history = await inventoryService.getTransferHistory(client, organizationId, transfer.id);
  assert.deepEqual(history.map((event) => event.event_type), ['REQUESTED', 'APPROVED', 'DISPATCHED', 'RECEIVED']);
  assert.ok(history.every((event) => event.actor_user_id === actorId && event.occurred_at));
  assert.deepEqual(history.map((event) => event.reason), [
    'Warehouse replenishment',
    'Stock available for replenishment',
    'Loaded on vehicle 12',
    'Count verified at destination',
  ]);
  assert.equal(dispatched.transaction.direction, 'OUT');
  assert.equal(received.transaction.direction, 'IN');
  assert.equal((await inventoryService.getStockBalance(client, organizationId, fixture.product.id, fixture.destination.id)).quantity, 5);
  assert.equal((await inventoryService.getStockBalance(client, organizationId, fixture.product.id, fixture.source.id)).quantity, 8);

  const rejectedTransfer = await inventoryService.createTransfer(client, organizationId, actorId, {
    productId: fixture.product.id, sourceWarehouseId: fixture.source.id, destinationWarehouseId: fixture.destination.id,
    requestedQuantity: 1, reason: 'Additional test request',
  });
  const rejected = await inventoryService.rejectTransfer(client, organizationId, actorId, rejectedTransfer.id, 'Destination capacity is full');
  assert.equal(rejected.status, 'REJECTED');
  const rejectionHistory = await inventoryService.getTransferHistory(client, organizationId, rejectedTransfer.id);
  assert.deepEqual(rejectionHistory.map((event) => event.event_type), ['REQUESTED', 'REJECTED']);
  assert.equal(rejectionHistory[1].actor_user_id, actorId);
  assert.equal(rejectionHistory[1].reason, 'Destination capacity is full');

  const adjustment = await inventoryService.createAdjustment(client, organizationId, actorId, {
    productId: fixture.product.id, warehouseId: fixture.destination.id, locationId: fixture.destinationLocation.id,
    quantity: 2, adjustmentType: 'ADD', reason: 'Damaged stock correction', cost: 12,
  });
  const approvedAdjustment = await inventoryService.approveAdjustment(client, organizationId, actorId, adjustment.id);
  const postedAdjustment = await inventoryService.postAdjustment(client, organizationId, actorId, adjustment.id);
  assert.equal(approvedAdjustment.status, 'APPROVED');
  assert.equal(postedAdjustment.transaction.direction, 'IN');
  assert.equal((await inventoryService.getStockBalance(client, organizationId, fixture.product.id, fixture.destination.id)).quantity, 7);

  const countSession = await inventoryService.createCountSession(client, organizationId, actorId, {
    warehouseId: fixture.destination.id,
    lines: [{ productId: fixture.product.id, locationId: fixture.destinationLocation.id, countedQuantity: 9 }],
  });
  const approvedCount = await inventoryService.approveCountSession(client, organizationId, actorId, countSession.id);
  const postedCount = await inventoryService.postCountSession(client, organizationId, actorId, countSession.id);
  assert.equal(approvedCount.status, 'APPROVED');
  assert.equal(postedCount.adjustments.length, 1);
  assert.equal(postedCount.adjustments[0].direction, 'IN');
  assert.equal((await inventoryService.getStockBalance(client, organizationId, fixture.product.id, fixture.destination.id)).quantity, 9);

  const postedReceipt = await inventoryService.receive(client, organizationId, actorId, {
    productId: fixture.product.id,
    warehouseId: fixture.destination.id,
    locationId: fixture.destinationLocation.id,
    quantity: 1,
    unitCost: 10,
    referenceType: 'PURCHASE_RECEIPT',
    referenceId: `API-POST-${randomUUID()}`,
    postToLedger: true,
  });
  assert.equal(postedReceipt.journal.status, 'POSTED');
});

test('failed stock movement rolls back its transaction and journal', async () => {
  const fixture = await createTestFixture();
  const receipt = await inventoryService.receive(client, organizationId, actorId, {
    productId: fixture.product.id, warehouseId: fixture.source.id, locationId: fixture.sourceLocation.id,
    quantity: 3, unitCost: 4, referenceType: 'PURCHASE_RECEIPT', referenceId: `PO-${randomUUID()}`,
  });
  await assert.rejects(() => inventoryService.issue(client, organizationId, actorId, {
    productId: fixture.product.id, warehouseId: fixture.source.id, locationId: fixture.sourceLocation.id,
    quantity: 10, unitCost: 4, referenceType: 'MANUFACTURING_ISSUE', referenceId: `MO-${randomUUID()}`,
  }), /Insufficient stock/);
  const balance = await inventoryService.getStockBalance(client, organizationId, fixture.product.id, fixture.source.id);
  assert.equal(Number(balance.quantity), 3);
  const transactions = await inventoryService.getStockTransactions(client, organizationId, { productId: fixture.product.id });
  assert.equal(transactions.filter((row) => row.reference_id === receipt.transaction.reference_id).length, 1);
});

test('product master, uom conversions, adjustments, stock counts, valuation, and reports operate end-to-end', async () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const uomBox = await inventoryService.createUom(client, organizationId, actorId, {
    code: `BX-${suffix}`, name: 'Box of 10', baseUnit: 'piece', factor: 10,
  });
  const uomEach = await inventoryService.createUom(client, organizationId, actorId, {
    code: `PC-${suffix}`, name: 'Piece', baseUnit: 'piece', factor: 1,
  });
  testResources.uoms.push(uomBox.id, uomEach.id);

  // Unit conversion
  const conversion = await inventoryService.createUomConversion(client, organizationId, actorId, {
    fromUomId: uomBox.id, toUomId: uomEach.id, factor: 10,
  });
  assert.equal(Number(conversion.factor), 10);
  const converted = await inventoryService.convertUom(client, organizationId, uomBox.id, uomEach.id, 5);
  assert.equal(converted.toQuantity, 50);

  // Product Master
  const product = await inventoryService.createProduct(client, organizationId, actorId, {
    sku: `PM-${suffix}`, productCode: `COD-${suffix}`, barcode: `BAR-${suffix}`,
    name: 'Master Finished Product', description: 'Complete inventory product',
    category: 'Electronics', brand: 'PLC-Tech', productType: 'FINISHED_GOOD',
    unitOfMeasureId: uomEach.id, purchasePrice: 40, salesPrice: 85, standardCost: 45,
    taxCategory: 'STANDARD', minimumStock: 10, maximumStock: 200, reorderLevel: 25,
    reorderQuantity: 50, valuationMethod: 'WEIGHTED_AVERAGE',
  });
  testResources.products.push(product.id);
  assert.equal(product.sku, `PM-${suffix}`);
  assert.equal(product.product_type, 'FINISHED_GOOD');
  assert.equal(product.valuation_method, 'WEIGHTED_AVERAGE');

  // Warehouse & Location
  const warehouse = await inventoryService.createWarehouse(client, organizationId, actorId, {
    code: `WH-${suffix}`, name: 'Valuation Test Warehouse',
  });
  const location = await inventoryService.createLocation(client, organizationId, actorId, {
    warehouseId: warehouse.id, code: `L-${suffix}`, name: 'Main Rack', binCode: 'R-01', zone: 'Zone A',
  });
  testResources.warehouses.push(warehouse.id);
  testResources.locations.push(location.id);

  // Stock Receipts at different costs to verify weighted average / stock valuation
  await inventoryService.receive(client, organizationId, actorId, {
    productId: product.id, warehouseId: warehouse.id, locationId: location.id,
    quantity: 10, unitCost: 40, referenceType: 'PURCHASE_RECEIPT', referenceId: `REC1-${suffix}`,
  });
  await inventoryService.receive(client, organizationId, actorId, {
    productId: product.id, warehouseId: warehouse.id, locationId: location.id,
    quantity: 10, unitCost: 50, referenceType: 'PURCHASE_RECEIPT', referenceId: `REC2-${suffix}`,
  });

  const balance = await inventoryService.getStockBalance(client, organizationId, product.id, warehouse.id);
  assert.equal(Number(balance.quantity), 20);
  assert.equal(Number(balance.unitCost), 45); // (10*40 + 10*50)/20 = 45

  // Controlled Inventory Adjustment
  const adj = await inventoryService.createAdjustment(client, organizationId, actorId, {
    productId: product.id, warehouseId: warehouse.id, locationId: location.id,
    adjustmentType: 'ADD', quantity: 5, cost: 45, reason: 'Physical audit correction',
  });
  assert.equal(adj.status, 'DRAFT');
  const approvedAdj = await inventoryService.approveAdjustment(client, organizationId, actorId, adj.id);
  assert.equal(approvedAdj.status, 'APPROVED');
  const postedAdj = await inventoryService.postAdjustment(client, organizationId, actorId, adj.id);
  assert.equal(postedAdj.adjustment.status, 'POSTED');
  assert.equal(Number((await inventoryService.getStockBalance(client, organizationId, product.id, warehouse.id)).quantity), 25);

  const adjustmentsList = await inventoryService.getAdjustments(client, organizationId);
  assert.ok(adjustmentsList.some((item) => item.id === adj.id));

  // Physical Stock Count session
  await assert.rejects(
    inventoryService.createCountSession(client, organizationId, actorId, { warehouseId: warehouse.id, lines: [] }),
    /at least one product/i,
  );
  await assert.rejects(
    inventoryService.createCountSession(client, organizationId, actorId, {
      warehouseId: warehouse.id,
      lines: [{ productId: product.id, countedQuantity: -1 }],
    }),
    /cannot be negative/i,
  );
  const countSession = await inventoryService.createCountSession(client, organizationId, actorId, {
    warehouseId: warehouse.id,
    lines: [{ productId: product.id, locationId: location.id, countedQuantity: 28 }],
  });
  assert.equal(countSession.status, 'DRAFT');
  const listedCount = (await inventoryService.getCountSessions(client, organizationId)).find((count) => count.id === countSession.id);
  assert.equal(listedCount.warehouse_code, warehouse.code);
  assert.equal(Number(listedCount.line_count), 1);
  assert.equal(Number(listedCount.variance_line_count), 1);
  assert.equal(Number(listedCount.net_variance), 3);
  assert.equal((await inventoryService.getCountLines(client, organizationId, countSession.id))[0].sku, product.sku);
  await inventoryService.approveCountSession(client, organizationId, actorId, countSession.id);
  const postedCount = await inventoryService.postCountSession(client, organizationId, actorId, countSession.id);
  assert.equal(postedCount.status, 'POSTED');
  assert.equal(Number((await inventoryService.getStockBalance(client, organizationId, product.id, warehouse.id)).quantity), 28);
  const countJournal = await client.query(
    'SELECT status FROM accounting_journals WHERE organization_id = $1 AND source_transaction_id = $2',
    [organizationId, postedCount.adjustments[0].id],
  );
  assert.equal(countJournal.rows[0]?.status, 'APPROVED');

  // Valuation report and reorder suggestions
  const valuationReport = await inventoryService.getReports(client, organizationId, 'stock-valuation');
  assert.ok(valuationReport.some((item) => item.id === product.id));

  const reorderReport = await inventoryService.getReports(client, organizationId, 'low-stock');
  assert.ok(Array.isArray(reorderReport));
});
