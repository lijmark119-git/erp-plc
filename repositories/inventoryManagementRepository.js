import { randomUUID } from 'node:crypto';
import { isValidBusinessCode } from '../validation.js';

const PRODUCT_COLUMNS = `
  id, organization_id, sku, product_code, barcode, name, description, category,
  brand, product_type, unit_of_measure_id, purchase_price, sales_price,
  standard_cost, tax_category, minimum_stock, maximum_stock, reorder_level,
  reorder_quantity, inventory_account_code, cogs_account_code, wip_account_code,
  finished_goods_account_code, grni_account_code, valuation_method, active,
  created_by, created_at, updated_at
`;

const WAREHOUSE_COLUMNS = `id, organization_id, code, name, description, responsible_employee_id, active, created_at, updated_at`;
const LOCATION_COLUMNS = `id, organization_id, warehouse_id, code, name, bin_code, zone, active, created_at, updated_at`;
const TRANSACTION_COLUMNS = `
  id, organization_id, product_id, warehouse_id, location_id, transaction_type,
  direction, quantity, unit_of_measure_id, unit_cost, total_cost, reference_type,
  reference_id, transaction_date, transfer_id, counterparty_warehouse_id,
  created_by, created_at, updated_at
`;

function normalizeAmount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('Amount must be a finite number.');
  return Math.round(number * 1_000_000) / 1_000_000;
}

function normalizeRequired(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
}

function normalizeOptionalCode(value, field, maxLength) {
  if (value === undefined || value === null || value === '') return null;
  if (!isValidBusinessCode(value, maxLength)) throw new Error(`${field} must be a valid code.`);
  return value.trim();
}

function normalizeProductAmount(value, field, allowZero = true) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || (!allowZero && number === 0)) {
    throw new Error(`${field} must be a ${allowZero ? 'non-negative' : 'positive'} number.`);
  }
  return Math.round(number * 1_000_000) / 1_000_000;
}

function normalizeProductInput(input) {
  const sku = normalizeRequired(input.sku, 'sku');
  const name = normalizeRequired(input.name, 'name');
  const productType = normalizeRequired(input.productType, 'productType');
  const valuationMethod = input.valuationMethod || 'FIFO';
  if (!isValidBusinessCode(sku, 80)) throw new Error('sku must be a valid code of up to 80 characters.');
  if (name.length > 240) throw new Error('name must be 240 characters or fewer.');
  if (!['RAW_MATERIAL', 'FINISHED_GOOD', 'SEMI_FINISHED_GOOD', 'TRADING_PRODUCT', 'CONSUMABLE', 'SPARE_PART', 'SERVICE'].includes(productType)) {
    throw new Error('productType is invalid.');
  }
  if (!['FIFO', 'WEIGHTED_AVERAGE'].includes(valuationMethod)) throw new Error('valuationMethod is invalid.');
  const values = {
    sku,
    productCode: normalizeOptionalCode(input.productCode, 'productCode', 80),
    barcode: normalizeOptionalCode(input.barcode, 'barcode', 128),
    name,
    productType,
    unitOfMeasureId: normalizeRequired(input.unitOfMeasureId, 'unitOfMeasureId'),
    purchasePrice: normalizeProductAmount(input.purchasePrice ?? 0, 'purchasePrice'),
    salesPrice: normalizeProductAmount(input.salesPrice ?? 0, 'salesPrice'),
    standardCost: normalizeProductAmount(input.standardCost ?? 0, 'standardCost'),
    minimumStock: normalizeProductAmount(input.minimumStock ?? 0, 'minimumStock'),
    maximumStock: normalizeProductAmount(input.maximumStock ?? 0, 'maximumStock'),
    reorderLevel: normalizeProductAmount(input.reorderLevel ?? 0, 'reorderLevel'),
    reorderQuantity: normalizeProductAmount(input.reorderQuantity ?? 1, 'reorderQuantity', false),
    valuationMethod,
  };
  if (values.maximumStock > 0 && values.maximumStock < values.minimumStock) {
    throw new Error('maximumStock cannot be lower than minimumStock.');
  }
  return values;
}

export async function getInventoryProducts(client, organizationId, activeOnly = false) {
  const result = await client.query(
    `SELECT p.*, u.code AS unit_of_measure_code, u.name AS unit_of_measure_name
     FROM inventory_products p
     JOIN inventory_uoms u ON u.id = p.unit_of_measure_id
     WHERE p.organization_id = $1${activeOnly ? ' AND p.active = TRUE' : ''}
     ORDER BY p.name`,
    [organizationId],
  );
  return result.rows;
}

export async function getInventoryProduct(client, organizationId, productId) {
  const result = await client.query(
    `SELECT p.*, u.code AS unit_of_measure_code, u.name AS unit_of_measure_name
     FROM inventory_products p JOIN inventory_uoms u ON u.id = p.unit_of_measure_id
     WHERE p.organization_id = $1 AND p.id = $2`,
    [organizationId, productId],
  );
  return result.rows[0] ?? null;
}

export async function getInventoryProductBySku(client, organizationId, sku) {
  const result = await client.query(
    `SELECT p.*, u.code AS unit_of_measure_code, u.name AS unit_of_measure_name
     FROM inventory_products p JOIN inventory_uoms u ON u.id = p.unit_of_measure_id
     WHERE p.organization_id = $1 AND p.sku = $2`,
    [organizationId, sku],
  );
  return result.rows[0] ?? null;
}

export async function createInventoryProduct(client, organizationId, actorId, input) {
  const values = normalizeProductInput(input);
  const product = await client.query(
    `INSERT INTO inventory_products (
      organization_id, sku, product_code, barcode, name, description, category,
      brand, product_type, unit_of_measure_id, purchase_price, sales_price,
      standard_cost, tax_category, minimum_stock, maximum_stock, reorder_level,
      reorder_quantity, inventory_account_code, cogs_account_code, wip_account_code,
      finished_goods_account_code, grni_account_code, valuation_method, active,
      created_by, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
              $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26,
              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     RETURNING ${PRODUCT_COLUMNS}`,
    [
      organizationId,
      values.sku,
      values.productCode,
      values.barcode,
      values.name,
      input.description?.trim() || null,
      input.category?.trim() || null,
      input.brand?.trim() || null,
      values.productType,
      values.unitOfMeasureId,
      values.purchasePrice,
      values.salesPrice,
      values.standardCost,
      input.taxCategory || 'STANDARD',
      values.minimumStock,
      values.maximumStock,
      values.reorderLevel,
      values.reorderQuantity,
      input.inventoryAccountCode || '1200',
      input.cogsAccountCode || '5000',
      input.wipAccountCode || '1300',
      input.finishedGoodsAccountCode || '1400',
      input.grniAccountCode || '2000',
      values.valuationMethod,
      input.active !== false,
      actorId,
    ],
  );
  await recordAudit(client, organizationId, actorId, 'inventory_product', product.rows[0].id, 'created', { sku: product.rows[0].sku });
  return product.rows[0];
}

