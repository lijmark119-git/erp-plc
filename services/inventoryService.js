import { createAccountingJournal, postAccountingJournal } from '../repositories/accountingRepository.js';
import {
  createInventoryAdjustment,
  createInventoryCountSession,
  createInventoryProduct,
  createInventoryUom,
  createInventoryWarehouse,
  createInventoryLocation,
  createStockTransaction,
  createTransferRequest,
  getInventoryAdjustment,
  getInventoryBalance,
  getInventoryProducts,
  getInventoryProduct,
  getInventoryProductBySku,
  getInventoryWarehouse,
  getInventoryStockTransactions,
  getInventoryTransferRequest,
  getInventoryTransferRequests,
  getInventoryTransferHistory,
  getInventoryStockUnitCost,
  getInventoryReports,
  getInventoryReorderSuggestions,
  getInventoryStockBalance,
  getInventoryUoms,
  getInventoryWarehouses,
  getInventoryLocations,
  getInventoryAuditEvents,
  getInventoryCountSessions,
  getInventoryCountLines,
  getInventoryCountSession,
  approveInventoryCountSession,
  postInventoryCountSession,
  approveTransferRequest,
  rejectTransferRequest,
  dispatchTransferRequest,
  receiveTransferRequest,
  completeTransferRequest,
  cancelTransferRequest,
  createInventoryAdjustment as createAdjustment,
  approveInventoryAdjustment,
  postInventoryAdjustment,
  getInventoryAdjustments,
  createInventoryUomConversion,
  getInventoryUomConversions,
  convertUomQuantity,
  updateInventoryProduct,
  getInventoryProduct as getProduct,
} from '../repositories/inventoryManagementRepository.js';
import {
  createInventoryStockReservation,
  dispatchInventoryTransferSerials,
  fulfillInventoryStockReservation,
  getInventoryAvailableQuantity,
  getInventorySerialNumbers,
  getInventoryStockReservations,
  getInventoryTraceLots,
  issueInventorySerialNumbers,
  lockInventoryPosition,
  lookupInventoryTraceCode,
  registerInventorySerialNumbers,
  registerInventoryTraceLot,
  releaseInventoryStockReservation,
  receiveInventoryTransferSerials,
  updateInventoryLotQuality,
} from '../repositories/inventoryTraceabilityRepository.js';

const ACCOUNT_CODES = {
  receive: ['inventory_account_code', 'grni_account_code'],
  issue: ['cogs_account_code', 'inventory_account_code'],
  productionConsume: ['wip_account_code', 'inventory_account_code'],
  productionComplete: ['finished_goods_account_code', 'wip_account_code'],
};

function toNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error('Quantity must be a positive number.');
  return number;
}

function validateMovement(input) {
  if (!input || typeof input !== 'object') throw new Error('Movement data is required.');
  if (!input.productId || !input.warehouseId || !input.quantity) throw new Error('productId, warehouseId, and quantity are required.');
  if (!['IN', 'OUT'].includes(String(input.direction).toUpperCase())) throw new Error('Direction must be IN or OUT.');
  return { ...input, direction: String(input.direction).toUpperCase() };
}

