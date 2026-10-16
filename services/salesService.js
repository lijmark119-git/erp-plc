import { randomUUID } from 'node:crypto';
import { accountingService } from './accountingService.js';
import { inventoryService } from './inventoryService.js';

const quoteStatuses = new Set(['Draft', 'Submitted', 'Approved', 'Rejected', 'Expired', 'Converted']);
const paymentMethods = new Set(['cash', 'bank', 'transfer', 'cheque', 'other']);

export class SalesError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function money(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function requiredText(value, field) {
  const result = String(value ?? '').trim();
  if (!result) throw new SalesError(400, `${field} is required.`);
  return result;
}

function amount(value, field, { min = 0, max = 100 } = {}) {
  const result = Number(value ?? 0);
  if (!Number.isFinite(result) || result < min || result > max) {
    throw new SalesError(400, `${field} must be between ${min} and ${max}.`);
  }
  return result;
}

function dateValue(value, field, optional = false) {
  if (optional && !value) return null;
  if (!value || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new SalesError(400, `${field} must be a valid date.`);
  return value;
}

async function audit(client, organizationId, actorId, action, entityType, entityId, changes = {}) {
  await client.query(
    `INSERT INTO sales_audit_trail (organization_id, action, entity_type, entity_id, user_id, changes)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [organizationId, action, entityType, entityId, actorId, JSON.stringify(changes)],
  );
}

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

async function ensureCustomer(client, organizationId, customerId) {
  const result = await client.query(
    'SELECT * FROM customers WHERE id = $1 AND organization_id = $2 AND active = TRUE',
    [customerId, organizationId],
  );
  if (!result.rows[0]) throw new SalesError(404, 'Active customer not found.');
  return result.rows[0];
}

async function lockCustomer(client, organizationId, customerId) {
  const result = await client.query(
    'SELECT * FROM customers WHERE id = $1 AND organization_id = $2 AND active = TRUE FOR UPDATE',
    [customerId, organizationId],
  );
  if (!result.rows[0]) throw new SalesError(404, 'Active customer not found.');
  return result.rows[0];
}

async function assertCreditAvailable(client, organizationId, customer, orderTotal, excludeOrderId = null) {
  if (customer.credit_hold) {
    throw new SalesError(409, `Customer is on credit hold${customer.credit_hold_reason ? `: ${customer.credit_hold_reason}` : '.'}`);
  }
  const exposure = await client.query(
    `SELECT
       COALESCE((
         SELECT SUM(ar.outstanding)
         FROM accounts_receivable ar
         WHERE ar.organization_id = $1 AND ar.customer_id = $2 AND ar.outstanding > 0
       ), 0)
       + COALESCE((
         SELECT SUM(GREATEST(0, so.total - COALESCE(invoiced.total, 0)))
         FROM sales_orders so
         LEFT JOIN (
           SELECT sales_order_id, SUM(total) AS total
           FROM customer_invoices
           WHERE organization_id = $1 AND status IN ('Issued', 'Paid', 'Overdue')
           GROUP BY sales_order_id
         ) invoiced ON invoiced.sales_order_id = so.id
         WHERE so.organization_id = $1 AND so.customer_id = $2
           AND so.status IN ('Draft', 'Submitted', 'Approved')
           AND ($3::uuid IS NULL OR so.id <> $3::uuid)
       ), 0) AS amount`,
    [organizationId, customer.id, excludeOrderId],
  );
  const currentExposure = Number(exposure.rows[0].amount);
  const proposedExposure = money(currentExposure + Number(orderTotal));
  const creditLimit = Number(customer.credit_limit || 0);
  if (proposedExposure > creditLimit) {
    throw new SalesError(409, `Customer credit limit exceeded. Current exposure is ${money(currentExposure)} and the order would raise it to ${proposedExposure}, above the approved limit of ${money(creditLimit)}.`);
  }
}

function calculateLines(inputLines, orderDiscountPercent = 0) {
  if (!Array.isArray(inputLines) || inputLines.length === 0) throw new SalesError(400, 'At least one sales line is required.');
  const normalized = inputLines.map((line) => {
    const productSku = requiredText(line.productSku ?? line.product_sku, 'productSku');
    const productName = requiredText(line.productName ?? line.product_name, 'productName');
    const quantity = amount(line.quantity, 'quantity', { min: 0.000001, max: Number.MAX_SAFE_INTEGER });
    const unitPrice = amount(line.unitPrice ?? line.unit_price, 'unitPrice', { min: 0, max: Number.MAX_SAFE_INTEGER });
    const discountPercent = amount(line.discountPercent ?? line.discount_percent, 'discountPercent');
    const taxPercent = amount(line.taxPercent ?? line.tax_percent, 'taxPercent');
    return { productSku, productName, quantity, unitPrice, discountPercent, taxPercent };
  });
  const subtotal = normalized.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
  const lineDiscount = normalized.reduce((sum, line) => sum + line.quantity * line.unitPrice * line.discountPercent / 100, 0);
  const orderDiscount = amount(orderDiscountPercent, 'discountPercent') * Math.max(0, subtotal - lineDiscount) / 100;
  const taxableAfterLineDiscount = Math.max(0, subtotal - lineDiscount - orderDiscount);
  const taxBase = Math.max(0, subtotal - lineDiscount);
  const lines = normalized.map((line) => {
    const gross = line.quantity * line.unitPrice;
    const discount = gross * line.discountPercent / 100 + (taxBase ? orderDiscount * (gross * (1 - line.discountPercent / 100)) / taxBase : 0);
    const lineTax = Math.max(0, gross - discount) * line.taxPercent / 100;
    return { ...line, lineTotal: money(gross - discount + lineTax), _discount: discount, _tax: lineTax };
  });
  const discountAmount = lineDiscount + orderDiscount;
  const taxAmount = lines.reduce((sum, line) => sum + line._tax, 0);
  return {
    lines,
    subtotal: money(subtotal),
    discountAmount: money(discountAmount),
    discountPercent: subtotal ? money(discountAmount / subtotal * 100) : 0,
    taxAmount: money(taxAmount),
    total: money(taxableAfterLineDiscount + taxAmount),
  };
}

async function insertLines(client, table, foreignKey, parentId, lines) {
  const inserted = [];
  for (const line of lines) {
    const result = await client.query(
      `INSERT INTO ${table} (${foreignKey}, product_sku, product_name, quantity, unit_price, discount_percent, tax_percent, line_total)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [parentId, line.productSku, line.productName, line.quantity, line.unitPrice, line.discountPercent, line.taxPercent, line.lineTotal],
    );
    inserted.push(result.rows[0]);
  }
  return inserted;
}

async function accountId(client, organizationId, code) {
  const result = await client.query(
    'SELECT id FROM accounting_accounts WHERE organization_id = $1 AND account_code = $2 AND active = TRUE',
    [organizationId, code],
  );
  if (!result.rows[0]) throw new Error(`Sales accounting account ${code} is missing or inactive.`);
  return result.rows[0].id;
}

async function postSalesJournal(client, organizationId, actorId, { date, reference, description, sourceId, currency, debitCode, debitAmount, credits }) {
  const lines = [];
  const debit = money(debitAmount);
  if (debit > 0) lines.push({ accountId: await accountId(client, organizationId, debitCode), debit, credit: 0, description });
  for (const credit of credits) {
    const creditAmount = money(credit.amount);
    if (creditAmount > 0) lines.push({
      accountId: await accountId(client, organizationId, credit.code),
      debit: 0,
      credit: creditAmount,
      description: credit.description,
    });
  }
  if (lines.length < 2) throw new SalesError(400, 'A sales journal requires a non-zero debit and credit.');
  const journal = await accountingService.createJournal(client, organizationId, actorId, {
    transactionDate: date,
    reference,
    description,
    sourceModule: 'sales',
    sourceTransactionId: sourceId,
    currency: currency || 'ETB',
    status: 'SUBMITTED',
    lines,
  });
  await accountingService.approveJournal(client, organizationId, actorId, journal.id);
  const posted = await accountingService.postJournal(client, organizationId, actorId, journal.id);
  if (!posted) throw new Error(`Sales journal ${journal.journal_number} could not be posted.`);
  return posted;
}

async function getLines(client, table, foreignKey, parentId) {
  const result = await client.query(`SELECT * FROM ${table} WHERE ${foreignKey} = $1 ORDER BY created_at, id`, [parentId]);
  return result.rows;
}

export const salesService = {
  async listWarehouses(client, organizationId) {
    return (await client.query(
      'SELECT id, code, name FROM inventory_warehouses WHERE organization_id=$1 AND active=TRUE ORDER BY name',
      [organizationId],
    )).rows;
  },

  async listCustomers(client, organizationId) {
    const result = await client.query('SELECT * FROM customers WHERE organization_id = $1 ORDER BY legal_name', [organizationId]);
    return result.rows;
  },

  async createCustomer(client, organizationId, actorId, input) {
    const customerCode = requiredText(input.customerCode ?? input.customer_code, 'customerCode');
    const legalName = requiredText(input.legalName ?? input.legal_name, 'legalName');
    const creditLimit = amount(input.creditLimit ?? input.credit_limit, 'creditLimit', { max: Number.MAX_SAFE_INTEGER });
    return transaction(client, async () => {
      const result = await client.query(
        `INSERT INTO customers (organization_id, customer_code, legal_name, contact_person, phone, email, tax_id, credit_limit, payment_terms, currency, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [organizationId, customerCode, legalName, input.contactPerson ?? input.contact_person ?? null,
          input.phone || null, input.email || null, input.taxId ?? input.tax_id ?? null, creditLimit,
          input.paymentTerms ?? input.payment_terms ?? '30 days', input.currency || 'ETB', input.active !== false],
      );
      const customer = result.rows[0];
      for (const address of input.addresses || []) await this.addAddress(client, organizationId, actorId, customer.id, address, false);
      await audit(client, organizationId, actorId, 'customer_created', 'customer', customer.id, { customerCode });
      return customer;
    });
  },

  async updateCustomer(client, organizationId, actorId, customerId, input) {
    const fields = {
      customer_code: input.customerCode ?? input.customer_code,
      legal_name: input.legalName ?? input.legal_name,
      contact_person: input.contactPerson ?? input.contact_person,
      phone: input.phone,
      email: input.email,
      tax_id: input.taxId ?? input.tax_id,
      credit_limit: input.creditLimit ?? input.credit_limit,
      payment_terms: input.paymentTerms ?? input.payment_terms,
      currency: input.currency,
      active: input.active,
    };
    const assignments = [];
    const values = [customerId, organizationId];
    for (const [field, value] of Object.entries(fields)) if (value !== undefined) {
      if (field === 'credit_limit') amount(value, field, { max: Number.MAX_SAFE_INTEGER });
      values.push(value);
      assignments.push(`${field} = $${values.length}`);
    }
    if (!assignments.length) throw new SalesError(400, 'At least one customer field is required.');
    const result = await client.query(
      `UPDATE customers SET ${assignments.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND organization_id = $2 RETURNING *`,
      values,
    );
    if (!result.rows[0]) throw new SalesError(404, 'Customer not found.');
    await audit(client, organizationId, actorId, 'customer_updated', 'customer', customerId, fields);
    return result.rows[0];
  },

  async setCustomerCreditHold(client, organizationId, actorId, customerId, reason) {
    const holdReason = requiredText(reason, 'reason');
    return transaction(client, async () => {
      const customer = await lockCustomer(client, organizationId, customerId);
      if (customer.credit_hold) throw new SalesError(409, 'Customer is already on credit hold.');
      const updated = (await client.query(
        `UPDATE customers
         SET credit_hold = TRUE, credit_hold_reason = $1, credit_hold_by = $2,
             credit_hold_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3 AND organization_id = $4 RETURNING *`,
        [holdReason, actorId, customerId, organizationId],
      )).rows[0];
      await audit(client, organizationId, actorId, 'customer_credit_hold_placed', 'customer', customerId, { reason: holdReason });
      return updated;
    });
  },

  async releaseCustomerCreditHold(client, organizationId, actorId, customerId, reason) {
    const releaseReason = requiredText(reason, 'reason');
    return transaction(client, async () => {
      const customer = await lockCustomer(client, organizationId, customerId);
      if (!customer.credit_hold) throw new SalesError(409, 'Customer is not on credit hold.');
      const updated = (await client.query(
        `UPDATE customers
         SET credit_hold = FALSE, credit_hold_reason = NULL, credit_hold_by = NULL,
             credit_hold_at = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND organization_id = $2 RETURNING *`,
        [customerId, organizationId],
      )).rows[0];
      await audit(client, organizationId, actorId, 'customer_credit_hold_released', 'customer', customerId, {
        reason: releaseReason,
        previousHoldReason: customer.credit_hold_reason,
      });
      return updated;
    });
  },

  async listAddresses(client, organizationId, customerId) {
    await ensureCustomer(client, organizationId, customerId);
    const result = await client.query(
      `SELECT a.* FROM customer_addresses a JOIN customers c ON c.id = a.customer_id
       WHERE a.customer_id = $1 AND c.organization_id = $2 ORDER BY a.is_primary DESC, a.address_type`,
      [customerId, organizationId],
    );
    return result.rows;
  },

  async addAddress(client, organizationId, actorId, customerId, input, writeAudit = true) {
    await ensureCustomer(client, organizationId, customerId);
    const addressType = requiredText(input.addressType ?? input.address_type, 'addressType').toLowerCase();
    if (!['billing', 'shipping', 'delivery'].includes(addressType)) throw new SalesError(400, 'addressType must be billing, shipping, or delivery.');
    const addressLine = requiredText(input.addressLine ?? input.address_line, 'addressLine');
    const result = await client.query(
      `INSERT INTO customer_addresses (customer_id, address_type, address_line, city, region, postal_code, country, is_primary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [customerId, addressType, addressLine, input.city || null, input.region || null, input.postalCode ?? input.postal_code ?? null, input.country || 'Ethiopia', input.isPrimary === true || input.is_primary === true],
    );
    if (writeAudit) await audit(client, organizationId, actorId, 'customer_address_created', 'customer', customerId, { addressId: result.rows[0].id, addressType });
    return result.rows[0];
  },

  async listQuotations(client, organizationId) {
    const result = await client.query(
      `SELECT q.*, c.legal_name AS customer_name FROM quotations q JOIN customers c ON c.id = q.customer_id
       WHERE q.organization_id = $1 ORDER BY q.created_at DESC`, [organizationId],
    );
    return result.rows;
  },

  async createQuotation(client, organizationId, actorId, input) {
    const customer = await ensureCustomer(client, organizationId, input.customerId ?? input.customer_id);
    const validityDate = dateValue(input.validityDate ?? input.validity_date, 'validityDate');
    const totals = calculateLines(input.lines, input.discountPercent ?? 0);
    return transaction(client, async () => {
      const number = input.quotationNumber || `QT-${Date.now()}-${randomUUID().slice(0, 6)}`;
      const result = await client.query(
        `INSERT INTO quotations (quotation_number, customer_id, created_by, quotation_date, validity_date, status, subtotal, discount_amount, discount_percent, tax_amount, total, notes, terms, organization_id)
         VALUES ($1, $2, $3, CURRENT_DATE, $4, 'Draft', $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [number, customer.id, actorId, validityDate, totals.subtotal, totals.discountAmount, totals.discountPercent, totals.taxAmount, totals.total, input.notes || null, input.terms || null, organizationId],
      );
      const quote = result.rows[0];
      const lines = await insertLines(client, 'quotation_lines', 'quotation_id', quote.id, totals.lines);
      await audit(client, organizationId, actorId, 'quotation_created', 'quotation', quote.id, { quotationNumber: number, total: totals.total });
      return { ...quote, lines };
    });
  },

  async decideQuotation(client, organizationId, actorId, quotationId, status) {
    if (!['Submitted', 'Approved', 'Rejected', 'Expired'].includes(status) || !quoteStatuses.has(status)) throw new SalesError(400, 'Invalid quotation status.');
    const quote = (await client.query('SELECT * FROM quotations WHERE id = $1 AND organization_id = $2 FOR UPDATE', [quotationId, organizationId])).rows[0];
    if (!quote) throw new SalesError(404, 'Quotation not found.');
    const allowed = status === 'Submitted' ? quote.status === 'Draft' : quote.status === 'Submitted';
    if (!allowed || quote.status === 'Converted') throw new SalesError(409, `Quotation cannot move from ${quote.status} to ${status}.`);
    if (status === 'Approved' && quote.validity_date < new Date().toISOString().slice(0, 10)) throw new SalesError(409, 'Quotation has expired.');
    const result = await client.query('UPDATE quotations SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *', [status, quotationId]);
    await audit(client, organizationId, actorId, `quotation_${status.toLowerCase()}`, 'quotation', quotationId);
    return result.rows[0];
  },

  async convertQuotation(client, organizationId, actorId, quotationId, input = {}) {
    return transaction(client, async () => {
      const quote = (await client.query('SELECT * FROM quotations WHERE id = $1 AND organization_id = $2 FOR UPDATE', [quotationId, organizationId])).rows[0];
      if (!quote) throw new SalesError(404, 'Quotation not found.');
      if (quote.status !== 'Approved') throw new SalesError(409, 'Only approved quotations can be converted.');
      if (quote.validity_date < new Date().toISOString().slice(0, 10)) throw new SalesError(409, 'Quotation has expired.');
      const customer = await lockCustomer(client, organizationId, quote.customer_id);
      await assertCreditAvailable(client, organizationId, customer, quote.total);
      const lines = await getLines(client, 'quotation_lines', 'quotation_id', quote.id);
      const number = input.orderNumber || `SO-${Date.now()}-${randomUUID().slice(0, 6)}`;
      const result = await client.query(
        `INSERT INTO sales_orders (order_number, customer_id, quotation_id, created_by, delivery_date, status, approval_status, subtotal, discount_amount, discount_percent, tax_amount, total, payment_terms, organization_id)
         VALUES ($1, $2, $3, $4, $5, 'Draft', 'Pending', $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [number, quote.customer_id, quote.id, actorId, dateValue(input.deliveryDate ?? input.delivery_date, 'deliveryDate', true), quote.subtotal, quote.discount_amount, quote.discount_percent, quote.tax_amount, quote.total, input.paymentTerms || '30 days', organizationId],
      );
      const order = result.rows[0];
      for (const line of lines) await client.query(
        `INSERT INTO sales_order_lines (sales_order_id, product_sku, product_name, quantity, unit_price, discount_percent, tax_percent, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [order.id, line.product_sku, line.product_name, line.quantity, line.unit_price, line.discount_percent, line.tax_percent, line.line_total],
      );
      await client.query("UPDATE quotations SET status = 'Converted', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [quote.id]);
      await audit(client, organizationId, actorId, 'quotation_converted', 'quotation', quote.id, { orderId: order.id });
      return { ...order, lines };
    });
  },

  async listOrders(client, organizationId) {
    const result = await client.query(
      `SELECT so.*, c.legal_name AS customer_name FROM sales_orders so JOIN customers c ON c.id = so.customer_id
       WHERE so.organization_id = $1 ORDER BY so.created_at DESC`, [organizationId],
    );
    return result.rows;
  },

  async createOrder(client, organizationId, actorId, input) {
    const totals = calculateLines(input.lines, input.discountPercent ?? 0);
    return transaction(client, async () => {
      const customer = await lockCustomer(client, organizationId, input.customerId ?? input.customer_id);
      await assertCreditAvailable(client, organizationId, customer, totals.total);
      const number = input.orderNumber || `SO-${Date.now()}-${randomUUID().slice(0, 6)}`;
      const result = await client.query(
        `INSERT INTO sales_orders (order_number, customer_id, created_by, delivery_date, status, approval_status, subtotal, discount_amount, discount_percent, tax_amount, total, payment_terms, organization_id)
         VALUES ($1, $2, $3, $4, 'Draft', 'Pending', $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [number, customer.id, actorId, dateValue(input.deliveryDate ?? input.delivery_date, 'deliveryDate', true), totals.subtotal, totals.discountAmount, totals.discountPercent, totals.taxAmount, totals.total, input.paymentTerms ?? input.payment_terms ?? customer.payment_terms, organizationId],
      );
      const order = result.rows[0];
      const lines = await insertLines(client, 'sales_order_lines', 'sales_order_id', order.id, totals.lines);
      await audit(client, organizationId, actorId, 'sales_order_created', 'sales_order', order.id, { orderNumber: number, total: totals.total });
      return { ...order, lines };
    });
  },

  async submitOrder(client, organizationId, actorId, orderId) {
    return transaction(client, async () => {
      const order = (await client.query('SELECT * FROM sales_orders WHERE id = $1 AND organization_id = $2 FOR UPDATE', [orderId, organizationId])).rows[0];
      if (!order) throw new SalesError(404, 'Sales order not found.');
      if (order.status !== 'Draft') throw new SalesError(409, 'Only draft orders can be submitted.');
      const customer = await lockCustomer(client, organizationId, order.customer_id);
      await assertCreditAvailable(client, organizationId, customer, order.total, order.id);
      const updated = (await client.query("UPDATE sales_orders SET status='Submitted', updated_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *", [orderId])).rows[0];
      await audit(client, organizationId, actorId, 'sales_order_submitted', 'sales_order', orderId);
      return updated;
    });
  },

  async decideOrder(client, organizationId, actorId, orderId, decision) {
    if (!['Approved', 'Rejected'].includes(decision)) throw new SalesError(400, 'Decision must be Approved or Rejected.');
    const order = (await client.query('SELECT * FROM sales_orders WHERE id = $1 AND organization_id = $2 FOR UPDATE', [orderId, organizationId])).rows[0];
    if (!order) throw new SalesError(404, 'Sales order not found.');
    if (order.status !== 'Submitted' || order.approval_status !== 'Pending') throw new SalesError(409, 'Only submitted orders awaiting approval can be decided.');
    if (decision === 'Approved') {
      const customer = await lockCustomer(client, organizationId, order.customer_id);
      await assertCreditAvailable(client, organizationId, customer, order.total, order.id);
    }
    const status = decision === 'Approved' ? 'Approved' : 'Rejected';
    const updated = (await client.query('UPDATE sales_orders SET status=$1, approval_status=$1, approved_by=$2, updated_at=CURRENT_TIMESTAMP WHERE id=$3 RETURNING *', [status, actorId, orderId])).rows[0];
    await audit(client, organizationId, actorId, `sales_order_${status.toLowerCase()}`, 'sales_order', orderId);
    return updated;
  },

  async listDeliveries(client, organizationId) {
    return (await client.query(
      `SELECT d.*, c.legal_name AS customer_name, so.order_number FROM delivery_notes d
       JOIN customers c ON c.id=d.customer_id JOIN sales_orders so ON so.id=d.sales_order_id
       WHERE d.organization_id=$1 ORDER BY d.created_at DESC`, [organizationId],
    )).rows;
  },

  async createDelivery(client, organizationId, actorId, input) {
    const order = (await client.query('SELECT * FROM sales_orders WHERE id=$1 AND organization_id=$2', [input.orderId ?? input.salesOrderId ?? input.sales_order_id, organizationId])).rows[0];
    if (!order || order.status !== 'Approved' || order.approval_status !== 'Approved') throw new SalesError(409, 'Delivery requires an approved sales order.');
    const orderLines = await getLines(client, 'sales_order_lines', 'sales_order_id', order.id);
    if (!orderLines.length) throw new SalesError(409, 'Sales order has no lines.');
    const warehouseId = requiredText(input.warehouseId ?? input.warehouse_id, 'warehouseId');
    const result = await client.query(
      `INSERT INTO delivery_notes (delivery_number, sales_order_id, customer_id, delivery_date, status, warehouse_id, carrier, tracking_number, notes, organization_id)
       VALUES ($1,$2,$3,$4,'Pending',$5,$6,$7,$8,$9) RETURNING *`,
      [input.deliveryNumber || `DN-${Date.now()}-${randomUUID().slice(0, 6)}`, order.id, order.customer_id,
        dateValue(input.deliveryDate ?? input.delivery_date, 'deliveryDate', true) || new Date().toISOString().slice(0, 10), warehouseId,
        input.carrier || null, input.trackingNumber || null, input.notes || null, organizationId],
    );
    const delivery = result.rows[0];
    for (const line of orderLines) await client.query(
      `INSERT INTO delivery_line_items (delivery_id, product_sku, product_name, ordered_qty, picked_qty, packed_qty, delivered_qty)
       VALUES ($1,$2,$3,$4,0,0,0)`, [delivery.id, line.product_sku, line.product_name, line.quantity],
    );
    await audit(client, organizationId, actorId, 'delivery_created', 'delivery', delivery.id, { orderId: order.id, warehouseId });
    return delivery;
  },

  async updateDeliveryStatus(client, organizationId, actorId, deliveryId, status, input = {}) {
    const transitions = { Pending: 'Picking', Picking: 'Packed', Packed: 'Shipped', Shipped: 'Delivered', Delivered: 'Returned' };
    const delivery = (await client.query('SELECT * FROM delivery_notes WHERE id=$1 AND organization_id=$2 FOR UPDATE', [deliveryId, organizationId])).rows[0];
    if (!delivery) throw new SalesError(404, 'Delivery not found.');
    if (transitions[delivery.status] !== status) throw new SalesError(409, `Delivery cannot move from ${delivery.status} to ${status}.`);
    const lines = await getLines(client, 'delivery_line_items', 'delivery_id', deliveryId);
    if (status === 'Shipped' || status === 'Returned') {
      const period = await client.query(
        `SELECT status FROM accounting_periods
         WHERE organization_id=$1 AND CURRENT_DATE BETWEEN period_start AND period_end`,
        [organizationId],
      );
      if (period.rows[0]?.status === 'CLOSED') throw new SalesError(409, 'The accounting period is closed; delivery inventory cannot be posted.');
    }
    if (status === 'Picking') {
      for (const line of lines) await client.query('UPDATE delivery_line_items SET picked_qty=ordered_qty WHERE id=$1', [line.id]);
    }
    if (status === 'Packed') {
      for (const line of lines) await client.query('UPDATE delivery_line_items SET packed_qty=picked_qty WHERE id=$1', [line.id]);
    }
    if (status === 'Shipped' || status === 'Returned') {
      const products = [];
      for (const line of lines) {
        const sku = line.product_sku;
        const product = await inventoryService.getProductBySku(client, organizationId, sku);
        if (!product) throw new SalesError(400, `Inventory product ${sku} was not found.`);
        const quantity = Number(line.packed_qty || line.ordered_qty);
        products.push({ line, product, quantity });
      }
      if (status === 'Shipped') {
        for (const { line, product, quantity } of products) {
          const balance = await inventoryService.getStockBalance(client, organizationId, product.id, delivery.warehouse_id);
          if (Number(balance.quantity) < quantity) throw new SalesError(409, `Insufficient stock for ${product.sku}. Available: ${balance.quantity}`);
        }
      }
      for (const { line, product, quantity } of products) {
        if (status === 'Shipped') {
          const movement = await inventoryService.issue(client, organizationId, actorId, {
            productId: product.id, warehouseId: delivery.warehouse_id, quantity,
            unitCost: product.standard_cost, transactionType: 'SALES_DELIVERY',
            referenceType: 'SALES_DELIVERY', referenceId: delivery.id,
          });
          await accountingService.postJournal(client, organizationId, actorId, movement.journal.id);
          await client.query('UPDATE delivery_line_items SET delivered_qty=$2 WHERE id=$1', [line.id, quantity]);
        } else {
          const movement = await inventoryService.receive(client, organizationId, actorId, {
            productId: product.id, warehouseId: delivery.warehouse_id, quantity: Number(line.delivered_qty),
            unitCost: product.standard_cost, transactionType: 'SALES_RETURN',
            referenceType: 'SALES_RETURN', referenceId: delivery.id,
          });
          await accountingService.postJournal(client, organizationId, actorId, movement.journal.id);
        }
      }
    }
    const updated = (await client.query('UPDATE delivery_notes SET status=$1, delivered_by=$2, updated_at=CURRENT_TIMESTAMP WHERE id=$3 RETURNING *', [status, actorId, deliveryId])).rows[0];
    await audit(client, organizationId, actorId, `delivery_${status.toLowerCase()}`, 'delivery', deliveryId, input);
    return updated;
  },

  async listInvoices(client, organizationId) {
    return (await client.query(
      `SELECT i.*, c.legal_name AS customer_name FROM customer_invoices i JOIN customers c ON c.id=i.customer_id
       WHERE i.organization_id=$1 ORDER BY i.created_at DESC`, [organizationId],
    )).rows;
  },

  async createInvoice(client, organizationId, actorId, input) {
    const orderId = input.orderId ?? input.salesOrderId ?? input.sales_order_id;
    const order = orderId ? (await client.query('SELECT * FROM sales_orders WHERE id=$1 AND organization_id=$2', [orderId, organizationId])).rows[0] : null;
    const customerId = input.customerId ?? input.customer_id ?? order?.customer_id;
    const customer = await ensureCustomer(client, organizationId, customerId);
    let lines = input.lines;
    if (!lines && order) {
      if (order.status !== 'Approved') throw new SalesError(409, 'Invoice requires an approved sales order.');
      lines = (await getLines(client, 'sales_order_lines', 'sales_order_id', order.id)).map((line) => ({
        productSku: line.product_sku, productName: line.product_name, quantity: line.quantity,
        unitPrice: line.unit_price, discountPercent: line.discount_percent, taxPercent: line.tax_percent,
      }));
    }
    const totals = calculateLines(lines, input.discountPercent ?? 0);
    const invoiceDate = dateValue(input.invoiceDate ?? input.invoice_date, 'invoiceDate', true) || new Date().toISOString().slice(0, 10);
    const dueDate = dateValue(input.dueDate ?? input.due_date, 'dueDate');
    return transaction(client, async () => {
      const invoice = (await client.query(
        `INSERT INTO customer_invoices (invoice_number, customer_id, sales_order_id, delivery_id, invoice_date, due_date, status, subtotal, discount_amount, tax_amount, total, notes, organization_id)
         VALUES ($1,$2,$3,$4,$5,$6,'Draft',$7,$8,$9,$10,$11,$12) RETURNING *`,
        [input.invoiceNumber || `INV-${Date.now()}-${randomUUID().slice(0, 6)}`, customer.id, order?.id || null,
          input.deliveryId ?? input.delivery_id ?? null, invoiceDate, dueDate, totals.subtotal, totals.discountAmount,
          totals.taxAmount, totals.total, input.notes || null, organizationId],
      )).rows[0];
      const insertedLines = await insertLines(client, 'invoice_lines', 'invoice_id', invoice.id, totals.lines);
      await audit(client, organizationId, actorId, 'invoice_created', 'invoice', invoice.id, { invoiceNumber: invoice.invoice_number, total: invoice.total });
      return { ...invoice, lines: insertedLines };
    });
  },

  async issueInvoice(client, organizationId, actorId, invoiceId) {
    return transaction(client, async () => {
      const invoice = (await client.query('SELECT * FROM customer_invoices WHERE id=$1 AND organization_id=$2 FOR UPDATE', [invoiceId, organizationId])).rows[0];
      if (!invoice) throw new SalesError(404, 'Invoice not found.');
      if (invoice.status !== 'Draft') throw new SalesError(409, 'Only draft invoices can be issued.');
      const journal = await postSalesJournal(client, organizationId, actorId, {
        date: invoice.invoice_date, reference: invoice.invoice_number, description: `Sales invoice ${invoice.invoice_number}`,
        sourceId: `invoice:${invoice.id}`, currency: 'ETB', debitCode: '1100', debitAmount: invoice.total,
        credits: [
          { code: '4000', amount: Number(invoice.subtotal) - Number(invoice.discount_amount), description: 'Net sales revenue' },
          { code: '2200', amount: invoice.tax_amount, description: 'VAT payable' },
        ],
      });
      const issued = (await client.query("UPDATE customer_invoices SET status='Issued', updated_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *", [invoice.id])).rows[0];
      await client.query(
        `INSERT INTO accounts_receivable (invoice_id, customer_id, invoice_total, payment_received, outstanding, invoice_date, due_date, days_overdue, status, organization_id)
         VALUES ($1,$2,$3,0,$3,$4,$5,0,'Outstanding',$6)`,
        [invoice.id, invoice.customer_id, invoice.total, invoice.invoice_date, invoice.due_date, organizationId],
      );
      await audit(client, organizationId, actorId, 'invoice_issued', 'invoice', invoice.id, { journalId: journal.id });
      return { ...issued, journalId: journal.id, journalNumber: journal.journal_number };
    });
  },

  async listPayments(client, organizationId) {
    return (await client.query(
      `SELECT p.*, c.legal_name AS customer_name, i.invoice_number FROM customer_payments p
       JOIN customers c ON c.id=p.customer_id JOIN customer_invoices i ON i.id=p.invoice_id
       WHERE p.organization_id=$1 ORDER BY p.created_at DESC`, [organizationId],
    )).rows;
  },

  async recordPayment(client, organizationId, actorId, input) {
    const invoiceId = input.invoiceId ?? input.invoice_id;
    const paymentAmount = amount(input.amount, 'amount', { min: 0.01, max: Number.MAX_SAFE_INTEGER });
    const method = String(input.paymentMethod ?? input.payment_method ?? '').toLowerCase();
    if (!paymentMethods.has(method)) throw new SalesError(400, 'paymentMethod must be cash, bank, transfer, cheque, or other.');
    return transaction(client, async () => {
      const invoice = (await client.query('SELECT * FROM customer_invoices WHERE id=$1 AND organization_id=$2 FOR UPDATE', [invoiceId, organizationId])).rows[0];
      if (!invoice || !['Issued', 'Overdue'].includes(invoice.status)) throw new SalesError(409, 'Payment requires an issued invoice.');
      const receivable = (await client.query('SELECT * FROM accounts_receivable WHERE invoice_id=$1 AND organization_id=$2 FOR UPDATE', [invoice.id, organizationId])).rows[0];
      if (!receivable || paymentAmount > Number(receivable.outstanding) + 0.001) throw new SalesError(409, 'Payment exceeds the outstanding receivable.');
      const date = dateValue(input.paymentDate ?? input.payment_date, 'paymentDate', true) || new Date().toISOString().slice(0, 10);
      const payment = (await client.query(
        `INSERT INTO customer_payments (payment_number, invoice_id, customer_id, payment_date, payment_method, amount, reference_number, notes, recorded_by, organization_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [input.paymentNumber || `RCT-${Date.now()}-${randomUUID().slice(0, 6)}`, invoice.id, invoice.customer_id, date, method, paymentAmount,
          input.referenceNumber ?? input.reference_number ?? null, input.notes || null, actorId, organizationId],
      )).rows[0];
      const cashCode = input.accountCode || (method === 'cash' ? '1000' : '1000');
      const journal = await postSalesJournal(client, organizationId, actorId, {
        date, reference: payment.payment_number, description: `Customer receipt ${payment.payment_number}`,
        sourceId: `payment:${payment.id}`, currency: 'ETB', debitCode: cashCode, debitAmount: paymentAmount,
        credits: [{ code: '1100', amount: paymentAmount, description: 'Accounts receivable collected' }],
      });
      const received = money(Number(receivable.payment_received) + paymentAmount);
      const outstanding = money(Number(receivable.invoice_total) - received);
      const status = outstanding <= 0.005 ? 'Paid' : (new Date(receivable.due_date) < new Date(date) ? 'Overdue' : 'Partial');
      await client.query('UPDATE accounts_receivable SET payment_received=$1, outstanding=$2, status=$3, days_overdue=GREATEST(0, $4::date - due_date), updated_at=CURRENT_TIMESTAMP WHERE id=$5', [received, outstanding, status, date, receivable.id]);
      await client.query('UPDATE customer_invoices SET paid_amount=$1, status=$2, updated_at=CURRENT_TIMESTAMP WHERE id=$3', [received, outstanding <= 0.005 ? 'Paid' : 'Issued', invoice.id]);
      await audit(client, organizationId, actorId, 'payment_recorded', 'payment', payment.id, { invoiceId: invoice.id, amount: paymentAmount, journalId: journal.id });
      return { ...payment, receiptNumber: payment.payment_number, journalId: journal.id, journalNumber: journal.journal_number, outstanding };
    });
  },

  async listReceivables(client, organizationId) {
    const result = await client.query(
      `SELECT ar.*, c.legal_name AS customer_name, i.invoice_number,
              GREATEST(0, CURRENT_DATE - ar.due_date) AS days_overdue,
              CASE WHEN ar.outstanding <= 0 THEN 'Paid'
                   WHEN ar.due_date < CURRENT_DATE THEN 'Overdue'
                   WHEN ar.payment_received > 0 THEN 'Partial' ELSE 'Outstanding' END AS current_status,
              CASE WHEN ar.due_date >= CURRENT_DATE THEN 'current'
                   WHEN CURRENT_DATE - ar.due_date <= 30 THEN '1-30'
                   WHEN CURRENT_DATE - ar.due_date <= 60 THEN '31-60'
                   WHEN CURRENT_DATE - ar.due_date <= 90 THEN '61-90' ELSE '90+' END AS aging_bucket
       FROM accounts_receivable ar JOIN customers c ON c.id=ar.customer_id JOIN customer_invoices i ON i.id=ar.invoice_id
       WHERE ar.organization_id=$1 ORDER BY ar.due_date`, [organizationId],
    );
    return result.rows;
  },

  async salesReports(client, organizationId, filters = {}) {
    const values = [organizationId];
    const dateFilter = filters.startDate && filters.endDate
      ? `AND i.invoice_date BETWEEN $2 AND $3` : '';
    if (dateFilter) values.push(filters.startDate, filters.endDate);
    const where = `i.organization_id=$1 AND i.status IN ('Issued','Paid','Overdue') ${dateFilter}`;
    const [summary, customers, products, salespeople, periods, receivables] = await Promise.all([
      client.query(`SELECT COALESCE(SUM(i.subtotal),0) gross_sales, COALESCE(SUM(i.discount_amount),0) discounts,
        COALESCE(SUM(i.tax_amount),0) vat, COALESCE(SUM(i.total-i.tax_amount),0) net_sales FROM customer_invoices i WHERE ${where}`, values),
      client.query(`SELECT c.id, c.legal_name, COALESCE(SUM(i.total),0) sales FROM customer_invoices i JOIN customers c ON c.id=i.customer_id WHERE ${where} GROUP BY c.id,c.legal_name ORDER BY sales DESC`, values),
      client.query(`SELECT il.product_sku,il.product_name,COALESCE(SUM(il.quantity),0) quantity,COALESCE(SUM(il.line_total),0) sales FROM invoice_lines il JOIN customer_invoices i ON i.id=il.invoice_id WHERE ${where} GROUP BY il.product_sku,il.product_name ORDER BY sales DESC`, values),
      client.query(`SELECT u.display_name AS salesperson,COALESCE(SUM(i.total),0) sales FROM customer_invoices i LEFT JOIN sales_orders so ON so.id=i.sales_order_id LEFT JOIN users u ON u.id=so.created_by WHERE ${where} GROUP BY u.display_name ORDER BY sales DESC`, values),
      client.query(`SELECT TO_CHAR(DATE_TRUNC('month',i.invoice_date),'YYYY-MM') period,COALESCE(SUM(i.total),0) sales FROM customer_invoices i WHERE ${where} GROUP BY DATE_TRUNC('month',i.invoice_date) ORDER BY period DESC`, values),
      client.query(`SELECT COALESCE(SUM(outstanding),0) receivables,
        COALESCE(SUM(outstanding) FILTER (WHERE due_date >= CURRENT_DATE OR CURRENT_DATE-due_date <= 30),0) aging_30,
        COALESCE(SUM(outstanding) FILTER (WHERE CURRENT_DATE-due_date BETWEEN 31 AND 60),0) aging_60,
        COALESCE(SUM(outstanding) FILTER (WHERE CURRENT_DATE-due_date BETWEEN 61 AND 90),0) aging_90,
        COALESCE(SUM(outstanding) FILTER (WHERE CURRENT_DATE-due_date > 90),0) aging_over_90
        FROM accounts_receivable WHERE organization_id=$1`, [organizationId]),
    ]);
    return { summary: summary.rows[0], byCustomer: customers.rows, byProduct: products.rows, bySalesperson: salespeople.rows, byPeriod: periods.rows, receivables: receivables.rows[0] };
  },

  async listAudit(client, organizationId) {
    return (await client.query('SELECT * FROM sales_audit_trail WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 500', [organizationId])).rows;
  },
};