export async function updateInventoryProduct(client, organizationId, actorId, productId, input) {
  const values = normalizeProductInput(input);
  const result = await client.query(
    `UPDATE inventory_products SET
      sku = $1, product_code = $2, barcode = $3, name = $4, description = $5,
      category = $6, brand = $7, product_type = $8, unit_of_measure_id = $9,
      purchase_price = $10, sales_price = $11, standard_cost = $12,
      tax_category = $13, minimum_stock = $14, maximum_stock = $15,
      reorder_level = $16, reorder_quantity = $17, inventory_account_code = $18,
      cogs_account_code = $19, wip_account_code = $20,
      finished_goods_account_code = $21, grni_account_code = $22,
      valuation_method = $23, active = $24, updated_at = CURRENT_TIMESTAMP
     WHERE organization_id = $25 AND id = $26
     RETURNING ${PRODUCT_COLUMNS}`,
    [
      values.sku, values.productCode, values.barcode,
      values.name, input.description?.trim() || null, input.category?.trim() || null,
      input.brand?.trim() || null, values.productType, values.unitOfMeasureId,
      values.purchasePrice, values.salesPrice,
      values.standardCost, input.taxCategory || 'STANDARD',
      values.minimumStock, values.maximumStock,
      values.reorderLevel, values.reorderQuantity,
      input.inventoryAccountCode || '1200', input.cogsAccountCode || '5000',
      input.wipAccountCode || '1300', input.finishedGoodsAccountCode || '1400',
      input.grniAccountCode || '2000', values.valuationMethod, input.active !== false,
      organizationId, productId,
    ],
  );
  if (!result.rows[0]) return null;
  await recordAudit(client, organizationId, actorId, 'inventory_product', productId, 'updated', { fields: Object.keys(input) });
  return result.rows[0];
}

export async function createInventoryUom(client, organizationId, actorId, input) {
  const result = await client.query(
    `INSERT INTO inventory_uoms (organization_id, code, name, base_unit, factor, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     RETURNING id, organization_id, code, name, base_unit, factor, active`,
    [organizationId, input.code.toLowerCase(), input.name, input.baseUnit || input.code.toLowerCase(), normalizeAmount(input.factor || 1), input.active !== false],
  );
  await recordAudit(client, organizationId, actorId, 'inventory_uom', result.rows[0].id, 'created', { code: result.rows[0].code });
  return result.rows[0];
}

export async function getInventoryUoms(client, organizationId) {
  const result = await client.query('SELECT * FROM inventory_uoms WHERE organization_id = $1 AND active = TRUE ORDER BY code', [organizationId]);
  return result.rows;
}

export async function createInventoryWarehouse(client, organizationId, actorId, input) {
  const result = await client.query(
    `INSERT INTO inventory_warehouses (organization_id, code, name, description, responsible_employee_id, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     RETURNING ${WAREHOUSE_COLUMNS}`,
    [organizationId, input.code.trim().toUpperCase(), input.name.trim(), input.description?.trim() || null, input.responsibleEmployeeId || null, input.active !== false],
  );
  await recordAudit(client, organizationId, actorId, 'inventory_warehouse', result.rows[0].id, 'created', { code: result.rows[0].code });
  return result.rows[0];
}

export async function getInventoryWarehouses(client, organizationId) {
  const result = await client.query(`SELECT w.*, COUNT(l.id) AS location_count FROM inventory_warehouses w LEFT JOIN inventory_locations l ON l.warehouse_id = w.id WHERE w.organization_id = $1 GROUP BY w.id ORDER BY w.name`, [organizationId]);
  return result.rows;
}

export async function createInventoryLocation(client, organizationId, actorId, input) {
  const result = await client.query(
    `INSERT INTO inventory_locations (organization_id, warehouse_id, code, name, bin_code, zone, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     RETURNING ${LOCATION_COLUMNS}`,
    [organizationId, input.warehouseId, input.code.trim().toUpperCase(), input.name.trim(), input.binCode?.trim() || null, input.zone?.trim() || null, input.active !== false],
  );
  await recordAudit(client, organizationId, actorId, 'inventory_location', result.rows[0].id, 'created', { warehouseId: input.warehouseId });
  return result.rows[0];
}

export async function getInventoryLocations(client, organizationId, warehouseId) {
  const params = warehouseId ? [organizationId, warehouseId] : [organizationId];
  const where = warehouseId ? 'WHERE organization_id = $1 AND warehouse_id = $2' : 'WHERE organization_id = $1';
  const result = await client.query(`SELECT ${LOCATION_COLUMNS} FROM inventory_locations ${where} ORDER BY code`, params);
  return result.rows;
}

export async function createStockTransaction(client, organizationId, actorId, input) {
  const product = await getInventoryProduct(client, organizationId, input.productId);
  if (!product) throw new Error('Inventory product not found.');
  if (!product.active) throw new Error('Inventory product is inactive.');
  const warehouse = await getInventoryWarehouse(client, organizationId, input.warehouseId);
  if (!warehouse || !warehouse.active) throw new Error('Inventory warehouse not found or inactive.');
  const quantity = normalizeAmount(input.quantity);
  if (quantity <= 0) throw new Error('Quantity must be greater than zero.');
  const unitCost = normalizeAmount(input.unitCost ?? 0);
  if (unitCost < 0) throw new Error('Unit cost cannot be negative.');
  const transaction = await client.query(
    `INSERT INTO inventory_stock_transactions (
      organization_id, product_id, warehouse_id, location_id, transaction_type,
      direction, quantity, unit_of_measure_id, unit_cost, total_cost,
      reference_type, reference_id, transaction_date, transfer_id,
      counterparty_warehouse_id, created_by, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
              $15, $16, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     RETURNING ${TRANSACTION_COLUMNS}`,
    [organizationId, product.id, input.warehouseId, input.locationId || null,
      input.transactionType, input.direction, quantity, input.unitOfMeasureId || product.unit_of_measure_id,
      unitCost, quantity * unitCost, input.referenceType, input.referenceId,
      input.transactionDate || new Date(), input.transferId || null,
      input.counterpartyWarehouseId || null, actorId],
  );
  await recordAudit(client, organizationId, actorId, 'inventory_stock_transaction', transaction.rows[0].id, 'created', {
    productId: product.id, warehouseId: input.warehouseId, quantity, transactionType: input.transactionType,
    referenceType: input.referenceType, referenceId: input.referenceId,
  });
  return transaction.rows[0];
}

