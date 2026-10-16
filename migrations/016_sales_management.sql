-- Sales Management Schema
-- Customers, Quotations, Sales Orders, Deliveries, Invoices, Payments, Receivables

CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_code VARCHAR(50) NOT NULL UNIQUE,
  legal_name VARCHAR(255) NOT NULL,
  contact_person VARCHAR(255),
  phone VARCHAR(20),
  email VARCHAR(255),
  tax_id VARCHAR(50),
  credit_limit DECIMAL(15, 2) DEFAULT 0,
  payment_terms VARCHAR(100) DEFAULT '30 days',
  currency VARCHAR(3) DEFAULT 'ETB',
  active BOOLEAN DEFAULT TRUE,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS customer_addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  address_type VARCHAR(50), -- billing, shipping, delivery
  address_line VARCHAR(500),
  city VARCHAR(100),
  region VARCHAR(100),
  postal_code VARCHAR(20),
  country VARCHAR(100),
  is_primary BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS quotations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_number VARCHAR(50) NOT NULL UNIQUE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  created_by UUID REFERENCES users(id),
  quotation_date DATE DEFAULT CURRENT_DATE,
  validity_date DATE,
  status VARCHAR(50) DEFAULT 'Draft', -- Draft, Submitted, Approved, Rejected, Expired, Converted
  subtotal DECIMAL(15, 2) DEFAULT 0,
  discount_amount DECIMAL(15, 2) DEFAULT 0,
  discount_percent DECIMAL(5, 2) DEFAULT 0,
  tax_amount DECIMAL(15, 2) DEFAULT 0,
  total DECIMAL(15, 2) DEFAULT 0,
  notes TEXT,
  terms TEXT,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS quotation_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_id UUID NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  product_sku VARCHAR(50),
  product_name VARCHAR(255),
  quantity DECIMAL(12, 2),
  unit_price DECIMAL(15, 2),
  discount_percent DECIMAL(5, 2) DEFAULT 0,
  tax_percent DECIMAL(5, 2) DEFAULT 0,
  line_total DECIMAL(15, 2),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sales_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number VARCHAR(50) NOT NULL UNIQUE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  quotation_id UUID REFERENCES quotations(id),
  created_by UUID REFERENCES users(id),
  order_date DATE DEFAULT CURRENT_DATE,
  delivery_date DATE,
  status VARCHAR(50) DEFAULT 'Draft', -- Draft, Submitted, Approved, Cancelled
  approval_status VARCHAR(50) DEFAULT 'Pending', -- Pending, Approved, Rejected
  approved_by UUID REFERENCES users(id),
  subtotal DECIMAL(15, 2) DEFAULT 0,
  discount_amount DECIMAL(15, 2) DEFAULT 0,
  discount_percent DECIMAL(5, 2) DEFAULT 0,
  tax_amount DECIMAL(15, 2) DEFAULT 0,
  total DECIMAL(15, 2) DEFAULT 0,
  payment_terms VARCHAR(100),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sales_order_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id UUID NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  product_sku VARCHAR(50),
  product_name VARCHAR(255),
  quantity DECIMAL(12, 2),
  unit_price DECIMAL(15, 2),
  discount_percent DECIMAL(5, 2) DEFAULT 0,
  tax_percent DECIMAL(5, 2) DEFAULT 0,
  line_total DECIMAL(15, 2),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS delivery_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_number VARCHAR(50) NOT NULL UNIQUE,
  sales_order_id UUID NOT NULL REFERENCES sales_orders(id),
  customer_id UUID NOT NULL REFERENCES customers(id),
  delivery_date DATE DEFAULT CURRENT_DATE,
  status VARCHAR(50) DEFAULT 'Pending', -- Pending, Picking, Packed, Shipped, Delivered, Returned
  warehouse_id VARCHAR(50),
  carrier VARCHAR(255),
  tracking_number VARCHAR(100),
  delivered_by UUID REFERENCES users(id),
  notes TEXT,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS delivery_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id UUID NOT NULL REFERENCES delivery_notes(id) ON DELETE CASCADE,
  product_sku VARCHAR(50),
  product_name VARCHAR(255),
  ordered_qty DECIMAL(12, 2),
  picked_qty DECIMAL(12, 2) DEFAULT 0,
  packed_qty DECIMAL(12, 2) DEFAULT 0,
  delivered_qty DECIMAL(12, 2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS customer_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number VARCHAR(50) NOT NULL UNIQUE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  sales_order_id UUID REFERENCES sales_orders(id),
  delivery_id UUID REFERENCES delivery_notes(id),
  invoice_date DATE DEFAULT CURRENT_DATE,
  due_date DATE,
  status VARCHAR(50) DEFAULT 'Draft', -- Draft, Issued, Paid, Overdue, Cancelled
  subtotal DECIMAL(15, 2) DEFAULT 0,
  discount_amount DECIMAL(15, 2) DEFAULT 0,
  tax_amount DECIMAL(15, 2) DEFAULT 0,
  total DECIMAL(15, 2) DEFAULT 0,
  paid_amount DECIMAL(15, 2) DEFAULT 0,
  notes TEXT,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES customer_invoices(id) ON DELETE CASCADE,
  product_sku VARCHAR(50),
  product_name VARCHAR(255),
  quantity DECIMAL(12, 2),
  unit_price DECIMAL(15, 2),
  discount_percent DECIMAL(5, 2) DEFAULT 0,
  tax_percent DECIMAL(5, 2) DEFAULT 0,
  line_total DECIMAL(15, 2),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS customer_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_number VARCHAR(50) NOT NULL UNIQUE,
  invoice_id UUID NOT NULL REFERENCES customer_invoices(id),
  customer_id UUID NOT NULL REFERENCES customers(id),
  payment_date DATE DEFAULT CURRENT_DATE,
  payment_method VARCHAR(50), -- cash, bank, transfer, cheque, other
  amount DECIMAL(15, 2),
  reference_number VARCHAR(100),
  notes TEXT,
  recorded_by UUID REFERENCES users(id),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS accounts_receivable (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES customer_invoices(id),
  customer_id UUID NOT NULL REFERENCES customers(id),
  invoice_total DECIMAL(15, 2),
  payment_received DECIMAL(15, 2) DEFAULT 0,
  outstanding DECIMAL(15, 2),
  invoice_date DATE,
  due_date DATE,
  days_overdue INTEGER DEFAULT 0,
  status VARCHAR(50) DEFAULT 'Outstanding', -- Outstanding, Partial, Paid, Overdue
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sales_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  report_date DATE,
  report_type VARCHAR(50), -- by_customer, by_product, by_salesperson, by_period
  total_sales DECIMAL(15, 2),
  total_discount DECIMAL(15, 2),
  total_tax DECIMAL(15, 2),
  net_sales DECIMAL(15, 2),
  total_receivables DECIMAL(15, 2),
  aging_30 DECIMAL(15, 2),
  aging_60 DECIMAL(15, 2),
  aging_90 DECIMAL(15, 2),
  aging_over_90 DECIMAL(15, 2),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_customers_org ON customers(organization_id);
CREATE INDEX IF NOT EXISTS idx_customers_code ON customers(customer_code);
CREATE INDEX IF NOT EXISTS idx_quotations_customer ON quotations(customer_id);
CREATE INDEX IF NOT EXISTS idx_quotations_org ON quotations(organization_id);
CREATE INDEX IF NOT EXISTS idx_quotations_status ON quotations(status);
CREATE INDEX IF NOT EXISTS idx_sales_orders_customer ON sales_orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_orders_org ON sales_orders(organization_id);
CREATE INDEX IF NOT EXISTS idx_sales_orders_status ON sales_orders(status);
CREATE INDEX IF NOT EXISTS idx_sales_orders_approval ON sales_orders(approval_status);
CREATE INDEX IF NOT EXISTS idx_delivery_notes_order ON delivery_notes(sales_order_id);
CREATE INDEX IF NOT EXISTS idx_delivery_notes_org ON delivery_notes(organization_id);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON customer_invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_org ON customer_invoices(organization_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON customer_invoices(status);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON customer_payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_org ON customer_payments(organization_id);
CREATE INDEX IF NOT EXISTS idx_ar_customer ON accounts_receivable(customer_id);
CREATE INDEX IF NOT EXISTS idx_ar_invoice ON accounts_receivable(invoice_id);
CREATE INDEX IF NOT EXISTS idx_ar_org ON accounts_receivable(organization_id);
CREATE INDEX IF NOT EXISTS idx_ar_status ON accounts_receivable(status);

-- Audit trail for sales
CREATE TABLE IF NOT EXISTS sales_audit_trail (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  action VARCHAR(50),
  entity_type VARCHAR(50),
  entity_id UUID,
  user_id UUID REFERENCES users(id),
  changes JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sales_audit_org ON sales_audit_trail(organization_id);
CREATE INDEX IF NOT EXISTS idx_sales_audit_entity ON sales_audit_trail(entity_type, entity_id);
