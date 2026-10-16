import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';

import { createDatabasePool } from '../database.js';
import { inventoryService } from '../services/inventoryService.js';
import { manufacturingService } from '../services/manufacturingService.js';

const pool = createDatabasePool();
const organizationId = (await pool.query('SELECT id FROM organizations WHERE code=$1', ['DEFAULT'])).rows[0].id;
const client = await pool.connect();
const actorId = (await client.query('SELECT id FROM users WHERE organization_id=$1 AND active=TRUE ORDER BY created_at LIMIT 1', [organizationId])).rows[0].id;

const cleanup = {
  productIds: [], warehouseIds: [], centerIds: [], bomIds: [], routingIds: [], orderIds: [],
  lotIds: [], transactionIds: [], journalIds: [], supplyIds: [], runIds: [], uomIds: [],
  deliveryIds: [], salesOrderIds: [], customerIds: [],
  qualityInspectionIds: [],
  forecastIds: [], maintenanceIds: [],
};

after(async () => {
  try {
    await client.query('BEGIN');
    if (cleanup.maintenanceIds.length) await client.query('DELETE FROM manufacturing_maintenance_events WHERE id=ANY($1::uuid[])', [cleanup.maintenanceIds]);
    if (cleanup.forecastIds.length) await client.query('DELETE FROM manufacturing_demand_forecasts WHERE id=ANY($1::uuid[])', [cleanup.forecastIds]);
    if (cleanup.journalIds.length) {
      const ids = (await client.query(
        'SELECT id FROM accounting_journals WHERE organization_id=$1 AND id=ANY($2::uuid[])',
        [organizationId, cleanup.journalIds],
      )).rows.map((row) => row.id);
      if (ids.length) {
        await client.query("DELETE FROM audit_events WHERE entity_type='accounting_journal' AND entity_id=ANY($1::text[])", [ids]);
        await client.query('DELETE FROM accounting_journal_lines WHERE journal_id=ANY($1::uuid[])', [ids]);
        await client.query('DELETE FROM accounting_journals WHERE id=ANY($1::uuid[])', [ids]);
      }
    }
    if (cleanup.runIds.length) await client.query('DELETE FROM manufacturing_mrp_runs WHERE id=ANY($1::uuid[])', [cleanup.runIds]);
    if (cleanup.deliveryIds.length) {
      await client.query('DELETE FROM delivery_line_items WHERE delivery_id=ANY($1::uuid[])', [cleanup.deliveryIds]);
      await client.query('DELETE FROM delivery_notes WHERE id=ANY($1::uuid[])', [cleanup.deliveryIds]);
    }
    if (cleanup.salesOrderIds.length) {
      await client.query('DELETE FROM sales_order_lines WHERE sales_order_id=ANY($1::uuid[])', [cleanup.salesOrderIds]);
      await client.query('DELETE FROM sales_orders WHERE id=ANY($1::uuid[])', [cleanup.salesOrderIds]);
    }
    if (cleanup.customerIds.length) await client.query('DELETE FROM customers WHERE id=ANY($1::uuid[])', [cleanup.customerIds]);
    if (cleanup.orderIds.length) {
      await client.query('DELETE FROM manufacturing_lot_shipments WHERE organization_id=$1 AND inventory_transaction_id=ANY($2::uuid[])', [organizationId, cleanup.transactionIds]);
      if (cleanup.qualityInspectionIds.length) await client.query('DELETE FROM manufacturing_quality_inspections WHERE id=ANY($1::uuid[])', [cleanup.qualityInspectionIds]);
      await client.query('DELETE FROM manufacturing_lot_genealogy WHERE organization_id=$1 AND (source_lot_id=ANY($2::uuid[]) OR output_lot_id=ANY($2::uuid[]))', [organizationId, cleanup.lotIds]);
      await client.query('DELETE FROM manufacturing_production_outputs WHERE manufacturing_order_id=ANY($1::uuid[])', [cleanup.orderIds]);
      await client.query('DELETE FROM manufacturing_material_consumptions WHERE organization_id=$1 AND order_material_id IN (SELECT id FROM manufacturing_order_materials WHERE manufacturing_order_id=ANY($2::uuid[]))', [organizationId, cleanup.orderIds]);
      await client.query('DELETE FROM manufacturing_material_reservations WHERE organization_id=$1 AND order_material_id IN (SELECT id FROM manufacturing_order_materials WHERE manufacturing_order_id=ANY($2::uuid[]))', [organizationId, cleanup.orderIds]);
      await client.query('DELETE FROM manufacturing_lots WHERE id=ANY($1::uuid[])', [cleanup.lotIds]);
      await client.query('DELETE FROM manufacturing_orders WHERE id=ANY($1::uuid[])', [cleanup.orderIds]);
    }
    if (cleanup.lotIds.length) await client.query('DELETE FROM manufacturing_lots WHERE id=ANY($1::uuid[])', [cleanup.lotIds]);
    if (cleanup.transactionIds.length) await client.query('DELETE FROM inventory_stock_transactions WHERE id=ANY($1::uuid[])', [cleanup.transactionIds]);
    if (cleanup.routingIds.length) {
      await client.query('DELETE FROM manufacturing_routing_operations WHERE routing_id=ANY($1::uuid[])', [cleanup.routingIds]);
      await client.query('DELETE FROM manufacturing_routings WHERE id=ANY($1::uuid[])', [cleanup.routingIds]);
    }
    if (cleanup.bomIds.length) {
      await client.query('DELETE FROM manufacturing_bom_lines WHERE bom_id=ANY($1::uuid[])', [cleanup.bomIds]);
      await client.query('DELETE FROM manufacturing_boms WHERE id=ANY($1::uuid[])', [cleanup.bomIds]);
    }
    if (cleanup.supplyIds.length) await client.query('DELETE FROM manufacturing_open_purchase_supply WHERE id=ANY($1::uuid[])', [cleanup.supplyIds]);
    if (cleanup.productIds.length) {
      await client.query('DELETE FROM inventory_stock_transactions WHERE product_id=ANY($1::uuid[])', [cleanup.productIds]);
      await client.query('DELETE FROM inventory_products WHERE id=ANY($1::uuid[])', [cleanup.productIds]);
    }
    if (cleanup.warehouseIds.length) await client.query('DELETE FROM inventory_warehouses WHERE id=ANY($1::uuid[])', [cleanup.warehouseIds]);
    if (cleanup.centerIds.length) await client.query('DELETE FROM manufacturing_work_centers WHERE id=ANY($1::uuid[])', [cleanup.centerIds]);
    if (cleanup.uomIds.length) await client.query('DELETE FROM inventory_uoms WHERE id=ANY($1::uuid[])', [cleanup.uomIds]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
});

test('manufacturing plans, reserves, consumes, costs, completes, and traces production', async () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
  const uom = await inventoryService.createUom(client, organizationId, actorId, {
    code: `PC-${suffix}`, name: 'Test piece', baseUnit: `PC-${suffix}`, factor: 1,
  });
  cleanup.uomIds.push(uom.id);
  const caseUom = await inventoryService.createUom(client, organizationId, actorId, {
    code: `CASE-${suffix}`, name: '12-piece case', baseUnit: `PC-${suffix}`, factor: 12,
  });
  cleanup.uomIds.push(caseUom.id);
  const raw = await inventoryService.createProduct(client, organizationId, actorId, {
    sku: `MFG-RM-${suffix}`, name: 'Manufacturing test raw material', productType: 'RAW_MATERIAL',
    unitOfMeasureId: uom.id, standardCost: 2, minimumStock: 3, reorderLevel: 3, reorderQuantity: 1,
    inventoryAccountCode: '1200', cogsAccountCode: '5000', wipAccountCode: '1300', finishedGoodsAccountCode: '1400', grniAccountCode: '2000',
  });
  const finished = await inventoryService.createProduct(client, organizationId, actorId, {
    sku: `MFG-FG-${suffix}`, name: 'Manufacturing test finished good', productType: 'FINISHED_GOOD',
    unitOfMeasureId: uom.id, standardCost: 0, minimumStock: 0, reorderLevel: 0, reorderQuantity: 1,
    inventoryAccountCode: '1400', cogsAccountCode: '5000', wipAccountCode: '1300', finishedGoodsAccountCode: '1400', grniAccountCode: '2000',
  });
  cleanup.productIds.push(raw.id, finished.id);
  const warehouse = await inventoryService.createWarehouse(client, organizationId, actorId, { code: `MFG-${suffix}`, name: `Manufacturing ${suffix}` });
  cleanup.warehouseIds.push(warehouse.id);
  const center = await manufacturingService.createWorkCenter(client, organizationId, actorId, {
    code: `WC-${suffix}`, name: 'Assembly cell', machineName: 'Assembly machine', machineCapacity: 1,
    laborCapacity: 2, machineHourRate: 2, laborHourRate: 10, overheadHourRate: 1,
    calendar: { workingDays: [1, 2, 3, 4, 5], hoursPerDay: 8 },
  });
  cleanup.centerIds.push(center.id);
  const bom = await manufacturingService.createBom(client, organizationId, actorId, {
    bomCode: `BOM-${suffix}`, version: 'A', finishedProductId: finished.id, effectiveFrom: new Date().toISOString().slice(0, 10),
    lines: [{ rawMaterialProductId: raw.id, quantityPer: 2, unitOfMeasureId: caseUom.id, scrapPercent: 10, operationSequence: 10 }],
  });
  cleanup.bomIds.push(bom.id);
  await manufacturingService.activateBom(client, organizationId, actorId, bom.id);
  const forecast = await manufacturingService.createDemandForecast(client, organizationId, actorId, {
    productId: finished.id, forecastDate: new Date().toISOString().slice(0, 10), quantity: 5, notes: 'Test forecast',
  });
  cleanup.forecastIds.push(forecast.id);
  const forecastMrp = await manufacturingService.runMrp(client, organizationId, actorId, {
    planningDate: new Date().toISOString().slice(0, 10),
    endDate: new Date().toISOString().slice(0, 10),
    demandSource: 'FORECAST',
  });
  cleanup.runIds.push(forecastMrp.id);
  assert.equal(forecastMrp.demands[0].quantity, 5);
  assert.equal(forecastMrp.demand_source, 'FORECAST');
  const maintenance = await manufacturingService.createMaintenanceEvent(client, organizationId, actorId, {
    workCenterId: center.id, maintenanceType: 'PREVENTIVE', description: 'Test scheduled service',
    scheduledDate: new Date().toISOString().slice(0, 10),
  });
  cleanup.maintenanceIds.push(maintenance.id);
  const completedMaintenance = await manufacturingService.completeMaintenanceEvent(
    client, organizationId, actorId, maintenance.id, 45,
  );
  assert.equal(completedMaintenance.status, 'COMPLETED');
  assert.equal(Number(completedMaintenance.downtime_minutes), 45);
  const routing = await manufacturingService.createRouting(client, organizationId, actorId, {
    routingCode: `RT-${suffix}`, version: 'A', finishedProductId: finished.id, effectiveFrom: new Date().toISOString().slice(0, 10),
    operations: [{ sequenceNumber: 10, operationName: 'Assembly', workCenterId: center.id, setupMinutes: 0, machineMinutesPerUnit: 6, laborHoursPerUnit: 0.05 }],
  });
  cleanup.routingIds.push(routing.id);
  const supply = await manufacturingService.createOpenPurchaseSupply(client, organizationId, actorId, {
    purchaseOrderNumber: `PO-MFG-${suffix}`, productId: raw.id, orderedQuantity: 10,
  });
  cleanup.supplyIds.push(supply.id);
  const mrp = await manufacturingService.runMrp(client, organizationId, actorId, {
    planningDate: new Date().toISOString().slice(0, 10), demands: [{ productId: finished.id, quantity: 20 }],
  });
  cleanup.runIds.push(mrp.id);
  assert.equal(Number(mrp.requirements[0].gross_required), 528);
  assert.equal(Number(mrp.requirements[0].open_purchase), 10);
  assert.equal(Number(mrp.requirements[0].net_requirement), 521);

  const receipt = await inventoryService.receive(client, organizationId, actorId, {
    productId: raw.id, warehouseId: warehouse.id, quantity: 400, unitCost: 2,
    referenceType: 'PURCHASE_RECEIPT', referenceId: `MFG-RECEIPT-${suffix}`, postToLedger: true,
  });
  cleanup.transactionIds.push(receipt.transaction.id);
  cleanup.journalIds.push(receipt.journal.id);
  const rawLot = await manufacturingService.registerRawLot(client, organizationId, actorId, {
    inventoryTransactionId: receipt.transaction.id, lotNumber: `RAW-${suffix}`, quantity: 400,
  });
  cleanup.lotIds.push(rawLot.id);
  await manufacturingService.updatePurchaseSupplyReceipt(client, organizationId, actorId, supply.id, 10);

  const order = await manufacturingService.createOrder(client, organizationId, actorId, {
    finishedProductId: finished.id, bomId: bom.id, routingId: routing.id, warehouseId: warehouse.id,
    plannedQuantity: 10, dueDate: new Date().toISOString().slice(0, 10),
  });
  cleanup.orderIds.push(order.id);
  assert.equal(Number(order.materials[0].required_quantity), 264);
  await manufacturingService.reserveMaterials(client, organizationId, actorId, order.id);
  const released = await manufacturingService.releaseOrder(client, organizationId, actorId, order.id);
  assert.equal(released.status, 'RELEASED');
  await manufacturingService.startOrder(client, organizationId, actorId, order.id);

  const consumption = await manufacturingService.consumeMaterial(client, organizationId, actorId, order.id, {
    productId: raw.id, quantity: 264, lotNumber: rawLot.lot_number,
  });
  cleanup.transactionIds.push(consumption.transaction.id);
  cleanup.journalIds.push(consumption.journal.id);
  const operation = (await manufacturingService.getOrder(client, organizationId, order.id)).operations[0];
  await manufacturingService.completeOperation(client, organizationId, actorId, order.id, operation.id, {
    actualLaborHours: 0.5, actualMachineHours: 0.5,
  });
  const operationJournals = (await client.query(
    `SELECT id FROM accounting_journals WHERE organization_id=$1 AND source_module='manufacturing'
     AND source_transaction_id=ANY($2::text[])`,
    [organizationId, [`labor:${operation.id}`, `overhead:${operation.id}`]],
  )).rows.map((row) => row.id);
  cleanup.journalIds.push(...operationJournals);

  const output = await manufacturingService.recordOutput(client, organizationId, actorId, order.id, {
    producedQuantity: 9, rejectedQuantity: 1, batchNumber: `FG-${suffix}`,
    productionDate: new Date().toISOString().slice(0, 10),
  });
  cleanup.lotIds.push(output.lot.id);
  cleanup.transactionIds.push(output.transaction.id);
  cleanup.journalIds.push(output.journal.id);
  const scrapJournal = (await client.query("SELECT id FROM accounting_journals WHERE organization_id=$1 AND source_module='manufacturing' AND source_transaction_id=$2", [organizationId, `scrap:${output.output.id}`])).rows[0];
  if (scrapJournal) cleanup.journalIds.push(scrapJournal.id);
  assert.equal(Number(output.output.produced_quantity), 9);
  assert.equal(Number(output.output.rejected_quantity), 1);
  const inspection = await manufacturingService.createQualityInspection(client, organizationId, actorId, {
    lotNumber: output.lot.lot_number, inspectionStage: 'FINAL',
    inspectedQuantity: 4, passedQuantity: 3, failedQuantity: 1, defectCode: 'SURFACE', notes: 'Surface blemish sample',
  });
  cleanup.qualityInspectionIds.push(inspection.id);
  assert.equal(inspection.result, 'PARTIAL');
  assert.equal(inspection.order_number, order.order_number);
  assert.equal(inspection.inspector_username, (await client.query('SELECT username FROM users WHERE id=$1', [actorId])).rows[0].username);
  await assert.rejects(
    manufacturingService.createQualityInspection(client, organizationId, actorId, {
      lotNumber: output.lot.lot_number, inspectionStage: 'FINAL',
      inspectedQuantity: 2, passedQuantity: 1, failedQuantity: 0,
    }),
    { status: 400 },
  );
  assert.equal((await manufacturingService.listQualityInspections(client, organizationId)).some((row) => row.id === inspection.id), true);
  const completed = await manufacturingService.getOrder(client, organizationId, order.id);
  assert.equal(completed.status, 'COMPLETED');

  const costReport = await manufacturingService.getReport(client, organizationId, 'production-cost');
  const cost = costReport.find((row) => row.id === order.id);
  assert.ok(Number(cost.material_cost) > 0);
  assert.ok(Number(cost.labor_cost) > 0);
  assert.ok(Number(cost.overhead_cost) > 0);

  const customer = (await client.query(
    'INSERT INTO customers (organization_id,customer_code,legal_name) VALUES ($1,$2,$3) RETURNING id',
    [organizationId, `MFG-CUST-${suffix}`, 'Manufacturing trace customer'],
  )).rows[0];
  cleanup.customerIds.push(customer.id);
  const salesOrder = (await client.query(
    `INSERT INTO sales_orders (order_number,customer_id,created_by,status,approval_status,organization_id)
     VALUES ($1,$2,$3,'Approved','Approved',$4) RETURNING id`,
    [`MFG-SO-${suffix}`, customer.id, actorId, organizationId],
  )).rows[0];
  cleanup.salesOrderIds.push(salesOrder.id);
  const delivery = (await client.query(
    `INSERT INTO delivery_notes (delivery_number,sales_order_id,customer_id,status,warehouse_id,organization_id)
     VALUES ($1,$2,$3,'Shipped',$4,$5) RETURNING id`,
    [`MFG-DN-${suffix}`, salesOrder.id, customer.id, warehouse.id, organizationId],
  )).rows[0];
  cleanup.deliveryIds.push(delivery.id);
  const shipment = await inventoryService.issue(client, organizationId, actorId, {
    productId: finished.id, warehouseId: warehouse.id, quantity: 2, unitCost: output.output.unit_cost,
    transactionType: 'SALES_DELIVERY', referenceType: 'SALES_DELIVERY', referenceId: delivery.id, postToLedger: true,
  });
  cleanup.transactionIds.push(shipment.transaction.id);
  cleanup.journalIds.push(shipment.journal.id);
  const trace = await manufacturingService.traceLot(client, organizationId, output.lot.lot_number);
  assert.equal(trace.sourceLots[0].lot_number, rawLot.lot_number);
  assert.equal(trace.deliveries.length, 1);
  assert.equal(Number(trace.deliveries[0].quantity), 2);
  assert.equal(trace.deliveries[0].delivery_number, `MFG-DN-${suffix}`);
  assert.equal(trace.deliveries[0].customer_name, 'Manufacturing trace customer');

  const closed = await manufacturingService.closeOrder(client, organizationId, actorId, order.id);
  assert.equal(closed.status, 'CLOSED');
  const consumptionLines = (await client.query(
    `SELECT account.account_code,line.debit,line.credit FROM accounting_journal_lines line
     JOIN accounting_accounts account ON account.id=line.account_id WHERE line.journal_id=$1 ORDER BY line.line_number`,
    [consumption.journal.id],
  )).rows;
  assert.equal(consumptionLines.find((line) => line.account_code === '1300').debit, '528.000000');
  assert.equal(consumptionLines.find((line) => line.account_code === '1200').credit, '528.000000');
});