export async function getInventoryStockTransactions(client, organizationId, filters = {}) {
  const clauses = ['t.organization_id = $1'];
  const values = [organizationId];
  if (filters.productId) { values.push(filters.productId); clauses.push(`t.product_id = $${values.length}`); }
  if (filters.warehouseId) { values.push(filters.warehouseId); clauses.push(`t.warehouse_id = $${values.length}`); }
  if (filters.transactionType) { values.push(filters.transactionType); clauses.push(`t.transaction_type = $${values.length}`); }
  const transactionColumns = TRANSACTION_COLUMNS
    .split(',')
    .map((column) => `t.${column.trim()}`)
    .join(', ');
  const result = await client.query(
    `SELECT ${transactionColumns}, p.sku, p.name, p.product_type, u.code AS unit_of_measure_code,
            w.code AS warehouse_code, l.code AS location_code
     FROM inventory_stock_transactions t
     JOIN inventory_products p ON p.id = t.product_id
     JOIN inventory_uoms u ON u.id = t.unit_of_measure_id
     JOIN inventory_warehouses w ON w.id = t.warehouse_id
     LEFT JOIN inventory_locations l ON l.id = t.location_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY t.transaction_date DESC, t.created_at DESC`,
    values,
  );
  return result.rows;
}

export async function getInventoryBalance(client, organizationId, productId, warehouseId) {
  const result = await client.query(
    `SELECT COALESCE(SUM(CASE WHEN t.direction = 'IN' THEN t.quantity ELSE 0 END), 0) AS inbound,
            COALESCE(SUM(CASE WHEN t.direction = 'OUT' THEN t.quantity ELSE 0 END), 0) AS outbound,
            COALESCE(SUM(CASE WHEN t.direction = 'TRANSFER' THEN t.quantity ELSE 0 END), 0) AS transferred
     FROM inventory_stock_transactions t
     WHERE t.organization_id = $1 AND t.product_id = $2 AND t.warehouse_id = $3`,
    [organizationId, productId, warehouseId],
  );
  const inbound = normalizeAmount(result.rows[0].inbound);
  const outbound = normalizeAmount(result.rows[0].outbound);
  return { inbound, outbound, quantity: inbound - outbound, transferred: normalizeAmount(result.rows[0].transferred) };
}

export async function getInventoryStockBalance(client, organizationId, productId, warehouseId) {
  const product = await getInventoryProduct(client, organizationId, productId);
  const balance = await getInventoryBalance(client, organizationId, productId, warehouseId);
  const ledger = await getInventoryStockTransactions(client, organizationId, { productId, warehouseId });
  const fifoRows = ledger.filter((row) => row.direction === 'IN' && row.quantity > 0);
  const weightedRows = fifoRows;
  let value = 0;
  let units = 0;
  if (product?.valuation_method === 'WEIGHTED_AVERAGE') {
    for (const row of weightedRows) {
      const qty = Number(row.quantity) || 0;
      const costPer = Number(row.unit_cost) || 0;
      units += qty;
      value += qty * costPer;
    }
  }
  let fifoCost = 0;
  if (product?.valuation_method === 'FIFO') {
    fifoCost = await getFifoCost(client, ledger, balance.quantity);
  } else if (product?.valuation_method === 'WEIGHTED_AVERAGE') {
    fifoCost = units ? value / units : 0;
  }
  const safeQuantity = Number(balance.quantity) || 0;
  const safeFifoCost = Number(fifoCost) || 0;
  return { ...balance, valuationMethod: product?.valuation_method || 'FIFO', unitCost: fifoCost, value: normalizeAmount(safeQuantity * safeFifoCost), product };
}

export async function getInventoryStockUnitCost(client, organizationId, productId, warehouseId, quantity) {
  const balance = await getInventoryStockBalance(client, organizationId, productId, warehouseId);
  if (balance.quantity < quantity) throw new Error('Insufficient stock for transfer.');
  return balance.unitCost;
}

async function getFifoCost(client, ledger, quantity) {
  const inbound = ledger.filter((row) => row.direction === 'IN');
  let remaining = quantity;
  let cost = 0;
  for (const row of inbound) {
    if (remaining <= 0) break;
    const consumed = Math.min(remaining, row.quantity);
    cost += consumed * row.unit_cost;
    remaining -= consumed;
  }
  return remaining > 0 ? 0 : cost / quantity;
}

export async function createTransferRequest(client, organizationId, actorId, input) {
  const product = await getInventoryProduct(client, organizationId, input.productId);
  if (!product || !product.active) throw new Error('Inventory product not found or inactive.');
  const source = await getInventoryWarehouse(client, organizationId, input.sourceWarehouseId);
  const destination = await getInventoryWarehouse(client, organizationId, input.destinationWarehouseId);
  if (!source?.active || !destination?.active) throw new Error('Source and destination warehouses must be active.');
  for (const [locationId, warehouseId, label] of [
    [input.sourceLocationId, source.id, 'Source'],
    [input.destinationLocationId, destination.id, 'Destination'],
  ]) {
    if (!locationId) continue;
    const location = await client.query(
      `SELECT id FROM inventory_locations
       WHERE id = $1 AND organization_id = $2 AND warehouse_id = $3 AND active = TRUE`,
      [locationId, organizationId, warehouseId],
    );
    if (!location.rows[0]) throw new Error(`${label} location must be active and belong to its selected warehouse.`);
  }
  const requestedQuantity = normalizeAmount(input.requestedQuantity);
  if (requestedQuantity <= 0) throw new Error('Requested quantity must be greater than zero.');
  const sourceBalance = await getInventoryBalance(client, organizationId, product.id, source.id);
  if (sourceBalance.quantity < requestedQuantity) throw new Error('Insufficient stock at source warehouse.');
  const result = await client.query(
    `INSERT INTO inventory_transfer_requests (
      organization_id, product_id, source_warehouse_id, destination_warehouse_id,
      source_location_id, destination_location_id, requested_quantity, approved_quantity,
      dispatched_quantity, received_quantity, status, reason, requested_by,
      requested_at, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, 0, 'REQUESTED', $8, $9,
              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     RETURNING id, organization_id, product_id, source_warehouse_id, destination_warehouse_id,
               requested_quantity, approved_quantity, dispatched_quantity, received_quantity,
               status, reason, requested_by, requested_at, created_at, updated_at`,
    [organizationId, product.id, source.id, destination.id, input.sourceLocationId || null,
      input.destinationLocationId || null, requestedQuantity, input.reason || null, actorId],
  );
  await recordAudit(client, organizationId, actorId, 'inventory_transfer_request', result.rows[0].id, 'created', { requestedQuantity });
  await recordTransferHistory(client, organizationId, result.rows[0].id, 'REQUESTED', actorId, input.reason || null, { requestedQuantity });
  return result.rows[0];
}

