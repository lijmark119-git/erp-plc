import { randomUUID } from 'node:crypto';
import { accountingService } from './accountingService.js';
import { inventoryService } from './inventoryService.js';
import { isValidISODate } from '../validation.js';

export class ManufacturingError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const round = (value) => Math.round((Number(value) + Number.EPSILON) * 1_000_000) / 1_000_000;
const today = () => new Date().toISOString().slice(0, 10);

async function transaction(client, operation) {
  await client.query('BEGIN');
  try {
    const result = await operation();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

function requiredText(value, name) {
  const text = String(value ?? '').trim();
  if (!text) throw new ManufacturingError(400, `${name} is required.`);
  return text;
}

function positive(value, name, allowZero = false) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || (!allowZero && number === 0)) {
    throw new ManufacturingError(400, `${name} must be a ${allowZero ? 'non-negative' : 'positive'} number.`);
  }
  return number;
}

function validDate(value, name, optional = false) {
  if (optional && !value) return null;
  if (!isValidISODate(value)) {
    throw new ManufacturingError(400, `${name} must use YYYY-MM-DD.`);
  }
  return value;
}

async function audit(client, organizationId, actorId, action, entityType, entityId, details = {}) {
  await client.query(
    `INSERT INTO manufacturing_audit_trail (organization_id, actor_user_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [organizationId, actorId, action, entityType, entityId, JSON.stringify(details)],
  );
}

async function getProduct(client, organizationId, productId) {
  const result = await client.query(
    `SELECT * FROM inventory_products WHERE organization_id = $1 AND id = $2 AND active = TRUE`,
    [organizationId, productId],
  );
  if (!result.rows[0]) throw new ManufacturingError(404, 'Active inventory product not found.');
  return result.rows[0];
}

async function getWarehouse(client, organizationId, warehouseId) {
  const result = await client.query(
    'SELECT * FROM inventory_warehouses WHERE organization_id = $1 AND id = $2 AND active = TRUE',
    [organizationId, warehouseId],
  );
  if (!result.rows[0]) throw new ManufacturingError(404, 'Active warehouse not found.');
  return result.rows[0];
}

async function getWorkCenter(client, organizationId, workCenterId) {
  const result = await client.query(
    'SELECT * FROM manufacturing_work_centers WHERE organization_id=$1 AND id=$2 AND active=TRUE',
    [organizationId, workCenterId],
  );
  if (!result.rows[0]) throw new ManufacturingError(404, 'Active work center not found.');
  return result.rows[0];
}

async function convertToProductUnit(client, organizationId, product, quantity, sourceUnitId) {
  if (sourceUnitId === product.unit_of_measure_id) return quantity;
  const units = await client.query(
    `SELECT id, base_unit, factor FROM inventory_uoms
     WHERE organization_id=$1 AND id = ANY($2::uuid[]) AND active=TRUE`,
    [organizationId, [sourceUnitId, product.unit_of_measure_id]],
  );
  const source = units.rows.find((unit) => unit.id === sourceUnitId);
  const target = units.rows.find((unit) => unit.id === product.unit_of_measure_id);
  if (source && target && source.base_unit === target.base_unit) {
    return quantity * Number(source.factor) / Number(target.factor);
  }
  const direct = await client.query(
    'SELECT factor FROM inventory_uom_conversions WHERE organization_id=$1 AND from_uom_id=$2 AND to_uom_id=$3 AND active=TRUE',
    [organizationId, sourceUnitId, product.unit_of_measure_id],
  );
  if (direct.rows[0]) return quantity * Number(direct.rows[0].factor);
  const reverse = await client.query(
    'SELECT factor FROM inventory_uom_conversions WHERE organization_id=$1 AND from_uom_id=$2 AND to_uom_id=$3 AND active=TRUE',
    [organizationId, product.unit_of_measure_id, sourceUnitId],
  );
  if (reverse.rows[0]) return quantity / Number(reverse.rows[0].factor);
  throw new ManufacturingError(400, `No unit conversion exists for ${product.sku}.`);
}

async function getStock(client, organizationId, productId, warehouseId = null) {
  const result = await client.query(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'IN' THEN quantity WHEN direction = 'OUT' THEN -quantity ELSE 0 END), 0) AS quantity
     FROM inventory_stock_transactions
     WHERE organization_id = $1 AND product_id = $2 AND ($3::uuid IS NULL OR warehouse_id = $3)`,
    [organizationId, productId, warehouseId],
  );
  return Number(result.rows[0].quantity);
}

async function getBom(client, organizationId, bomId) {
  const result = await client.query(
    `SELECT bom.*, product.sku AS finished_sku, product.name AS finished_name
     FROM manufacturing_boms bom JOIN inventory_products product ON product.id = bom.finished_product_id
     WHERE bom.organization_id = $1 AND bom.id = $2`,
    [organizationId, bomId],
  );
  if (!result.rows[0]) return null;
  const lines = await client.query(
    `SELECT line.*, product.sku AS material_sku, product.name AS material_name,
            uom.code AS uom_code
     FROM manufacturing_bom_lines line
     JOIN inventory_products product ON product.id = line.raw_material_product_id
     JOIN inventory_uoms uom ON uom.id = line.unit_of_measure_id
     WHERE line.bom_id = $1 ORDER BY line.line_number`,
    [bomId],
  );
  return { ...result.rows[0], lines: lines.rows };
}

async function getOrder(client, organizationId, orderId) {
  const orderResult = await client.query(
    `SELECT mo.*, product.sku AS finished_sku, product.name AS finished_name,
            warehouse.name AS warehouse_name, bom.bom_code, bom.version AS bom_version,
            routing.routing_code, routing.version AS routing_version
     FROM manufacturing_orders mo
     JOIN inventory_products product ON product.id = mo.finished_product_id
     JOIN inventory_warehouses warehouse ON warehouse.id = mo.warehouse_id
     JOIN manufacturing_boms bom ON bom.id = mo.bom_id
     LEFT JOIN manufacturing_routings routing ON routing.id = mo.routing_id
     WHERE mo.organization_id = $1 AND mo.id = $2`,
    [organizationId, orderId],
  );
  if (!orderResult.rows[0]) return null;
  const [materials, operations, outputs] = await Promise.all([
    client.query(
      `SELECT material.*, product.sku, product.name, uom.code AS uom_code
       FROM manufacturing_order_materials material
       JOIN inventory_products product ON product.id = material.raw_material_product_id
       JOIN inventory_uoms uom ON uom.id = product.unit_of_measure_id
       WHERE material.manufacturing_order_id = $1 ORDER BY product.name`, [orderId],
    ),
    client.query(
      `SELECT operation.*, work_center.code AS work_center_code, work_center.name AS work_center_name,
              work_center.machine_hour_rate, work_center.labor_hour_rate, work_center.overhead_hour_rate
       FROM manufacturing_order_operations operation
       JOIN manufacturing_work_centers work_center ON work_center.id = operation.work_center_id
       WHERE operation.manufacturing_order_id = $1 ORDER BY operation.sequence_number`, [orderId],
    ),
    client.query(
      `SELECT output.*, lot.lot_number FROM manufacturing_production_outputs output
       JOIN manufacturing_lots lot ON lot.id = output.lot_id
       WHERE output.manufacturing_order_id = $1 ORDER BY output.created_at`, [orderId],
    ),
  ]);
  return { ...orderResult.rows[0], materials: materials.rows, operations: operations.rows, outputs: outputs.rows };
}

async function getOrderCosts(client, organizationId, orderId) {
  const materials = await client.query(
    `SELECT COALESCE(SUM(consumption.total_cost), 0) AS total
     FROM manufacturing_material_consumptions consumption
     JOIN manufacturing_order_materials material ON material.id = consumption.order_material_id
     WHERE material.manufacturing_order_id = $1 AND consumption.organization_id = $2`,
    [orderId, organizationId],
  );
  const operations = await client.query(
    `SELECT COALESCE(SUM(operation.actual_labor_hours * center.labor_hour_rate), 0) AS labor,
            COALESCE(SUM(operation.actual_machine_hours * center.machine_hour_rate), 0) AS machine,
            COALESCE(SUM(operation.actual_machine_hours * center.overhead_hour_rate), 0) AS overhead
     FROM manufacturing_order_operations operation
     JOIN manufacturing_work_centers center ON center.id = operation.work_center_id
     WHERE operation.manufacturing_order_id = $1 AND operation.organization_id = $2`,
    [orderId, organizationId],
  );
  return {
    materialCost: Number(materials.rows[0].total),
    laborCost: Number(operations.rows[0].labor),
    machineCost: Number(operations.rows[0].machine),
    overheadCost: Number(operations.rows[0].overhead),
    totalCost: Number(materials.rows[0].total) + Number(operations.rows[0].labor) + Number(operations.rows[0].machine) + Number(operations.rows[0].overhead),
  };
}

async function activeReservations(client, organizationId, productId, warehouseId) {
  const result = await client.query(
    `SELECT COALESCE(SUM(quantity - consumed_quantity), 0) AS quantity
     FROM manufacturing_material_reservations
     WHERE organization_id = $1 AND warehouse_id = $2 AND status = 'RESERVED'
       AND order_material_id IN (SELECT id FROM manufacturing_order_materials WHERE raw_material_product_id = $3)`,
    [organizationId, warehouseId, productId],
  );
  return Number(result.rows[0].quantity);
}

