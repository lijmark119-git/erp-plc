const TRACE_QUALITY_STATUSES = new Set(['AVAILABLE', 'QUARANTINED', 'DAMAGED', 'RETURNED']);

function positiveAmount(value, field) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`${field} must be a positive number.`);
  return amount;
}

function validateDate(value, field) {
  if (value == null || value === '') return null;
  const parsed = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00Z`)
    : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} must be a valid date in YYYY-MM-DD format.`);
  }
  return value;
}

function validateBarcode(value, field = 'barcode') {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > 128) throw new Error(`${field} must be 128 characters or fewer.`);
  return value.trim();
}

export async function lockInventoryPosition(client, organizationId, productId, warehouseId) {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
    [`${organizationId}:${productId}`, warehouseId],
  );
}

export async function getInventoryAvailableQuantity(client, organizationId, productId, warehouseId, locationId = null) {
  const result = await client.query(
    `SELECT
       COALESCE(SUM(CASE WHEN t.direction = 'IN' THEN t.quantity ELSE -t.quantity END), 0) AS on_hand,
       COALESCE((
         SELECT SUM(r.quantity - r.fulfilled_quantity)
         FROM inventory_stock_reservations r
         WHERE r.organization_id = $1 AND r.product_id = $2 AND r.warehouse_id = $3 AND r.status = 'ACTIVE'
           AND ($4::uuid IS NULL OR r.location_id = $4 OR r.location_id IS NULL)
       ), 0) AS reserved,
       COALESCE((
         SELECT COALESCE(SUM(l.remaining_quantity), 0)
           + COALESCE((
             SELECT COUNT(*)
             FROM inventory_serial_numbers s
             JOIN manufacturing_lots serial_lot ON serial_lot.id = s.lot_id AND serial_lot.organization_id = s.organization_id
             WHERE s.organization_id = $1 AND s.product_id = $2 AND s.warehouse_id = $3
               AND s.status <> 'ISSUED' AND s.status <> 'IN_TRANSIT'
               AND (serial_lot.quality_status <> 'AVAILABLE' OR serial_lot.expiry_date < CURRENT_DATE
                    OR s.status <> 'AVAILABLE')
               AND ($4::uuid IS NULL OR s.location_id = $4)
           ), 0)
         FROM manufacturing_lots l
         WHERE l.organization_id = $1 AND l.product_id = $2 AND l.warehouse_id = $3
           AND ($4::uuid IS NULL OR l.location_id = $4)
           AND l.remaining_quantity > 0
           AND (l.quality_status <> 'AVAILABLE' OR l.expiry_date < CURRENT_DATE)
           AND NOT EXISTS (
             SELECT 1 FROM inventory_serial_numbers s
             WHERE s.organization_id = l.organization_id AND s.lot_id = l.id
           )
       ), 0) AS unavailable
     FROM inventory_stock_transactions t
     WHERE t.organization_id = $1 AND t.product_id = $2 AND t.warehouse_id = $3
       AND ($4::uuid IS NULL OR t.location_id = $4)`,
    [organizationId, productId, warehouseId, locationId],
  );
  const row = result.rows[0];
  return {
    onHand: Number(row.on_hand),
    reserved: Number(row.reserved),
    unavailable: Number(row.unavailable),
    available: Math.max(0, Number(row.on_hand) - Number(row.reserved) - Number(row.unavailable)),
  };
}

