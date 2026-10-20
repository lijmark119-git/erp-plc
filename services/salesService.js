import { randomUUID } from 'node:crypto';
import { accountingService } from './accountingService.js';
import { inventoryService } from './inventoryService.js';
import { isValidEmail, isValidISODate, isValidPersonName, isValidPhone } from '../validation.js';

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
  if (!isValidISODate(value)) throw new SalesError(400, `${field} must be a valid calendar date in YYYY-MM-DD format.`);
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

async function assertPricesAuthorized(client, organizationId, customerId, lines, allowPriceOverride) {
  if (allowPriceOverride) return;
  for (const line of lines) {
    const price = await client.query(
      `SELECT COALESCE((
                SELECT line.unit_price
                FROM sales_customer_price_list_lines line
                JOIN sales_customer_price_lists price_list ON price_list.id=line.price_list_id
                WHERE price_list.organization_id=$1 AND price_list.customer_id=$2
                  AND price_list.active=TRUE AND CURRENT_DATE >= price_list.effective_from
                  AND (price_list.effective_to IS NULL OR CURRENT_DATE <= price_list.effective_to)
                  AND line.product_sku=$3
                ORDER BY price_list.effective_from DESC, price_list.created_at DESC
                LIMIT 1
              ), product.sales_price) AS allowed_price
       FROM inventory_products product
       WHERE product.organization_id=$1 AND product.sku=$3 AND product.active=TRUE
       LIMIT 1`,
      [organizationId, customerId, line.productSku],
    );
    if (!price.rows[0]) continue;
    const allowedPrice = Number(price.rows[0].allowed_price);
    if (Math.abs(Number(line.unitPrice) - allowedPrice) > 0.0001) {
      throw new SalesError(403, `You cannot override the approved unit price for ${line.productSku}. Request a price approval from a sales manager.`);
    }
  }
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
    if (!isValidPhone(input.phone ?? '')) throw new SalesError(400, 'Phone must contain 7 to 15 digits and only standard phone characters.');
    const contactPerson = input.contactPerson ?? input.contact_person ?? '';
    if ((contactPerson && !isValidPersonName(contactPerson)) || !isValidEmail(input.email ?? '')) {
      throw new SalesError(400, 'Contact person or email has an invalid format.');
    }
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
    if (input.phone !== undefined && !isValidPhone(input.phone ?? '')) {
      throw new SalesError(400, 'Phone must contain 7 to 15 digits and only standard phone characters.');
    }
    const legalName = input.legalName ?? input.legal_name;
    const contactPerson = input.contactPerson ?? input.contact_person;
    if ((legalName !== undefined && !String(legalName).trim()) ||
      (contactPerson !== undefined && contactPerson !== '' && !isValidPersonName(contactPerson)) ||
      (input.email !== undefined && !isValidEmail(input.email))) {
      throw new SalesError(400, 'Legal name, contact person, or email has an invalid format.');
    }
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

  async listCustomerPriceLists(client, organizationId) {
    return (await client.query(
      `SELECT price_list.*, customer.legal_name AS customer_name,
              COALESCE(jsonb_agg(
                jsonb_build_object('productSku', line.product_sku, 'unitPrice', line.unit_price)
                ORDER BY line.product_sku
              ) FILTER (WHERE line.id IS NOT NULL), '[]'::jsonb) AS lines
       FROM sales_customer_price_lists price_list
       JOIN customers customer ON customer.id=price_list.customer_id
       LEFT JOIN sales_customer_price_list_lines line ON line.price_list_id=price_list.id
       WHERE price_list.organization_id=$1
       GROUP BY price_list.id, customer.legal_name
       ORDER BY price_list.created_at DESC`,
      [organizationId],
    )).rows;
  },

  async createCustomerPriceList(client, organizationId, actorId, input) {
    const customerId = input.customerId ?? input.customer_id;
    const customer = await ensureCustomer(client, organizationId, customerId);
    const name = requiredText(input.name, 'name').slice(0, 160);
    const currency = String(input.currency || customer.currency || 'ETB').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new SalesError(400, 'currency must be a three-letter currency code.');
    const effectiveFrom = dateValue(input.effectiveFrom ?? input.effective_from, 'effectiveFrom', true)
      || new Date().toISOString().slice(0, 10);
    const effectiveTo = dateValue(input.effectiveTo ?? input.effective_to, 'effectiveTo', true);
    if (effectiveTo && effectiveTo < effectiveFrom) throw new SalesError(400, 'effectiveTo cannot be earlier than effectiveFrom.');
    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      throw new SalesError(400, 'At least one price-list line is required.');
    }
    const lines = input.lines.map((line) => ({
      productSku: requiredText(line.productSku ?? line.product_sku, 'productSku').slice(0, 80),
      unitPrice: amount(line.unitPrice ?? line.unit_price, 'unitPrice', { max: Number.MAX_SAFE_INTEGER }),
    }));
    if (new Set(lines.map((line) => line.productSku)).size !== lines.length) {
      throw new SalesError(400, 'A product can only appear once in a price list.');
    }
    return transaction(client, async () => {
      const priceList = (await client.query(
        `INSERT INTO sales_customer_price_lists
           (organization_id, customer_id, name, currency, effective_from, effective_to, active, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [organizationId, customer.id, name, currency, effectiveFrom, effectiveTo, input.active !== false, actorId],
      )).rows[0];
      for (const line of lines) {
        await client.query(
          `INSERT INTO sales_customer_price_list_lines (price_list_id, product_sku, unit_price)
           VALUES ($1,$2,$3)`,
          [priceList.id, line.productSku, line.unitPrice],
        );
      }
      await audit(client, organizationId, actorId, 'customer_price_list_created', 'customer_price_list', priceList.id, {
        customerId, name, currency, effectiveFrom, effectiveTo, lines,
      });
      return { ...priceList, customer_name: customer.legal_name, lines };
    });
  },

  async setCustomerPriceListStatus(client, organizationId, actorId, priceListId, active) {
    if (typeof active !== 'boolean') throw new SalesError(400, 'active must be a boolean.');
    return transaction(client, async () => {
      const priceList = (await client.query(
        'SELECT id, active FROM sales_customer_price_lists WHERE id=$1 AND organization_id=$2 FOR UPDATE',
        [priceListId, organizationId],
      )).rows[0];
      if (!priceList) throw new SalesError(404, 'Customer price list not found.');
      const updated = (await client.query(
        `UPDATE sales_customer_price_lists SET active=$1, updated_at=CURRENT_TIMESTAMP
         WHERE id=$2 AND organization_id=$3 RETURNING *`,
        [active, priceListId, organizationId],
      )).rows[0];
      await audit(client, organizationId, actorId, 'customer_price_list_status_changed', 'customer_price_list', priceListId, {
        previousActive: priceList.active,
        active,
      });
      return updated;
    });
  },

  async createQuotation(client, organizationId, actorId, input) {
    const customer = await ensureCustomer(client, organizationId, input.customerId ?? input.customer_id);
    const validityDate = dateValue(input.validityDate ?? input.validity_date, 'validityDate');
    const totals = calculateLines(input.lines, input.discountPercent ?? 0);
    await assertPricesAuthorized(client, organizationId, customer.id, totals.lines, input.allowPriceOverride === true);
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

  async reviseQuotation(client, organizationId, actorId, quotationId, input = {}) {
    return transaction(client, async () => {
      const source = (await client.query(
        'SELECT * FROM quotations WHERE id=$1 AND organization_id=$2 FOR UPDATE',
        [quotationId, organizationId],
      )).rows[0];
      if (!source) throw new SalesError(404, 'Quotation not found.');
      if (source.status === 'Converted') throw new SalesError(409, 'A converted quotation cannot be revised.');
      const rootId = source.revision_of || source.id;
      await client.query('SELECT id FROM quotations WHERE id=$1 AND organization_id=$2 FOR UPDATE', [rootId, organizationId]);
      const latest = (await client.query(
        'SELECT COALESCE(MAX(revision_number), 1) AS latest_revision FROM quotations WHERE organization_id=$1 AND (id=$2 OR revision_of=$2)',
        [organizationId, rootId],
      )).rows[0];
      const revisionNumber = Number(latest.latest_revision) + 1;
      const validityDate = input.validityDate === undefined
        ? source.validity_date
        : dateValue(input.validityDate, 'validityDate');
      const lines = await getLines(client, 'quotation_lines', 'quotation_id', source.id);
      const revision = (await client.query(
        `INSERT INTO quotations
           (quotation_number, customer_id, created_by, quotation_date, validity_date, status,
            subtotal, discount_amount, discount_percent, tax_amount, total, notes, terms,
            organization_id, revision_of, revision_number)
         VALUES ($1,$2,$3,CURRENT_DATE,$4,'Draft',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [`QT-${Date.now()}-${randomUUID().slice(0, 6)}`, source.customer_id, actorId, validityDate,
          source.subtotal, source.discount_amount, source.discount_percent, source.tax_amount, source.total,
          source.notes, source.terms, organizationId, rootId, revisionNumber],
      )).rows[0];
      for (const line of lines) {
        await client.query(
          `INSERT INTO quotation_lines
             (quotation_id, product_sku, product_name, quantity, unit_price, discount_percent, tax_percent, line_total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [revision.id, line.product_sku, line.product_name, line.quantity, line.unit_price,
            line.discount_percent, line.tax_percent, line.line_total],
        );
      }
      await audit(client, organizationId, actorId, 'quotation_revised', 'quotation', revision.id, {
        sourceQuotationId: source.id,
        rootQuotationId: rootId,
        revisionNumber,
      });
      return { ...revision, lines, sourceQuotationId: source.id };
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
      `SELECT so.*, c.legal_name AS customer_name,
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'productSku', line.product_sku,
                  'productName', line.product_name,
                  'quantity', line.quantity,
                  'unitPrice', line.unit_price,
                  'discountPercent', line.discount_percent,
                  'taxPercent', line.tax_percent
                ) ORDER BY line.created_at, line.id)
                FROM sales_order_lines line WHERE line.sales_order_id=so.id
              ), '[]'::jsonb) AS lines
       FROM sales_orders so JOIN customers c ON c.id = so.customer_id
       WHERE so.organization_id = $1 ORDER BY so.created_at DESC`, [organizationId],
    );
    return result.rows;
  },

  async createOrder(client, organizationId, actorId, input) {
    const totals = calculateLines(input.lines, input.discountPercent ?? 0);
    const customerId = input.customerId ?? input.customer_id;
    const deliveryDate = dateValue(input.deliveryDate ?? input.delivery_date, 'deliveryDate', true);
    const paymentTerms = input.paymentTerms ?? input.payment_terms;
    const clientRequestId = input.idempotencyKey ?? input.idempotency_key ?? null;
    if (clientRequestId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientRequestId)) {
      throw new SalesError(400, 'idempotencyKey must be a valid UUID.');
    }
    const requestFingerprint = JSON.stringify({
      customerId,
      deliveryDate,
      paymentTerms: paymentTerms || null,
      lines: totals.lines,
      discountPercent: Number(input.discountPercent || 0),
    });
    return transaction(client, async () => {
      const customer = await lockCustomer(client, organizationId, customerId);
      if (clientRequestId) {
        const existing = (await client.query(
          `SELECT * FROM sales_orders
           WHERE organization_id=$1 AND client_request_id=$2`,
          [organizationId, clientRequestId],
        )).rows[0];
        if (existing) {
          if (existing.request_fingerprint !== requestFingerprint) {
            throw new SalesError(409, 'This request key was already used for a different sales order.');
          }
          const lines = await getLines(client, 'sales_order_lines', 'sales_order_id', existing.id);
          return { ...existing, lines, idempotentReplay: true };
        }
      }
      await assertPricesAuthorized(client, organizationId, customer.id, totals.lines, input.allowPriceOverride === true);
      await assertCreditAvailable(client, organizationId, customer, totals.total);
      const number = input.orderNumber || `SO-${Date.now()}-${randomUUID().slice(0, 6)}`;
      const result = await client.query(
        `INSERT INTO sales_orders
           (order_number, customer_id, created_by, delivery_date, status, approval_status, subtotal,
            discount_amount, discount_percent, tax_amount, total, payment_terms, organization_id,
            client_request_id, request_fingerprint)
         VALUES ($1,$2,$3,$4,'Draft','Pending',$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (organization_id, client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING
         RETURNING *`,
        [number, customer.id, actorId, deliveryDate, totals.subtotal, totals.discountAmount, totals.discountPercent,
          totals.taxAmount, totals.total, paymentTerms || customer.payment_terms, organizationId,
          clientRequestId, clientRequestId ? requestFingerprint : null],
      );
      if (!result.rows[0] && clientRequestId) {
        const existing = (await client.query(
          'SELECT * FROM sales_orders WHERE organization_id=$1 AND client_request_id=$2',
          [organizationId, clientRequestId],
        )).rows[0];
        if (!existing || existing.request_fingerprint !== requestFingerprint) {
          throw new SalesError(409, 'This request key was already used for a different sales order.');
        }
        const lines = await getLines(client, 'sales_order_lines', 'sales_order_id', existing.id);
        return { ...existing, lines, idempotentReplay: true };
      }
      const order = result.rows[0];
      const lines = await insertLines(client, 'sales_order_lines', 'sales_order_id', order.id, totals.lines);
      await audit(client, organizationId, actorId, 'sales_order_created', 'sales_order', order.id, { orderNumber: number, total: totals.total });
      return { ...order, lines };
    });
  },

  async amendDraftOrder(client, organizationId, actorId, orderId, input) {
    const reason = requiredText(input.reason, 'reason').slice(0, 500);
    return transaction(client, async () => {
      const order = (await client.query(
        'SELECT * FROM sales_orders WHERE id=$1 AND organization_id=$2 FOR UPDATE',
        [orderId, organizationId],
      )).rows[0];
      if (!order) throw new SalesError(404, 'Sales order not found.');
      if (order.status !== 'Draft') throw new SalesError(409, 'Only draft sales orders can be amended; submitted orders must follow the approval workflow.');
      const existingLines = await getLines(client, 'sales_order_lines', 'sales_order_id', order.id);
      const linesChanged = Array.isArray(input.lines);
      const linesInput = input.lines ?? existingLines.map((line) => ({
        productSku: line.product_sku,
        productName: line.product_name,
        quantity: line.quantity,
        unitPrice: line.unit_price,
        discountPercent: line.discount_percent,
        taxPercent: line.tax_percent,
      }));
      const totals = linesChanged
        ? calculateLines(linesInput, input.discountPercent ?? 0)
        : {
            lines: existingLines,
            subtotal: Number(order.subtotal),
            discountAmount: Number(order.discount_amount),
            discountPercent: Number(order.discount_percent),
            taxAmount: Number(order.tax_amount),
            total: Number(order.total),
          };
      const customer = await lockCustomer(client, organizationId, order.customer_id);
      if (linesChanged) {
        await assertPricesAuthorized(client, organizationId, customer.id, totals.lines, input.allowPriceOverride === true);
      }
      await assertCreditAvailable(client, organizationId, customer, totals.total, order.id);
      const deliveryDate = input.deliveryDate === undefined
        ? order.delivery_date
        : dateValue(input.deliveryDate, 'deliveryDate', true);
      const paymentTerms = input.paymentTerms === undefined ? order.payment_terms : input.paymentTerms;
      const before = {
        deliveryDate: order.delivery_date,
        paymentTerms: order.payment_terms,
        subtotal: order.subtotal,
        discountAmount: order.discount_amount,
        discountPercent: order.discount_percent,
        taxAmount: order.tax_amount,
        total: order.total,
        lines: existingLines,
      };
      let lines = existingLines;
      if (linesChanged) {
        await client.query('DELETE FROM sales_order_lines WHERE sales_order_id=$1', [order.id]);
        lines = await insertLines(client, 'sales_order_lines', 'sales_order_id', order.id, totals.lines);
      }
      const updated = (await client.query(
        `UPDATE sales_orders
         SET delivery_date=$1, payment_terms=$2, subtotal=$3, discount_amount=$4,
             discount_percent=$5, tax_amount=$6, total=$7, updated_at=CURRENT_TIMESTAMP
         WHERE id=$8 AND organization_id=$9 RETURNING *`,
        [deliveryDate, paymentTerms, totals.subtotal, totals.discountAmount, totals.discountPercent,
          totals.taxAmount, totals.total, order.id, organizationId],
      )).rows[0];
      await audit(client, organizationId, actorId, 'sales_order_amended', 'sales_order', order.id, {
        reason,
        before,
        after: { ...updated, lines },
      });
      return { ...updated, lines };
    });
  },

  async cancelOrder(client, organizationId, actorId, orderId, reason) {
    const cancellationReason = requiredText(reason, 'reason').slice(0, 500);
    return transaction(client, async () => {
      const order = (await client.query(
        'SELECT * FROM sales_orders WHERE id=$1 AND organization_id=$2 FOR UPDATE',
        [orderId, organizationId],
      )).rows[0];
      if (!order) throw new SalesError(404, 'Sales order not found.');
      if (!['Draft', 'Submitted'].includes(order.status)) {
        throw new SalesError(409, 'Only draft or submitted orders can be cancelled. Approved orders must be handled through delivery and return workflows.');
      }
      const updated = (await client.query(
        `UPDATE sales_orders SET status='Cancelled', approval_status='Cancelled',
         updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND organization_id=$2 RETURNING *`,
        [order.id, organizationId],
      )).rows[0];
      await audit(client, organizationId, actorId, 'sales_order_cancelled', 'sales_order', order.id, {
        reason: cancellationReason,
        previousStatus: order.status,
      });
      return updated;
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
    if (status === 'Returned') {
      const inspection = (await client.query(
        `SELECT inspection.id
         FROM sales_return_inspections inspection
         JOIN sales_return_requests request ON request.id=inspection.return_request_id
         WHERE inspection.organization_id=$1 AND request.delivery_id=$2
           AND request.status='APPROVED'`,
        [organizationId, deliveryId],
      )).rows[0];
      if (!inspection) throw new SalesError(409, 'An approved return request must be received and inspected before the delivery can be marked returned.');
    }
    const lines = await getLines(client, 'delivery_line_items', 'delivery_id', deliveryId);
    if (status === 'Shipped') {
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
    if (status === 'Shipped') {
      const products = [];
      for (const line of lines) {
        const sku = line.product_sku;
        const product = await inventoryService.getProductBySku(client, organizationId, sku);
        if (!product) throw new SalesError(400, `Inventory product ${sku} was not found.`);
        const quantity = Number(line.packed_qty || line.ordered_qty);
        products.push({ line, product, quantity });
      }
      for (const { line, product, quantity } of products) {
        const balance = await inventoryService.getStockBalance(client, organizationId, product.id, delivery.warehouse_id);
        if (Number(balance.quantity) < quantity) throw new SalesError(409, `Insufficient stock for ${product.sku}. Available: ${balance.quantity}`);
      }
      for (const { line, product, quantity } of products) {
        const movement = await inventoryService.issue(client, organizationId, actorId, {
          productId: product.id, warehouseId: delivery.warehouse_id, quantity,
          unitCost: product.standard_cost, transactionType: 'SALES_DELIVERY',
          referenceType: 'SALES_DELIVERY', referenceId: delivery.id,
        });
        await accountingService.postJournal(client, organizationId, actorId, movement.journal.id);
        await client.query('UPDATE delivery_line_items SET delivered_qty=$2 WHERE id=$1', [line.id, quantity]);
      }
    }
    const recipientName = status === 'Delivered' && input.recipientName !== undefined
      ? requiredText(input.recipientName, 'recipientName').slice(0, 160)
      : null;
    const proofOfDeliveryRef = status === 'Delivered' && input.proofOfDeliveryRef !== undefined
      ? requiredText(input.proofOfDeliveryRef, 'proofOfDeliveryRef').slice(0, 255)
      : null;
    const trackingUrl = status === 'Shipped' && input.trackingUrl !== undefined
      ? String(input.trackingUrl).trim().slice(0, 1000) || null
      : null;
    if (trackingUrl && !/^https?:\/\/\S+$/i.test(trackingUrl)) {
      throw new SalesError(400, 'trackingUrl must be an HTTP or HTTPS URL.');
    }
    const updated = (await client.query(
      `UPDATE delivery_notes
       SET status=$1, delivered_by=$2,
           recipient_name=CASE WHEN $1::varchar='Delivered'::varchar THEN COALESCE($3, recipient_name) ELSE recipient_name END,
           proof_of_delivery_ref=CASE WHEN $1::varchar='Delivered'::varchar THEN COALESCE($4, proof_of_delivery_ref) ELSE proof_of_delivery_ref END,
           delivered_at=CASE WHEN $1::varchar='Delivered'::varchar THEN COALESCE(delivered_at, CURRENT_TIMESTAMP) ELSE delivered_at END,
           tracking_url=CASE WHEN $1::varchar='Shipped'::varchar THEN COALESCE($5, tracking_url) ELSE tracking_url END,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$6 RETURNING *`,
      [status, actorId, recipientName, proofOfDeliveryRef, trackingUrl, deliveryId],
    )).rows[0];
    await audit(client, organizationId, actorId, `delivery_${status.toLowerCase()}`, 'delivery', deliveryId, input);
    return updated;
  },

  async listReturnRequests(client, organizationId) {
    return (await client.query(
      `SELECT request.*, delivery.delivery_number, delivery.status AS delivery_status,
              customer.legal_name AS customer_name, requester.display_name AS requester_name,
              decider.display_name AS decider_name,
              inspection.inspected_at,
              COALESCE(lines.items, '[]'::jsonb) AS inspection_lines,
              COALESCE(delivery_lines.items, '[]'::jsonb) AS delivery_lines
       FROM sales_return_requests request
       JOIN delivery_notes delivery ON delivery.id=request.delivery_id
       JOIN customers customer ON customer.id=delivery.customer_id
       LEFT JOIN users requester ON requester.id=request.requested_by
       LEFT JOIN users decider ON decider.id=request.decided_by
       LEFT JOIN sales_return_inspections inspection
         ON inspection.return_request_id=request.id AND inspection.organization_id=request.organization_id
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'deliveryLineId', line.delivery_line_item_id,
           'receivedQuantity', line.received_quantity,
           'restockQuantity', line.restock_quantity,
           'quarantineQuantity', line.quarantine_quantity,
           'damagedQuantity', line.damaged_quantity
         ) ORDER BY line.id) AS items
         FROM sales_return_inspection_lines line WHERE line.inspection_id=inspection.id
       ) lines ON TRUE
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'deliveryLineId', line.id, 'productSku', line.product_sku,
           'productName', line.product_name, 'deliveredQuantity', line.delivered_qty
         ) ORDER BY line.id) AS items
         FROM delivery_line_items line WHERE line.delivery_id=delivery.id
       ) delivery_lines ON TRUE
       WHERE request.organization_id=$1 ORDER BY request.created_at DESC`,
      [organizationId],
    )).rows;
  },

  async createReturnRequest(client, organizationId, actorId, deliveryId, input = {}) {
    const reason = requiredText(input.reason, 'reason').slice(0, 500);
    const delivery = (await client.query(
      'SELECT id, status FROM delivery_notes WHERE id=$1 AND organization_id=$2',
      [deliveryId, organizationId],
    )).rows[0];
    if (!delivery) throw new SalesError(404, 'Delivery not found.');
    if (delivery.status !== 'Delivered') throw new SalesError(409, 'A return request can only be created for a delivered shipment.');
    const request = (await client.query(
      `INSERT INTO sales_return_requests (organization_id, delivery_id, reason, requested_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [organizationId, deliveryId, reason, actorId],
    )).rows[0];
    await audit(client, organizationId, actorId, 'delivery_return_requested', 'sales_return_request', request.id, { deliveryId, reason });
    return request;
  },

  async decideReturnRequest(client, organizationId, actorId, requestId, decision, resolution) {
    const status = String(decision || '').toUpperCase();
    if (!['APPROVED', 'REJECTED'].includes(status)) throw new SalesError(400, 'decision must be APPROVED or REJECTED.');
    const note = requiredText(resolution, 'resolution').slice(0, 500);
    return transaction(client, async () => {
      const request = (await client.query(
        'SELECT * FROM sales_return_requests WHERE id=$1 AND organization_id=$2 FOR UPDATE',
        [requestId, organizationId],
      )).rows[0];
      if (!request || request.status !== 'PENDING') throw new SalesError(409, 'Pending return request not found.');
      if (status === 'APPROVED') {
        const delivery = (await client.query(
          'SELECT status FROM delivery_notes WHERE id=$1 AND organization_id=$2 FOR UPDATE',
          [request.delivery_id, organizationId],
        )).rows[0];
        if (!delivery || delivery.status !== 'Delivered') throw new SalesError(409, 'The delivery is no longer eligible for return.');
        await client.query(
          `UPDATE sales_return_requests
           SET status='APPROVED', resolution=$1, decided_by=$2, updated_at=CURRENT_TIMESTAMP
           WHERE id=$3`,
          [note, actorId, requestId],
        );
      } else {
        await client.query(
          `UPDATE sales_return_requests
           SET status='REJECTED', resolution=$1, decided_by=$2, updated_at=CURRENT_TIMESTAMP
           WHERE id=$3`,
          [note, actorId, requestId],
        );
      }
      await audit(client, organizationId, actorId, `delivery_return_${status.toLowerCase()}`, 'sales_return_request', requestId, { resolution: note });
      return (await client.query('SELECT * FROM sales_return_requests WHERE id=$1', [requestId])).rows[0];
    });
  },

  async inspectReturnRequest(client, organizationId, actorId, requestId, input = {}) {
    const lines = input.lines;
    if (!Array.isArray(lines) || !lines.length) throw new SalesError(400, 'At least one inspected delivery line is required.');
    const note = String(input.notes || '').trim().slice(0, 500);
    const quantities = lines.map((line, index) => {
      const values = {
        deliveryLineId: requiredText(line.deliveryLineId ?? line.delivery_line_id, `lines[${index}].deliveryLineId`),
        receivedQuantity: amount(line.receivedQuantity ?? line.received_quantity, `lines[${index}].receivedQuantity`, { max: Number.MAX_SAFE_INTEGER }),
        restockQuantity: amount(line.restockQuantity ?? line.restock_quantity, `lines[${index}].restockQuantity`, { max: Number.MAX_SAFE_INTEGER }),
        quarantineQuantity: amount(line.quarantineQuantity ?? line.quarantine_quantity, `lines[${index}].quarantineQuantity`, { max: Number.MAX_SAFE_INTEGER }),
        damagedQuantity: amount(line.damagedQuantity ?? line.damaged_quantity, `lines[${index}].damagedQuantity`, { max: Number.MAX_SAFE_INTEGER }),
      };
      if (Math.abs(values.receivedQuantity - values.restockQuantity - values.quarantineQuantity - values.damagedQuantity) > 0.000001) {
        throw new SalesError(400, `Inspected quantities for delivery line ${values.deliveryLineId} must equal receivedQuantity.`);
      }
      return values;
    });
    if (new Set(quantities.map((line) => line.deliveryLineId)).size !== quantities.length) {
      throw new SalesError(400, 'A delivery line can only be inspected once.');
    }
    if (!quantities.some((line) => line.receivedQuantity > 0)) throw new SalesError(400, 'At least one returned quantity must be received.');

    return transaction(client, async () => {
      const request = (await client.query(
        `SELECT request.*, delivery.warehouse_id, delivery.status AS delivery_status
         FROM sales_return_requests request
         JOIN delivery_notes delivery ON delivery.id=request.delivery_id
         WHERE request.id=$1 AND request.organization_id=$2
         FOR UPDATE OF request, delivery`,
        [requestId, organizationId],
      )).rows[0];
      if (!request || request.status !== 'APPROVED') throw new SalesError(409, 'Only an approved return request can be inspected.');
      if (request.delivery_status !== 'Delivered') throw new SalesError(409, 'The delivery must remain delivered until its return inspection is completed.');
      const existing = await client.query('SELECT id FROM sales_return_inspections WHERE organization_id=$1 AND return_request_id=$2', [organizationId, requestId]);
      if (existing.rows[0]) throw new SalesError(409, 'This return has already been inspected.');
      const deliveryLines = (await client.query(
        `SELECT line.*, product.id AS product_id, product.standard_cost
         FROM delivery_line_items line
         JOIN inventory_products product ON product.organization_id=$1 AND product.sku=line.product_sku
         WHERE line.delivery_id=$2
         ORDER BY line.id
         FOR UPDATE OF line`,
        [organizationId, request.delivery_id],
      )).rows;
      if (deliveryLines.length !== quantities.length) throw new SalesError(400, 'Inspection must include every delivery line.');
      const deliveredById = new Map(deliveryLines.map((line) => [line.id, line]));
      for (const item of quantities) {
        const deliveryLine = deliveredById.get(item.deliveryLineId);
        if (!deliveryLine) throw new SalesError(400, 'An inspected line does not belong to this delivery.');
        if (item.receivedQuantity > Number(deliveryLine.delivered_qty) + 0.000001) {
          throw new SalesError(409, `Received quantity exceeds delivered quantity for ${deliveryLine.product_sku}.`);
        }
      }
      const inspection = (await client.query(
        `INSERT INTO sales_return_inspections (organization_id, return_request_id, inspected_by, notes)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [organizationId, requestId, actorId, note || null],
      )).rows[0];
      for (const item of quantities) {
        const deliveryLine = deliveredById.get(item.deliveryLineId);
        await client.query(
          `INSERT INTO sales_return_inspection_lines
             (inspection_id, delivery_line_item_id, received_quantity, restock_quantity, quarantine_quantity, damaged_quantity)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [inspection.id, item.deliveryLineId, item.receivedQuantity, item.restockQuantity, item.quarantineQuantity, item.damagedQuantity],
        );
        const dispositions = [
          ['restock', item.restockQuantity, 'AVAILABLE'],
          ['quarantine', item.quarantineQuantity, 'QUARANTINED'],
          ['damaged', item.damagedQuantity, 'DAMAGED'],
        ];
        for (const [disposition, quantity, qualityStatus] of dispositions) {
          if (quantity <= 0) continue;
          const movement = await inventoryService.receive(client, organizationId, actorId, {
            productId: deliveryLine.product_id,
            warehouseId: request.warehouse_id,
            quantity,
            unitCost: deliveryLine.standard_cost,
            transactionType: 'RETURN',
            referenceType: 'SALES_RETURN_INSPECTION',
            referenceId: `${requestId}:${deliveryLine.id}:${disposition}`,
            traceLotNumber: `RET-${requestId.slice(0, 8)}-${deliveryLine.id.slice(0, 8)}-${disposition}`,
            traceLotQuantity: quantity,
            qualityStatus,
            manageTransaction: false,
          });
          await accountingService.postJournal(client, organizationId, actorId, movement.journal.id);
        }
      }
      await this.updateDeliveryStatus(client, organizationId, actorId, request.delivery_id, 'Returned', {
        returnInspectionCompleted: true,
        manageTransaction: false,
      });
      await audit(client, organizationId, actorId, 'delivery_return_inspected', 'sales_return_request', requestId, {
        inspectionId: inspection.id,
        lines: quantities,
        notes: note,
      });
      return inspection;
    });
  },

  async salesPerformance(client, organizationId, filters = {}) {
    const today = new Date().toISOString().slice(0, 10);
    const startDate = dateValue(filters.startDate, 'startDate', true)
      || `${today.slice(0, 7)}-01`;
    const endDate = dateValue(filters.endDate, 'endDate', true) || today;
    if (startDate > endDate) throw new SalesError(400, 'startDate must be on or before endDate.');
    const salespeople = await client.query(
      'SELECT id, display_name FROM users WHERE organization_id=$1 AND active=TRUE ORDER BY display_name',
      [organizationId],
    );
    const targetVsActual = await client.query(
      `WITH actual AS (
           SELECT order_record.created_by AS salesperson_id,
                  date_trunc('month', invoice.invoice_date)::date AS target_month,
                  SUM(invoice.total - invoice.tax_amount) AS actual_amount
           FROM customer_invoices invoice
           JOIN sales_orders order_record ON order_record.id=invoice.sales_order_id
           WHERE invoice.organization_id=$1
             AND invoice.status IN ('Issued','Paid','Overdue')
             AND invoice.invoice_date >= $2::date
             AND invoice.invoice_date <= $3::date
           GROUP BY order_record.created_by, date_trunc('month', invoice.invoice_date)::date
         ), target AS (
           SELECT salesperson_id, target_month, target_amount
           FROM sales_targets
           WHERE organization_id=$1
             AND target_month >= date_trunc('month',$2::date)::date
             AND target_month <= date_trunc('month',$3::date)::date
         )
         SELECT COALESCE(actual.salesperson_id, target.salesperson_id) AS salesperson_id,
                person.display_name AS salesperson_name,
                COALESCE(actual.target_month, target.target_month) AS target_month,
                COALESCE(target.target_amount,0) AS target_amount,
                COALESCE(actual.actual_amount,0) AS actual_amount
         FROM actual FULL OUTER JOIN target
           ON target.salesperson_id=actual.salesperson_id AND target.target_month=actual.target_month
         LEFT JOIN users person ON person.id=COALESCE(actual.salesperson_id,target.salesperson_id)
         ORDER BY target_month DESC, salesperson_name`,
      [organizationId, startDate, endDate],
    );
    const commissionRules = await client.query(
      `SELECT rule.*, person.display_name AS salesperson_name
         FROM sales_commission_rules rule
         JOIN users person ON person.id=rule.salesperson_id
         WHERE rule.organization_id=$1 ORDER BY person.display_name, rule.effective_from DESC`,
      [organizationId],
    );
    const commissions = await client.query(
      `SELECT rule.id AS rule_id, rule.salesperson_id, person.display_name AS salesperson_name,
                SUM(invoice.total-invoice.tax_amount) AS eligible_sales,
                SUM((invoice.total-invoice.tax_amount)*rule.rate_percent/100) AS estimated_commission,
                rule.rate_percent
         FROM customer_invoices invoice
         JOIN sales_orders order_record ON order_record.id=invoice.sales_order_id
         JOIN sales_commission_rules rule
           ON rule.organization_id=invoice.organization_id
          AND rule.salesperson_id=order_record.created_by
          AND invoice.invoice_date >= rule.effective_from
          AND (rule.effective_to IS NULL OR invoice.invoice_date <= rule.effective_to)
          AND rule.active=TRUE
         JOIN users person ON person.id=rule.salesperson_id
         WHERE invoice.organization_id=$1 AND invoice.status IN ('Issued','Paid','Overdue')
           AND invoice.invoice_date >= $2::date AND invoice.invoice_date <= $3::date
         GROUP BY rule.id, rule.salesperson_id, person.display_name, rule.rate_percent
         ORDER BY person.display_name`,
      [organizationId, startDate, endDate],
    );
    const forecast = await client.query(
      `SELECT COALESCE(AVG(monthly_sales),0) AS average_monthly_sales
         FROM (
           SELECT date_trunc('month', invoice_date) AS month, SUM(total-tax_amount) AS monthly_sales
           FROM customer_invoices
           WHERE organization_id=$1 AND status IN ('Issued','Paid','Overdue')
             AND invoice_date >= date_trunc('month', CURRENT_DATE) - INTERVAL '3 months'
             AND invoice_date < date_trunc('month', CURRENT_DATE)
           GROUP BY date_trunc('month', invoice_date)
         ) monthly`,
      [organizationId],
    );
    return {
      startDate,
      endDate,
      salespeople: salespeople.rows,
      targetVsActual: targetVsActual.rows,
      commissionRules: commissionRules.rows,
      commissions: commissions.rows,
      forecast: {
        basis: 'Average net invoiced sales over the previous three complete calendar months',
        nextMonthNetSales: Number(forecast.rows[0]?.average_monthly_sales || 0),
      },
    };
  },

  async saveCommissionRule(client, organizationId, actorId, input = {}) {
    const salespersonId = requiredText(input.salespersonId, 'salespersonId');
    const ratePercent = amount(input.ratePercent, 'ratePercent');
    const effectiveFrom = dateValue(input.effectiveFrom, 'effectiveFrom', true) || new Date().toISOString().slice(0, 10);
    const effectiveTo = dateValue(input.effectiveTo, 'effectiveTo', true);
    if (effectiveTo && effectiveTo < effectiveFrom) throw new SalesError(400, 'effectiveTo must be on or after effectiveFrom.');
    const user = (await client.query(
      'SELECT id FROM users WHERE id=$1 AND organization_id=$2 AND active=TRUE',
      [salespersonId, organizationId],
    )).rows[0];
    if (!user) throw new SalesError(404, 'Active salesperson not found in this organization.');
    const overlap = await client.query(
      `SELECT id FROM sales_commission_rules
       WHERE organization_id=$1 AND salesperson_id=$2 AND active=TRUE
         AND ($4::date IS NULL OR effective_from <= $4::date)
         AND (effective_to IS NULL OR effective_to >= $3::date)
       LIMIT 1`,
      [organizationId, salespersonId, effectiveFrom, effectiveTo],
    );
    if (overlap.rows[0]) throw new SalesError(409, 'Commission rule dates overlap an existing active rule for this salesperson.');
    const result = await client.query(
      `INSERT INTO sales_commission_rules
         (organization_id, salesperson_id, rate_percent, effective_from, effective_to, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [organizationId, salespersonId, ratePercent, effectiveFrom, effectiveTo, actorId],
    );
    await audit(client, organizationId, actorId, 'sales_commission_rule_created', 'sales_commission_rule', result.rows[0].id, {
      salespersonId, ratePercent, effectiveFrom, effectiveTo,
    });
    return result.rows[0];
  },

  async saveSalesTarget(client, organizationId, actorId, input = {}) {
    const salespersonId = requiredText(input.salespersonId, 'salespersonId');
    const month = dateValue(input.targetMonth, 'targetMonth');
    if (!month.endsWith('-01')) throw new SalesError(400, 'targetMonth must be the first day of a month.');
    const targetAmount = amount(input.targetAmount, 'targetAmount', { max: Number.MAX_SAFE_INTEGER });
    const user = (await client.query(
      'SELECT id FROM users WHERE id=$1 AND organization_id=$2 AND active=TRUE',
      [salespersonId, organizationId],
    )).rows[0];
    if (!user) throw new SalesError(404, 'Active salesperson not found in this organization.');
    const result = await client.query(
      `INSERT INTO sales_targets (organization_id, salesperson_id, target_month, target_amount, created_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (organization_id, salesperson_id, target_month)
       DO UPDATE SET target_amount=EXCLUDED.target_amount, created_by=EXCLUDED.created_by, updated_at=CURRENT_TIMESTAMP
       RETURNING *`,
      [organizationId, salespersonId, month, targetAmount, actorId],
    );
    await audit(client, organizationId, actorId, 'sales_target_saved', 'sales_target', result.rows[0].id, {
      salespersonId, month, targetAmount,
    });
    return result.rows[0];
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

  async listCustomerInsights(client, organizationId) {
    return (await client.query(
      `SELECT c.id AS customer_id, c.customer_code, c.legal_name,
              purchases.purchase_count, purchases.lifetime_value, purchases.last_purchase_date,
              balances.outstanding, balances.overdue_amount,
              CASE
                WHEN purchases.purchase_count = 0 THEN 'PROSPECT'
                WHEN purchases.last_purchase_date < CURRENT_DATE - INTERVAL '180 days' THEN 'AT_RISK'
                WHEN purchases.purchase_count >= 5 THEN 'LOYAL'
                WHEN purchases.purchase_count >= 2 THEN 'REPEAT'
                ELSE 'NEW'
              END AS segment,
              balances.overdue_amount > 0 AS overdue_warning
       FROM customers c
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::INTEGER AS purchase_count,
                COALESCE(SUM(invoice.total), 0) AS lifetime_value,
                MAX(invoice.invoice_date) AS last_purchase_date
         FROM customer_invoices invoice
         WHERE invoice.organization_id=c.organization_id AND invoice.customer_id=c.id
           AND invoice.status IN ('Issued','Paid','Overdue')
       ) purchases ON TRUE
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(ar.outstanding), 0) AS outstanding,
                COALESCE(SUM(ar.outstanding) FILTER (WHERE ar.due_date < CURRENT_DATE), 0) AS overdue_amount
         FROM accounts_receivable ar
         WHERE ar.organization_id=c.organization_id AND ar.customer_id=c.id AND ar.outstanding > 0
       ) balances ON TRUE
       WHERE c.organization_id=$1
       ORDER BY purchases.lifetime_value DESC, c.legal_name`,
      [organizationId],
    )).rows;
  },

  async listCrmRecords(client, organizationId) {
    return (await client.query(
      `SELECT record.*, customer.legal_name AS customer_name
       FROM sales_crm_records record
       LEFT JOIN customers customer ON customer.id=record.customer_id AND customer.organization_id=record.organization_id
       WHERE record.organization_id=$1 ORDER BY record.updated_at DESC`,
      [organizationId],
    )).rows;
  },

  async listCustomerActivities(client, organizationId) {
    return (await client.query(
      `SELECT activity.*, customer.legal_name AS customer_name, record.name AS crm_record_name,
              actor.display_name AS created_by_name
       FROM sales_customer_activities activity
       LEFT JOIN customers customer ON customer.id=activity.customer_id
       LEFT JOIN sales_crm_records record ON record.id=activity.crm_record_id
       LEFT JOIN users actor ON actor.id=activity.created_by
       WHERE activity.organization_id=$1 ORDER BY activity.activity_date DESC LIMIT 500`,
      [organizationId],
    )).rows;
  },

  async createCrmRecord(client, organizationId, actorId, input) {
    const recordType = String(input.recordType || '').toUpperCase();
    if (!['LEAD', 'OPPORTUNITY'].includes(recordType)) throw new SalesError(400, 'recordType must be LEAD or OPPORTUNITY.');
    const name = requiredText(input.name, 'name').slice(0, 180);
    const customerId = input.customerId || null;
    if (customerId) await ensureCustomer(client, organizationId, customerId);
    const estimatedValue = amount(input.estimatedValue, 'estimatedValue', { max: Number.MAX_SAFE_INTEGER });
    const expectedCloseDate = dateValue(input.expectedCloseDate, 'expectedCloseDate', true);
    const result = await client.query(
      `INSERT INTO sales_crm_records
         (organization_id, customer_id, record_type, name, contact_name, email, phone, source, stage,
          estimated_value, expected_close_date, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [organizationId, customerId, recordType, name, input.contactName || null, input.email || null,
        input.phone || null, input.source || null, input.stage || 'NEW', estimatedValue, expectedCloseDate,
        input.notes || null, actorId],
    );
    await audit(client, organizationId, actorId, 'crm_record_created', recordType.toLowerCase(), result.rows[0].id, { name, customerId });
    return result.rows[0];
  },

  async updateCrmRecord(client, organizationId, actorId, recordId, input) {
    const allowedStages = new Set(['NEW', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST']);
    return transaction(client, async () => {
      const record = (await client.query(
        'SELECT * FROM sales_crm_records WHERE id=$1 AND organization_id=$2 FOR UPDATE',
        [recordId, organizationId],
      )).rows[0];
      if (!record) throw new SalesError(404, 'CRM lead or opportunity not found.');
      const stage = input.stage === undefined ? record.stage : String(input.stage).toUpperCase();
      if (!allowedStages.has(stage)) {
        throw new SalesError(400, 'stage must be NEW, QUALIFIED, PROPOSAL, NEGOTIATION, WON, or LOST.');
      }
      const estimatedValue = input.estimatedValue === undefined
        ? record.estimated_value
        : amount(input.estimatedValue, 'estimatedValue', { max: Number.MAX_SAFE_INTEGER });
      const expectedCloseDate = input.expectedCloseDate === undefined
        ? record.expected_close_date
        : dateValue(input.expectedCloseDate, 'expectedCloseDate', true);
      const notes = input.notes === undefined ? record.notes : input.notes;
      const updated = (await client.query(
        `UPDATE sales_crm_records
         SET stage=$1, estimated_value=$2, expected_close_date=$3, notes=$4, updated_at=CURRENT_TIMESTAMP
         WHERE id=$5 AND organization_id=$6 RETURNING *`,
        [stage, estimatedValue, expectedCloseDate, notes, record.id, organizationId],
      )).rows[0];
      await audit(client, organizationId, actorId, 'crm_record_updated', record.record_type.toLowerCase(), record.id, {
        before: { stage: record.stage, estimatedValue: record.estimated_value, expectedCloseDate: record.expected_close_date, notes: record.notes },
        after: { stage, estimatedValue, expectedCloseDate, notes },
      });
      return updated;
    });
  },

  async createCustomerActivity(client, organizationId, actorId, input) {
    const activityType = String(input.activityType || '').toUpperCase();
    if (!['CALL', 'EMAIL', 'MEETING', 'NOTE', 'FOLLOW_UP'].includes(activityType)) {
      throw new SalesError(400, 'activityType must be CALL, EMAIL, MEETING, NOTE, or FOLLOW_UP.');
    }
    const subject = requiredText(input.subject, 'subject').slice(0, 180);
    let customerId = input.customerId || null;
    let crmRecordId = input.crmRecordId || null;
    if (crmRecordId) {
      const record = (await client.query(
        'SELECT customer_id FROM sales_crm_records WHERE id=$1 AND organization_id=$2',
        [crmRecordId, organizationId],
      )).rows[0];
      if (!record) throw new SalesError(404, 'CRM lead or opportunity not found.');
      customerId ||= record.customer_id;
    }
    if (customerId) await ensureCustomer(client, organizationId, customerId);
    if (!customerId && !crmRecordId) throw new SalesError(400, 'customerId or crmRecordId is required.');
    const followUp = dateValue(input.nextFollowUp, 'nextFollowUp', true);
    const result = await client.query(
      `INSERT INTO sales_customer_activities
         (organization_id, customer_id, crm_record_id, activity_type, subject, details, next_follow_up, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [organizationId, customerId, crmRecordId, activityType, subject, input.details || null, followUp, actorId],
    );
    await audit(client, organizationId, actorId, 'customer_activity_recorded', 'customer_activity', result.rows[0].id, { subject, activityType });
    return result.rows[0];
  },

  async listReceivableDisputes(client, organizationId) {
    return (await client.query(
      `SELECT dispute.*, ar.invoice_id, ar.outstanding, ar.due_date, invoice.invoice_number,
              customer.legal_name AS customer_name
       FROM sales_receivable_disputes dispute
       JOIN accounts_receivable ar ON ar.id=dispute.receivable_id AND ar.organization_id=dispute.organization_id
       JOIN customer_invoices invoice ON invoice.id=ar.invoice_id
       JOIN customers customer ON customer.id=ar.customer_id
       WHERE dispute.organization_id=$1 ORDER BY dispute.created_at DESC`,
      [organizationId],
    )).rows;
  },

  async createReceivableDispute(client, organizationId, actorId, input) {
    const receivableId = requiredText(input.receivableId, 'receivableId');
    const reason = requiredText(input.reason, 'reason').slice(0, 240);
    const receivable = (await client.query(
      'SELECT id FROM accounts_receivable WHERE id=$1 AND organization_id=$2 AND outstanding > 0',
      [receivableId, organizationId],
    )).rows[0];
    if (!receivable) throw new SalesError(404, 'Open receivable not found.');
    const result = await client.query(
      `INSERT INTO sales_receivable_disputes (organization_id, receivable_id, reason, created_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [organizationId, receivableId, reason, actorId],
    );
    await audit(client, organizationId, actorId, 'receivable_dispute_opened', 'receivable_dispute', result.rows[0].id, { receivableId, reason });
    return result.rows[0];
  },

  async updateReceivableDispute(client, organizationId, actorId, disputeId, status, resolution) {
    const nextStatus = String(status || '').toUpperCase();
    if (!['UNDER_REVIEW', 'RESOLVED', 'REJECTED'].includes(nextStatus)) {
      throw new SalesError(400, 'status must be UNDER_REVIEW, RESOLVED, or REJECTED.');
    }
    if (['RESOLVED', 'REJECTED'].includes(nextStatus) && !String(resolution || '').trim()) {
      throw new SalesError(400, 'A resolution note is required to close a dispute.');
    }
    const result = await client.query(
      `UPDATE sales_receivable_disputes
       SET status=$1::varchar, resolution=COALESCE(NULLIF($2::text,''), resolution),
           resolved_by=CASE WHEN $1::varchar IN ('RESOLVED','REJECTED') THEN $3 ELSE resolved_by END,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$4 AND organization_id=$5 AND status IN ('OPEN','UNDER_REVIEW')
       RETURNING *`,
      [nextStatus, String(resolution || '').trim(), actorId, disputeId, organizationId],
    );
    if (!result.rows[0]) throw new SalesError(409, 'Open receivable dispute not found or already closed.');
    await audit(client, organizationId, actorId, 'receivable_dispute_updated', 'receivable_dispute', disputeId, { status: nextStatus });
    return result.rows[0];
  },

  async listAudit(client, organizationId) {
    return (await client.query('SELECT * FROM sales_audit_trail WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 500', [organizationId])).rows;
  },
};