async function recordTransferHistory(client, organizationId, transferId, eventType, actorId, reason = null, details = {}) {
  await client.query(
    `INSERT INTO inventory_transfer_history (organization_id, transfer_id, event_type, actor_user_id, reason, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [organizationId, transferId, eventType, actorId, reason, JSON.stringify(details)],
  );
}

export async function approveTransferRequest(client, organizationId, actorId, transferId, approvedQuantity = null, reason = null) {
  const transfer = await getInventoryTransferRequest(client, organizationId, transferId);
  if (!transfer || !['REQUESTED', 'APPROVED'].includes(transfer.status)) return null;
  const quantity = normalizeAmount(approvedQuantity ?? transfer.requested_quantity);
  if (quantity > transfer.requested_quantity) throw new Error('Approved quantity cannot exceed requested quantity.');
  const sourceBalance = await getInventoryBalance(client, organizationId, transfer.product_id, transfer.source_warehouse_id);
  if (sourceBalance.quantity < quantity) throw new Error('Insufficient stock at source warehouse.');
  const result = await client.query(
    `UPDATE inventory_transfer_requests SET status = 'APPROVED', approved_quantity = $1,
        approved_by = $2, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = $3 AND organization_id = $4
     RETURNING *`,
    [quantity, actorId, transferId, organizationId],
  );
  await recordAudit(client, organizationId, actorId, 'inventory_transfer_request', transferId, 'approved', { approvedQuantity: quantity });
  await recordTransferHistory(client, organizationId, transferId, 'APPROVED', actorId, reason, { approvedQuantity: quantity });
  return result.rows[0];
}

export async function rejectTransferRequest(client, organizationId, actorId, transferId, reason) {
  const result = await client.query(
    `UPDATE inventory_transfer_requests SET status = 'REJECTED', updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND organization_id = $2 AND status = 'REQUESTED'
     RETURNING *`,
    [transferId, organizationId],
  );
  if (!result.rows[0]) return null;
  await recordAudit(client, organizationId, actorId, 'inventory_transfer_request', transferId, 'rejected', { reason });
  await recordTransferHistory(client, organizationId, transferId, 'REJECTED', actorId, reason);
  return result.rows[0];
}

export async function dispatchTransferRequest(client, organizationId, actorId, transferId, reason = null) {
  const transfer = await getInventoryTransferRequest(client, organizationId, transferId);
  if (!transfer || transfer.status !== 'APPROVED') return null;
  const product = await getInventoryProduct(client, organizationId, transfer.product_id);
  const cost = await getInventoryStockUnitCost(client, organizationId, transfer.product_id, transfer.source_warehouse_id, transfer.approved_quantity);
  const source = await createStockTransaction(client, organizationId, actorId, {
    productId: transfer.product_id,
    warehouseId: transfer.source_warehouse_id,
    locationId: transfer.source_location_id,
    transactionType: 'STOCK_TRANSFER', direction: 'OUT', quantity: transfer.approved_quantity,
    unitOfMeasureId: product.unit_of_measure_id, unitCost: cost,
    referenceType: 'INVENTORY_TRANSFER', referenceId: transfer.id,
    transactionDate: new Date(), transferId: transfer.id,
    counterpartyWarehouseId: transfer.destination_warehouse_id,
  });
  const result = await client.query(
    `UPDATE inventory_transfer_requests SET status = 'DISPATCHED', dispatched_quantity = approved_quantity,
        dispatched_by = $1, dispatched_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = $2 AND organization_id = $3
     RETURNING *`,
    [actorId, transferId, organizationId],
  );
  await recordAudit(client, organizationId, actorId, 'inventory_transfer_request', transferId, 'dispatched', { transactionId: source.id });
  await recordTransferHistory(client, organizationId, transferId, 'DISPATCHED', actorId, reason, { transactionId: source.id });
  return result.rows[0];
}

export async function receiveTransferRequest(client, organizationId, actorId, transferId, reason = null) {
  const transfer = await getInventoryTransferRequest(client, organizationId, transferId);
  if (!transfer || transfer.status !== 'DISPATCHED') return null;
  const product = await getInventoryProduct(client, organizationId, transfer.product_id);
  const cost = await getInventoryStockUnitCost(client, organizationId, transfer.product_id, transfer.source_warehouse_id, transfer.dispatched_quantity);
  const destination = await createStockTransaction(client, organizationId, actorId, {
    productId: transfer.product_id,
    warehouseId: transfer.destination_warehouse_id,
    locationId: transfer.destination_location_id,
    transactionType: 'STOCK_TRANSFER', direction: 'IN', quantity: transfer.dispatched_quantity,
    unitOfMeasureId: product.unit_of_measure_id, unitCost: cost,
    referenceType: 'INVENTORY_TRANSFER', referenceId: `${transfer.id}-RECEIVED-${randomUUID()}`,
    transactionDate: new Date(), transferId: transfer.id,
    counterpartyWarehouseId: transfer.source_warehouse_id,
  });
  const result = await client.query(
    `UPDATE inventory_transfer_requests SET status = 'RECEIVED', received_quantity = dispatched_quantity,
        received_by = $1, received_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = $2 AND organization_id = $3
     RETURNING *`,
    [actorId, transferId, organizationId],
  );
  await recordAudit(client, organizationId, actorId, 'inventory_transfer_request', transferId, 'received', { transactionId: destination.id });
  await recordTransferHistory(client, organizationId, transferId, 'RECEIVED', actorId, reason, { transactionId: destination.id });
  return result.rows[0];
}

export async function completeTransferRequest(client, organizationId, actorId, transferId) {
  const transfer = await getInventoryTransferRequest(client, organizationId, transferId);
  if (!transfer || transfer.status !== 'RECEIVED') return null;
  const result = await client.query(
    `UPDATE inventory_transfer_requests SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND organization_id = $2
     RETURNING *`,
    [transferId, organizationId],
  );
  await recordAudit(client, organizationId, actorId, 'inventory_transfer_request', transferId, 'completed', {});
  await recordTransferHistory(client, organizationId, transferId, 'COMPLETED', actorId);
  return result.rows[0];
}

export async function cancelTransferRequest(client, organizationId, actorId, transferId) {
  const result = await client.query(
    `UPDATE inventory_transfer_requests SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND organization_id = $2 AND status = 'REQUESTED'
     RETURNING *`,
    [transferId, organizationId],
  );
  if (result.rows[0]) {
    await recordAudit(client, organizationId, actorId, 'inventory_transfer_request', transferId, 'cancelled', {});
    await recordTransferHistory(client, organizationId, transferId, 'CANCELLED', actorId);
  }
  return result.rows[0] ?? null;
}

export async function getInventoryTransferRequest(client, organizationId, transferId) {
  const result = await client.query(
    `SELECT t.*, p.sku, p.name, s.code AS source_warehouse_code, d.code AS destination_warehouse_code,
            sl.code AS source_location_code, dl.code AS destination_location_code,
            u.code AS unit_of_measure_code
     FROM inventory_transfer_requests t
     JOIN inventory_products p ON p.id = t.product_id
     JOIN inventory_warehouses s ON s.id = t.source_warehouse_id
     JOIN inventory_warehouses d ON d.id = t.destination_warehouse_id
     LEFT JOIN inventory_locations sl ON sl.id = t.source_location_id
     LEFT JOIN inventory_locations dl ON dl.id = t.destination_location_id
     JOIN inventory_uoms u ON u.id = p.unit_of_measure_id
     WHERE t.id = $1 AND t.organization_id = $2`,
    [transferId, organizationId],
  );
  return result.rows[0] ?? null;
}

export async function getInventoryTransferRequests(client, organizationId, status) {
  const query = `SELECT t.*, p.sku AS product_sku, p.name AS product_name,
       u.code AS unit_of_measure_code,
       source.code AS source_warehouse_code, source.name AS source_warehouse_name,
       destination.code AS destination_warehouse_code, destination.name AS destination_warehouse_name,
       source_location.code AS source_location_code, source_location.name AS source_location_name,
       source_location.bin_code AS source_bin_code,
       destination_location.code AS destination_location_code, destination_location.name AS destination_location_name,
       destination_location.bin_code AS destination_bin_code,
       requester.display_name AS requester_name,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'eventType', history.event_type,
           'actorName', users.display_name,
           'occurredAt', history.occurred_at,
           'reason', history.reason,
           'details', history.details
         ) ORDER BY history.occurred_at, history.id)
         FROM inventory_transfer_history history
         LEFT JOIN users ON users.id = history.actor_user_id
         WHERE history.organization_id = t.organization_id AND history.transfer_id = t.id
       ), '[]'::jsonb) AS history
     FROM inventory_transfer_requests t
     JOIN inventory_products p ON p.id = t.product_id
     JOIN inventory_uoms u ON u.id = p.unit_of_measure_id
     JOIN inventory_warehouses source ON source.id = t.source_warehouse_id
     JOIN inventory_warehouses destination ON destination.id = t.destination_warehouse_id
     LEFT JOIN inventory_locations source_location ON source_location.id = t.source_location_id
     LEFT JOIN inventory_locations destination_location ON destination_location.id = t.destination_location_id
     LEFT JOIN users requester ON requester.id = t.requested_by
     WHERE t.organization_id = $1${status ? ' AND t.status = $2' : ''}
     ORDER BY t.requested_at DESC`;
  const result = await client.query(query, status ? [organizationId, status] : [organizationId]);
  return result.rows;
}

export async function getInventoryTransferHistory(client, organizationId, transferId) {
  const result = await client.query(
    `SELECT history.*, users.display_name AS actor_name
     FROM inventory_transfer_history history
     LEFT JOIN users ON users.id = history.actor_user_id
     WHERE history.organization_id = $1 AND history.transfer_id = $2
     ORDER BY history.occurred_at, history.id`,
    [organizationId, transferId],
  );
  return result.rows;
}

export async function createInventoryAdjustment(client, organizationId, actorId, input) {
  const product = await getInventoryProduct(client, organizationId, input.productId);
  if (!product || !product.active) throw new Error('Inventory product not found or inactive.');
  const warehouse = await getInventoryWarehouse(client, organizationId, input.warehouseId);
  if (!warehouse?.active) throw new Error('Inventory warehouse not found or inactive.');
  const quantity = normalizeAmount(input.quantity);
  if (quantity <= 0) throw new Error('Adjustment quantity must be greater than zero.');
  const result = await client.query(
    `INSERT INTO inventory_adjustments (
      organization_id, product_id, warehouse_id, location_id, quantity,
      adjustment_type, reason, cost, status, requested_by, requested_at,
      created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'DRAFT', $9, CURRENT_TIMESTAMP,
              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     RETURNING *`,
    [organizationId, product.id, input.warehouseId, input.locationId || null, quantity,
      input.adjustmentType, input.reason, normalizeAmount(input.cost || 0), actorId],
  );
  await recordAudit(client, organizationId, actorId, 'inventory_adjustment', result.rows[0].id, 'requested', { quantity, reason: input.reason });
  return result.rows[0];
}

export async function approveInventoryAdjustment(client, organizationId, actorId, adjustmentId) {
  const adjustment = await getInventoryAdjustment(client, organizationId, adjustmentId);
  if (!adjustment || adjustment.status !== 'DRAFT') return null;
  const result = await client.query(
    `UPDATE inventory_adjustments SET status = 'APPROVED', approved_by = $1, approved_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND organization_id = $3
     RETURNING *`,
    [actorId, adjustmentId, organizationId],
  );
  await recordAudit(client, organizationId, actorId, 'inventory_adjustment', adjustmentId, 'approved', {});
  return result.rows[0];
}

export async function postInventoryAdjustment(client, organizationId, actorId, adjustmentId) {
  const adjustment = await getInventoryAdjustment(client, organizationId, adjustmentId);
  if (!adjustment || adjustment.status !== 'APPROVED') return null;
  const product = await getInventoryProduct(client, organizationId, adjustment.product_id);
  const direction = adjustment.adjustment_type === 'REMOVE' ? 'OUT' : 'IN';
  const transaction = await createStockTransaction(client, organizationId, actorId, {
    productId: adjustment.product_id,
    warehouseId: adjustment.warehouse_id,
    locationId: adjustment.location_id,
    transactionType: 'STOCK_ADJUSTMENT', direction,
    quantity: adjustment.quantity,
    unitOfMeasureId: product.unit_of_measure_id,
    unitCost: adjustment.cost,
    referenceType: 'INVENTORY_ADJUSTMENT', referenceId: adjustment.id,
    transactionDate: new Date(),
  });
  const result = await client.query(
    `UPDATE inventory_adjustments SET status = 'POSTED', posted_by = $1, posted_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND organization_id = $3
     RETURNING *`,
    [actorId, adjustmentId, organizationId],
  );
  await recordAudit(client, organizationId, actorId, 'inventory_adjustment', adjustmentId, 'posted', { transactionId: transaction.id });
  return { ...result.rows[0], transaction };
}

export async function getInventoryAdjustment(client, organizationId, adjustmentId) {
  const result = await client.query(`SELECT * FROM inventory_adjustments WHERE organization_id = $1 AND id = $2`, [organizationId, adjustmentId]);
  return result.rows[0] ?? null;
}

export async function createInventoryCountSession(client, organizationId, actorId, input) {
  const warehouse = await getInventoryWarehouse(client, organizationId, input.warehouseId);
  if (!warehouse?.active) throw new Error('Inventory warehouse not found or inactive.');
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new Error('Add at least one product to the stock count.');
  }
  const countedProducts = new Set();
  const result = await client.query(
    `INSERT INTO inventory_count_sessions (organization_id, warehouse_id, counted_by, status, counted_at, created_at, updated_at)
     VALUES ($1, $2, $3, 'DRAFT', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     RETURNING *`,
    [organizationId, input.warehouseId, actorId],
  );
  const session = result.rows[0];
  for (const line of input.lines || []) {
    const product = await getInventoryProduct(client, organizationId, line.productId);
    if (!product) throw new Error('Inventory product not found.');
    if (countedProducts.has(product.id)) throw new Error('Each product can only appear once in a stock count.');
    countedProducts.add(product.id);
    const system = await getInventoryBalance(client, organizationId, product.id, input.warehouseId);
    const counted = normalizeAmount(line.countedQuantity);
    if (counted < 0) throw new Error('Counted quantity cannot be negative.');
    const variance = counted - system.quantity;
    await client.query(
      `INSERT INTO inventory_count_lines (organization_id, count_session_id, product_id, location_id,
          system_quantity, counted_quantity, variance, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)`,
      [organizationId, session.id, product.id, line.locationId || null, system.quantity, counted, variance],
    );
  }
  await recordAudit(client, organizationId, actorId, 'inventory_count_session', session.id, 'created', { warehouseId: input.warehouseId });
  return { ...session, lines: await getInventoryCountLines(client, organizationId, session.id) };
}

export async function getInventoryCountLines(client, organizationId, countSessionId) {
  const result = await client.query(
    `SELECT c.*, p.sku, p.name, l.code AS location_code FROM inventory_count_lines c
     JOIN inventory_products p ON p.id = c.product_id
     LEFT JOIN inventory_locations l ON l.id = c.location_id
     WHERE c.organization_id = $1 AND c.count_session_id = $2 ORDER BY p.name`,
    [organizationId, countSessionId],
  );
  return result.rows;
}

export async function approveInventoryCountSession(client, organizationId, actorId, countSessionId) {
  const result = await client.query(
    `UPDATE inventory_count_sessions SET status = 'APPROVED', approved_by = $1, approved_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND organization_id = $3 AND status = 'DRAFT'
     RETURNING *`,
    [actorId, countSessionId, organizationId],
  );
  if (result.rows[0]) await recordAudit(client, organizationId, actorId, 'inventory_count_session', countSessionId, 'approved', {});
  return result.rows[0] ?? null;
}

export async function postInventoryCountSession(client, organizationId, actorId, countSessionId) {
  const session = await getInventoryCountSession(client, organizationId, countSessionId);
  if (!session || session.status !== 'APPROVED') return null;
  const lines = await getInventoryCountLines(client, organizationId, countSessionId);
  const adjustments = [];
  for (const line of lines) {
    if (normalizeAmount(line.variance) === 0) continue;
    const product = await getInventoryProduct(client, organizationId, line.product_id);
    const adjustment = await createStockTransaction(client, organizationId, actorId, {
      productId: product.id,
      warehouseId: session.warehouse_id,
      locationId: line.location_id,
      transactionType: 'STOCK_ADJUSTMENT', direction: line.variance > 0 ? 'IN' : 'OUT',
      quantity: Math.abs(line.variance), unitOfMeasureId: product.unit_of_measure_id,
      unitCost: product.standard_cost,
      referenceType: 'INVENTORY_COUNT', referenceId: session.id,
      transactionDate: new Date(),
    });
    adjustments.push(adjustment);
  }
  const result = await client.query(
    `UPDATE inventory_count_sessions SET status = 'POSTED', posted_by = $1, posted_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND organization_id = $3
     RETURNING *`,
    [actorId, countSessionId, organizationId],
  );
  await recordAudit(client, organizationId, actorId, 'inventory_count_session', countSessionId, 'posted', { adjustments: adjustments.length });
  return { ...result.rows[0], adjustments };
}

export async function getInventoryCountSession(client, organizationId, countSessionId) {
  const result = await client.query(`SELECT * FROM inventory_count_sessions WHERE organization_id = $1 AND id = $2`, [organizationId, countSessionId]);
  return result.rows[0] ?? null;
}

export async function getInventoryCountSessions(client, organizationId, status) {
  const query = `SELECT s.*, w.code AS warehouse_code, w.name AS warehouse_name,
      COUNT(l.id)::INTEGER AS line_count,
      COUNT(l.id) FILTER (WHERE l.variance <> 0)::INTEGER AS variance_line_count,
      COALESCE(SUM(l.variance), 0) AS net_variance
    FROM inventory_count_sessions s
    JOIN inventory_warehouses w ON w.id = s.warehouse_id AND w.organization_id = s.organization_id
    LEFT JOIN inventory_count_lines l ON l.count_session_id = s.id AND l.organization_id = s.organization_id
    WHERE s.organization_id = $1${status ? ' AND s.status = $2' : ''}
    GROUP BY s.id, w.id
    ORDER BY s.counted_at DESC`;
  const result = await client.query(query, status ? [organizationId, status] : [organizationId]);
  return result.rows;
}

export async function getInventoryStockLedger(client, organizationId, productId, warehouseId) {
  const filters = { productId, warehouseId };
  const rows = await getInventoryStockTransactions(client, organizationId, filters);
  return rows;
}

export async function getInventoryReports(client, organizationId, reportType, params = {}) {
  const common = `SELECT p.id, p.sku, p.name, p.product_type, p.valuation_method,
       w.code AS warehouse_code, COALESCE(SUM(CASE WHEN t.direction = 'IN' THEN t.quantity ELSE 0 END), 0) AS on_hand,
       COALESCE(SUM(CASE WHEN t.direction = 'IN' THEN t.total_cost ELSE 0 END), 0) AS inbound_value,
       COALESCE(SUM(CASE WHEN t.direction = 'OUT' THEN t.total_cost ELSE 0 END), 0) AS outbound_value
       FROM inventory_products p
       JOIN inventory_warehouses w ON w.organization_id = p.organization_id
       LEFT JOIN inventory_stock_transactions t ON t.product_id = p.id AND t.warehouse_id = w.id
       WHERE p.organization_id = $1 AND p.active = TRUE`;
  if (reportType === 'stock-on-hand') {
    const result = await client.query(`${common} GROUP BY p.id, w.id ORDER BY p.name, w.name`, [organizationId]);
    return result.rows.map((row) => ({ ...row, onHand: normalizeAmount(row.on_hand), value: normalizeAmount(row.on_hand * (params.unitCost || 0)) }));
  }
  if (reportType === 'stock-valuation') {
    const result = await client.query(`${common} GROUP BY p.id, w.id ORDER BY p.name, w.name`, [organizationId]);
    return result.rows.map((row) => ({ ...row, onHand: normalizeAmount(row.on_hand), inboundValue: normalizeAmount(row.inbound_value), outboundValue: normalizeAmount(row.outbound_value), netValue: normalizeAmount(row.inbound_value - row.outbound_value) }));
  }
  if (reportType === 'stock-movement' || reportType === 'stock-ledger') {
    return getInventoryStockTransactions(client, organizationId, params.filters || {});
  }
  if (reportType === 'low-stock') {
    const result = await client.query(`SELECT p.*, w.code AS warehouse_code,
       COALESCE(SUM(CASE WHEN t.direction = 'IN' THEN t.quantity ELSE 0 END), 0) -
       COALESCE(SUM(CASE WHEN t.direction = 'OUT' THEN t.quantity ELSE 0 END), 0) AS on_hand
       FROM inventory_products p JOIN inventory_warehouses w ON w.organization_id = p.organization_id
       LEFT JOIN inventory_stock_transactions t ON t.product_id = p.id AND t.warehouse_id = w.id
       WHERE p.organization_id = $1 AND p.active = TRUE
       GROUP BY p.id, w.id
       HAVING COALESCE(SUM(CASE WHEN t.direction = 'IN' THEN t.quantity ELSE 0 END), 0) -
              COALESCE(SUM(CASE WHEN t.direction = 'OUT' THEN t.quantity ELSE 0 END), 0) <= p.reorder_level
       ORDER BY p.name`, [organizationId]);
    return result.rows;
  }
  if (reportType === 'stockout-risk') {
    const result = await client.query(`WITH balances AS (
       SELECT product_id, warehouse_id,
         SUM(CASE WHEN direction = 'IN' THEN quantity WHEN direction = 'OUT' THEN -quantity ELSE 0 END) AS on_hand
       FROM inventory_stock_transactions
       WHERE organization_id = $1
       GROUP BY product_id, warehouse_id
     ), usage AS (
       SELECT product_id, warehouse_id, SUM(quantity) AS consumed
       FROM inventory_stock_transactions
       WHERE organization_id = $1 AND direction = 'OUT'
         AND transaction_type IN ('SALES_DELIVERY', 'PRODUCTION_CONSUMPTION')
         AND transaction_date >= CURRENT_TIMESTAMP - INTERVAL '30 days'
       GROUP BY product_id, warehouse_id
     ), positions AS (
       SELECT p.id AS product_id, p.sku, p.name, p.reorder_level, p.reorder_quantity,
         w.id AS warehouse_id, w.code AS warehouse_code,
         COALESCE(b.on_hand, 0) AS on_hand, COALESCE(u.consumed, 0) AS consumed_30_days
       FROM inventory_products p
       JOIN inventory_warehouses w ON w.organization_id = p.organization_id
       LEFT JOIN balances b ON b.product_id = p.id AND b.warehouse_id = w.id
       LEFT JOIN usage u ON u.product_id = p.id AND u.warehouse_id = w.id
       WHERE p.organization_id = $1 AND p.active = TRUE
     )
     SELECT *, consumed_30_days / 30.0 AS average_daily_usage,
       CASE WHEN consumed_30_days > 0 THEN on_hand / (consumed_30_days / 30.0) ELSE NULL END AS days_of_stock_remaining,
       GREATEST(reorder_quantity, reorder_level + consumed_30_days - on_hand, 0) AS suggested_replenishment,
       CASE WHEN on_hand <= reorder_level THEN 'REORDER'
            WHEN consumed_30_days > 0 AND on_hand / (consumed_30_days / 30.0) <= 30 THEN 'HIGH_RISK'
            ELSE 'MONITOR' END AS risk_level
     FROM positions
     WHERE consumed_30_days > 0 OR on_hand <= reorder_level
     ORDER BY CASE WHEN on_hand <= reorder_level THEN 0
                   WHEN consumed_30_days > 0 AND on_hand / (consumed_30_days / 30.0) <= 30 THEN 1 ELSE 2 END,
       days_of_stock_remaining NULLS LAST, name`, [organizationId]);
    return result.rows;
  }
  if (reportType === 'inventory-aging') {
    const result = await client.query(`SELECT p.sku, p.name, w.code AS warehouse_code,
       COALESCE(SUM(CASE WHEN t.direction = 'IN' THEN t.quantity ELSE 0 END), 0) -
       COALESCE(SUM(CASE WHEN t.direction = 'OUT' THEN t.quantity ELSE 0 END), 0) AS on_hand,
       MAX(t.transaction_date) AS last_movement
       FROM inventory_products p JOIN inventory_warehouses w ON w.organization_id = p.organization_id
       LEFT JOIN inventory_stock_transactions t ON t.product_id = p.id AND t.warehouse_id = w.id
       WHERE p.organization_id = $1 AND p.active = TRUE
       GROUP BY p.id, w.id ORDER BY p.name`, [organizationId]);
    return result.rows;
  }
  if (reportType === 'warehouse-report' || reportType === 'warehouse') {
    return getInventoryWarehouses(client, organizationId);
  }
  if (reportType === 'stock-variance') {
    const result = await client.query(`SELECT c.*, p.sku, p.name, w.code AS warehouse_code FROM inventory_count_lines c
       JOIN inventory_products p ON p.id = c.product_id JOIN inventory_warehouses w ON w.id = c.warehouse_id
       WHERE c.organization_id = $1 AND c.variance <> 0 ORDER BY c.created_at DESC`, [organizationId]);
    return result.rows;
  }
  if (reportType === 'slow-moving') {
    const result = await client.query(`SELECT p.sku, p.name, w.code AS warehouse_code,
       COALESCE(SUM(CASE WHEN t.direction = 'IN' THEN t.quantity ELSE 0 END), 0) -
       COALESCE(SUM(CASE WHEN t.direction = 'OUT' THEN t.quantity ELSE 0 END), 0) AS on_hand,
       MAX(t.transaction_date) AS last_movement
       FROM inventory_products p JOIN inventory_warehouses w ON w.organization_id = p.organization_id
       LEFT JOIN inventory_stock_transactions t ON t.product_id = p.id AND t.warehouse_id = w.id
       WHERE p.organization_id = $1 AND p.active = TRUE
       GROUP BY p.id, w.id ORDER BY p.name`, [organizationId]);
    return result.rows.filter((row) => Number(row.on_hand) > 0);
  }
  throw new Error('Unsupported inventory report.');
}

export async function getInventoryReorderSuggestions(client, organizationId) {
  const result = await client.query(`SELECT p.id, p.sku, p.name, p.product_type,
       COALESCE(SUM(CASE WHEN t.direction = 'IN' THEN t.quantity ELSE 0 END), 0) -
       COALESCE(SUM(CASE WHEN t.direction = 'OUT' THEN t.quantity ELSE 0 END), 0) AS on_hand,
       p.reorder_level, p.reorder_quantity, p.unit_of_measure_id, w.code AS warehouse_code
       FROM inventory_products p JOIN inventory_warehouses w ON w.organization_id = p.organization_id
       LEFT JOIN inventory_stock_transactions t ON t.product_id = p.id AND t.warehouse_id = w.id
       WHERE p.organization_id = $1 AND p.active = TRUE
       GROUP BY p.id, w.id ORDER BY p.name`, [organizationId]);
  return result.rows.filter((row) => Number(row.on_hand) <= Number(row.reorder_level));
}

export async function getInventoryWarehouse(client, organizationId, warehouseId) {
  const result = await client.query(`SELECT ${WAREHOUSE_COLUMNS} FROM inventory_warehouses WHERE organization_id = $1 AND id = $2`, [organizationId, warehouseId]);
  return result.rows[0] ?? null;
}

export async function getInventoryProductById(client, organizationId, productId) {
  return getInventoryProduct(client, organizationId, productId);
}

function randomId() { return randomUUID(); }

async function recordAudit(client, organizationId, actorId, entityType, entityId, action, details) {
  await client.query(
    `INSERT INTO inventory_audit_events (organization_id, inventory_entity_type, inventory_entity_id, action, actor_user_id, details, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, CURRENT_TIMESTAMP)`,
    [organizationId, entityType, entityId, action, actorId, JSON.stringify(details)],
  );
}

export async function getInventoryAuditEvents(client, organizationId, entityType, entityId) {
  const params = [organizationId];
  let where = 'organization_id = $1';
  if (entityType) { params.push(entityType); where += ` AND inventory_entity_type = $2`; }
  if (entityId) { params.push(entityId); where += ` AND inventory_entity_id = $3`; }
  const result = await client.query(`SELECT * FROM inventory_audit_events WHERE ${where} ORDER BY occurred_at DESC`, params);
  return result.rows;
}

export async function getInventoryAdjustments(client, organizationId, status = null) {
  const params = [organizationId];
  let query = `SELECT a.*, p.sku AS product_sku, p.name AS product_name, w.code AS warehouse_code, w.name AS warehouse_name
     FROM inventory_adjustments a
     JOIN inventory_products p ON p.id = a.product_id
     JOIN inventory_warehouses w ON w.id = a.warehouse_id
     WHERE a.organization_id = $1`;
  if (status) {
    params.push(status);
    query += ` AND a.status = $2`;
  }
  query += ` ORDER BY a.created_at DESC`;
  const result = await client.query(query, params);
  return result.rows;
}

export async function createInventoryUomConversion(client, organizationId, actorId, input) {
  const fromUom = await client.query('SELECT * FROM inventory_uoms WHERE id = $1 AND organization_id = $2', [input.fromUomId, organizationId]);
  const toUom = await client.query('SELECT * FROM inventory_uoms WHERE id = $1 AND organization_id = $2', [input.toUomId, organizationId]);
  if (!fromUom.rows[0] || !toUom.rows[0]) throw new Error('From and To units of measure must exist.');
  const factor = Number(input.factor);
  if (!Number.isFinite(factor) || factor <= 0) throw new Error('Conversion factor must be a positive number.');
  const result = await client.query(
    `INSERT INTO inventory_uom_conversions (organization_id, from_uom_id, to_uom_id, factor, active)
     VALUES ($1, $2, $3, $4, TRUE)
     ON CONFLICT (organization_id, from_uom_id, to_uom_id)
     DO UPDATE SET factor = EXCLUDED.factor, active = TRUE
     RETURNING *`,
    [organizationId, input.fromUomId, input.toUomId, factor],
  );
  await recordAudit(client, organizationId, actorId, 'inventory_uom_conversion', result.rows[0].id, 'created', { factor, from: fromUom.rows[0].code, to: toUom.rows[0].code });
  return result.rows[0];
}

export async function getInventoryUomConversions(client, organizationId) {
  const result = await client.query(
    `SELECT c.*, f.code AS from_uom_code, f.name AS from_uom_name, t.code AS to_uom_code, t.name AS to_uom_name
     FROM inventory_uom_conversions c
     JOIN inventory_uoms f ON f.id = c.from_uom_id
     JOIN inventory_uoms t ON t.id = c.to_uom_id
     WHERE c.organization_id = $1 AND c.active = TRUE
     ORDER BY f.code, t.code`,
    [organizationId],
  );
  return result.rows;
}

export async function convertUomQuantity(client, organizationId, fromUomId, toUomId, quantity) {
  const qty = Number(quantity);
  if (!Number.isFinite(qty)) throw new Error('Quantity must be a valid number.');
  if (fromUomId === toUomId) return { fromQuantity: qty, toQuantity: qty, factor: 1 };
  const direct = await client.query(
    `SELECT factor FROM inventory_uom_conversions WHERE organization_id = $1 AND from_uom_id = $2 AND to_uom_id = $3 AND active = TRUE`,
    [organizationId, fromUomId, toUomId],
  );
  if (direct.rows[0]) {
    const factor = Number(direct.rows[0].factor);
    return { fromQuantity: qty, toQuantity: qty * factor, factor };
  }
  const reverse = await client.query(
    `SELECT factor FROM inventory_uom_conversions WHERE organization_id = $1 AND from_uom_id = $2 AND to_uom_id = $3 AND active = TRUE`,
    [organizationId, toUomId, fromUomId],
  );
  if (reverse.rows[0]) {
    const factor = 1 / Number(reverse.rows[0].factor);
    return { fromQuantity: qty, toQuantity: qty * factor, factor };
  }
  const uoms = await client.query(
    `SELECT id, factor FROM inventory_uoms WHERE organization_id = $1 AND id IN ($2, $3)`,
    [organizationId, fromUomId, toUomId],
  );
  const from = uoms.rows.find((u) => u.id === fromUomId);
  const to = uoms.rows.find((u) => u.id === toUomId);
  if (from && to && Number(to.factor) > 0) {
    const effectiveFactor = Number(from.factor) / Number(to.factor);
    return { fromQuantity: qty, toQuantity: qty * effectiveFactor, factor: effectiveFactor };
  }
  throw new Error('No conversion rule found between these units of measure.');
}

export { randomId };
