import { randomUUID } from 'node:crypto';

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
  const [suppliers, comparisons, quotes, orders, history] = await Promise.all([
    client.query(
      `SELECT id, supplier_code, name, contact_name, email, phone, payment_terms, notes, active, created_at
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
      `SELECT po.*, s.name AS supplier_name, c.title AS comparison_title,
              c.quantity AS ordered_quantity, q.unit_price, q.tax_rate, q.tax_amount,
              q.shipping_cost, q.other_cost, q.payment_terms, q.delivery_days,
              ROUND(c.quantity * q.unit_price + q.tax_amount + q.shipping_cost + q.other_cost, 2) AS total_cost,
              creator.display_name AS created_by_name, approver.display_name AS approved_by_name
       FROM procurement_purchase_orders po
       JOIN procurement_suppliers s ON s.id = po.supplier_id
       JOIN procurement_comparisons c ON c.id = po.comparison_id
       JOIN procurement_supplier_quotes q ON q.id = po.quote_id
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
  };
}

export async function createSupplier(client, organizationId, actorId, input) {
  const name = String(input.name || '').trim();
  const supplierCode = String(input.supplierCode || '').trim();
  if (!name || !supplierCode) throw new ProcurementError(400, 'Supplier name and supplier code are required.');
  const result = await client.query(
    `INSERT INTO procurement_suppliers
       (organization_id, supplier_code, name, contact_name, email, phone, payment_terms, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, supplier_code, name, contact_name, email, phone, payment_terms, notes, active, created_at`,
    [organizationId, supplierCode, name, input.contactName || null, input.email || null,
      input.phone || null, input.paymentTerms || null, input.notes || null, actorId],
  );
  await addHistory(client, organizationId, actorId, 'SUPPLIER', result.rows[0].id, 'SUPPLIER_CREATED');
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
    `SELECT po.id, po.status, po.received_quantity, c.quantity AS ordered_quantity
     FROM procurement_purchase_orders po
     JOIN procurement_comparisons c ON c.id = po.comparison_id
     WHERE po.id = $1 AND po.organization_id = $2
     FOR UPDATE OF po`,
    [orderId, organizationId],
  );
  if (!orderResult.rowCount) throw new ProcurementError(404, 'Purchase order not found.');
  const order = orderResult.rows[0];
  if (!['APPROVED', 'ORDERED', 'PARTIALLY_RECEIVED'].includes(order.status)) {
    throw new ProcurementError(409, 'Approve the purchase order before receiving stock.');
  }
  const totalReceived = Number(order.received_quantity) + quantity;
  if (totalReceived > Number(order.ordered_quantity)) {
    throw new ProcurementError(400, 'Received quantity cannot exceed the ordered quantity.');
  }
  const status = totalReceived === Number(order.ordered_quantity) ? 'RECEIVED' : 'PARTIALLY_RECEIVED';
  await client.query(
    `INSERT INTO procurement_purchase_order_receipts
       (organization_id, purchase_order_id, quantity, received_by, reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [organizationId, orderId, quantity, actorId, reason],
  );
  const updated = await client.query(
    `UPDATE procurement_purchase_orders
     SET received_quantity = $3, status = $4, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND organization_id = $2
     RETURNING *`,
    [orderId, organizationId, totalReceived, status],
  );
  await addHistory(client, organizationId, actorId, 'PURCHASE_ORDER', orderId, 'GOODS_RECEIVED', reason, {
    quantity, totalReceived, orderedQuantity: Number(order.ordered_quantity),
  });
  return updated.rows[0];
}
