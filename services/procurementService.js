import { randomUUID } from 'node:crypto';
import { accountingService } from './accountingService.js';
import { inventoryService } from './inventoryService.js';
import { isValidBusinessCode, isValidEmail, isValidPersonName, isValidPhone } from '../validation.js';

export class ProcurementError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ProcurementError';
    this.status = status;
  }
}

const asPositive = (value, label, allowZero = false) => {
  const number = Number(value);
  if (!Number.isFinite(number) || (allowZero ? number < 0 : number <= 0)) {
    throw new ProcurementError(400, `${label} must be a ${allowZero ? 'non-negative' : 'positive'} number.`);
  }
  return number;
};

const roundedMoney = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

export function calculateQuotationCosts(quantity, quote) {
  const subtotal = roundedMoney(Number(quantity) * Number(quote.unitPrice));
  const taxAmount = roundedMoney(subtotal * Number(quote.taxRate || 0) / 100);
  const shippingCost = Number(quote.shippingCost || 0);
  const otherCost = Number(quote.otherCost || 0);
  return { subtotal, taxAmount, totalCost: roundedMoney(subtotal + taxAmount + shippingCost + otherCost) };
}

async function addHistory(client, organizationId, actorId, entityType, entityId, action, reason, details = {}) {
  await client.query(
    `INSERT INTO procurement_audit_history
       (organization_id, entity_type, entity_id, action, actor_user_id, reason, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [organizationId, entityType, entityId, action, actorId, reason || null, JSON.stringify(details)],
  );
}

export async function getProcurementWorkspace(client, organizationId) {
  const [suppliers, comparisons, quotes, orders, history, requisitions, supplierInvoices, scorecards, supplierDocuments, warehouses] = await Promise.all([
    client.query(
      `SELECT id, supplier_code, name, contact_name, email, phone, payment_terms, notes, active, created_at,
              qualification_status, risk_level
       FROM procurement_suppliers
       WHERE organization_id = $1 AND active = TRUE
       ORDER BY name`,
      [organizationId],
    ),
    client.query(
      `SELECT c.*, u.display_name AS created_by_name
       FROM procurement_comparisons c
       LEFT JOIN users u ON u.id = c.created_by
       WHERE c.organization_id = $1
       ORDER BY c.created_at DESC`,
      [organizationId],
    ),
    client.query(
      `SELECT q.*, s.name AS supplier_name, s.supplier_code
       FROM procurement_supplier_quotes q
       JOIN procurement_suppliers s ON s.id = q.supplier_id
       WHERE q.organization_id = $1
       ORDER BY q.created_at`,
      [organizationId],
    ),
    client.query(
      `SELECT po.*, s.name AS supplier_name, c.title AS comparison_title, c.sku AS comparison_sku,
              c.quantity AS ordered_quantity, q.unit_price, q.tax_rate, q.tax_amount,
              q.shipping_cost, q.other_cost, q.payment_terms, q.delivery_days,
              product.sku AS inventory_product_sku,
              ROUND(c.quantity * q.unit_price + q.tax_amount + q.shipping_cost + q.other_cost, 2) AS total_cost,
              creator.display_name AS created_by_name, approver.display_name AS approved_by_name
       FROM procurement_purchase_orders po
       JOIN procurement_suppliers s ON s.id = po.supplier_id
       JOIN procurement_comparisons c ON c.id = po.comparison_id
       JOIN procurement_supplier_quotes q ON q.id = po.quote_id
       LEFT JOIN inventory_products product ON product.id=po.inventory_product_id AND product.organization_id=po.organization_id
       LEFT JOIN users creator ON creator.id = po.created_by
       LEFT JOIN users approver ON approver.id = po.approved_by
       WHERE po.organization_id = $1
       ORDER BY po.created_at DESC`,
      [organizationId],
    ),
    client.query(
      `SELECT h.*, u.display_name AS actor_name
       FROM procurement_audit_history h
       LEFT JOIN users u ON u.id = h.actor_user_id
       WHERE h.organization_id = $1
       ORDER BY h.occurred_at DESC
       LIMIT 300`,
      [organizationId],
    ),
    client.query('SELECT * FROM procurement_requisitions WHERE organization_id=$1 ORDER BY created_at DESC', [organizationId]),
    client.query(
      `SELECT invoice.*, po.po_number, supplier.name AS supplier_name,
              comparison.quantity AS ordered_quantity, po.received_quantity,
              quote.unit_price, quote.tax_amount, quote.shipping_cost, quote.other_cost,
              comparison.quantity * quote.unit_price + quote.tax_amount + quote.shipping_cost + quote.other_cost AS po_total
       FROM procurement_supplier_invoices invoice
       JOIN procurement_purchase_orders po ON po.id=invoice.purchase_order_id
       JOIN procurement_suppliers supplier ON supplier.id=po.supplier_id
       JOIN procurement_comparisons comparison ON comparison.id=po.comparison_id
       JOIN procurement_supplier_quotes quote ON quote.id=po.quote_id
       WHERE invoice.organization_id=$1 ORDER BY invoice.created_at DESC`, [organizationId],
    ),
    client.query(
      `SELECT supplier.id, supplier.name, supplier.supplier_code, supplier.qualification_status, supplier.risk_level,
              COUNT(DISTINCT po.id)::int AS order_count,
              COALESCE(SUM(CASE WHEN po.status='RECEIVED' THEN 1 ELSE 0 END),0)::int AS completed_orders,
              COALESCE(AVG(CASE WHEN po.status='RECEIVED' AND receipt.last_received_at::date <= po.expected_delivery_date THEN 100.0 ELSE 0.0 END),0) AS on_time_score,
              COALESCE(SUM(comparison.quantity * quote.unit_price + quote.tax_amount + quote.shipping_cost + quote.other_cost),0) AS spend
       FROM procurement_suppliers supplier
       LEFT JOIN procurement_purchase_orders po ON po.supplier_id=supplier.id AND po.organization_id=supplier.organization_id
       LEFT JOIN LATERAL (
         SELECT MAX(received_at) AS last_received_at FROM procurement_purchase_order_receipts receipt
         WHERE receipt.purchase_order_id=po.id AND receipt.organization_id=po.organization_id
       ) receipt ON TRUE
       LEFT JOIN procurement_comparisons comparison ON comparison.id=po.comparison_id
       LEFT JOIN procurement_supplier_quotes quote ON quote.id=po.quote_id
       WHERE supplier.organization_id=$1
       GROUP BY supplier.id ORDER BY spend DESC, supplier.name`, [organizationId],
    ),
    client.query(
       `SELECT document.*, supplier.name AS supplier_name, supplier.supplier_code,
               CASE WHEN document.expiry_date < CURRENT_DATE THEN 'EXPIRED'
                    WHEN document.expiry_date <= CURRENT_DATE + INTERVAL '30 days' THEN 'EXPIRING_SOON'
                    ELSE 'CURRENT' END AS expiry_status
        FROM procurement_supplier_documents document
        JOIN procurement_suppliers supplier ON supplier.id=document.supplier_id
        WHERE document.organization_id=$1
        ORDER BY document.expiry_date NULLS LAST, supplier.name, document.document_name`,
       [organizationId],
    ),
    client.query(
       `SELECT id, code, name FROM inventory_warehouses
        WHERE organization_id=$1 AND active=TRUE ORDER BY name`,
       [organizationId],
    ),
  ]);
  const quotesByComparison = new Map();
  for (const quote of quotes.rows) {
    const list = quotesByComparison.get(quote.comparison_id) || [];
    list.push(quote);
    quotesByComparison.set(quote.comparison_id, list);
  }
  const historyByEntity = new Map();
  for (const event of history.rows) {
    const key = `${event.entity_type}:${event.entity_id}`;
    const list = historyByEntity.get(key) || [];
    list.push(event);
    historyByEntity.set(key, list);
  }
  return {
    suppliers: suppliers.rows,
    comparisons: comparisons.rows.map((comparison) => ({
      ...comparison,
      quotes: quotesByComparison.get(comparison.id) || [],
      history: historyByEntity.get(`COMPARISON:${comparison.id}`) || [],
    })),
    orders: orders.rows.map((order) => ({
      ...order,
      history: historyByEntity.get(`PURCHASE_ORDER:${order.id}`) || [],
    })),
    requisitions: requisitions.rows,
    supplierInvoices: supplierInvoices.rows,
    scorecards: scorecards.rows,
    supplierDocuments: supplierDocuments.rows,
    warehouses: warehouses.rows,
  };
}

export async function createSupplier(client, organizationId, actorId, input) {
  const name = String(input.name || '').trim();
  const supplierCode = String(input.supplierCode || '').trim();
  if (!name || !supplierCode) throw new ProcurementError(400, 'Supplier name and supplier code are required.');
  if (name.length > 180 || !isValidBusinessCode(supplierCode, 60)) throw new ProcurementError(400, 'Supplier name or code has an invalid format.');
  if ((input.contactName && !isValidPersonName(input.contactName)) || !isValidEmail(input.email ?? '')) {
    throw new ProcurementError(400, 'Contact person or email has an invalid format.');
  }
  if (!isValidPhone(input.phone ?? '')) throw new ProcurementError(400, 'Phone must contain 7 to 15 digits and only standard phone characters.');
  const result = await client.query(
    `INSERT INTO procurement_suppliers
       (organization_id, supplier_code, name, contact_name, email, phone, payment_terms, notes, created_by, qualification_status, risk_level)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, supplier_code, name, contact_name, email, phone, payment_terms, notes, active, created_at, qualification_status, risk_level`,
    [organizationId, supplierCode, name, input.contactName || null, input.email || null,
      input.phone || null, input.paymentTerms || null, input.notes || null, actorId,
      ['PENDING', 'QUALIFIED', 'SUSPENDED'].includes(input.qualificationStatus) ? input.qualificationStatus : 'PENDING',
      ['LOW', 'MEDIUM', 'HIGH'].includes(input.riskLevel) ? input.riskLevel : 'MEDIUM'],
  );
  await addHistory(client, organizationId, actorId, 'SUPPLIER', result.rows[0].id, 'SUPPLIER_CREATED');
  return result.rows[0];
}

export async function createSupplierDocument(client, organizationId, actorId, input) {
  const supplierId = String(input.supplierId || '').trim();
  const documentType = String(input.documentType || '').trim();
  const documentName = String(input.documentName || '').trim();
  const referenceUrl = String(input.referenceUrl || '').trim() || null;
  const expiryDate = String(input.expiryDate || '').trim() || null;
  if (!supplierId || !documentType || !documentName) {
    throw new ProcurementError(400, 'Supplier, document type, and document name are required.');
  }
  if (documentType.length > 80 || documentName.length > 180) {
    throw new ProcurementError(400, 'Document type or name exceeds the allowed length.');
  }
  if (expiryDate && (!/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)
    || Number.isNaN(Date.parse(`${expiryDate}T00:00:00Z`))
    || new Date(`${expiryDate}T00:00:00Z`).toISOString().slice(0, 10) !== expiryDate)) {
    throw new ProcurementError(400, 'Expiry date must be a real calendar date in YYYY-MM-DD format.');
  }
  if (referenceUrl) {
    try {
      const parsed = new URL(referenceUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported URL protocol.');
    } catch {
      throw new ProcurementError(400, 'Document reference must be a valid HTTP or HTTPS URL.');
    }
  }
  const result = await client.query(
    `INSERT INTO procurement_supplier_documents
       (organization_id, supplier_id, document_type, document_name, reference_url, expiry_date, created_by)
     SELECT $1, supplier.id, $3, $4, $5, $6, $7
     FROM procurement_suppliers supplier
     WHERE supplier.id=$2 AND supplier.organization_id=$1 AND supplier.active=TRUE
     RETURNING *`,
    [organizationId, supplierId, documentType, documentName, referenceUrl, expiryDate, actorId],
  );
  if (!result.rows[0]) throw new ProcurementError(404, 'Active supplier not found.');
  await addHistory(client, organizationId, actorId, 'SUPPLIER', supplierId, 'SUPPLIER_DOCUMENT_ADDED', null, {
    documentId: result.rows[0].id, documentType, documentName, expiryDate,
  });
  return result.rows[0];
}

export async function createComparison(client, organizationId, actorId, input) {
  const title = String(input.title || '').trim();
  const description = String(input.productDescription || '').trim();
  const currency = String(input.currency || 'ETB').trim().toUpperCase();
  const quantity = asPositive(input.quantity, 'Quantity');
  const quotes = Array.isArray(input.quotes) ? input.quotes : [];
  if (!title || !description) throw new ProcurementError(400, 'Comparison title and product description are required.');
  if (!/^[A-Z]{3}$/.test(currency)) throw new ProcurementError(400, 'Currency must be a valid three-letter currency code.');
  if (title.length > 180 || description.length > 2000) {
    throw new ProcurementError(400, 'Comparison title or product description is too long.');
  }
  if (quotes.length < 2) throw new ProcurementError(400, 'Add quotations from at least two suppliers to compare.');
  const seenSuppliers = new Set();
  const normalizedQuotes = quotes.map((quote) => {
    const supplierId = String(quote.supplierId || '');
    if (!supplierId || seenSuppliers.has(supplierId)) {
      throw new ProcurementError(400, 'Each quote must use a different supplier.');
    }
    seenSuppliers.add(supplierId);
    const unitPrice = asPositive(quote.unitPrice, 'Unit price', true);
    const taxRate = asPositive(quote.taxRate || 0, 'Tax rate', true);
    const deliveryDays = Number(quote.deliveryDays);
    if (!Number.isInteger(deliveryDays) || deliveryDays < 0) {
      throw new ProcurementError(400, 'Delivery days must be a non-negative whole number.');
    }
    if (taxRate > 100) throw new ProcurementError(400, 'Tax rate cannot exceed 100%.');
    const shippingCost = asPositive(quote.shippingCost || 0, 'Shipping cost', true);
    const otherCost = asPositive(quote.otherCost || 0, 'Other cost', true);
    const costs = calculateQuotationCosts(quantity, { unitPrice, taxRate, shippingCost, otherCost });
    const validUntil = quote.validUntil || null;
    if (validUntil && (!/^\d{4}-\d{2}-\d{2}$/.test(validUntil)
      || Number.isNaN(Date.parse(`${validUntil}T00:00:00Z`))
      || new Date(`${validUntil}T00:00:00Z`).toISOString().slice(0, 10) !== validUntil)) {
      throw new ProcurementError(400, 'Quote validity must be a real calendar date.');
    }
    return {
      supplierId, quoteReference: String(quote.quoteReference || '').trim() || null,
      unitPrice, taxRate, ...costs, shippingCost, otherCost, deliveryDays,
      paymentTerms: String(quote.paymentTerms || '').trim(),
      validUntil, notes: String(quote.notes || '').trim() || null,
    };
  });
  if (normalizedQuotes.some((quote) => !quote.paymentTerms)) {
    throw new ProcurementError(400, 'Payment terms are required for every supplier quote.');
  }
  const supplierRows = await client.query(
    `SELECT id FROM procurement_suppliers
     WHERE organization_id = $1 AND active = TRUE AND id = ANY($2::uuid[])`,
    [organizationId, normalizedQuotes.map((quote) => quote.supplierId)],
  );
  if (supplierRows.rowCount !== normalizedQuotes.length) {
    throw new ProcurementError(400, 'One or more suppliers are inactive or not part of this organization.');
  }
  const comparisonResult = await client.query(
    `INSERT INTO procurement_comparisons
       (organization_id, title, product_description, sku, quantity, currency, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [organizationId, title, description, String(input.sku || '').trim() || null,
      quantity, currency, actorId],
  );
  const comparison = comparisonResult.rows[0];
  for (const quote of normalizedQuotes) {
    await client.query(
      `INSERT INTO procurement_supplier_quotes
         (organization_id, comparison_id, supplier_id, quote_reference, unit_price, tax_rate,
          tax_amount, shipping_cost, other_cost, delivery_days, payment_terms, valid_until, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [organizationId, comparison.id, quote.supplierId, quote.quoteReference, quote.unitPrice,
        quote.taxRate, quote.taxAmount, quote.shippingCost, quote.otherCost,
        quote.deliveryDays, quote.paymentTerms, quote.validUntil, quote.notes],
    );
  }
  await addHistory(client, organizationId, actorId, 'COMPARISON', comparison.id, 'COMPARISON_CREATED', null, {
    quoteCount: normalizedQuotes.length,
  });
  return comparison;
}

export async function selectComparisonQuote(client, organizationId, actorId, comparisonId, input) {
  const reason = String(input.reason || '').trim();
  if (!reason) throw new ProcurementError(400, 'Provide a reason for selecting this supplier.');
  const result = await client.query(
    `UPDATE procurement_comparisons c
     SET selected_quote_id = q.id, status = 'SELECTED', selection_reason = $4, updated_at = CURRENT_TIMESTAMP
     FROM procurement_supplier_quotes q
     WHERE c.id = $1 AND c.organization_id = $2 AND c.status = 'OPEN'
       AND q.id = $3 AND q.comparison_id = c.id AND q.organization_id = c.organization_id
     RETURNING c.*`,
    [comparisonId, organizationId, input.quoteId, reason],
  );
  if (!result.rowCount) throw new ProcurementError(404, 'Open comparison or matching quote not found.');
  await addHistory(client, organizationId, actorId, 'COMPARISON', comparisonId, 'SUPPLIER_SELECTED', reason, {
    quoteId: input.quoteId,
  });
  return result.rows[0];
}

export async function createPurchaseOrder(client, organizationId, actorId, comparisonId) {
  const comparisonResult = await client.query(
    `SELECT c.id, c.quantity, c.selected_quote_id, c.status, q.supplier_id, q.delivery_days
     FROM procurement_comparisons c
     JOIN procurement_supplier_quotes q ON q.id = c.selected_quote_id AND q.comparison_id = c.id
     WHERE c.id = $1 AND c.organization_id = $2 AND c.status = 'SELECTED'
     FOR UPDATE OF c`,
    [comparisonId, organizationId],
  );
  if (!comparisonResult.rowCount) throw new ProcurementError(409, 'Select a supplier before creating a purchase order.');
  const comparison = comparisonResult.rows[0];
  const expectedDate = new Date(Date.now() + Number(comparison.delivery_days) * 86_400_000).toISOString().slice(0, 10);
  const poNumber = `PO-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`;
  const inserted = await client.query(
    `INSERT INTO procurement_purchase_orders
       (organization_id, po_number, comparison_id, quote_id, supplier_id, expected_delivery_date, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [organizationId, poNumber, comparison.id, comparison.selected_quote_id,
      comparison.supplier_id, expectedDate, actorId],
  );
  await client.query(
    `UPDATE procurement_comparisons SET status = 'ORDERED', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [comparison.id],
  );
  await addHistory(client, organizationId, actorId, 'PURCHASE_ORDER', inserted.rows[0].id, 'PURCHASE_ORDER_CREATED');
  await addHistory(client, organizationId, actorId, 'COMPARISON', comparison.id, 'PURCHASE_ORDER_CREATED', null, {
    purchaseOrderId: inserted.rows[0].id,
  });
  return inserted.rows[0];
}

export async function decidePurchaseOrder(client, organizationId, actorId, orderId, decision, input) {
  const reason = String(input.reason || '').trim();
  if (!['APPROVED', 'REJECTED'].includes(decision)) throw new ProcurementError(400, 'Invalid purchase order decision.');
  if (decision === 'REJECTED' && !reason) throw new ProcurementError(400, 'A rejection reason is required.');
  const result = await client.query(
    `UPDATE procurement_purchase_orders
     SET status = $3::varchar, approved_by = $4,
         approved_at = CASE WHEN $3::varchar = 'APPROVED' THEN CURRENT_TIMESTAMP ELSE approved_at END,
         rejection_reason = CASE WHEN $3::varchar = 'REJECTED' THEN $5 ELSE NULL END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND organization_id = $2 AND status = 'PENDING_APPROVAL'
     RETURNING *`,
    [orderId, organizationId, decision, actorId, reason || null],
  );
  if (!result.rowCount) throw new ProcurementError(409, 'Only purchase orders awaiting approval can be decided.');
  await addHistory(client, organizationId, actorId, 'PURCHASE_ORDER', orderId, decision, reason);
  return result.rows[0];
}

export async function receivePurchaseOrder(client, organizationId, actorId, orderId, input) {
  const quantity = asPositive(input.quantity, 'Received quantity');
  const reason = String(input.reason || '').trim();
  if (!reason) throw new ProcurementError(400, 'A receipt note is required.');
  const orderResult = await client.query(
    `SELECT po.id, po.status, po.received_quantity, po.inventory_product_id, po.inventory_warehouse_id,
            c.quantity AS ordered_quantity, quote.unit_price,
            product.sku AS inventory_product_sku
     FROM procurement_purchase_orders po
     JOIN procurement_comparisons c ON c.id = po.comparison_id
     JOIN procurement_supplier_quotes quote ON quote.id=po.quote_id
     LEFT JOIN inventory_products product ON product.id=po.inventory_product_id AND product.organization_id=po.organization_id
     WHERE po.id = $1 AND po.organization_id = $2
     FOR UPDATE OF po`,
    [orderId, organizationId],
  );
  if (!orderResult.rowCount) throw new ProcurementError(404, 'Purchase order not found.');
  const order = orderResult.rows[0];
  const idempotencyKey = input.idempotencyKey ? String(input.idempotencyKey).trim() : null;
  if (idempotencyKey && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
    throw new ProcurementError(400, 'idempotencyKey must be a valid UUID.');
  }
  const productSku = String(input.productSku || order.inventory_product_sku || '').trim();
  const warehouseId = String(input.warehouseId || order.inventory_warehouse_id || '').trim();
  if (idempotencyKey) {
    const previousReceipt = (await client.query(
      `SELECT receipt.purchase_order_id, receipt.quantity, receipt.inventory_transaction_id
       FROM procurement_purchase_order_receipts receipt
       WHERE receipt.organization_id=$1 AND receipt.idempotency_key=$2`,
      [organizationId, idempotencyKey],
    )).rows[0];
    if (previousReceipt) {
      if (previousReceipt.purchase_order_id !== orderId) throw new ProcurementError(409, 'This idempotency key was already used for another purchase order.');
      if (Number(previousReceipt.quantity) !== quantity
        || Boolean(previousReceipt.inventory_transaction_id) !== Boolean(productSku && warehouseId)
        || (previousReceipt.inventory_transaction_id
          && (order.inventory_product_sku !== productSku || order.inventory_warehouse_id !== warehouseId))) {
        throw new ProcurementError(409, 'This idempotency key was already used with different receipt details.');
      }
      return { ...order, idempotentReplay: true };
    }
  }
  if (!['APPROVED', 'ORDERED', 'PARTIALLY_RECEIVED'].includes(order.status)) {
    throw new ProcurementError(409, 'Approve the purchase order before receiving stock.');
  }
  let product = null;
  if (productSku || warehouseId) {
    if (!productSku || !warehouseId) {
      throw new ProcurementError(400, 'Choose both the inventory SKU and receiving warehouse for a stock receipt.');
    }
    product = order.inventory_product_id
      ? await inventoryService.getProduct(client, organizationId, order.inventory_product_id)
      : await inventoryService.getProductBySku(client, organizationId, productSku);
    if (!product || !product.active || product.sku !== productSku) {
      throw new ProcurementError(400, 'The inventory SKU must identify an active product in this organization.');
    }
    const warehouse = (await client.query(
      'SELECT id FROM inventory_warehouses WHERE id=$1 AND organization_id=$2 AND active=TRUE',
      [warehouseId, organizationId],
    )).rows[0];
    if (!warehouse) throw new ProcurementError(400, 'The receiving warehouse must be active and belong to this organization.');
    if (order.inventory_warehouse_id && order.inventory_warehouse_id !== warehouseId) {
      throw new ProcurementError(409, 'All receipts for a purchase order must use its original warehouse.');
    }
  }

  const totalReceived = Number(order.received_quantity) + quantity;
  if (totalReceived > Number(order.ordered_quantity)) {
    throw new ProcurementError(400, 'Received quantity cannot exceed the ordered quantity.');
  }
  const status = totalReceived === Number(order.ordered_quantity) ? 'RECEIVED' : 'PARTIALLY_RECEIVED';
  const receipt = (await client.query(
    `INSERT INTO procurement_purchase_order_receipts
       (organization_id, purchase_order_id, quantity, received_by, reason, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [organizationId, orderId, quantity, actorId, reason, idempotencyKey],
  )).rows[0];
  let movement = null;
  let journal = null;
  if (product) {
    movement = await inventoryService.receive(client, organizationId, actorId, {
      productId: product.id,
      warehouseId,
      quantity,
      unitCost: order.unit_price,
      transactionType: 'PURCHASE_RECEIPT',
      referenceType: 'PROCUREMENT_RECEIPT',
      referenceId: receipt.id,
      manageTransaction: false,
    });
    journal = await accountingService.postJournal(client, organizationId, actorId, movement.journal.id);
    if (!journal) throw new ProcurementError(409, 'The inventory receipt journal could not be posted.');
    await client.query(
      `UPDATE procurement_purchase_order_receipts
       SET inventory_transaction_id=$1 WHERE id=$2`,
      [movement.transaction.id, receipt.id],
    );
    await client.query(
      `UPDATE procurement_purchase_orders
       SET inventory_product_id=COALESCE(inventory_product_id,$1),
           inventory_warehouse_id=COALESCE(inventory_warehouse_id,$2)
       WHERE id=$3 AND organization_id=$4`,
      [product.id, warehouseId, orderId, organizationId],
    );
  }
  const updated = await client.query(
    `UPDATE procurement_purchase_orders
     SET received_quantity = $3, status = $4, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND organization_id = $2
     RETURNING *`,
    [orderId, organizationId, totalReceived, status],
  );
  await addHistory(client, organizationId, actorId, 'PURCHASE_ORDER', orderId, 'GOODS_RECEIVED', reason, {
    quantity, totalReceived, orderedQuantity: Number(order.ordered_quantity),
    ...(movement ? {
      inventoryTransactionId: movement.transaction.id,
      inventoryJournalId: journal.id,
      productSku: product.sku,
      warehouseId,
    } : {}),
  });
  return updated.rows[0];
}

export async function createPurchaseRequisition(client, organizationId, actorId, input) {
  const title = String(input.title || '').trim();
  const description = String(input.description || '').trim();
  if (!title || !description) throw new ProcurementError(400, 'Requisition title and description are required.');
  const quantity = asPositive(input.quantity, 'Quantity');
  const estimatedUnitCost = asPositive(input.estimatedUnitCost, 'Estimated unit cost', true);
  const budgetLimit = asPositive(input.budgetLimit, 'Budget limit', true);
  const estimatedTotal = roundedMoney(quantity * estimatedUnitCost);
  if (estimatedTotal > budgetLimit) throw new ProcurementError(409, `Budget validation failed: estimated total ${estimatedTotal} exceeds budget ${budgetLimit}.`);
  const requisitionNumber = `REQ-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`;
  const result = await client.query(
    `INSERT INTO procurement_requisitions
       (organization_id,requisition_number,title,description,quantity,estimated_unit_cost,budget_limit,requested_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [organizationId, requisitionNumber, title, description, quantity, estimatedUnitCost, budgetLimit, actorId],
  );
  await addHistory(client, organizationId, actorId, 'REQUISITION', result.rows[0].id, 'REQUISITION_SUBMITTED', null, { estimatedTotal, budgetLimit });
  return result.rows[0];
}

export async function decidePurchaseRequisition(client, organizationId, actorId, requisitionId, decision, reason) {
  if (!['APPROVED', 'REJECTED'].includes(decision)) throw new ProcurementError(400, 'Decision must be APPROVED or REJECTED.');
  const note = String(reason || '').trim();
  if (!note) throw new ProcurementError(400, 'A decision reason is required.');
  const result = await client.query(
    `UPDATE procurement_requisitions
     SET status=$1, decided_by=$2, decision_reason=$3, updated_at=CURRENT_TIMESTAMP
     WHERE id=$4 AND organization_id=$5 AND status='SUBMITTED' RETURNING *`,
    [decision, actorId, note, requisitionId, organizationId],
  );
  if (!result.rows[0]) throw new ProcurementError(409, 'Only submitted requisitions can be decided.');
  await addHistory(client, organizationId, actorId, 'REQUISITION', requisitionId, decision, note);
  return result.rows[0];
}

export async function createSupplierInvoice(client, organizationId, actorId, input) {
  const purchaseOrderId = String(input.purchaseOrderId || '');
  const invoiceNumber = String(input.supplierInvoiceNumber || '').trim();
  if (!invoiceNumber) throw new ProcurementError(400, 'Supplier invoice number is required.');
  const invoiceQuantity = asPositive(input.invoiceQuantity, 'Invoice quantity');
  const invoiceAmount = asPositive(input.invoiceAmount, 'Invoice amount', true);
  const invoiceDate = input.invoiceDate || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate) || Number.isNaN(Date.parse(`${invoiceDate}T00:00:00Z`))) {
    throw new ProcurementError(400, 'Invoice date must use YYYY-MM-DD.');
  }
  const order = (await client.query(
    `SELECT po.id, po.received_quantity, comparison.quantity AS ordered_quantity,
            comparison.quantity * quote.unit_price + quote.tax_amount + quote.shipping_cost + quote.other_cost AS po_total
     FROM procurement_purchase_orders po
     JOIN procurement_comparisons comparison ON comparison.id=po.comparison_id
     JOIN procurement_supplier_quotes quote ON quote.id=po.quote_id
     WHERE po.id=$1 AND po.organization_id=$2 AND po.status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED','RECEIVED')`,
    [purchaseOrderId, organizationId],
  )).rows[0];
  if (!order) throw new ProcurementError(404, 'Approved purchase order not found.');
  const notes = invoiceQuantity > Number(order.received_quantity)
    ? `Invoice quantity ${invoiceQuantity} exceeds received quantity ${order.received_quantity}.`
    : invoiceAmount > Number(order.po_total) + 0.01
      ? `Invoice amount ${invoiceAmount} exceeds purchase order total ${Number(order.po_total)}.`
      : null;
  const result = await client.query(
    `INSERT INTO procurement_supplier_invoices
       (organization_id,purchase_order_id,supplier_invoice_number,invoice_quantity,invoice_amount,status,match_notes,invoice_date,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [organizationId, purchaseOrderId, invoiceNumber, invoiceQuantity, invoiceAmount, notes ? 'EXCEPTION' : 'PENDING_MATCH',
      notes, invoiceDate, actorId],
  );
  await addHistory(client, organizationId, actorId, 'SUPPLIER_INVOICE', result.rows[0].id, result.rows[0].status, notes, { purchaseOrderId });
  return result.rows[0];
}

export async function matchSupplierInvoice(client, organizationId, actorId, invoiceId) {
  const result = await client.query(
    `UPDATE procurement_supplier_invoices invoice
     SET status=CASE
           WHEN invoice.status='EXCEPTION' THEN 'EXCEPTION'
           WHEN invoice.invoice_quantity <= po.received_quantity
             AND invoice.invoice_quantity <= comparison.quantity
             AND invoice.invoice_amount <= comparison.quantity * quote.unit_price + quote.tax_amount + quote.shipping_cost + quote.other_cost + 0.01
           THEN 'MATCHED' ELSE 'EXCEPTION' END,
         match_notes=CASE
           WHEN invoice.status='EXCEPTION' THEN invoice.match_notes
           WHEN invoice.invoice_quantity > po.received_quantity THEN 'Three-way match failed: invoice quantity exceeds goods received.'
           WHEN invoice.invoice_quantity > comparison.quantity THEN 'Three-way match failed: invoice quantity exceeds purchase order quantity.'
           WHEN invoice.invoice_amount > comparison.quantity * quote.unit_price + quote.tax_amount + quote.shipping_cost + quote.other_cost + 0.01 THEN 'Three-way match failed: invoice amount exceeds purchase order value.'
           ELSE NULL END,
         matched_by=$2, matched_at=CURRENT_TIMESTAMP
     FROM procurement_purchase_orders po
     JOIN procurement_comparisons comparison ON comparison.id=po.comparison_id
     JOIN procurement_supplier_quotes quote ON quote.id=po.quote_id
     WHERE invoice.id=$1 AND invoice.organization_id=$3 AND invoice.purchase_order_id=po.id
       AND invoice.status IN ('PENDING_MATCH','EXCEPTION')
     RETURNING invoice.*`,
    [invoiceId, actorId, organizationId],
  );
  if (!result.rows[0]) throw new ProcurementError(404, 'Supplier invoice not found or already paid.');
  await addHistory(client, organizationId, actorId, 'SUPPLIER_INVOICE', invoiceId, result.rows[0].status, result.rows[0].match_notes);
  return result.rows[0];
}