async function reserveOrderMaterials(client, organizationId, actorId, orderId) {
  const order = await client.query('SELECT * FROM manufacturing_orders WHERE id = $1 AND organization_id = $2 FOR UPDATE', [orderId, organizationId]);
  if (!order.rows[0] || order.rows[0].status !== 'PLANNED') throw new ManufacturingError(409, 'Only planned orders can reserve materials.');
  const materials = (await client.query(
    `SELECT * FROM manufacturing_order_materials WHERE manufacturing_order_id = $1 ORDER BY raw_material_product_id FOR UPDATE`,
    [orderId],
  )).rows;
  for (const material of materials) {
    const needed = round(Number(material.required_quantity) - Number(material.reserved_quantity) - Number(material.consumed_quantity));
    if (needed <= 0) continue;
    await client.query('SELECT id FROM inventory_products WHERE id = $1 AND organization_id = $2 FOR UPDATE', [material.raw_material_product_id, organizationId]);
    const stock = await getStock(client, organizationId, material.raw_material_product_id, order.rows[0].warehouse_id);
    const alreadyReserved = await activeReservations(client, organizationId, material.raw_material_product_id, order.rows[0].warehouse_id);
    const available = Math.max(0, stock - alreadyReserved);
    if (available + 0.000001 < needed) {
      const product = await getProduct(client, organizationId, material.raw_material_product_id);
      throw new ManufacturingError(409, `Insufficient available material for ${product.sku}. Required ${needed}; available ${available}.`);
    }
    const product = await getProduct(client, organizationId, material.raw_material_product_id);
    await client.query(
      `INSERT INTO manufacturing_material_reservations (organization_id, order_material_id, warehouse_id, quantity, reserved_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [organizationId, material.id, order.rows[0].warehouse_id, needed, actorId],
    );
    await client.query(
      `UPDATE manufacturing_order_materials SET reserved_quantity = reserved_quantity + $2,
       unit_cost = $3 WHERE id = $1`,
      [material.id, needed, product.standard_cost],
    );
  }
  const refreshed = await client.query(
    `SELECT COUNT(*)::int AS count FROM manufacturing_order_materials
     WHERE manufacturing_order_id = $1 AND reserved_quantity + consumed_quantity + 0.000001 < required_quantity`,
    [orderId],
  );
  if (refreshed.rows[0].count) throw new ManufacturingError(409, 'All required materials must be reserved before release.');
  await audit(client, organizationId, actorId, 'materials_reserved', 'manufacturing_order', orderId);
  return getOrder(client, organizationId, orderId);
}

async function explodeProduct(client, organizationId, productId, quantity, onDate, path, requirements) {
  if (path.includes(productId)) throw new ManufacturingError(409, 'A BOM cycle was detected.');
  const product = await getProduct(client, organizationId, productId);
  const bomResult = await client.query(
    `SELECT id, scrap_percent FROM manufacturing_boms
     WHERE organization_id = $1 AND finished_product_id = $2 AND status = 'ACTIVE'
       AND effective_from <= $3 AND (effective_to IS NULL OR effective_to >= $3)
     LIMIT 1`,
    [organizationId, productId, onDate],
  );
  if (!bomResult.rows[0] || product.product_type === 'RAW_MATERIAL' || product.product_type === 'CONSUMABLE') {
    const current = requirements.get(productId) || { product, grossRequired: 0 };
    current.grossRequired += quantity;
    requirements.set(productId, current);
    return;
  }
  const bom = bomResult.rows[0];
  const lines = await client.query('SELECT * FROM manufacturing_bom_lines WHERE bom_id = $1 ORDER BY line_number', [bom.id]);
  if (!lines.rows.length) throw new ManufacturingError(409, `Active BOM ${bom.id} has no material lines.`);
  const nextPath = [...path, productId];
  for (const line of lines.rows) {
    const component = await getProduct(client, organizationId, line.raw_material_product_id);
    const baseQuantity = await convertToProductUnit(client, organizationId, component, Number(line.quantity_per), line.unit_of_measure_id);
    const requiredQuantity = baseQuantity * quantity * (1 + Number(bom.scrap_percent) / 100) * (1 + Number(line.scrap_percent) / 100);
    await explodeProduct(client, organizationId, line.raw_material_product_id, requiredQuantity, onDate, nextPath, requirements);
  }
}

async function loadDemand(client, organizationId, input) {
  if (Array.isArray(input.demands) && input.demands.length) return input.demands.map((line) => ({
    productId: requiredText(line.productId, 'demand.productId'),
    quantity: positive(line.quantity, 'demand.quantity'),
  }));
  const from = validDate(input.startDate || today(), 'startDate');
  const to = validDate(input.endDate || new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10), 'endDate');
  if (from > to) throw new ManufacturingError(400, 'startDate must not be after endDate.');
  const source = input.demandSource || 'SALES_ORDERS';
  if (!['SALES_ORDERS', 'FORECAST', 'COMBINED'].includes(source)) {
    throw new ManufacturingError(400, 'demandSource must be SALES_ORDERS, FORECAST, or COMBINED.');
  }
  const demands = new Map();
  if (source !== 'FORECAST') {
    const sales = await client.query(
      `SELECT product.id AS product_id, SUM(line.quantity) AS quantity
       FROM sales_order_lines line
       JOIN sales_orders order_header ON order_header.id = line.sales_order_id
       JOIN inventory_products product ON product.organization_id = order_header.organization_id AND product.sku = line.product_sku
       WHERE order_header.organization_id = $1 AND order_header.status = 'Approved'
         AND order_header.delivery_date BETWEEN $2 AND $3
       GROUP BY product.id`,
      [organizationId, from, to],
    );
    for (const row of sales.rows) demands.set(row.product_id, Number(row.quantity));
  }
  if (source !== 'SALES_ORDERS') {
    const forecasts = await client.query(
      `SELECT product_id, SUM(quantity) AS quantity
       FROM manufacturing_demand_forecasts
       WHERE organization_id = $1 AND forecast_date BETWEEN $2 AND $3
       GROUP BY product_id`,
      [organizationId, from, to],
    );
    for (const row of forecasts.rows) {
      demands.set(row.product_id, (demands.get(row.product_id) || 0) + Number(row.quantity));
    }
  }
  return [...demands].map(([productId, quantity]) => ({ productId, quantity }));
}

export const manufacturingService = {
  async getWorkspace(client, organizationId) {
    const [workCenters, boms, routings, orders, supplies, latestRun, products, warehouses, receipts, lots, forecasts, maintenance, downtimeEvents] = await Promise.all([
      client.query('SELECT * FROM manufacturing_work_centers WHERE organization_id = $1 ORDER BY name', [organizationId]),
      client.query(
        `SELECT bom.*, product.sku AS finished_sku, product.name AS finished_name,
         (SELECT COUNT(*)::int FROM manufacturing_bom_lines line WHERE line.bom_id = bom.id) AS material_count
         FROM manufacturing_boms bom JOIN inventory_products product ON product.id = bom.finished_product_id
         WHERE bom.organization_id = $1 ORDER BY bom.bom_code, bom.version DESC`, [organizationId],
      ),
      client.query(
        `SELECT routing.*, product.sku AS finished_sku, product.name AS finished_name,
         (SELECT COUNT(*)::int FROM manufacturing_routing_operations operation WHERE operation.routing_id = routing.id) AS operation_count
         FROM manufacturing_routings routing JOIN inventory_products product ON product.id = routing.finished_product_id
         WHERE routing.organization_id = $1 ORDER BY routing.routing_code, routing.version DESC`, [organizationId],
      ),
      client.query(
        `SELECT mo.*, product.sku AS finished_sku, product.name AS finished_name, warehouse.name AS warehouse_name
         FROM manufacturing_orders mo JOIN inventory_products product ON product.id = mo.finished_product_id
         JOIN inventory_warehouses warehouse ON warehouse.id = mo.warehouse_id
         WHERE mo.organization_id = $1 ORDER BY mo.created_at DESC`, [organizationId],
      ),
      client.query('SELECT * FROM manufacturing_open_purchase_supply WHERE organization_id = $1 AND status IN (\'OPEN\', \'PARTIALLY_RECEIVED\') ORDER BY due_date', [organizationId]),
      client.query('SELECT * FROM manufacturing_mrp_runs WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1', [organizationId]),
      client.query('SELECT id,sku,name,product_type,unit_of_measure_id,standard_cost,reorder_level,reorder_quantity FROM inventory_products WHERE organization_id=$1 AND active=TRUE ORDER BY name', [organizationId]),
      client.query('SELECT id,code,name FROM inventory_warehouses WHERE organization_id=$1 AND active=TRUE ORDER BY name', [organizationId]),
      client.query("SELECT id,product_id,warehouse_id,quantity,unit_cost,transaction_date,reference_id FROM inventory_stock_transactions WHERE organization_id=$1 AND direction='IN' ORDER BY transaction_date DESC LIMIT 200", [organizationId]),
      client.query(
        `SELECT lot.id, lot.lot_number, lot.lot_type, product.sku, product.name AS product_name
         FROM manufacturing_lots lot JOIN inventory_products product ON product.id = lot.product_id
         WHERE lot.organization_id = $1 ORDER BY lot.created_at DESC`, [organizationId],
      ),
      client.query(
        `SELECT forecast.*, product.sku, product.name AS product_name
         FROM manufacturing_demand_forecasts forecast JOIN inventory_products product ON product.id=forecast.product_id
         WHERE forecast.organization_id=$1 ORDER BY forecast.forecast_date, product.name`, [organizationId],
      ),
      client.query(
        `SELECT event.*, center.code AS work_center_code, center.name AS work_center_name
         FROM manufacturing_maintenance_events event JOIN manufacturing_work_centers center ON center.id=event.work_center_id
         WHERE event.organization_id=$1 ORDER BY event.scheduled_date DESC, event.created_at DESC`, [organizationId],
      ),
      client.query(
        `SELECT event.*, center.code AS work_center_code, center.name AS work_center_name,
                mo.order_number
         FROM manufacturing_downtime_events event
         JOIN manufacturing_work_centers center ON center.id=event.work_center_id
         LEFT JOIN manufacturing_orders mo ON mo.id=event.manufacturing_order_id
         WHERE event.organization_id=$1
         ORDER BY event.downtime_date DESC, event.created_at DESC`, [organizationId],
      ),
    ]);
    const summary = await this.getReport(client, organizationId, 'wip');
    const latestRequirements = latestRun.rows[0]
      ? (await client.query('SELECT * FROM manufacturing_mrp_requirements WHERE run_id = $1 ORDER BY product_id', [latestRun.rows[0].id])).rows
      : [];
    return {
      workCenters: workCenters.rows,
      boms: boms.rows,
      routings: routings.rows,
      orders: orders.rows,
      openPurchaseSupply: supplies.rows,
      products: products.rows,
      warehouses: warehouses.rows,
      inventoryReceipts: receipts.rows,
      lots: lots.rows,
      forecasts: forecasts.rows,
      maintenance: maintenance.rows,
      downtimeEvents: downtimeEvents.rows,
      latestMrp: latestRun.rows[0] ? { ...latestRun.rows[0], requirements: latestRequirements } : null,
      summary,
    };
  },

  async listWorkCenters(client, organizationId) {
    return (await client.query('SELECT * FROM manufacturing_work_centers WHERE organization_id = $1 ORDER BY name', [organizationId])).rows;
  },

  async createDemandForecast(client, organizationId, actorId, input) {
    const productId = requiredText(input.productId, 'productId');
    const forecastDate = validDate(input.forecastDate, 'forecastDate');
    const quantity = positive(input.quantity, 'quantity');
    await getProduct(client, organizationId, productId);
    return transaction(client, async () => {
      const result = await client.query(
        `INSERT INTO manufacturing_demand_forecasts
           (organization_id, product_id, forecast_date, quantity, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (organization_id, product_id, forecast_date)
         DO UPDATE SET quantity=EXCLUDED.quantity, notes=EXCLUDED.notes
         RETURNING *`,
        [organizationId, productId, forecastDate, quantity, input.notes ? String(input.notes).trim() : null, actorId],
      );
      await audit(client, organizationId, actorId, 'demand_forecast_saved', 'demand_forecast', result.rows[0].id, { productId, forecastDate, quantity });
      return result.rows[0];
    });
  },

  async createMaintenanceEvent(client, organizationId, actorId, input) {
    const workCenterId = requiredText(input.workCenterId, 'workCenterId');
    const maintenanceType = String(input.maintenanceType || 'PREVENTIVE').toUpperCase();
    if (!['PREVENTIVE', 'CORRECTIVE'].includes(maintenanceType)) {
      throw new ManufacturingError(400, 'maintenanceType must be PREVENTIVE or CORRECTIVE.');
    }
    const description = requiredText(input.description, 'description').slice(0, 240);
    const scheduledDate = validDate(input.scheduledDate, 'scheduledDate');
    const nextDueDate = validDate(input.nextDueDate, 'nextDueDate', true);
    await getWorkCenter(client, organizationId, workCenterId);
    return transaction(client, async () => {
      const result = await client.query(
        `INSERT INTO manufacturing_maintenance_events
           (organization_id, work_center_id, maintenance_type, description, scheduled_date, next_due_date, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [organizationId, workCenterId, maintenanceType, description, scheduledDate, nextDueDate,
          input.notes ? String(input.notes).trim() : null, actorId],
      );
      await audit(client, organizationId, actorId, 'maintenance_scheduled', 'maintenance_event', result.rows[0].id, { workCenterId, maintenanceType, scheduledDate });
      return result.rows[0];
    });
  },

  async completeMaintenanceEvent(client, organizationId, actorId, eventId, downtimeMinutes) {
    const downtime = positive(downtimeMinutes ?? 0, 'downtimeMinutes', true);
    return transaction(client, async () => {
      const result = await client.query(
        `UPDATE manufacturing_maintenance_events
         SET status='COMPLETED', downtime_minutes=$1, completed_by=$2, completed_at=CURRENT_TIMESTAMP,
             updated_at=CURRENT_TIMESTAMP
         WHERE id=$3 AND organization_id=$4 AND status='PLANNED'
         RETURNING *`,
        [downtime, actorId, eventId, organizationId],
      );
      if (!result.rows[0]) throw new ManufacturingError(409, 'Only scheduled maintenance can be completed.');
      await audit(client, organizationId, actorId, 'maintenance_completed', 'maintenance_event', eventId, { downtimeMinutes: downtime });
      return result.rows[0];
    });
  },

  async recordDowntimeEvent(client, organizationId, actorId, input) {
    const workCenterId = requiredText(input.workCenterId, 'workCenterId');
    const downtimeDate = validDate(input.downtimeDate || today(), 'downtimeDate');
    const downtimeMinutes = positive(input.downtimeMinutes, 'downtimeMinutes');
    const reason = requiredText(input.reason, 'reason');
    const notes = input.notes ? String(input.notes).trim() : null;
    if (reason.length > 120) throw new ManufacturingError(400, 'reason must be 120 characters or fewer.');
    await getWorkCenter(client, organizationId, workCenterId);
    const orderId = input.manufacturingOrderId ? requiredText(input.manufacturingOrderId, 'manufacturingOrderId') : null;
    if (orderId) {
      const order = await client.query(
        `SELECT id FROM manufacturing_orders
         WHERE id=$1 AND organization_id=$2 AND status IN ('RELEASED','IN_PROGRESS')`,
        [orderId, organizationId],
      );
      if (!order.rows[0]) throw new ManufacturingError(404, 'Active production order not found.');
    }
    return transaction(client, async () => {
      const result = await client.query(
        `INSERT INTO manufacturing_downtime_events
           (organization_id, work_center_id, manufacturing_order_id, downtime_date,
            downtime_minutes, reason, notes, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [organizationId, workCenterId, orderId, downtimeDate, downtimeMinutes, reason, notes, actorId],
      );
      await audit(client, organizationId, actorId, 'production_downtime_recorded', 'downtime_event', result.rows[0].id, {
        workCenterId, manufacturingOrderId: orderId, downtimeDate, downtimeMinutes, reason,
      });
      return result.rows[0];
    });
  },

  async createWorkCenter(client, organizationId, actorId, input) {
    const code = requiredText(input.code, 'code').toUpperCase();
    const name = requiredText(input.name, 'name');
    const machineCapacity = positive(input.machineCapacity ?? 1, 'machineCapacity');
    const laborCapacity = positive(input.laborCapacity ?? 1, 'laborCapacity');
    const calendar = input.calendar || { workingDays: [1, 2, 3, 4, 5], hoursPerDay: 8 };
    if (!calendar || typeof calendar !== 'object' || Array.isArray(calendar) || !Array.isArray(calendar.workingDays) ||
      calendar.workingDays.some((day) => !Number.isInteger(Number(day)) || Number(day) < 1 || Number(day) > 7) ||
      !Number.isFinite(Number(calendar.hoursPerDay)) || Number(calendar.hoursPerDay) <= 0 || Number(calendar.hoursPerDay) > 24) {
      throw new ManufacturingError(400, 'calendar requires workingDays (1-7) and hoursPerDay (0-24].');
    }
    return transaction(client, async () => {
      const result = await client.query(
        `INSERT INTO manufacturing_work_centers (
          organization_id, code, name, machine_name, machine_capacity, labor_capacity,
          machine_hour_rate, labor_hour_rate, overhead_hour_rate, calendar, active, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12) RETURNING *`,
        [organizationId, code, name, input.machineName || null, machineCapacity, laborCapacity,
          positive(input.machineHourRate ?? 0, 'machineHourRate', true), positive(input.laborHourRate ?? 0, 'laborHourRate', true),
          positive(input.overheadHourRate ?? input.operatingCost ?? 0, 'overheadHourRate', true),
          JSON.stringify(calendar), input.active !== false, actorId],
      );
      await audit(client, organizationId, actorId, 'work_center_created', 'work_center', result.rows[0].id, { code });
      return result.rows[0];
    });
  },

  async listBoms(client, organizationId) {
    return (await client.query(
      `SELECT bom.*, product.sku AS finished_sku, product.name AS finished_name,
       (SELECT COUNT(*)::int FROM manufacturing_bom_lines line WHERE line.bom_id = bom.id) AS material_count
       FROM manufacturing_boms bom JOIN inventory_products product ON product.id = bom.finished_product_id
       WHERE bom.organization_id = $1 ORDER BY bom.bom_code, bom.version DESC`, [organizationId],
    )).rows;
  },

  async createBom(client, organizationId, actorId, input) {
    const code = requiredText(input.bomCode ?? input.bom_code, 'bomCode').toUpperCase();
    const version = requiredText(input.version, 'version');
    const effectiveFrom = validDate(input.effectiveFrom ?? input.effective_from ?? today(), 'effectiveFrom');
    const effectiveTo = validDate(input.effectiveTo ?? input.effective_to, 'effectiveTo', true);
    const scrapPercent = positive(input.scrapPercent ?? input.scrap_percent ?? 0, 'scrapPercent', true);
    if (scrapPercent >= 100) throw new ManufacturingError(400, 'scrapPercent must be below 100.');
    if (effectiveTo && effectiveTo < effectiveFrom) throw new ManufacturingError(400, 'effectiveTo must not precede effectiveFrom.');
    if (!Array.isArray(input.lines) || !input.lines.length) throw new ManufacturingError(400, 'A BOM requires at least one material line.');
    return transaction(client, async () => {
      const finished = await getProduct(client, organizationId, input.finishedProductId ?? input.finished_product_id);
      if (!['FINISHED_GOOD', 'SEMI_FINISHED_GOOD'].includes(finished.product_type)) throw new ManufacturingError(400, 'BOM finished product must be a finished or semi-finished good.');
      const bom = (await client.query(
        `INSERT INTO manufacturing_boms (organization_id, bom_code, version, finished_product_id, effective_from, effective_to, scrap_percent, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [organizationId, code, version, finished.id, effectiveFrom, effectiveTo, scrapPercent, input.notes || null, actorId],
      )).rows[0];
      for (const [index, line] of input.lines.entries()) {
        const rawMaterial = await getProduct(client, organizationId, line.rawMaterialProductId ?? line.raw_material_product_id);
        if (rawMaterial.id === finished.id) throw new ManufacturingError(400, 'A finished product cannot consume itself.');
        if (!['RAW_MATERIAL', 'SEMI_FINISHED_GOOD', 'CONSUMABLE'].includes(rawMaterial.product_type)) throw new ManufacturingError(400, 'BOM components must be raw materials, semi-finished goods, or consumables.');
        const quantity = positive(line.quantityPer ?? line.quantity_per, 'quantityPer');
        const lineScrap = positive(line.scrapPercent ?? line.scrap_percent ?? 0, 'line.scrapPercent', true);
        if (lineScrap >= 100) throw new ManufacturingError(400, 'line scrapPercent must be below 100.');
        const lineNumber = Number(line.lineNumber ?? index + 1);
        const operationSequence = Number(line.operationSequence ?? line.operation_sequence ?? 10);
        if (!Number.isInteger(lineNumber) || lineNumber <= 0 || !Number.isInteger(operationSequence) || operationSequence <= 0) throw new ManufacturingError(400, 'BOM line and operation sequences must be positive integers.');
        const unitOfMeasureId = line.unitOfMeasureId ?? line.unit_of_measure_id ?? rawMaterial.unit_of_measure_id;
        await convertToProductUnit(client, organizationId, rawMaterial, quantity, unitOfMeasureId);
        await client.query(
          `INSERT INTO manufacturing_bom_lines (bom_id, line_number, raw_material_product_id, quantity_per, unit_of_measure_id, scrap_percent, operation_sequence, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [bom.id, lineNumber, rawMaterial.id, quantity,
            unitOfMeasureId, lineScrap,
            operationSequence, line.notes || null],
        );
      }
      await audit(client, organizationId, actorId, 'bom_created', 'bom', bom.id, { bomCode: code, version });
      return getBom(client, organizationId, bom.id);
    });
  },

  async activateBom(client, organizationId, actorId, bomId) {
    return transaction(client, async () => {
      const bom = (await client.query('SELECT * FROM manufacturing_boms WHERE id = $1 AND organization_id = $2 FOR UPDATE', [bomId, organizationId])).rows[0];
      if (!bom) throw new ManufacturingError(404, 'BOM not found.');
      if (bom.effective_to && bom.effective_to < today()) throw new ManufacturingError(409, 'An expired BOM cannot be activated.');
      const count = Number((await client.query('SELECT COUNT(*) FROM manufacturing_bom_lines WHERE bom_id = $1', [bomId])).rows[0].count);
      if (!count) throw new ManufacturingError(409, 'A BOM must have material lines before activation.');
      await client.query(
        `UPDATE manufacturing_boms SET status = 'INACTIVE', updated_at = CURRENT_TIMESTAMP
         WHERE organization_id = $1 AND finished_product_id = $2 AND status = 'ACTIVE' AND id <> $3`,
        [organizationId, bom.finished_product_id, bomId],
      );
      await client.query("UPDATE manufacturing_boms SET status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [bomId]);
      await audit(client, organizationId, actorId, 'bom_activated', 'bom', bomId, { previousStatus: bom.status });
      return getBom(client, organizationId, bomId);
    });
  },

  async createRouting(client, organizationId, actorId, input) {
    const code = requiredText(input.routingCode ?? input.routing_code, 'routingCode').toUpperCase();
    const version = requiredText(input.version, 'version');
    if (!Array.isArray(input.operations) || !input.operations.length) throw new ManufacturingError(400, 'A routing requires at least one operation.');
    return transaction(client, async () => {
      const product = await getProduct(client, organizationId, input.finishedProductId ?? input.finished_product_id);
      const effectiveFrom = validDate(input.effectiveFrom ?? today(), 'effectiveFrom');
      const effectiveTo = validDate(input.effectiveTo, 'effectiveTo', true);
      if (effectiveTo && effectiveTo < effectiveFrom) throw new ManufacturingError(400, 'effectiveTo must not precede effectiveFrom.');
      const routing = (await client.query(
        `INSERT INTO manufacturing_routings (organization_id, routing_code, version, finished_product_id, effective_from, effective_to, active, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [organizationId, code, version, product.id, effectiveFrom,
          effectiveTo, input.active !== false, input.notes || null, actorId],
      )).rows[0];
      for (const [index, operation] of input.operations.entries()) {
        const workCenterId = requiredText(operation.workCenterId ?? operation.work_center_id, 'workCenterId');
        const center = await client.query('SELECT id FROM manufacturing_work_centers WHERE id = $1 AND organization_id = $2 AND active = TRUE', [workCenterId, organizationId]);
        if (!center.rows[0]) throw new ManufacturingError(404, 'Active work center not found.');
        const sequence = Number(operation.sequenceNumber ?? index + 1);
        if (!Number.isInteger(sequence) || sequence <= 0) throw new ManufacturingError(400, 'Routing operation sequence must be a positive integer.');
        await client.query(
          `INSERT INTO manufacturing_routing_operations (routing_id, sequence_number, operation_name, work_center_id, setup_minutes, machine_minutes_per_unit, labor_hours_per_unit, instructions)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [routing.id, sequence, requiredText(operation.operationName, 'operationName'), workCenterId,
            positive(operation.setupMinutes ?? 0, 'setupMinutes', true), positive(operation.machineMinutesPerUnit ?? 0, 'machineMinutesPerUnit', true),
            positive(operation.laborHoursPerUnit ?? 0, 'laborHoursPerUnit', true), operation.instructions || null],
        );
      }
      await audit(client, organizationId, actorId, 'routing_created', 'routing', routing.id, { routingCode: code, version });
      return routing;
    });
  },

  async listRoutings(client, organizationId) {
    return (await client.query(
      `SELECT routing.*, product.sku AS finished_sku, product.name AS finished_name,
       (SELECT COUNT(*)::int FROM manufacturing_routing_operations operation WHERE operation.routing_id = routing.id) AS operation_count
       FROM manufacturing_routings routing JOIN inventory_products product ON product.id = routing.finished_product_id
       WHERE routing.organization_id = $1 ORDER BY routing.routing_code, routing.version DESC`, [organizationId],
    )).rows;
  },

  async listOrders(client, organizationId) {
    return (await client.query(
      `SELECT mo.*, product.sku AS finished_sku, product.name AS finished_name, warehouse.name AS warehouse_name,
       COALESCE((SELECT SUM(output.produced_quantity) FROM manufacturing_production_outputs output WHERE output.manufacturing_order_id = mo.id),0) AS good_output,
       COALESCE((SELECT SUM(output.rejected_quantity) FROM manufacturing_production_outputs output WHERE output.manufacturing_order_id = mo.id),0) AS scrap_output
       FROM manufacturing_orders mo JOIN inventory_products product ON product.id = mo.finished_product_id
       JOIN inventory_warehouses warehouse ON warehouse.id = mo.warehouse_id
       WHERE mo.organization_id = $1 ORDER BY mo.created_at DESC`, [organizationId],
    )).rows;
  },

  async getOrder(client, organizationId, orderId) {
    return getOrder(client, organizationId, orderId);
  },

  async createOrder(client, organizationId, actorId, input) {
    const plannedQuantity = positive(input.plannedQuantity ?? input.planned_quantity, 'plannedQuantity');
    const dueDate = validDate(input.dueDate ?? input.due_date, 'dueDate', true);
    const startDate = validDate(input.plannedStart ?? input.planned_start, 'plannedStart', true);
    return transaction(client, async () => {
      const finished = await getProduct(client, organizationId, input.finishedProductId ?? input.finished_product_id);
      await getWarehouse(client, organizationId, input.warehouseId ?? input.warehouse_id);
      const effectiveDate = startDate || today();
      const bomResult = input.bomId || input.bom_id
        ? await client.query("SELECT * FROM manufacturing_boms WHERE id=$1 AND organization_id=$2 AND status='ACTIVE' AND effective_from<=$3 AND (effective_to IS NULL OR effective_to >= $3)", [input.bomId ?? input.bom_id, organizationId, effectiveDate])
        : await client.query(
          `SELECT * FROM manufacturing_boms WHERE organization_id=$1 AND finished_product_id=$2 AND status='ACTIVE'
           AND effective_from <= $3 AND (effective_to IS NULL OR effective_to >= $3) LIMIT 1`,
          [organizationId, finished.id, startDate || today()],
        );
      const bom = bomResult.rows[0];
      if (!bom || bom.finished_product_id !== finished.id) throw new ManufacturingError(409, 'A matching active BOM is required to create a manufacturing order.');
      const routingId = input.routingId ?? input.routing_id ?? null;
      if (routingId) {
        const routing = await client.query('SELECT id FROM manufacturing_routings WHERE id=$1 AND organization_id=$2 AND finished_product_id=$3 AND active=TRUE', [routingId, organizationId, finished.id]);
        if (!routing.rows[0]) throw new ManufacturingError(409, 'The routing must be active and match the finished product.');
      }
      const orderNumber = input.orderNumber ?? input.order_number ?? `MO-${new Date().getFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`;
      const order = (await client.query(
        `INSERT INTO manufacturing_orders (organization_id, order_number, finished_product_id, bom_id, routing_id, warehouse_id, planned_quantity, planned_start, due_date, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [organizationId, orderNumber, finished.id, bom.id, routingId, input.warehouseId ?? input.warehouse_id, plannedQuantity, startDate, dueDate, actorId],
      )).rows[0];
      const bomLines = (await client.query('SELECT * FROM manufacturing_bom_lines WHERE bom_id=$1 ORDER BY line_number', [bom.id])).rows;
      const materials = new Map();
      for (const line of bomLines) {
        const component = await getProduct(client, organizationId, line.raw_material_product_id);
        const baseQuantity = await convertToProductUnit(client, organizationId, component, Number(line.quantity_per), line.unit_of_measure_id);
        const requiredQuantity = baseQuantity * plannedQuantity * (1 + Number(bom.scrap_percent) / 100) * (1 + Number(line.scrap_percent) / 100);
        const current = materials.get(line.raw_material_product_id) || { quantity: 0, lineId: line.id };
        current.quantity += requiredQuantity;
        materials.set(line.raw_material_product_id, current);
      }
      for (const [productId, item] of materials) {
        const product = await getProduct(client, organizationId, productId);
        await client.query(
          `INSERT INTO manufacturing_order_materials (organization_id, manufacturing_order_id, bom_line_id, raw_material_product_id, required_quantity, unit_cost)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [organizationId, order.id, item.lineId, productId, round(item.quantity), product.standard_cost],
        );
      }
      if (routingId) {
        const operations = (await client.query('SELECT * FROM manufacturing_routing_operations WHERE routing_id=$1 ORDER BY sequence_number', [routingId])).rows;
        for (const operation of operations) {
          await client.query(
            `INSERT INTO manufacturing_order_operations (organization_id, manufacturing_order_id, routing_operation_id, sequence_number, operation_name, work_center_id, planned_machine_hours, planned_labor_hours)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [organizationId, order.id, operation.id, operation.sequence_number, operation.operation_name, operation.work_center_id,
              Number(operation.setup_minutes) / 60 + Number(operation.machine_minutes_per_unit) * plannedQuantity / 60,
              Number(operation.labor_hours_per_unit) * plannedQuantity],
          );
        }
      }
      await audit(client, organizationId, actorId, 'manufacturing_order_created', 'manufacturing_order', order.id, { orderNumber, plannedQuantity });
      return getOrder(client, organizationId, order.id);
    });
  },

  async reserveMaterials(client, organizationId, actorId, orderId) {
    return transaction(client, () => reserveOrderMaterials(client, organizationId, actorId, orderId));
  },

  async releaseOrder(client, organizationId, actorId, orderId) {
    return transaction(client, async () => {
      const order = await reserveOrderMaterials(client, organizationId, actorId, orderId);
      const updated = (await client.query(
        `UPDATE manufacturing_orders SET status='RELEASED', released_by=$1, updated_at=CURRENT_TIMESTAMP
         WHERE id=$2 AND organization_id=$3 AND status='PLANNED' RETURNING *`, [actorId, orderId, organizationId],
      )).rows[0];
      if (!updated) throw new ManufacturingError(409, 'Only planned orders can be released.');
      await audit(client, organizationId, actorId, 'manufacturing_order_released', 'manufacturing_order', orderId);
      return { ...order, ...updated, materials: order.materials };
    });
  },

  async startOrder(client, organizationId, actorId, orderId) {
    return transaction(client, async () => {
      const order = await client.query('SELECT * FROM manufacturing_orders WHERE id=$1 AND organization_id=$2 FOR UPDATE', [orderId, organizationId]);
      if (!order.rows[0] || order.rows[0].status !== 'RELEASED') throw new ManufacturingError(409, 'Only released orders can start.');
      const updated = (await client.query(
        `UPDATE manufacturing_orders SET status='IN_PROGRESS', started_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
         WHERE id=$1 RETURNING *`, [orderId],
      )).rows[0];
      await client.query("UPDATE manufacturing_order_operations SET status='IN_PROGRESS', started_at=CURRENT_TIMESTAMP WHERE manufacturing_order_id=$1 AND sequence_number=(SELECT MIN(sequence_number) FROM manufacturing_order_operations WHERE manufacturing_order_id=$1)", [orderId]);
      await audit(client, organizationId, actorId, 'manufacturing_order_started', 'manufacturing_order', orderId);
      return updated;
    });
  },

  async registerRawLot(client, organizationId, actorId, input) {
    const inventoryTransactionId = requiredText(input.inventoryTransactionId ?? input.inventory_transaction_id, 'inventoryTransactionId');
    const lotNumber = requiredText(input.lotNumber ?? input.lot_number, 'lotNumber');
    const register = async () => {
      const receipt = (await client.query(
        `SELECT * FROM inventory_stock_transactions WHERE id=$1 AND organization_id=$2 AND direction='IN' FOR UPDATE`,
        [inventoryTransactionId, organizationId],
      )).rows[0];
      if (!receipt) throw new ManufacturingError(404, 'Inventory receipt transaction not found.');
      const product = await getProduct(client, organizationId, receipt.product_id);
      if (!['RAW_MATERIAL', 'SEMI_FINISHED_GOOD', 'CONSUMABLE'].includes(product.product_type)) {
        throw new ManufacturingError(400, 'Only raw, semi-finished, or consumable stock can be registered as a raw lot.');
      }
      const registered = await client.query('SELECT COALESCE(SUM(quantity),0) AS quantity FROM manufacturing_lots WHERE source_inventory_transaction_id=$1', [receipt.id]);
      const quantity = positive(input.quantity, 'quantity');
      if (quantity + Number(registered.rows[0].quantity) > Number(receipt.quantity) + 0.000001) throw new ManufacturingError(409, 'Registered raw lots cannot exceed receipt quantity.');
      const productionDate = receipt.transaction_date
        ? new Date(receipt.transaction_date).toISOString().slice(0, 10)
        : today();
      const lot = (await client.query(
        `INSERT INTO manufacturing_lots (organization_id, product_id, lot_number, lot_type, source_inventory_transaction_id, warehouse_id, quantity, remaining_quantity, unit_cost, production_date, created_by)
         VALUES ($1,$2,$3,'RAW_MATERIAL',$4,$5,$6,$6,$7,$8,$9) RETURNING *`,
        [organizationId, receipt.product_id, lotNumber, receipt.id, receipt.warehouse_id, quantity, receipt.unit_cost, productionDate, actorId],
      )).rows[0];
      await audit(client, organizationId, actorId, 'raw_lot_registered', 'lot', lot.id, { lotNumber, quantity });
      return lot;
    };
    return input.manageTransaction === false ? register() : transaction(client, register);
  },

  async consumeMaterial(client, organizationId, actorId, orderId, input) {
    const productId = requiredText(input.productId ?? input.product_id, 'productId');
    const quantity = positive(input.quantity, 'quantity');
    const lotNumber = requiredText(input.lotNumber ?? input.lot_number, 'lotNumber');
    return transaction(client, async () => {
      const order = (await client.query('SELECT * FROM manufacturing_orders WHERE id=$1 AND organization_id=$2 FOR UPDATE', [orderId, organizationId])).rows[0];
      if (!order || order.status !== 'IN_PROGRESS') throw new ManufacturingError(409, 'Materials can only be consumed by an in-progress order.');
      const material = (await client.query(
        'SELECT * FROM manufacturing_order_materials WHERE manufacturing_order_id=$1 AND raw_material_product_id=$2 FOR UPDATE',
        [orderId, productId],
      )).rows[0];
      if (!material) throw new ManufacturingError(404, 'Material is not required by this order.');
      if (Number(material.consumed_quantity) + quantity > Number(material.required_quantity) + 0.000001) throw new ManufacturingError(409, 'Consumption exceeds the order material requirement.');
      const reservations = (await client.query(
        `SELECT * FROM manufacturing_material_reservations
         WHERE order_material_id=$1 AND status='RESERVED' AND quantity > consumed_quantity
         ORDER BY created_at FOR UPDATE`, [material.id],
      )).rows;
      const reserved = reservations.reduce((sum, item) => sum + Number(item.quantity) - Number(item.consumed_quantity), 0);
      if (reserved + 0.000001 < quantity) throw new ManufacturingError(409, 'Reserve material before consuming it.');
      const sourceLot = (await client.query(
        `SELECT * FROM manufacturing_lots WHERE organization_id=$1 AND product_id=$2 AND lot_number=$3
         AND lot_type='RAW_MATERIAL' AND warehouse_id=$4 FOR UPDATE`,
        [organizationId, productId, lotNumber, order.warehouse_id],
      )).rows[0];
      if (!sourceLot || Number(sourceLot.remaining_quantity) + 0.000001 < quantity) throw new ManufacturingError(409, 'Register the raw-material lot or check its remaining quantity.');
      const consumptionId = randomUUID();
      const movement = await inventoryService.issue(client, organizationId, actorId, {
        productId, warehouseId: order.warehouse_id, quantity, unitCost: sourceLot.unit_cost,
        transactionType: 'PRODUCTION_CONSUMPTION', referenceType: 'MANUFACTURING_ORDER',
        referenceId: consumptionId, transactionDate: today(), postToLedger: true, manageTransaction: false,
      });
      await client.query(
        `INSERT INTO manufacturing_material_consumptions (id, organization_id, order_material_id, inventory_transaction_id, lot_id, quantity, unit_cost, total_cost, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [consumptionId, organizationId, material.id, movement.transaction.id, sourceLot.id, quantity,
          movement.transaction.unit_cost, movement.transaction.total_cost, actorId],
      );
      let remaining = quantity;
      for (const reservation of reservations) {
        if (remaining <= 0.000001) break;
        const unconsumed = Number(reservation.quantity) - Number(reservation.consumed_quantity);
        const consumedNow = Math.min(unconsumed, remaining);
        const consumedTotal = Number(reservation.consumed_quantity) + consumedNow;
        await client.query(
          `UPDATE manufacturing_material_reservations SET consumed_quantity=$2,
           status=CASE WHEN $2 + 0.000001 >= quantity THEN 'CONSUMED' ELSE status END,
           updated_at=CURRENT_TIMESTAMP WHERE id=$1`, [reservation.id, consumedTotal],
        );
        remaining -= consumedNow;
      }
      await client.query(
        `UPDATE manufacturing_order_materials SET reserved_quantity=GREATEST(0,reserved_quantity-$2),
         consumed_quantity=consumed_quantity+$2 WHERE id=$1`, [material.id, quantity],
      );
      await client.query('UPDATE manufacturing_lots SET remaining_quantity=remaining_quantity-$2 WHERE id=$1', [sourceLot.id, quantity]);
      await audit(client, organizationId, actorId, 'material_consumed', 'manufacturing_order', orderId, { productId, quantity, lotNumber, transactionId: movement.transaction.id });
      return { consumptionId, transaction: movement.transaction, journal: movement.journal, lot: sourceLot };
    });
  },

  async startOperation(client, organizationId, actorId, orderId, operationId) {
    return transaction(client, async () => {
      const order = (await client.query('SELECT status FROM manufacturing_orders WHERE id=$1 AND organization_id=$2 FOR UPDATE', [orderId, organizationId])).rows[0];
      if (!order || order.status !== 'IN_PROGRESS') throw new ManufacturingError(409, 'Operations require an in-progress order.');
      const operation = (await client.query('SELECT * FROM manufacturing_order_operations WHERE id=$1 AND organization_id=$2 AND manufacturing_order_id=$3 FOR UPDATE', [operationId, organizationId, orderId])).rows[0];
      if (!operation || operation.status !== 'PLANNED') throw new ManufacturingError(409, 'Operation is not available to start.');
      const earlier = await client.query(
        `SELECT 1 FROM manufacturing_order_operations WHERE manufacturing_order_id=$1 AND sequence_number<$2 AND status<>'COMPLETED' LIMIT 1`,
        [orderId, operation.sequence_number],
      );
      if (earlier.rows.length) throw new ManufacturingError(409, 'Complete earlier routing operations first.');
      const result = await client.query("UPDATE manufacturing_order_operations SET status='IN_PROGRESS',started_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *", [operationId]);
      await audit(client, organizationId, actorId, 'production_operation_started', 'manufacturing_order', orderId, { operationId });
      return result.rows[0];
    });
  },

  async completeOperation(client, organizationId, actorId, orderId, operationId, input) {
    return transaction(client, async () => {
      const operation = (await client.query(
        `SELECT operation.*, center.labor_hour_rate, center.machine_hour_rate, center.overhead_hour_rate
         FROM manufacturing_order_operations operation JOIN manufacturing_work_centers center ON center.id=operation.work_center_id
         WHERE operation.id=$1 AND operation.organization_id=$2 AND operation.manufacturing_order_id=$3 FOR UPDATE`,
        [operationId, organizationId, orderId],
      )).rows[0];
      if (!operation || operation.status !== 'IN_PROGRESS') throw new ManufacturingError(409, 'Only in-progress operations can complete.');
      const laborHours = positive(input.actualLaborHours ?? operation.planned_labor_hours, 'actualLaborHours', true);
      const machineHours = positive(input.actualMachineHours ?? operation.planned_machine_hours, 'actualMachineHours', true);
      const order = await getOrder(client, organizationId, orderId);
      const product = await getProduct(client, organizationId, order.finished_product_id);
      const laborCost = round(laborHours * Number(operation.labor_hour_rate));
      const overheadCost = round(machineHours * (Number(operation.machine_hour_rate) + Number(operation.overhead_hour_rate)));
      const transactionDate = today();
      if (laborCost > 0) await accountingService.createBusinessJournal(client, organizationId, actorId, {
        transactionType: 'manufacturing-labor', transactionDate, sourceTransactionId: `labor:${operationId}`,
        description: `Direct labor for ${order.order_number}/${operation.operation_name}`, amount: laborCost,
        wipAccountCode: product.wip_account_code, expenseAccountCode: '6010',
      });
      if (overheadCost > 0) await accountingService.createBusinessJournal(client, organizationId, actorId, {
        transactionType: 'manufacturing-overhead', transactionDate, sourceTransactionId: `overhead:${operationId}`,
        description: `Machine and overhead for ${order.order_number}/${operation.operation_name}`, amount: overheadCost,
        wipAccountCode: product.wip_account_code, expenseAccountCode: '6000',
      });
      const completed = (await client.query(
        `UPDATE manufacturing_order_operations SET status='COMPLETED', actual_labor_hours=$2,
         actual_machine_hours=$3, completed_at=CURRENT_TIMESTAMP, completed_by=$4 WHERE id=$1 RETURNING *`,
        [operationId, laborHours, machineHours, actorId],
      )).rows[0];
      await audit(client, organizationId, actorId, 'production_operation_completed', 'manufacturing_order', orderId, { operationId, laborHours, machineHours, laborCost, overheadCost });
      return completed;
    });
  },

  async recordOutput(client, organizationId, actorId, orderId, input) {
    const produced = positive(input.producedQuantity ?? input.produced_quantity, 'producedQuantity');
    const rejected = positive(input.rejectedQuantity ?? input.rejected_quantity ?? 0, 'rejectedQuantity', true);
    const productionDate = validDate(input.productionDate ?? input.production_date ?? today(), 'productionDate');
    return transaction(client, async () => {
      const order = (await client.query('SELECT * FROM manufacturing_orders WHERE id=$1 AND organization_id=$2 FOR UPDATE', [orderId, organizationId])).rows[0];
      if (!order || order.status !== 'IN_PROGRESS') throw new ManufacturingError(409, 'Output can only be recorded for an in-progress order.');
      const totalOutput = produced + rejected;
      const priorOutput = Number(order.completed_quantity) + Number(order.rejected_quantity);
      if (priorOutput + totalOutput > Number(order.planned_quantity) + 0.000001) throw new ManufacturingError(409, 'Recorded output exceeds planned order quantity.');
      const operationsPending = await client.query("SELECT 1 FROM manufacturing_order_operations WHERE manufacturing_order_id=$1 AND status<>'COMPLETED' LIMIT 1", [orderId]);
      if (operationsPending.rows.length) throw new ManufacturingError(409, 'Complete all routing operations before recording finished output.');
      const materials = (await client.query('SELECT * FROM manufacturing_order_materials WHERE manufacturing_order_id=$1', [orderId])).rows;
      const scale = (priorOutput + totalOutput) / Number(order.planned_quantity);
      for (const material of materials) {
        const requiredAtOutput = Number(material.required_quantity) * scale;
        if (Number(material.consumed_quantity) + 0.000001 < requiredAtOutput) throw new ManufacturingError(409, 'Consume the required material before recording output.');
      }
      const costs = await getOrderCosts(client, organizationId, orderId);
      const allocatedCost = round(costs.totalCost * (totalOutput / Number(order.planned_quantity)));
      const goodCost = totalOutput > 0 ? round(allocatedCost * (produced / totalOutput)) : 0;
      const scrapCost = round(allocatedCost - goodCost);
      const batchNumber = requiredText(input.batchNumber ?? input.batch_number ?? `${order.order_number}-B${priorOutput + 1}`, 'batchNumber');
      const lot = (await client.query(
        `INSERT INTO manufacturing_lots (organization_id, product_id, lot_number, lot_type, manufacturing_order_id,
         warehouse_id, quantity, remaining_quantity, unit_cost, production_date, created_by)
         VALUES ($1,$2,$3,'FINISHED_GOOD',$4,$5,$6,$6,$7,$8,$9) RETURNING *`,
        [organizationId, order.finished_product_id, batchNumber, orderId, order.warehouse_id, produced,
          produced ? round(goodCost / produced) : 0, productionDate, actorId],
      )).rows[0];
      const outputId = randomUUID();
      const movement = await inventoryService.receive(client, organizationId, actorId, {
        productId: order.finished_product_id,
        warehouseId: order.warehouse_id,
        quantity: produced,
        unitCost: produced ? round(goodCost / produced) : 0,
        transactionType: 'PRODUCTION_COMPLETION',
        referenceType: 'MANUFACTURING_OUTPUT',
        referenceId: outputId,
        transactionDate: productionDate,
        postToLedger: true,
        manageTransaction: false,
      });
      await client.query('UPDATE manufacturing_lots SET source_inventory_transaction_id=$2 WHERE id=$1', [lot.id, movement.transaction.id]);
      const output = (await client.query(
        `INSERT INTO manufacturing_production_outputs (id, organization_id, manufacturing_order_id, product_id, lot_id,
         inventory_transaction_id, produced_quantity, rejected_quantity, unit_cost, total_cost, scrap_cost, production_date, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [outputId, organizationId, orderId, order.finished_product_id, lot.id, movement.transaction.id, produced, rejected,
          produced ? round(goodCost / produced) : 0, allocatedCost, scrapCost, productionDate, actorId],
      )).rows[0];
      if (scrapCost > 0) {
        const product = await getProduct(client, organizationId, order.finished_product_id);
        await accountingService.createBusinessJournal(client, organizationId, actorId, {
          transactionType: 'manufacturing-scrap', transactionDate: productionDate,
          sourceTransactionId: `scrap:${outputId}`, description: `Scrap for ${order.order_number}/${batchNumber}`,
          amount: scrapCost, wipAccountCode: product.wip_account_code,
        });
      }
      const untraced = (await client.query(
        `SELECT consumption.id, consumption.lot_id, consumption.quantity
         FROM manufacturing_material_consumptions consumption
         JOIN manufacturing_order_materials material ON material.id=consumption.order_material_id
         WHERE material.manufacturing_order_id=$1 AND consumption.lot_id IS NOT NULL`, [orderId],
      )).rows;
      for (const consumption of untraced) {
        const quantity = round(Number(consumption.quantity) * totalOutput / Number(order.planned_quantity));
        if (quantity > 0) await client.query(
          `INSERT INTO manufacturing_lot_genealogy (organization_id, material_consumption_id, source_lot_id, output_lot_id, quantity)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (material_consumption_id, output_lot_id) DO UPDATE SET quantity=manufacturing_lot_genealogy.quantity + EXCLUDED.quantity`,
          [organizationId, consumption.id, consumption.lot_id, lot.id, quantity],
        );
      }
      const newGood = Number(order.completed_quantity) + produced;
      const newRejected = Number(order.rejected_quantity) + rejected;
      const newStatus = newGood + newRejected + 0.000001 >= Number(order.planned_quantity) ? 'COMPLETED' : 'IN_PROGRESS';
      await client.query(
        `UPDATE manufacturing_orders SET completed_quantity=$2,rejected_quantity=$3,status=$4::varchar,
         completed_at=CASE WHEN $4::varchar='COMPLETED' THEN CURRENT_TIMESTAMP ELSE completed_at END,updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
        [orderId, newGood, newRejected, newStatus],
      );
      await audit(client, organizationId, actorId, 'production_output_recorded', 'manufacturing_order', orderId, { batchNumber, produced, rejected, goodCost, scrapCost });
      return { output, lot, transaction: movement.transaction, journal: movement.journal, costs: { ...costs, allocatedCost, goodCost, scrapCost } };
    });
  },

  async closeOrder(client, organizationId, actorId, orderId) {
    return transaction(client, async () => {
      const order = (await client.query('SELECT * FROM manufacturing_orders WHERE id=$1 AND organization_id=$2 FOR UPDATE', [orderId, organizationId])).rows[0];
      if (!order || order.status !== 'COMPLETED') throw new ManufacturingError(409, 'Only completed orders can be closed.');
      await client.query(
        `UPDATE manufacturing_material_reservations SET status='RELEASED',updated_at=CURRENT_TIMESTAMP
         WHERE organization_id=$1 AND status='RESERVED' AND order_material_id IN (SELECT id FROM manufacturing_order_materials WHERE manufacturing_order_id=$2)`,
        [organizationId, orderId],
      );
      const closed = (await client.query("UPDATE manufacturing_orders SET status='CLOSED',closed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *", [orderId])).rows[0];
      await audit(client, organizationId, actorId, 'manufacturing_order_closed', 'manufacturing_order', orderId);
      return closed;
    });
  },

  async createOpenPurchaseSupply(client, organizationId, actorId, input) {
    const product = await getProduct(client, organizationId, input.productId ?? input.product_id);
    const orderedQuantity = positive(input.orderedQuantity ?? input.ordered_quantity, 'orderedQuantity');
    const receivedQuantity = positive(input.receivedQuantity ?? 0, 'receivedQuantity', true);
    if (receivedQuantity > orderedQuantity) throw new ManufacturingError(400, 'receivedQuantity cannot exceed orderedQuantity.');
    return transaction(client, async () => {
      const result = await client.query(
        `INSERT INTO manufacturing_open_purchase_supply (organization_id,purchase_order_number,product_id,ordered_quantity,received_quantity,due_date,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [organizationId, requiredText(input.purchaseOrderNumber ?? input.purchase_order_number, 'purchaseOrderNumber'), product.id,
          orderedQuantity, receivedQuantity, validDate(input.dueDate ?? input.due_date, 'dueDate', true), actorId],
      );
      await audit(client, organizationId, actorId, 'open_purchase_supply_created', 'purchase_supply', result.rows[0].id, { purchaseOrderNumber: result.rows[0].purchase_order_number });
      return result.rows[0];
    });
  },

  async updatePurchaseSupplyReceipt(client, organizationId, actorId, supplyId, receivedQuantity) {
    const received = positive(receivedQuantity, 'receivedQuantity', true);
    return transaction(client, async () => {
      const supply = (await client.query('SELECT * FROM manufacturing_open_purchase_supply WHERE id=$1 AND organization_id=$2 FOR UPDATE', [supplyId, organizationId])).rows[0];
      if (!supply) throw new ManufacturingError(404, 'Open purchase supply not found.');
      if (received < Number(supply.received_quantity) || received > Number(supply.ordered_quantity)) throw new ManufacturingError(400, 'Received quantity must be between previously received and ordered quantity.');
      const status = received >= Number(supply.ordered_quantity) ? 'CLOSED' : received > 0 ? 'PARTIALLY_RECEIVED' : 'OPEN';
      const updated = (await client.query('UPDATE manufacturing_open_purchase_supply SET received_quantity=$1,status=$2,updated_at=CURRENT_TIMESTAMP WHERE id=$3 RETURNING *', [received, status, supplyId])).rows[0];
      await audit(client, organizationId, actorId, 'open_purchase_supply_updated', 'purchase_supply', supplyId, { receivedQuantity: received, status });
      return updated;
    });
  },

  async runMrp(client, organizationId, actorId, input) {
    return transaction(client, async () => {
      const demands = await loadDemand(client, organizationId, input);
      if (!demands.length) throw new ManufacturingError(409, 'No approved sales demand was found for the planning horizon.');
      const planningDate = validDate(input.planningDate ?? today(), 'planningDate');
      const exploded = new Map();
      for (const demand of demands) {
        const product = await getProduct(client, organizationId, demand.productId);
        const onHand = await getStock(client, organizationId, product.id);
        const openProduction = Number((await client.query(
          `SELECT COALESCE(SUM(planned_quantity-completed_quantity),0) AS quantity FROM manufacturing_orders
           WHERE organization_id=$1 AND finished_product_id=$2 AND status IN ('PLANNED','RELEASED','IN_PROGRESS')`, [organizationId, product.id],
        )).rows[0].quantity);
        const netBuild = Math.max(0, demand.quantity + Number(product.reorder_level) - onHand - openProduction);
        if (netBuild > 0) await explodeProduct(client, organizationId, product.id, netBuild, planningDate, [], exploded);
      }
      const demandSource = input.demands?.length ? 'MANUAL' : (input.demandSource || 'SALES_ORDERS');
      const run = (await client.query(
        'INSERT INTO manufacturing_mrp_runs (organization_id,planning_date,demand_source,created_by) VALUES ($1,$2,$3,$4) RETURNING *',
        [organizationId, planningDate, demandSource, actorId],
      )).rows[0];
      const requirements = [];
      for (const { product, grossRequired } of exploded.values()) {
        const stock = await getStock(client, organizationId, product.id);
        const reserved = Number((await client.query(
          `SELECT COALESCE(SUM(reservation.quantity-reservation.consumed_quantity),0) AS quantity
           FROM manufacturing_material_reservations reservation
           JOIN manufacturing_order_materials material ON material.id=reservation.order_material_id
           WHERE reservation.organization_id=$1 AND material.raw_material_product_id=$2 AND reservation.status='RESERVED'`,
          [organizationId, product.id],
        )).rows[0].quantity);
        const openPurchase = Number((await client.query(
          `SELECT COALESCE(SUM(ordered_quantity-received_quantity),0) AS quantity FROM manufacturing_open_purchase_supply
           WHERE organization_id=$1 AND product_id=$2 AND status IN ('OPEN','PARTIALLY_RECEIVED')`, [organizationId, product.id],
        )).rows[0].quantity);
        const openProduction = Number((await client.query(
          `SELECT COALESCE(SUM(planned_quantity-completed_quantity),0) AS quantity FROM manufacturing_orders
           WHERE organization_id=$1 AND finished_product_id=$2 AND status IN ('PLANNED','RELEASED','IN_PROGRESS')`, [organizationId, product.id],
        )).rows[0].quantity);
        const safetyStock = Number(product.reorder_level || product.minimum_stock || 0);
        const net = Math.max(0, grossRequired + safetyStock - stock - reserved - openPurchase - openProduction);
        const multiple = Number(product.reorder_quantity || 0);
        const suggested = net > 0 && multiple > 0 ? Math.ceil(net / multiple) * multiple : net;
        const row = (await client.query(
          `INSERT INTO manufacturing_mrp_requirements (run_id,product_id,gross_required,safety_stock,on_hand,reserved,open_purchase,open_production,net_requirement,suggested_quantity)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [run.id, product.id, round(grossRequired), safetyStock, stock, reserved, openPurchase, openProduction, round(net), round(suggested)],
        )).rows[0];
        requirements.push({ ...row, sku: product.sku, product_name: product.name });
      }
      await audit(client, organizationId, actorId, 'mrp_run_created', 'mrp_run', run.id, { demandCount: demands.length, requirementCount: requirements.length });
      return { ...run, demands, requirements };
    });
  },

  async getReport(client, organizationId, reportType, filters = {}) {
    if (reportType === 'machine-utilization') {
      const endDate = validDate(filters.endDate || today(), 'endDate');
      const startDate = validDate(filters.startDate || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10), 'startDate');
      if (startDate > endDate) throw new ManufacturingError(400, 'startDate must not be after endDate.');
      const centers = (await client.query(
        `SELECT center.*,COALESCE(SUM(operation.actual_machine_hours),0) AS actual_machine_hours,
         COALESCE(SUM(operation.planned_machine_hours),0) AS planned_machine_hours
         FROM manufacturing_work_centers center LEFT JOIN manufacturing_order_operations operation
           ON operation.work_center_id=center.id AND operation.completed_at::date BETWEEN $2 AND $3
         WHERE center.organization_id=$1 GROUP BY center.id ORDER BY center.name`,
        [organizationId, startDate, endDate],
      )).rows;
      return centers.map((center) => {
        const calendar = center.calendar || {};
        const workingDays = new Set(Array.isArray(calendar.workingDays) ? calendar.workingDays.map(Number) : [1, 2, 3, 4, 5]);
        let availableDays = 0;
        for (let date = new Date(`${startDate}T00:00:00Z`); date <= new Date(`${endDate}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1)) {
          const weekDay = date.getUTCDay() || 7;
          if (workingDays.has(weekDay)) availableDays += 1;
        }
        const availableMachineHours = availableDays * Number(calendar.hoursPerDay || 8) * Number(center.machine_capacity);
        const actualMachineHours = Number(center.actual_machine_hours);
        return {
          id: center.id,
          code: center.code,
          name: center.name,
          actual_machine_hours: actualMachineHours,
          planned_machine_hours: Number(center.planned_machine_hours),
          available_machine_hours: availableMachineHours,
          utilization_percent: availableMachineHours ? round(actualMachineHours / availableMachineHours * 100) : 0,
        };
      });
    }
    const reports = {
      'production-plan': `SELECT * FROM manufacturing_orders WHERE organization_id=$1 AND status IN ('PLANNED','RELEASED','IN_PROGRESS') ORDER BY due_date`,
      orders: `SELECT * FROM manufacturing_orders WHERE organization_id=$1 ORDER BY created_at DESC`,
      consumption: `SELECT consumption.*, product.sku, product.name, mo.order_number, lot.lot_number FROM manufacturing_material_consumptions consumption JOIN manufacturing_order_materials material ON material.id=consumption.order_material_id JOIN manufacturing_orders mo ON mo.id=material.manufacturing_order_id JOIN inventory_products product ON product.id=material.raw_material_product_id LEFT JOIN manufacturing_lots lot ON lot.id=consumption.lot_id WHERE consumption.organization_id=$1 ORDER BY consumption.created_at DESC`,
      variance: `SELECT detail.*, detail.material_cost+detail.labor_cost+detail.overhead_cost AS actual_cost,
        detail.material_cost+detail.labor_cost+detail.overhead_cost-detail.planned_cost AS variance
        FROM (SELECT mo.id,mo.order_number,mo.planned_quantity,mo.completed_quantity,
          (SELECT COALESCE(SUM(consumption.total_cost),0) FROM manufacturing_material_consumptions consumption JOIN manufacturing_order_materials material ON material.id=consumption.order_material_id WHERE material.manufacturing_order_id=mo.id) AS material_cost,
          (SELECT COALESCE(SUM(operation.actual_labor_hours*center.labor_hour_rate),0) FROM manufacturing_order_operations operation JOIN manufacturing_work_centers center ON center.id=operation.work_center_id WHERE operation.manufacturing_order_id=mo.id) AS labor_cost,
          (SELECT COALESCE(SUM(operation.actual_machine_hours*(center.machine_hour_rate+center.overhead_hour_rate)),0) FROM manufacturing_order_operations operation JOIN manufacturing_work_centers center ON center.id=operation.work_center_id WHERE operation.manufacturing_order_id=mo.id) AS overhead_cost,
          (SELECT COALESCE(SUM(material.required_quantity*product.standard_cost),0) FROM manufacturing_order_materials material JOIN inventory_products product ON product.id=material.raw_material_product_id WHERE material.manufacturing_order_id=mo.id)
          +(SELECT COALESCE(SUM(operation.planned_labor_hours*center.labor_hour_rate),0) FROM manufacturing_order_operations operation JOIN manufacturing_work_centers center ON center.id=operation.work_center_id WHERE operation.manufacturing_order_id=mo.id)
          +(SELECT COALESCE(SUM(operation.planned_machine_hours*(center.machine_hour_rate+center.overhead_hour_rate)),0) FROM manufacturing_order_operations operation JOIN manufacturing_work_centers center ON center.id=operation.work_center_id WHERE operation.manufacturing_order_id=mo.id) AS planned_cost
        FROM manufacturing_orders mo WHERE mo.organization_id=$1) detail ORDER BY detail.order_number`,
      wip: `SELECT mo.id,mo.order_number,mo.status,mo.planned_quantity,mo.completed_quantity,
        (SELECT COALESCE(SUM(consumption.total_cost),0) FROM manufacturing_material_consumptions consumption JOIN manufacturing_order_materials material ON material.id=consumption.order_material_id WHERE material.manufacturing_order_id=mo.id)
        +(SELECT COALESCE(SUM(operation.actual_labor_hours*center.labor_hour_rate+operation.actual_machine_hours*(center.machine_hour_rate+center.overhead_hour_rate)),0) FROM manufacturing_order_operations operation JOIN manufacturing_work_centers center ON center.id=operation.work_center_id WHERE operation.manufacturing_order_id=mo.id)
        -(SELECT COALESCE(SUM(output.total_cost),0) FROM manufacturing_production_outputs output WHERE output.manufacturing_order_id=mo.id) AS wip_cost
        FROM manufacturing_orders mo WHERE mo.organization_id=$1 AND mo.status IN ('RELEASED','IN_PROGRESS') ORDER BY mo.order_number`,
      'production-cost': `SELECT detail.*, detail.material_cost+detail.labor_cost+detail.overhead_cost AS total_cost,
        CASE WHEN detail.completed_quantity=0 THEN 0 ELSE (detail.material_cost+detail.labor_cost+detail.overhead_cost)/detail.completed_quantity END AS unit_cost
        FROM (SELECT mo.id,mo.order_number,mo.planned_quantity,mo.completed_quantity,
          (SELECT COALESCE(SUM(consumption.total_cost),0) FROM manufacturing_material_consumptions consumption JOIN manufacturing_order_materials material ON material.id=consumption.order_material_id WHERE material.manufacturing_order_id=mo.id) AS material_cost,
          (SELECT COALESCE(SUM(operation.actual_labor_hours*center.labor_hour_rate),0) FROM manufacturing_order_operations operation JOIN manufacturing_work_centers center ON center.id=operation.work_center_id WHERE operation.manufacturing_order_id=mo.id) AS labor_cost,
          (SELECT COALESCE(SUM(operation.actual_machine_hours*(center.machine_hour_rate+center.overhead_hour_rate)),0) FROM manufacturing_order_operations operation JOIN manufacturing_work_centers center ON center.id=operation.work_center_id WHERE operation.manufacturing_order_id=mo.id) AS overhead_cost
        FROM manufacturing_orders mo WHERE mo.organization_id=$1) detail ORDER BY detail.order_number`,
      yield: `SELECT mo.id,mo.order_number,mo.planned_quantity,mo.completed_quantity,mo.rejected_quantity,CASE WHEN mo.completed_quantity+mo.rejected_quantity=0 THEN 0 ELSE ROUND(mo.completed_quantity/(mo.completed_quantity+mo.rejected_quantity)*100,2) END yield_percent,CASE WHEN mo.completed_quantity+mo.rejected_quantity=0 THEN 0 ELSE ROUND(mo.rejected_quantity/(mo.completed_quantity+mo.rejected_quantity)*100,2) END scrap_percent FROM manufacturing_orders mo WHERE mo.organization_id=$1 ORDER BY mo.created_at DESC`,
      scrap: `SELECT mo.order_number,output.production_date,lot.lot_number,output.rejected_quantity,output.unit_cost,output.rejected_quantity*output.unit_cost AS scrap_cost FROM manufacturing_production_outputs output JOIN manufacturing_orders mo ON mo.id=output.manufacturing_order_id JOIN manufacturing_lots lot ON lot.id=output.lot_id WHERE output.organization_id=$1 AND output.rejected_quantity>0 ORDER BY output.production_date DESC`,
    };
    const sql = reports[reportType];
    if (!sql) throw new ManufacturingError(400, 'Unsupported manufacturing report.');
    return (await client.query(sql, [organizationId])).rows;
  },

  async runMrpReport(client, organizationId, reportType, batchNumber = null) {
    if (reportType === 'mrp') {
      const run = (await client.query('SELECT * FROM manufacturing_mrp_runs WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 1', [organizationId])).rows[0];
      if (!run) return { run: null, requirements: [] };
      const requirements = (await client.query(
        `SELECT requirement.*,product.sku,product.name AS product_name FROM manufacturing_mrp_requirements requirement
         JOIN inventory_products product ON product.id=requirement.product_id WHERE requirement.run_id=$1 ORDER BY product.name`, [run.id],
      )).rows;
      return { run, requirements };
    }
    if (reportType === 'traceability') {
      if (!batchNumber) throw new ManufacturingError(400, 'batchNumber is required for traceability reports.');
      return this.traceLot(client, organizationId, batchNumber);
    }
    return this.getReport(client, organizationId, reportType);
  },

  async listQualityInspections(client, organizationId) {
    return (await client.query(
      `SELECT inspection.*, lot.lot_number, lot.lot_type, product.sku, product.name AS product_name,
              mo.order_number, inspector.username AS inspector_username
       FROM manufacturing_quality_inspections inspection
       JOIN manufacturing_lots lot ON lot.id = inspection.lot_id
       JOIN inventory_products product ON product.id = lot.product_id
       LEFT JOIN manufacturing_orders mo ON mo.id = lot.manufacturing_order_id
       LEFT JOIN users inspector ON inspector.id = inspection.inspected_by
       WHERE inspection.organization_id = $1
       ORDER BY inspection.inspected_at DESC, inspection.created_at DESC`,
      [organizationId],
    )).rows;
  },

  async createQualityInspection(client, organizationId, actorId, input) {
    const lotId = String(input.lotId ?? input.lot_id ?? '').trim() || null;
    const lotNumber = String(input.lotNumber ?? input.lot_number ?? '').trim();
    if (!lotId && !lotNumber) throw new ManufacturingError(400, 'lotNumber or lotId is required.');
    const stage = requiredText(input.inspectionStage ?? input.inspection_stage, 'inspectionStage').toUpperCase();
    if (!['INCOMING', 'IN_PROCESS', 'FINAL'].includes(stage)) {
      throw new ManufacturingError(400, 'inspectionStage must be INCOMING, IN_PROCESS, or FINAL.');
    }
    const inspected = positive(input.inspectedQuantity ?? input.inspected_quantity, 'inspectedQuantity');
    const passed = positive(input.passedQuantity ?? input.passed_quantity ?? 0, 'passedQuantity', true);
    const failed = positive(input.failedQuantity ?? input.failed_quantity ?? 0, 'failedQuantity', true);
    if (Math.abs(inspected - passed - failed) > 0.000001) {
      throw new ManufacturingError(400, 'passedQuantity and failedQuantity must add up to inspectedQuantity.');
    }
    const result = failed === 0 ? 'PASS' : passed === 0 ? 'FAIL' : 'PARTIAL';
    return transaction(client, async () => {
      const lot = (await client.query(
        `SELECT id, lot_number FROM manufacturing_lots
         WHERE organization_id = $1 AND (($2::uuid IS NOT NULL AND id = $2) OR ($2::uuid IS NULL AND lot_number = $3))
         ORDER BY created_at DESC LIMIT 2 FOR UPDATE`,
        [organizationId, lotId, lotNumber || null],
      )).rows;
      if (lot.length > 1) throw new ManufacturingError(409, 'Lot number is ambiguous; submit the lotId instead.');
      if (!lot[0]) throw new ManufacturingError(404, 'Manufacturing lot not found.');
      const inspection = (await client.query(
        `INSERT INTO manufacturing_quality_inspections (
           organization_id, lot_id, inspection_stage, inspected_quantity,
           passed_quantity, failed_quantity, result, defect_code, notes, inspected_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [organizationId, lot[0].id, stage, inspected, passed, failed, result,
          input.defectCode ? requiredText(input.defectCode, 'defectCode') : null,
          input.notes ? String(input.notes).trim() : null, actorId],
      )).rows[0];
      await audit(client, organizationId, actorId, 'quality_inspection_recorded', 'quality_inspection', inspection.id, {
        lotNumber: lot[0].lot_number, stage, inspectedQuantity: inspected, passedQuantity: passed, failedQuantity: failed, result,
      });
      return (await client.query(
        `SELECT inspection.*, lot.lot_number, lot.lot_type, product.sku, product.name AS product_name,
                mo.order_number, inspector.username AS inspector_username
         FROM manufacturing_quality_inspections inspection
         JOIN manufacturing_lots lot ON lot.id = inspection.lot_id
         JOIN inventory_products product ON product.id = lot.product_id
         LEFT JOIN manufacturing_orders mo ON mo.id = lot.manufacturing_order_id
         LEFT JOIN users inspector ON inspector.id = inspection.inspected_by
         WHERE inspection.id = $1 AND inspection.organization_id = $2`,
        [inspection.id, organizationId],
      )).rows[0];
    });
  },

  async traceLot(client, organizationId, lotNumber) {
    const lot = (await client.query(
      `SELECT lot.*,product.sku,product.name AS product_name,mo.order_number
       FROM manufacturing_lots lot JOIN inventory_products product ON product.id=lot.product_id
       LEFT JOIN manufacturing_orders mo ON mo.id=lot.manufacturing_order_id
       WHERE lot.organization_id=$1 AND lot.lot_number=$2`, [organizationId, lotNumber],
    )).rows[0];
    if (!lot) throw new ManufacturingError(404, 'Lot not found.');
    const [ancestors, descendants, shipments] = await Promise.all([
      client.query(
        `WITH RECURSIVE lineage AS (
           SELECT genealogy.source_lot_id AS lot_id,genealogy.quantity,1 AS depth
           FROM manufacturing_lot_genealogy genealogy WHERE genealogy.output_lot_id=$1
           UNION ALL
           SELECT genealogy.source_lot_id,genealogy.quantity,lineage.depth+1
           FROM manufacturing_lot_genealogy genealogy JOIN lineage ON genealogy.output_lot_id=lineage.lot_id
           WHERE lineage.depth<32
         ) SELECT DISTINCT source.lot_number,product.sku,product.name AS product_name,lineage.quantity,lineage.depth
           FROM lineage JOIN manufacturing_lots source ON source.id=lineage.lot_id
           JOIN inventory_products product ON product.id=source.product_id ORDER BY lineage.depth`, [lot.id],
      ),
      client.query(
        `WITH RECURSIVE lineage AS (
           SELECT genealogy.output_lot_id AS lot_id,genealogy.quantity,1 AS depth
           FROM manufacturing_lot_genealogy genealogy WHERE genealogy.source_lot_id=$1
           UNION ALL
           SELECT genealogy.output_lot_id,genealogy.quantity,lineage.depth+1
           FROM manufacturing_lot_genealogy genealogy JOIN lineage ON genealogy.source_lot_id=lineage.lot_id
           WHERE lineage.depth<32
         ) SELECT DISTINCT output.lot_number,product.sku,product.name AS product_name,lineage.quantity,lineage.depth
           FROM lineage JOIN manufacturing_lots output ON output.id=lineage.lot_id
           JOIN inventory_products product ON product.id=output.product_id ORDER BY lineage.depth`, [lot.id],
      ),
      client.query(
        `WITH RECURSIVE lineage AS (
           SELECT genealogy.output_lot_id AS lot_id,1 AS depth FROM manufacturing_lot_genealogy genealogy WHERE genealogy.source_lot_id=$1
           UNION ALL
           SELECT genealogy.output_lot_id,lineage.depth+1 FROM manufacturing_lot_genealogy genealogy JOIN lineage ON genealogy.source_lot_id=lineage.lot_id
           WHERE lineage.depth<32
         ) SELECT shipment.*,delivery.delivery_number,delivery.customer_id,customer.legal_name AS customer_name,shipped_lot.lot_number
         FROM manufacturing_lot_shipments shipment LEFT JOIN delivery_notes delivery ON delivery.id=shipment.delivery_id
         LEFT JOIN customers customer ON customer.id=shipment.customer_id
         JOIN manufacturing_lots shipped_lot ON shipped_lot.id=shipment.lot_id
         WHERE shipment.lot_id=$1 OR shipment.lot_id IN (SELECT lot_id FROM lineage)
         ORDER BY shipment.shipped_at`, [lot.id],
      ),
    ]);
    return { lot, sourceLots: ancestors.rows, resultingLots: descendants.rows, deliveries: shipments.rows };
  },

  async listAudit(client, organizationId) {
    return (await client.query('SELECT * FROM manufacturing_audit_trail WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 500', [organizationId])).rows;
  },
};
