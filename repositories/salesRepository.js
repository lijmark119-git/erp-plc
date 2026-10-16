import { randomUUID } from 'node:crypto';

export class SalesRepository {
  constructor(databasePool) {
    this.pool = databasePool;
  }

  // ============ CUSTOMER OPERATIONS ============

  async createCustomer(organizationId, customerData) {
    if (!this.pool) return null;
    const customerCode = customerData.customerCode || `CUST-${Date.now()}`;
    const result = await this.pool.query(
      `INSERT INTO customers 
       (customer_code, legal_name, contact_person, phone, email, tax_id, credit_limit, payment_terms, currency, organization_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        customerCode,
        customerData.legal_name || '',
        customerData.contact_person || '',
        customerData.phone || '',
        customerData.email || '',
        customerData.tax_id || '',
        customerData.credit_limit || 0,
        customerData.payment_terms || '30 days',
        customerData.currency || 'ETB',
        organizationId,
      ]
    );
    return result.rows[0] || null;
  }

  async getCustomers(organizationId) {
    if (!this.pool) return [];
    const result = await this.pool.query(
      `SELECT * FROM customers WHERE organization_id = $1 ORDER BY created_at DESC`,
      [organizationId]
    );
    return result.rows || [];
  }

  async getCustomerById(customerId) {
    if (!this.pool) return null;
    const result = await this.pool.query(`SELECT * FROM customers WHERE id = $1`, [customerId]);
    return result.rows[0] || null;
  }

  async updateCustomer(customerId, customerData) {
    if (!this.pool) return null;
    const updates = [];
    const values = [];
    let paramCount = 1;
    if (customerData.legal_name !== undefined) {
      updates.push(`legal_name = $${paramCount++}`);
      values.push(customerData.legal_name);
    }
    if (customerData.contact_person !== undefined) {
      updates.push(`contact_person = $${paramCount++}`);
      values.push(customerData.contact_person);
    }
    if (customerData.phone !== undefined) {
      updates.push(`phone = $${paramCount++}`);
      values.push(customerData.phone);
    }
    if (customerData.email !== undefined) {
      updates.push(`email = $${paramCount++}`);
      values.push(customerData.email);
    }
    if (customerData.credit_limit !== undefined) {
      updates.push(`credit_limit = $${paramCount++}`);
      values.push(customerData.credit_limit);
    }
    if (customerData.payment_terms !== undefined) {
      updates.push(`payment_terms = $${paramCount++}`);
      values.push(customerData.payment_terms);
    }
    if (customerData.active !== undefined) {
      updates.push(`active = $${paramCount++}`);
      values.push(customerData.active);
    }
    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(customerId);
    if (updates.length === 1) return null;
    const result = await this.pool.query(
      `UPDATE customers SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );
    return result.rows[0] || null;
  }

  // ============ QUOTATION OPERATIONS ============

  async createQuotation(organizationId, quotationData) {
    if (!this.pool) return null;
    const quotationNumber = quotationData.quotationNumber || `Q-${Date.now()}`;
    const result = await this.pool.query(
      `INSERT INTO quotations 
       (quotation_number, customer_id, created_by, quotation_date, validity_date, status, subtotal, discount_amount, discount_percent, tax_amount, total, organization_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        quotationNumber,
        quotationData.customer_id,
        quotationData.created_by,
        quotationData.quotation_date || new Date().toISOString().split('T')[0],
        quotationData.validity_date,
        'Draft',
        quotationData.subtotal || 0,
        quotationData.discount_amount || 0,
        quotationData.discount_percent || 0,
        quotationData.tax_amount || 0,
        quotationData.total || 0,
        organizationId,
      ]
    );
    return result.rows[0] || null;
  }

  async getQuotations(organizationId) {
    if (!this.pool) return [];
    const result = await this.pool.query(
      `SELECT q.*, c.legal_name as customer_name 
       FROM quotations q
       LEFT JOIN customers c ON q.customer_id = c.id
       WHERE q.organization_id = $1 ORDER BY q.created_at DESC`,
      [organizationId]
    );
    return result.rows || [];
  }

  async getQuotationById(quotationId) {
    if (!this.pool) return null;
    const result = await this.pool.query(
      `SELECT * FROM quotations WHERE id = $1`,
      [quotationId]
    );
    return result.rows[0] || null;
  }

  async updateQuotationStatus(quotationId, newStatus) {
    if (!this.pool) return null;
    const result = await this.pool.query(
      `UPDATE quotations SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
      [newStatus, quotationId]
    );
    return result.rows[0] || null;
  }