async function executeAtomicMovement(client, organizationId, actorId, businessOperation, manageTransaction = true) {
  if (!manageTransaction) return businessOperation();
  await client.query('BEGIN');
  try {
    const result = await businessOperation();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function createMovementJournal(client, organizationId, actorId, transaction, product, direction, input) {
  const transactionType = transaction.transaction_type || input.transactionType || (direction === 'IN' ? 'PURCHASE_RECEIPT' : (input.referenceType === 'SALES_DELIVERY' || input.transactionType === 'SALES_DELIVERY' ? 'SALES_DELIVERY' : 'PRODUCTION_CONSUMPTION'));
  const isTransfer = transactionType === 'STOCK_TRANSFER';
  const isProductionConsumption = transactionType === 'PRODUCTION_CONSUMPTION' || input.referenceType === 'MANUFACTURING_ISSUE';
  const isProductionCompletion = transactionType === 'PRODUCTION_COMPLETION';
  const debitCode = isTransfer
    ? product.inventory_account_code
    : isProductionConsumption ? product.wip_account_code
      : isProductionCompletion ? product.finished_goods_account_code
        : direction === 'IN' ? product.inventory_account_code : product.cogs_account_code || product.finished_goods_account_code;
  const creditCode = isTransfer
    ? product.inventory_account_code
    : isProductionCompletion ? product.wip_account_code
      : direction === 'IN' ? product.grni_account_code || product.inventory_account_code : product.inventory_account_code;
  const debitAccount = await client.query('SELECT id FROM accounting_accounts WHERE organization_id = $1 AND account_code = $2 AND active = TRUE', [organizationId, debitCode]);
  const creditAccount = await client.query('SELECT id FROM accounting_accounts WHERE organization_id = $1 AND account_code = $2 AND active = TRUE', [organizationId, creditCode]);
  if (!debitAccount.rows[0] || !creditAccount.rows[0]) throw new Error('Required accounting account is missing or inactive.');
  const amount = Number(transaction.total_cost);
  return createAccountingJournal(client, organizationId, actorId, {
    transactionDate: transaction.transaction_date,
    reference: `INV-${transaction.id}`,
    description: `${transactionType || input.transactionType || 'Inventory movement'}: ${product.sku}`,
    sourceModule: 'inventory',
    sourceTransactionId: transaction.id,
    currency: input.currency || 'ETB',
    status: 'APPROVED',
    lines: [
      { accountId: debitAccount.rows[0].id, debit: amount, credit: 0, description: `${product.name} ${direction === 'IN' ? 'receipt' : 'issue'}` },
      { accountId: creditAccount.rows[0].id, debit: 0, credit: amount, description: `${product.name} ${direction === 'IN' ? 'source' : 'inventory'}` },
    ],
  });
}

async function traceFinishedLotShipment(client, organizationId, transaction, product, input) {
  if (input.transactionType !== 'SALES_DELIVERY') return;
  const delivery = input.referenceId
    ? (await client.query('SELECT id, customer_id FROM delivery_notes WHERE id=$1 AND organization_id=$2', [input.referenceId, organizationId])).rows[0]
    : null;
  let remaining = Number(transaction.quantity);
  const lots = (await client.query(
    `SELECT * FROM manufacturing_lots
     WHERE organization_id=$1 AND product_id=$2 AND warehouse_id=$3 AND lot_type='FINISHED_GOOD'
       AND remaining_quantity>0 ORDER BY production_date, created_at FOR UPDATE`,
    [organizationId, product.id, transaction.warehouse_id],
  )).rows;
  for (const lot of lots) {
    if (remaining <= 0.000001) break;
    const shipped = Math.min(remaining, Number(lot.remaining_quantity));
    await client.query('UPDATE manufacturing_lots SET remaining_quantity=remaining_quantity-$2 WHERE id=$1', [lot.id, shipped]);
    await client.query(
      `INSERT INTO manufacturing_lot_shipments (organization_id, lot_id, inventory_transaction_id, delivery_id, customer_id, quantity)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [organizationId, lot.id, transaction.id, delivery?.id || null, delivery?.customer_id || null, shipped],
    );
    remaining -= shipped;
  }
}

export const inventoryService = {
  async createProduct(client, organizationId, actorId, input) {
    return createInventoryProduct(client, organizationId, actorId, input);
  },
  async updateProduct(client, organizationId, actorId, productId, input) {
    return updateInventoryProduct(client, organizationId, actorId, productId, input);
  },
  async getProducts(client, organizationId, activeOnly = false) {
    return getInventoryProducts(client, organizationId, activeOnly);
  },
  async getProduct(client, organizationId, productId) {
    return getProduct(client, organizationId, productId);
  },
  async getProductBySku(client, organizationId, sku) {
    return getInventoryProductBySku(client, organizationId, sku);
  },
  async createUom(client, organizationId, actorId, input) {
    return createInventoryUom(client, organizationId, actorId, input);
  },
  async getUoms(client, organizationId) {
    return getInventoryUoms(client, organizationId);
  },
  async createWarehouse(client, organizationId, actorId, input) {
    return createInventoryWarehouse(client, organizationId, actorId, input);
  },
  async getWarehouses(client, organizationId) {
    return getInventoryWarehouses(client, organizationId);
  },
  async createLocation(client, organizationId, actorId, input) {
    return createInventoryLocation(client, organizationId, actorId, input);
  },
  async getLocations(client, organizationId, warehouseId) {
    return getInventoryLocations(client, organizationId, warehouseId);
  },
  async receive(client, organizationId, actorId, input) {
    return executeAtomicMovement(client, organizationId, actorId, async () => {
      const movement = validateMovement({ ...input, direction: 'IN' });
      const product = await getInventoryProduct(client, organizationId, movement.productId);
      if (!product || !product.active) throw new Error('Inventory product not found or inactive.');
      const quantity = toNumber(movement.quantity);
      const balance = await getInventoryBalance(client, organizationId, product.id, movement.warehouseId);
      if (balance.quantity < 0) throw new Error('Invalid warehouse balance.');
      const transaction = await createStockTransaction(client, organizationId, actorId, {
        ...movement, quantity, unitCost: movement.unitCost ?? product.standard_cost,
        transactionType: movement.transactionType || 'PURCHASE_RECEIPT',
        referenceType: movement.referenceType || 'PURCHASE_RECEIPT',
        referenceId: movement.referenceId || null,
        transactionDate: movement.transactionDate || new Date(),
      });
      let traceLot = null;
      let serials = [];
      if (movement.traceLotNumber) {
        traceLot = await registerInventoryTraceLot(client, organizationId, actorId, {
          inventoryTransactionId: transaction.id,
          lotNumber: movement.traceLotNumber,
          quantity: movement.traceLotQuantity ?? quantity,
          expiryDate: movement.expiryDate,
          warrantyEndDate: movement.warrantyEndDate,
          barcode: movement.lotBarcode,
          qualityStatus: movement.qualityStatus,
        });
        serials = await registerInventorySerialNumbers(client, organizationId, {
          serialNumbers: movement.serialNumbers,
        }, traceLot);
      } else if (movement.serialNumbers != null || movement.expiryDate || movement.warrantyEndDate
        || movement.lotBarcode || movement.qualityStatus) {
        throw new Error('Lot and serial tracking fields require traceLotNumber.');
      }
      const journal = await createMovementJournal(client, organizationId, actorId, transaction, product, 'IN', movement);
      if (movement.postToLedger) {
        const posted = await postAccountingJournal(client, organizationId, actorId, journal.id);
        if (!posted) throw new Error('Inventory receipt journal could not be posted.');
        return { transaction, journal: { ...journal, ...posted }, lot: traceLot, serials };
      }
      return { transaction, journal, lot: traceLot, serials };
    }, input.manageTransaction !== false);
  },
  async issue(client, organizationId, actorId, input) {
    return executeAtomicMovement(client, organizationId, actorId, async () => {
      const movement = validateMovement({ ...input, direction: 'OUT' });
      const product = await getInventoryProduct(client, organizationId, movement.productId);
      if (!product || !product.active) throw new Error('Inventory product not found or inactive.');
      const quantity = toNumber(movement.quantity);
      const transactionType = movement.transactionType || (movement.referenceType === 'SALES_DELIVERY' ? 'SALES_DELIVERY' : 'PRODUCTION_CONSUMPTION');
      await lockInventoryPosition(client, organizationId, product.id, movement.warehouseId);
      let reservation = null;
      if (movement.reservationId) {
        reservation = (await client.query(
          `SELECT * FROM inventory_stock_reservations
           WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
          [movement.reservationId, organizationId],
        )).rows[0];
      } else if (transactionType === 'SALES_DELIVERY' && movement.referenceId) {
        reservation = (await client.query(
          `SELECT * FROM inventory_stock_reservations
           WHERE organization_id = $1 AND product_id = $2 AND warehouse_id = $3
             AND reference_id = $4 AND reference_type IN ('SALES_DELIVERY', 'SALES_ORDER')
             AND status = 'ACTIVE'
           ORDER BY created_at LIMIT 1 FOR UPDATE`,
          [organizationId, product.id, movement.warehouseId, movement.referenceId],
        )).rows[0];
      }
      if (movement.reservationId && (!reservation || reservation.status !== 'ACTIVE'
        || reservation.product_id !== product.id || reservation.warehouse_id !== movement.warehouseId)) {
        throw new Error('Active reservation does not match this product and warehouse.');
      }
      if (reservation) {
        if (reservation.location_id && movement.locationId && reservation.location_id !== movement.locationId) {
          throw new Error('Issue location does not match the reserved location.');
        }
        movement.locationId = movement.locationId || reservation.location_id;
      }
      const available = await getInventoryAvailableQuantity(
        client, organizationId, product.id, movement.warehouseId, movement.locationId || null,
      );
      if (reservation) {
        const ownReserved = Number(reservation.quantity) - Number(reservation.fulfilled_quantity);
        available.available = Math.max(
          0,
          available.onHand - available.unavailable - Math.max(0, available.reserved - ownReserved),
        );
      }
      if (available.available + 0.000001 < quantity) {
        throw new Error(`Insufficient stock. Available unreserved quantity: ${Math.max(0, available.available)}`);
      }
      const transaction = await createStockTransaction(client, organizationId, actorId, {
        ...movement, quantity, unitCost: movement.unitCost ?? product.standard_cost,
        transactionType,
        referenceType: movement.referenceType || 'MANUFACTURING_ISSUE',
        referenceId: movement.referenceId || null,
        transactionDate: movement.transactionDate || new Date(),
      });
      const serials = await issueInventorySerialNumbers(client, organizationId, actorId, movement, transaction);
      if (reservation) {
        await fulfillInventoryStockReservation(
          client, organizationId, actorId, reservation.id, product.id, movement.warehouseId, quantity,
        );
      }
      await traceFinishedLotShipment(client, organizationId, transaction, product, movement);
      const journal = await createMovementJournal(client, organizationId, actorId, transaction, product, 'OUT', { ...movement, transactionType });
      if (movement.postToLedger) {
        const posted = await postAccountingJournal(client, organizationId, actorId, journal.id);
        if (!posted) throw new Error('Inventory issue journal could not be posted.');
        return { transaction, journal: { ...journal, ...posted }, serials };
      }
      return { transaction, journal, serials };
    }, input.manageTransaction !== false);
  },
  async createTransfer(client, organizationId, actorId, input) {
    return executeAtomicMovement(client, organizationId, actorId, () => createTransferRequest(client, organizationId, actorId, input));
  },
  async approveTransfer(client, organizationId, actorId, transferId, approvedQuantity, reason = null) {
    return executeAtomicMovement(client, organizationId, actorId, () => (
      approveTransferRequest(client, organizationId, actorId, transferId, approvedQuantity, reason)
    ));
  },
  async rejectTransfer(client, organizationId, actorId, transferId, reason) {
    const rejectionReason = String(reason ?? '').trim();
    if (!rejectionReason) throw new Error('A rejection reason is required.');
    return executeAtomicMovement(client, organizationId, actorId, () => (
      rejectTransferRequest(client, organizationId, actorId, transferId, rejectionReason)
    ));
  },
  async dispatchTransfer(client, organizationId, actorId, transferId, reason = null) {
    return executeAtomicMovement(client, organizationId, actorId, async () => {
      const transfer = await getInventoryTransferRequest(client, organizationId, transferId);
      if (!transfer || transfer.status !== 'APPROVED') return null;
      await lockInventoryPosition(client, organizationId, transfer.product_id, transfer.source_warehouse_id);
      const available = await getInventoryAvailableQuantity(
        client, organizationId, transfer.product_id, transfer.source_warehouse_id, transfer.source_location_id || null,
      );
      if (available.available + 0.000001 < Number(transfer.approved_quantity)) {
        throw new Error(`Insufficient unreserved stock for transfer. Available: ${available.available}`);
      }
      const product = await getInventoryProduct(client, organizationId, transfer.product_id);
      const result = await dispatchTransferRequest(client, organizationId, actorId, transferId, reason);
      await dispatchInventoryTransferSerials(client, organizationId, actorId, { ...transfer, ...result });
      const transaction = (await getInventoryStockTransactions(client, organizationId, {
        transactionType: 'STOCK_TRANSFER',
      })).find((row) => row.reference_id === transfer.id && row.direction === 'OUT');
      if (!transaction) throw new Error('Source transfer transaction was not created.');
      const journal = await createMovementJournal(client, organizationId, actorId, transaction, product, 'OUT', { transactionType: 'STOCK_TRANSFER' });
      return { transfer: result, transaction, journal };
    });
  },
  async receiveTransfer(client, organizationId, actorId, transferId, reason = null) {
    return executeAtomicMovement(client, organizationId, actorId, async () => {
      const transfer = await getInventoryTransferRequest(client, organizationId, transferId);
      if (!transfer || transfer.status !== 'DISPATCHED') return null;
      const product = await getInventoryProduct(client, organizationId, transfer.product_id);
      const result = await receiveTransferRequest(client, organizationId, actorId, transferId, reason);
      await receiveInventoryTransferSerials(client, organizationId, actorId, { ...transfer, ...result });
      const transaction = (await getInventoryStockTransactions(client, organizationId, {
        transactionType: 'STOCK_TRANSFER',
      })).find((row) => row.direction === 'IN' && (
        row.transfer_id === transfer.id || row.reference_id.startsWith(`${transfer.id}-RECEIVED`)
      ));
      if (!transaction) throw new Error('Destination transfer transaction was not created.');
      const journal = await createMovementJournal(client, organizationId, actorId, transaction, product, 'IN', { transactionType: 'STOCK_TRANSFER' });
      return { transfer: result, transaction, journal };
    });
  },
  async completeTransfer(client, organizationId, actorId, transferId) {
    return completeTransferRequest(client, organizationId, actorId, transferId);
  },
  async cancelTransfer(client, organizationId, actorId, transferId) {
    return cancelTransferRequest(client, organizationId, actorId, transferId);
  },
  async createAdjustment(client, organizationId, actorId, input) {
    return createAdjustment(client, organizationId, actorId, input);
  },
  async approveAdjustment(client, organizationId, actorId, adjustmentId) {
    return approveInventoryAdjustment(client, organizationId, actorId, adjustmentId);
  },
  async postAdjustment(client, organizationId, actorId, adjustmentId) {
    return executeAtomicMovement(client, organizationId, actorId, async () => {
      const adjustment = await getInventoryAdjustment(client, organizationId, adjustmentId);
      if (!adjustment || adjustment.status !== 'APPROVED') return null;
      const product = await getInventoryProduct(client, organizationId, adjustment.product_id);
      const direction = adjustment.adjustment_type === 'REMOVE' ? 'OUT' : 'IN';
      const result = await postInventoryAdjustment(client, organizationId, actorId, adjustmentId);
      const persistedTransaction = (await getInventoryStockTransactions(client, organizationId, {
        referenceType: 'INVENTORY_ADJUSTMENT',
      })).find((row) => row.reference_id === adjustment.id);
      if (!persistedTransaction) throw new Error('Adjustment stock transaction was not created.');
      const journal = await createMovementJournal(client, organizationId, actorId, persistedTransaction, product, direction, { transactionType: 'STOCK_ADJUSTMENT' });
      return { adjustment: result, transaction: persistedTransaction, journal };
    });
  },
  async createCountSession(client, organizationId, actorId, input) {
    return executeAtomicMovement(client, organizationId, actorId, () => (
      createInventoryCountSession(client, organizationId, actorId, input)
    ));
  },
  async approveCountSession(client, organizationId, actorId, countSessionId) {
    return approveInventoryCountSession(client, organizationId, actorId, countSessionId);
  },
  async postCountSession(client, organizationId, actorId, countSessionId) {
    return executeAtomicMovement(client, organizationId, actorId, async () => {
      const result = await postInventoryCountSession(client, organizationId, actorId, countSessionId);
      if (!result) return null;
      for (const adjustment of result.adjustments) {
        const product = await getInventoryProduct(client, organizationId, adjustment.product_id);
        if (!product) throw new Error('Count adjustment product was not found.');
        await createMovementJournal(client, organizationId, actorId, adjustment, product, adjustment.direction, { transactionType: 'STOCK_ADJUSTMENT' });
      }
      return result;
    });
  },
  async getStockTransactions(client, organizationId, filters) {
    return getInventoryStockTransactions(client, organizationId, filters);
  },
  async getTransfers(client, organizationId, status) {
    return getInventoryTransferRequests(client, organizationId, status);
  },
  async getTransferHistory(client, organizationId, transferId) {
    return getInventoryTransferHistory(client, organizationId, transferId);
  },
  async getStockBalance(client, organizationId, productId, warehouseId) {
    return getInventoryStockBalance(client, organizationId, productId, warehouseId);
  },
  async getReports(client, organizationId, reportType, params) {
    return getInventoryReports(client, organizationId, reportType, params);
  },
  async getReorderSuggestions(client, organizationId) {
    return getInventoryReorderSuggestions(client, organizationId);
  },
  async getAuditEvents(client, organizationId, entityType, entityId) {
    return getInventoryAuditEvents(client, organizationId, entityType, entityId);
  },
  async getCountSessions(client, organizationId, status) {
    return getInventoryCountSessions(client, organizationId, status);
  },
  async getCountLines(client, organizationId, countSessionId) {
    return getInventoryCountLines(client, organizationId, countSessionId);
  },
  async getCountSession(client, organizationId, countSessionId) {
    return getInventoryCountSession(client, organizationId, countSessionId);
  },
  async getAdjustments(client, organizationId, status) {
    return getInventoryAdjustments(client, organizationId, status);
  },
  async getAdjustment(client, organizationId, adjustmentId) {
    return getInventoryAdjustment(client, organizationId, adjustmentId);
  },
  async createUomConversion(client, organizationId, actorId, input) {
    return createInventoryUomConversion(client, organizationId, actorId, input);
  },
  async getUomConversions(client, organizationId) {
    return getInventoryUomConversions(client, organizationId);
  },
  async convertUom(client, organizationId, fromUomId, toUomId, quantity) {
    return convertUomQuantity(client, organizationId, fromUomId, toUomId, quantity);
  },
  async reserveStock(client, organizationId, actorId, input) {
    return executeAtomicMovement(client, organizationId, actorId, () => (
      createInventoryStockReservation(client, organizationId, actorId, input)
    ));
  },
  async getStockReservations(client, organizationId, status = null) {
    return getInventoryStockReservations(client, organizationId, status);
  },
  async releaseStockReservation(client, organizationId, actorId, reservationId) {
    return executeAtomicMovement(client, organizationId, actorId, () => (
      releaseInventoryStockReservation(client, organizationId, actorId, reservationId)
    ));
  },
  async getTraceLots(client, organizationId) {
    return getInventoryTraceLots(client, organizationId);
  },
  async getSerialNumbers(client, organizationId) {
    return getInventorySerialNumbers(client, organizationId);
  },
  async lookupTraceCode(client, organizationId, code) {
    return lookupInventoryTraceCode(client, organizationId, code);
  },
  async updateLotQuality(client, organizationId, actorId, lotId, input) {
    return executeAtomicMovement(client, organizationId, actorId, async () => (
      updateInventoryLotQuality(client, organizationId, actorId, lotId, input.qualityStatus, input.reason)
    ));
  },
};