export async function createInventoryStockReservation(client, organizationId, actorId, input) {
  const productId = String(input.productId || '').trim();
  const warehouseId = String(input.warehouseId || '').trim();
  if (!productId || !warehouseId) throw new Error('productId and warehouseId are required.');
  const quantity = positiveAmount(input.quantity, 'quantity');
  await lockInventoryPosition(client, organizationId, productId, warehouseId);
  const available = await getInventoryAvailableQuantity(
    client, organizationId, productId, warehouseId, input.locationId || null,
  );
  if (available.available + 0.000001 < quantity) {
    throw new Error(`Insufficient unreserved stock. Available: ${available.available}`);
  }
  const result = await client.query(
    `INSERT INTO inventory_stock_reservations
       (organization_id, product_id, warehouse_id, location_id, reference_type, reference_id,
        quantity, reason, created_by)
     SELECT $1, p.id, w.id, l.id, $5, $6, $7, $8, $9
     FROM inventory_products p
     JOIN inventory_warehouses w ON w.id = $3 AND w.organization_id = p.organization_id
     LEFT JOIN inventory_locations l ON l.id = $4 AND l.warehouse_id = w.id AND l.organization_id = w.organization_id
     WHERE p.id = $2 AND p.organization_id = $1 AND p.active = TRUE
       AND ($4::uuid IS NULL OR l.id IS NOT NULL)
     RETURNING *`,
    [
      organizationId, productId, warehouseId, input.locationId || null,
      input.referenceType ? String(input.referenceType).trim().slice(0, 60) : null,
      input.referenceId ? String(input.referenceId).trim().slice(0, 128) : null,
      quantity, input.reason ? String(input.reason).trim() : null, actorId,
    ],
  );
  if (!result.rows[0]) throw new Error('Inventory product, warehouse, or location was not found.');
  await client.query(
    `INSERT INTO inventory_audit_events
       (organization_id, inventory_entity_type, inventory_entity_id, action, actor_user_id, details)
     VALUES ($1, 'inventory_stock_reservation', $2, 'created', $3, $4::jsonb)`,
    [organizationId, result.rows[0].id, actorId, JSON.stringify({ quantity, productId, warehouseId })],
  );
  return result.rows[0];
}

export async function getInventoryStockReservations(client, organizationId, status = null) {
  const result = await client.query(
    `SELECT r.*, p.sku AS product_sku, p.name AS product_name, u.code AS unit_of_measure_code,
       w.code AS warehouse_code, w.name AS warehouse_name, l.code AS location_code, l.bin_code
     FROM inventory_stock_reservations r
     JOIN inventory_products p ON p.id = r.product_id AND p.organization_id = r.organization_id
     JOIN inventory_uoms u ON u.id = p.unit_of_measure_id
     JOIN inventory_warehouses w ON w.id = r.warehouse_id AND w.organization_id = r.organization_id
     LEFT JOIN inventory_locations l ON l.id = r.location_id AND l.organization_id = r.organization_id
     WHERE r.organization_id = $1 AND ($2::text IS NULL OR r.status = $2)
     ORDER BY r.created_at DESC`,
    [organizationId, status],
  );
  return result.rows;
}

export async function releaseInventoryStockReservation(client, organizationId, actorId, reservationId) {
  const reservation = (await client.query(
    `SELECT * FROM inventory_stock_reservations
     WHERE id = $1 AND organization_id = $2`,
    [reservationId, organizationId],
  )).rows[0];
  if (!reservation || reservation.status !== 'ACTIVE') return null;
  await lockInventoryPosition(client, organizationId, reservation.product_id, reservation.warehouse_id);
  const result = await client.query(
    `UPDATE inventory_stock_reservations SET status = 'RELEASED', released_by = $1, updated_at = CURRENT_TIMESTAMP
     WHERE id = $2 AND organization_id = $3 AND status = 'ACTIVE'
     RETURNING *`,
    [actorId, reservationId, organizationId],
  );
  if (result.rows[0]) {
    await client.query(
      `INSERT INTO inventory_audit_events
         (organization_id, inventory_entity_type, inventory_entity_id, action, actor_user_id, details)
       VALUES ($1, 'inventory_stock_reservation', $2, 'released', $3, '{}'::jsonb)`,
      [organizationId, reservationId, actorId],
    );
  }
  return result.rows[0] ?? null;
}