  async addQuotationLine(quotationId, lineData) {
    if (!this.pool) return null;
    const result = await this.pool.query(
      `INSERT INTO quotation_lines 
       (quotation_id, product_sku, product_name, quantity, unit_price, discount_percent, tax_percent, line_total)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        quotationId,
        lineData.product_sku,
        lineData.product_name,
        lineData.quantity,
        lineData.unit_price,
        lineData.discount_percent || 0,
        lineData.tax_percent || 0,
        lineData.line_total || 0,
      ]
    );
    return result.rows[0] || null;
  }

  // ============ SALES ORDER OPERATIONS ============

  async createSalesOrder(organizationId, orderData) {
    if (!this.pool) return null;
    const orderNumber = orderData.orderNumber || `SO-${Date.now()}`;
    const result = await this.pool.query(
      `INSERT INTO sales_orders 
       (order_number, customer_id, quotation_id, created_by, order_date, delivery_date, status, approval_status, subtotal, discount_amount, discount_percent, tax_amount, total, payment_terms, organization_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING *`,
      [
        orderNumber,
        orderData.customer_id,
        orderData.quotation_id || null,
        orderData.created_by,
        orderData.order_date || new Date().toISOString().split('T')[0],
        orderData.delivery_date,
        'Draft',
        'Pending',
        orderData.subtotal || 0,
        orderData.discount_amount || 0,
        orderData.discount_percent || 0,
        orderData.tax_amount || 0,
        orderData.total || 0,
        orderData.payment_terms || '30 days',
        organizationId,
      ]
    );
    return result.rows[0] || null;
  }

  async getSalesOrders(organizationId) {
    if (!this.pool) return [];
    const result = await this.pool.query(
      `SELECT so.*, c.legal_name as customer_name 
       FROM sales_orders so
       LEFT JOIN customers c ON so.customer_id = c.id
       WHERE so.organization_id = $1 ORDER BY so.created_at DESC`,
      [organizationId]
    );
    return result.rows || [];
  }

  async getSalesOrderById(orderId) {
    if (!this.pool) return null;
    const result = await this.pool.query(
      `SELECT * FROM sales_orders WHERE id = $1`,
      [orderId]
    );
    return result.rows[0] || null;
  }

  async updateSalesOrderStatus(orderId, newStatus) {
    if (!this.pool) return null;
    const result = await this.pool.query(
      `UPDATE sales_orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
      [newStatus, orderId]
    );
    return result.rows[0] || null;
  }

  async approveSalesOrder(orderId, approvedBy) {
    if (!this.pool) return null;
    const result = await this.pool.query(
      `UPDATE sales_orders SET approval_status = $1, approved_by = $2, status = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4 RETURNING *`,
      ['Approved', approvedBy, 'Submitted', orderId]
    );
    return result.rows[0] || null;
  }

  async addSalesOrderLine(orderId, lineData) {
    if (!this.pool) return null;
    const result = await this.pool.query(
      `INSERT INTO sales_order_lines 
       (sales_order_id, product_sku, product_name, quantity, unit_price, discount_percent, tax_percent, line_total)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        orderId,
        lineData.product_sku,
        lineData.product_name,
        lineData.quantity,
        lineData.unit_price,
        lineData.discount_percent || 0,
        lineData.tax_percent || 0,
        lineData.line_total || 0,
      ]
    );
    return result.rows[0] || null;
  }

  // ============ DELIVERY OPERATIONS ============

  async createDeliveryNote(organizationId, deliveryData) {
    if (!this.pool) return null;
    const deliveryNumber = deliveryData.deliveryNumber || `DN-${Date.now()}`;
    const result = await this.pool.query(
      `INSERT INTO delivery_notes 
       (delivery_number, sales_order_id, customer_id, delivery_date, status, warehouse_id, organization_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        deliveryNumber,
        deliveryData.sales_order_id,
        deliveryData.customer_id,
        deliveryData.delivery_date || new Date().toISOString().split('T')[0],
        'Pending',
        deliveryData.warehouse_id || '',
        organizationId,
      ]
    );
    return result.rows[0] || null;
  }

  async getDeliveryNotes(organizationId) {
    if (!this.pool) return [];
    const result = await this.pool.query(
      `SELECT dn.*, c.legal_name as customer_name, so.order_number 
       FROM delivery_notes dn
       LEFT JOIN customers c ON dn.customer_id = c.id
       LEFT JOIN sales_orders so ON dn.sales_order_id = so.id
       WHERE dn.organization_id = $1 ORDER BY dn.created_at DESC`,
      [organizationId]
    );
    return result.rows || [];
  }

  async updateDeliveryStatus(deliveryId, newStatus) {
    if (!this.pool) return null;
    const result = await this.pool.query(
      `UPDATE delivery_notes SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
      [newStatus, deliveryId]
    );
    return result.rows[0] || null;
  }

  // ============ INVOICE OPERATIONS ============

  async createInvoice(organizationId, invoiceData) {
    if (!this.pool) return null;
    const invoiceNumber = invoiceData.invoiceNumber || `INV-${Date.now()}`;
    const result = await this.pool.query(
      `INSERT INTO customer_invoices 
       (invoice_number, customer_id, sales_order_id, delivery_id, invoice_date, due_date, status, subtotal, discount_amount, tax_amount, total, organization_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        invoiceNumber,
        invoiceData.customer_id,
        invoiceData.sales_order_id || null,
        invoiceData.delivery_id || null,
        invoiceData.invoice_date || new Date().toISOString().split('T')[0],
        invoiceData.due_date,
        'Draft',
        invoiceData.subtotal || 0,
        invoiceData.discount_amount || 0,
        invoiceData.tax_amount || 0,
        invoiceData.total || 0,
        organizationId,
      ]
    );
    return result.rows[0] || null;
  }

  async getInvoices(organizationId) {
    if (!this.pool) return [];
    const result = await this.pool.query(
      `SELECT ci.*, c.legal_name as customer_name 
       FROM customer_invoices ci
       LEFT JOIN customers c ON ci.customer_id = c.id
       WHERE ci.organization_id = $1 ORDER BY ci.created_at DESC`,
      [organizationId]
    );
    return result.rows || [];
  }

  async getInvoiceById(invoiceId) {
    if (!this.pool) return null;
    const result = await this.pool.query(
      `SELECT * FROM customer_invoices WHERE id = $1`,
      [invoiceId]
    );
    return result.rows[0] || null;
  }

  async updateInvoiceStatus(invoiceId, newStatus) {
    if (!this.pool) return null;
    const result = await this.pool.query(
      `UPDATE customer_invoices SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
      [newStatus, invoiceId]
    );
    return result.rows[0] || null;
  }

  async addInvoiceLine(invoiceId, lineData) {
    if (!this.pool) return null;
    const result = await this.pool.query(
      `INSERT INTO invoice_lines 
       (invoice_id, product_sku, product_name, quantity, unit_price, discount_percent, tax_percent, line_total)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        invoiceId,
        lineData.product_sku,
        lineData.product_name,
        lineData.quantity,
        lineData.unit_price,
        lineData.discount_percent || 0,
        lineData.tax_percent || 0,
        lineData.line_total || 0,
      ]
    );
    return result.rows[0] || null;
  }

  // ============ PAYMENT OPERATIONS ============

  async recordPayment(organizationId, paymentData) {
    if (!this.pool) return null;
    const paymentNumber = paymentData.paymentNumber || `PAY-${Date.now()}`;
    const result = await this.pool.query(
      `INSERT INTO customer_payments 
       (payment_number, invoice_id, customer_id, payment_date, payment_method, amount, reference_number, recorded_by, organization_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        paymentNumber,
        paymentData.invoice_id,
        paymentData.customer_id,
        paymentData.payment_date || new Date().toISOString().split('T')[0],
        paymentData.payment_method || 'bank',
        paymentData.amount,
        paymentData.reference_number || '',
        paymentData.recorded_by,
        organizationId,
      ]
    );
    return result.rows[0] || null;
  }

  async getPayments(organizationId) {
    if (!this.pool) return [];
    const result = await this.pool.query(
      `SELECT cp.*, c.legal_name as customer_name, ci.invoice_number 
       FROM customer_payments cp
       LEFT JOIN customers c ON cp.customer_id = c.id
       LEFT JOIN customer_invoices ci ON cp.invoice_id = ci.id
       WHERE cp.organization_id = $1 ORDER BY cp.created_at DESC`,
      [organizationId]
    );
    return result.rows || [];
  }

  // ============ ACCOUNTS RECEIVABLE ============

  async createArRecord(organizationId, arData) {
    if (!this.pool) return null;
    const result = await this.pool.query(
      `INSERT INTO accounts_receivable 
       (invoice_id, customer_id, invoice_total, payment_received, outstanding, invoice_date, due_date, status, organization_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        arData.invoice_id,
        arData.customer_id,
        arData.invoice_total,
        arData.payment_received || 0,
        arData.outstanding || arData.invoice_total,
        arData.invoice_date,
        arData.due_date,
        'Outstanding',
        organizationId,
      ]
    );
    return result.rows[0] || null;
  }