export async function fulfillInventoryStockReservation(client, organizationId, actorId, reservationId, productId, warehouseId, quantity) {
  const reservation = (await client.query(
    `SELECT * FROM inventory_stock_reservations
     WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
    [reservationId, organizationId],
  )).rows[0];
  if (!reservation || reservation.status !== 'ACTIVE'
    || reservation.product_id !== productId || reservation.warehouse_id !== warehouseId) {
    throw new Error('Active reservation does not match this product and warehouse.');
  }
  const fulfilled = Number(reservation.fulfilled_quantity) + quantity;
  if (fulfilled > Number(reservation.quantity) + 0.000001) throw new Error('Issue quantity exceeds the unfulfilled reservation quantity.');
  const updated = (await client.query(
    `UPDATE inventory_stock_reservations
     SET fulfilled_quantity = $2,
         status = CASE WHEN $2 + 0.000001 >= quantity THEN 'FULFILLED' ELSE 'ACTIVE' END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 RETURNING *`,
    [reservationId, fulfilled],
  )).rows[0];
  await client.query(
    `INSERT INTO inventory_audit_events
       (organization_id, inventory_entity_type, inventory_entity_id, action, actor_user_id, details)
     VALUES ($1, 'inventory_stock_reservation', $2, 'fulfilled', $3, $4::jsonb)`,
    [organizationId, reservationId, actorId, JSON.stringify({ fulfilledQuantity: quantity })],
  );
  return updated;
}

export async function registerInventoryTraceLot(client, organizationId, actorId, input) {
  const transactionId = String(input.inventoryTransactionId || '').trim();
  const lotNumber = String(input.lotNumber || '').trim();
  if (!transactionId || !lotNumber) throw new Error('inventoryTransactionId and lotNumber are required.');
  if (lotNumber.length > 100) throw new Error('lotNumber must be 100 characters or fewer.');
  const receipt = (await client.query(
    `SELECT * FROM inventory_stock_transactions
     WHERE id = $1 AND organization_id = $2 AND direction = 'IN' FOR UPDATE`,
    [transactionId, organizationId],
  )).rows[0];
  if (!receipt) throw new Error('Inventory receipt transaction not found.');
  const product = (await client.query(
    'SELECT product_type FROM inventory_products WHERE id = $1 AND organization_id = $2',
    [receipt.product_id, organizationId],
  )).rows[0];
  if (!product) throw new Error('Inventory product not found.');
  const quantity = positiveAmount(input.quantity ?? receipt.quantity, 'quantity');
  const registered = await client.query(
    'SELECT COALESCE(SUM(quantity), 0) AS quantity FROM manufacturing_lots WHERE source_inventory_transaction_id = $1',
    [transactionId],
  );
  if (quantity + Number(registered.rows[0].quantity) > Number(receipt.quantity) + 0.000001) {
    throw new Error('Registered lots cannot exceed receipt quantity.');
  }
  const expiryDate = validateDate(input.expiryDate, 'expiryDate');
  const warrantyEndDate = validateDate(input.warrantyEndDate, 'warrantyEndDate');
  const qualityStatus = String(input.qualityStatus || 'AVAILABLE').toUpperCase();
  if (!TRACE_QUALITY_STATUSES.has(qualityStatus)) throw new Error('qualityStatus must be AVAILABLE, QUARANTINED, DAMAGED, or RETURNED.');
  const barcode = validateBarcode(input.barcode);
  const lotType = product.product_type === 'FINISHED_GOOD' ? 'FINISHED_GOOD' : 'RAW_MATERIAL';
  const lot = (await client.query(
    `INSERT INTO manufacturing_lots
       (organization_id, product_id, lot_number, lot_type, source_inventory_transaction_id, warehouse_id,
        location_id, quantity, remaining_quantity, unit_cost, production_date, created_by, expiry_date,
        warranty_end_date, barcode, quality_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10::date, $11, $12::date, $13::date, $14, $15)
     RETURNING *`,
    [
      organizationId, receipt.product_id, lotNumber, lotType, receipt.id, receipt.warehouse_id,
      receipt.location_id, quantity, receipt.unit_cost, receipt.transaction_date, actorId,
      expiryDate, warrantyEndDate, barcode, qualityStatus,
    ],
  )).rows[0];
  await client.query(
    `INSERT INTO inventory_audit_events
       (organization_id, inventory_entity_type, inventory_entity_id, action, actor_user_id, details)
     VALUES ($1, 'inventory_lot', $2, 'registered', $3, $4::jsonb)`,
    [organizationId, lot.id, actorId, JSON.stringify({ lotNumber, quantity, expiryDate, qualityStatus })],
  );
  await client.query(
    `INSERT INTO manufacturing_audit_trail (organization_id, actor_user_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, 'inventory_lot_registered', 'lot', $3, $4::jsonb)`,
    [organizationId, actorId, lot.id, JSON.stringify({ lotNumber, quantity })],
  );
  return lot;
}

export async function registerInventorySerialNumbers(client, organizationId, input, lot) {
  const serialNumbers = input.serialNumbers;
  if (serialNumbers == null) return [];
  if (!Array.isArray(serialNumbers) || serialNumbers.length === 0) throw new Error('serialNumbers must be a non-empty array.');
  if (!Number.isInteger(Number(lot.quantity)) || serialNumbers.length !== Number(lot.quantity)) {
    throw new Error('A distinct serial number is required for each whole unit in the lot.');
  }
  const cleaned = serialNumbers.map((value) => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 128) {
      throw new Error('Each serial number must contain 1 to 128 characters.');
    }
    return value.trim();
  });
  if (new Set(cleaned).size !== cleaned.length) throw new Error('Serial numbers must be unique within the receipt.');
  const created = [];
  for (const serialNumber of cleaned) {
    created.push((await client.query(
      `INSERT INTO inventory_serial_numbers
         (organization_id, lot_id, product_id, warehouse_id, location_id, serial_number, barcode, warranty_end_date)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7::date) RETURNING *`,
      [organizationId, lot.id, lot.product_id, lot.warehouse_id, lot.location_id, serialNumber, lot.warranty_end_date],
    )).rows[0]);
  }
  return created;
}

export async function getInventoryTraceLots(client, organizationId) {
  const result = await client.query(
    `SELECT l.*, p.sku AS product_sku, p.name AS product_name, w.code AS warehouse_code,
       w.name AS warehouse_name, loc.code AS location_code, loc.bin_code, loc.zone,
       u.code AS unit_of_measure_code,
       (l.expiry_date IS NOT NULL AND l.expiry_date < CURRENT_DATE) AS expired
     FROM manufacturing_lots l
     JOIN inventory_products p ON p.id = l.product_id AND p.organization_id = l.organization_id
     LEFT JOIN inventory_warehouses w ON w.id = l.warehouse_id AND w.organization_id = l.organization_id
     LEFT JOIN inventory_locations loc ON loc.id = l.location_id AND loc.organization_id = l.organization_id
     JOIN inventory_uoms u ON u.id = p.unit_of_measure_id
     WHERE l.organization_id = $1
     ORDER BY l.created_at DESC`,
    [organizationId],
  );
  return result.rows;
}

export async function getInventorySerialNumbers(client, organizationId) {
  const result = await client.query(
    `SELECT s.*, p.sku AS product_sku, p.name AS product_name, w.code AS warehouse_code,
       l.lot_number, loc.code AS location_code, loc.bin_code,
       transfer.status AS transfer_status
     FROM inventory_serial_numbers s
     JOIN inventory_products p ON p.id = s.product_id AND p.organization_id = s.organization_id
     LEFT JOIN inventory_warehouses w ON w.id = s.warehouse_id AND w.organization_id = s.organization_id
     JOIN manufacturing_lots l ON l.id = s.lot_id AND l.organization_id = s.organization_id
     LEFT JOIN inventory_locations loc ON loc.id = s.location_id AND loc.organization_id = s.organization_id
     LEFT JOIN inventory_transfer_requests transfer ON transfer.id = s.transfer_id AND transfer.organization_id = s.organization_id
     WHERE s.organization_id = $1 ORDER BY s.created_at DESC`,
    [organizationId],
  );
  return result.rows;
}

export async function lookupInventoryTraceCode(client, organizationId, code) {
  const value = String(code || '').trim();
  if (!value || value.length > 128) throw new Error('A scan code of 1 to 128 characters is required.');
  const product = (await client.query(
    `SELECT id, sku, name, barcode FROM inventory_products
     WHERE organization_id = $1 AND barcode = $2`,
    [organizationId, value],
  )).rows[0];
  const serial = (await client.query(
    `SELECT s.*, p.sku AS product_sku, p.name AS product_name, l.lot_number
     FROM inventory_serial_numbers s
     JOIN inventory_products p ON p.id = s.product_id AND p.organization_id = s.organization_id
     JOIN manufacturing_lots l ON l.id = s.lot_id AND l.organization_id = s.organization_id
     WHERE s.organization_id = $1 AND (s.serial_number = $2 OR s.barcode = $2)`,
    [organizationId, value],
  )).rows[0];
  const lot = (await client.query(
    `SELECT l.*, p.sku AS product_sku, p.name AS product_name
     FROM manufacturing_lots l
     JOIN inventory_products p ON p.id = l.product_id AND p.organization_id = l.organization_id
     WHERE l.organization_id = $1 AND (l.lot_number = $2 OR l.barcode = $2)`,
    [organizationId, value],
  )).rows[0];
  const matches = [
    product && { type: 'PRODUCT', ...product },
    serial && { type: 'SERIAL', ...serial },
    lot && { type: 'LOT', ...lot },
  ].filter(Boolean);
  if (matches.length > 1) throw new Error('This scan code matches more than one inventory record. Assign a unique barcode.');
  return matches[0] ?? null;
}

export async function updateInventoryLotQuality(client, organizationId, actorId, lotId, qualityStatus, reason) {
  const status = String(qualityStatus || '').toUpperCase();
  if (!TRACE_QUALITY_STATUSES.has(status)) throw new Error('qualityStatus must be AVAILABLE, QUARANTINED, DAMAGED, or RETURNED.');
  const position = (await client.query(
    `SELECT product_id, warehouse_id FROM manufacturing_lots WHERE id = $1 AND organization_id = $2`,
    [lotId, organizationId],
  )).rows[0];
  if (!position) return null;
  if (position.warehouse_id) {
    await lockInventoryPosition(client, organizationId, position.product_id, position.warehouse_id);
  }
  const lot = (await client.query(
    `UPDATE manufacturing_lots SET quality_status = $1
     WHERE id = $2 AND organization_id = $3
     RETURNING *`,
    [status, lotId, organizationId],
  )).rows[0];
  if (!lot) return null;
  await client.query(
    `UPDATE inventory_serial_numbers SET status = $1, updated_at = CURRENT_TIMESTAMP
     WHERE lot_id = $2 AND organization_id = $3 AND status NOT IN ('ISSUED', 'IN_TRANSIT')`,
    [status, lotId, organizationId],
  );
  await client.query(
    `INSERT INTO inventory_audit_events
       (organization_id, inventory_entity_type, inventory_entity_id, action, actor_user_id, details)
     VALUES ($1, 'inventory_lot', $2, 'quality_disposition', $3, $4::jsonb)`,
    [organizationId, lotId, actorId, JSON.stringify({ qualityStatus: status, reason: reason || null })],
  );
  return lot;
}

export async function issueInventorySerialNumbers(client, organizationId, actorId, input, transaction) {
  let requestedSerials = input.serialNumbers;
  if (requestedSerials == null) {
    const autoSelection = await client.query(
      `SELECT s.serial_number
       FROM inventory_serial_numbers s
       JOIN manufacturing_lots l ON l.id = s.lot_id AND l.organization_id = s.organization_id
       WHERE s.organization_id = $1 AND s.product_id = $2 AND s.warehouse_id = $3
         AND s.status = 'AVAILABLE' AND l.quality_status = 'AVAILABLE'
         AND (l.expiry_date IS NULL OR l.expiry_date >= CURRENT_DATE)
         AND ($5::uuid IS NULL OR s.location_id = $5)
       ORDER BY l.expiry_date NULLS LAST, l.created_at, s.serial_number
       LIMIT $4`,
      [
        organizationId, transaction.product_id, transaction.warehouse_id,
        Math.ceil(Number(transaction.quantity)), input.locationId || null,
      ],
    );
    if (!autoSelection.rowCount) {
      const tracked = await client.query(
        `SELECT 1 FROM inventory_serial_numbers
         WHERE organization_id = $1 AND product_id = $2 LIMIT 1`,
        [organizationId, transaction.product_id],
      );
      if (tracked.rowCount) throw new Error('No available serial numbers remain for this product and warehouse.');
      return [];
    }
    if (!Number.isInteger(Number(transaction.quantity)) || autoSelection.rowCount !== Number(transaction.quantity)) {
      throw new Error('There are not enough available serial numbers to fulfill this issue.');
    }
    requestedSerials = autoSelection.rows.map((serial) => serial.serial_number);
  }
  if (!Array.isArray(requestedSerials) || requestedSerials.length !== Number(transaction.quantity)) {
    throw new Error('Provide one serial number for each whole unit being issued.');
  }
  if (!Number.isInteger(Number(transaction.quantity))) throw new Error('Serial-tracked stock must be issued in whole units.');
  const serials = [...new Set(requestedSerials.map((value) => String(value).trim()))];
  if (serials.length !== requestedSerials.length) throw new Error('Serial numbers must be unique within the issue.');
  const updated = [];
  for (const serialNumber of serials) {
    const serial = (await client.query(
      `UPDATE inventory_serial_numbers SET status = 'ISSUED', issued_by_transaction_id = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE organization_id = $2 AND product_id = $3 AND warehouse_id = $4
         AND serial_number = $5 AND status = 'AVAILABLE'
         AND EXISTS (
           SELECT 1 FROM manufacturing_lots l WHERE l.id = inventory_serial_numbers.lot_id
             AND l.quality_status = 'AVAILABLE'
             AND (l.expiry_date IS NULL OR l.expiry_date >= CURRENT_DATE)
             AND ($6::uuid IS NULL OR inventory_serial_numbers.location_id = $6)
         )
       RETURNING *`,
      [transaction.id, organizationId, transaction.product_id, transaction.warehouse_id, serialNumber, input.locationId || null],
    )).rows[0];
    if (!serial) throw new Error(`Available serial number not found: ${serialNumber}`);
    updated.push(serial);
    const lot = (await client.query(
      `UPDATE manufacturing_lots SET remaining_quantity = remaining_quantity - 1
       WHERE id = $1 AND organization_id = $2 AND remaining_quantity >= 1
       RETURNING id`,
      [serial.lot_id, organizationId],
    )).rows[0];
    if (!lot) throw new Error(`Tracked lot quantity is insufficient for serial number: ${serialNumber}`);
    await client.query(
      `INSERT INTO inventory_audit_events
         (organization_id, inventory_entity_type, inventory_entity_id, action, actor_user_id, details)
       VALUES ($1, 'inventory_serial_number', $2, 'issued', $3, $4::jsonb)`,
      [organizationId, serial.id, actorId, JSON.stringify({ transactionId: transaction.id })],
    );
  }
  return updated;
}

export async function dispatchInventoryTransferSerials(client, organizationId, actorId, transfer) {
  const quantity = Number(transfer.dispatched_quantity ?? transfer.approved_quantity);
  if (!Number.isInteger(quantity)) {
    const tracked = await client.query(
      `SELECT 1 FROM inventory_serial_numbers
       WHERE organization_id = $1 AND product_id = $2 LIMIT 1`,
      [organizationId, transfer.product_id],
    );
    if (tracked.rowCount) throw new Error('Serial-tracked stock must be transferred in whole units.');
    return [];
  }
  const tracked = await client.query(
    `SELECT 1 FROM inventory_serial_numbers
     WHERE organization_id = $1 AND product_id = $2 LIMIT 1`,
    [organizationId, transfer.product_id],
  );
  if (!tracked.rowCount) return [];
  const selected = await client.query(
    `SELECT s.id, s.serial_number, s.lot_id
     FROM inventory_serial_numbers s
     JOIN manufacturing_lots l ON l.id = s.lot_id AND l.organization_id = s.organization_id
     WHERE s.organization_id = $1 AND s.product_id = $2 AND s.warehouse_id = $3
       AND s.status = 'AVAILABLE' AND l.quality_status = 'AVAILABLE'
       AND (l.expiry_date IS NULL OR l.expiry_date >= CURRENT_DATE)
       AND ($5::uuid IS NULL OR s.location_id = $5)
     ORDER BY l.expiry_date NULLS LAST, l.created_at, s.serial_number
     LIMIT $4 FOR UPDATE OF s`,
    [organizationId, transfer.product_id, transfer.source_warehouse_id, quantity, transfer.source_location_id || null],
  );
  if (selected.rowCount !== quantity) throw new Error('There are not enough available serial numbers for this transfer.');
  for (const serial of selected.rows) {
    await client.query(
      `UPDATE inventory_serial_numbers SET status = 'IN_TRANSIT', transfer_id = $1, location_id = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND organization_id = $3`,
      [transfer.id, serial.id, organizationId],
    );
    await client.query(
      `INSERT INTO inventory_audit_events
         (organization_id, inventory_entity_type, inventory_entity_id, action, actor_user_id, details)
       VALUES ($1, 'inventory_serial_number', $2, 'transfer_dispatched', $3, $4::jsonb)`,
      [organizationId, serial.id, actorId, JSON.stringify({ transferId: transfer.id })],
    );
  }
  return selected.rows;
}

export async function receiveInventoryTransferSerials(client, organizationId, actorId, transfer) {
  const inTransit = await client.query(
    `SELECT id, serial_number FROM inventory_serial_numbers
     WHERE organization_id = $1 AND transfer_id = $2 AND status = 'IN_TRANSIT'
     ORDER BY serial_number FOR UPDATE`,
    [organizationId, transfer.id],
  );
  if (!inTransit.rowCount) return [];
  if (!Number.isInteger(Number(transfer.received_quantity))
    || inTransit.rowCount !== Number(transfer.received_quantity)) {
    throw new Error('In-transit serial count does not match the received transfer quantity.');
  }
  for (const serial of inTransit.rows) {
    await client.query(
      `UPDATE inventory_serial_numbers s
       SET status = CASE
             WHEN l.quality_status <> 'AVAILABLE' THEN l.quality_status
             WHEN l.expiry_date < CURRENT_DATE THEN 'QUARANTINED'
             ELSE 'AVAILABLE'
           END,
           warehouse_id = $1, location_id = $2, transfer_id = NULL, updated_at = CURRENT_TIMESTAMP
       FROM manufacturing_lots l
       WHERE s.id = $3 AND s.organization_id = $4 AND l.id = s.lot_id`,
      [transfer.destination_warehouse_id, transfer.destination_location_id || null, serial.id, organizationId],
    );
    await client.query(
      `INSERT INTO inventory_audit_events
         (organization_id, inventory_entity_type, inventory_entity_id, action, actor_user_id, details)
       VALUES ($1, 'inventory_serial_number', $2, 'transfer_received', $3, $4::jsonb)`,
      [organizationId, serial.id, actorId, JSON.stringify({ transferId: transfer.id })],
    );
  }
  return inTransit.rows;
}