  async getArRecords(organizationId) {
    if (!this.pool) return [];
    const result = await this.pool.query(
      `SELECT ar.*, c.legal_name as customer_name 
       FROM accounts_receivable ar
       LEFT JOIN customers c ON ar.customer_id = c.id
       WHERE ar.organization_id = $1 ORDER BY ar.due_date ASC`,
      [organizationId]
    );
    return result.rows || [];
  }

  async updateArRecord(arId, arData) {
    if (!this.pool) return null;
    const updates = [];
    const values = [];
    let paramCount = 1;
    if (arData.payment_received !== undefined) {
      updates.push(`payment_received = $${paramCount++}`);
      values.push(arData.payment_received);
    }
    if (arData.outstanding !== undefined) {
      updates.push(`outstanding = $${paramCount++}`);
      values.push(arData.outstanding);
    }
    if (arData.status !== undefined) {
      updates.push(`status = $${paramCount++}`);
      values.push(arData.status);
    }
    if (arData.days_overdue !== undefined) {
      updates.push(`days_overdue = $${paramCount++}`);
      values.push(arData.days_overdue);
    }
    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(arId);
    if (updates.length === 1) return null;
    const result = await this.pool.query(
      `UPDATE accounts_receivable SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );
    return result.rows[0] || null;
  }

  // ============ SALES REPORTS ============

  async getSalesReports(organizationId, reportType) {
    if (!this.pool) return [];
    const result = await this.pool.query(
      `SELECT * FROM sales_reports 
       WHERE organization_id = $1 ${reportType ? 'AND report_type = $2' : ''}
       ORDER BY report_date DESC`,
      reportType ? [organizationId, reportType] : [organizationId]
    );
    return result.rows || [];
  }

  async saveSalesReport(organizationId, reportData) {
    if (!this.pool) return null;
    const result = await this.pool.query(
      `INSERT INTO sales_reports 
       (organization_id, report_date, report_type, total_sales, total_discount, total_tax, net_sales, total_receivables, aging_30, aging_60, aging_90, aging_over_90)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        organizationId,
        reportData.report_date || new Date().toISOString().split('T')[0],
        reportData.report_type || 'summary',
        reportData.total_sales || 0,
        reportData.total_discount || 0,
        reportData.total_tax || 0,
        reportData.net_sales || 0,
        reportData.total_receivables || 0,
        reportData.aging_30 || 0,
        reportData.aging_60 || 0,
        reportData.aging_90 || 0,
        reportData.aging_over_90 || 0,
      ]
    );
    return result.rows[0] || null;
  }
}
