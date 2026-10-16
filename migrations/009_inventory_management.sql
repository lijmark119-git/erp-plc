CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS inventory_uoms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code VARCHAR(20) NOT NULL,
  name VARCHAR(120) NOT NULL,
  base_unit VARCHAR(20) NOT NULL DEFAULT 'piece',
  factor NUMERIC(20, 10) NOT NULL DEFAULT 1 CHECK (factor > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS inventory_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sku VARCHAR(80) NOT NULL,
  product_code VARCHAR(80),
  barcode VARCHAR(128),
  name VARCHAR(240) NOT NULL,
  description TEXT,
  category VARCHAR(120),
  brand VARCHAR(120),
  product_type VARCHAR(30) NOT NULL CHECK (
    product_type IN (
      'RAW_MATERIAL', 'FINISHED_GOOD', 'SEMI_FINISHED_GOOD',
      'TRADING_PRODUCT', 'CONSUMABLE', 'SPARE_PART', 'SERVICE'
    )
  ),
  unit_of_measure_id UUID NOT NULL REFERENCES inventory_uoms(id) ON DELETE RESTRICT,
  purchase_price NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (purchase_price >= 0),
  sales_price NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (sales_price >= 0),
  standard_cost NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (standard_cost >= 0),
  tax_category VARCHAR(80) NOT NULL DEFAULT 'STANDARD',
  minimum_stock NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (minimum_stock >= 0),
  maximum_stock NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (maximum_stock >= 0),
  reorder_level NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  reorder_quantity NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (reorder_quantity > 0),
  inventory_account_code VARCHAR(40) NOT NULL DEFAULT '1200',
  cogs_account_code VARCHAR(40) NOT NULL DEFAULT '5000',
  wip_account_code VARCHAR(40) NOT NULL DEFAULT '1300',
  finished_goods_account_code VARCHAR(40) NOT NULL DEFAULT '1400',
  grni_account_code VARCHAR(40) NOT NULL DEFAULT '2000',
  valuation_method VARCHAR(20) NOT NULL DEFAULT 'FIFO' CHECK (valuation_method IN ('FIFO', 'WEIGHTED_AVERAGE')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, sku),
  UNIQUE (organization_id, product_code),
  UNIQUE (organization_id, barcode)
);

CREATE TABLE IF NOT EXISTS inventory_uom_conversions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  from_uom_id UUID NOT NULL REFERENCES inventory_uoms(id) ON DELETE RESTRICT,
  to_uom_id UUID NOT NULL REFERENCES inventory_uoms(id) ON DELETE RESTRICT,
  factor NUMERIC(20, 10) NOT NULL CHECK (factor > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, from_uom_id, to_uom_id)
);

CREATE TABLE IF NOT EXISTS inventory_warehouses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(160) NOT NULL,
  description TEXT,
  responsible_employee_id UUID REFERENCES users(id) ON DELETE SET NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS inventory_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES inventory_warehouses(id) ON DELETE CASCADE,
  code VARCHAR(80) NOT NULL,
  name VARCHAR(160) NOT NULL,
  bin_code VARCHAR(80),
  zone VARCHAR(120),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, warehouse_id, code)
);

CREATE TABLE IF NOT EXISTS inventory_transfer_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES inventory_products(id) ON DELETE RESTRICT,
  source_warehouse_id UUID NOT NULL REFERENCES inventory_warehouses(id) ON DELETE RESTRICT,
  destination_warehouse_id UUID NOT NULL REFERENCES inventory_warehouses(id) ON DELETE RESTRICT,
  source_location_id UUID REFERENCES inventory_locations(id) ON DELETE SET NULL,
  destination_location_id UUID REFERENCES inventory_locations(id) ON DELETE SET NULL,
  requested_quantity NUMERIC(20, 6) NOT NULL CHECK (requested_quantity > 0),
  approved_quantity NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (approved_quantity >= 0),
  dispatched_quantity NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (dispatched_quantity >= 0),
  received_quantity NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'REQUESTED' CHECK (
    status IN ('REQUESTED', 'APPROVED', 'DISPATCHED', 'RECEIVED', 'COMPLETED', 'CANCELLED')
  ),
  reason TEXT,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at TIMESTAMPTZ,
  dispatched_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (source_warehouse_id <> destination_warehouse_id)
);

CREATE TABLE IF NOT EXISTS inventory_stock_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES inventory_products(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES inventory_warehouses(id) ON DELETE RESTRICT,
  location_id UUID REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  transaction_type VARCHAR(30) NOT NULL CHECK (
    transaction_type IN (
      'PURCHASE_RECEIPT', 'SALES_DELIVERY', 'PRODUCTION_CONSUMPTION',
      'PRODUCTION_COMPLETION', 'STOCK_TRANSFER', 'STOCK_ADJUSTMENT',
      'RETURN', 'OPENING_BALANCE'
    )
  ),
  direction VARCHAR(10) NOT NULL CHECK (direction IN ('IN', 'OUT', 'TRANSFER')),
  quantity NUMERIC(20, 6) NOT NULL CHECK (quantity > 0),
  unit_of_measure_id UUID NOT NULL REFERENCES inventory_uoms(id) ON DELETE RESTRICT,
  unit_cost NUMERIC(20, 6) NOT NULL CHECK (unit_cost >= 0),
  total_cost NUMERIC(20, 6) NOT NULL CHECK (total_cost >= 0),
  reference_type VARCHAR(120) NOT NULL,
  reference_id VARCHAR(160) NOT NULL,
  transaction_date TIMESTAMPTZ NOT NULL,
  transfer_id UUID REFERENCES inventory_transfer_requests(id) ON DELETE SET NULL,
  counterparty_warehouse_id UUID REFERENCES inventory_warehouses(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, reference_type, reference_id),
  UNIQUE (organization_id, transaction_type, reference_id)
);

CREATE TABLE IF NOT EXISTS inventory_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES inventory_products(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES inventory_warehouses(id) ON DELETE RESTRICT,
  location_id UUID REFERENCES inventory_locations(id) ON DELETE SET NULL,
  quantity NUMERIC(20, 6) NOT NULL CHECK (quantity > 0),
  adjustment_type VARCHAR(20) NOT NULL CHECK (adjustment_type IN ('ADD', 'REMOVE', 'REPLACE')),
  reason VARCHAR(240) NOT NULL,
  cost NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT' CHECK (
    status IN ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'POSTED', 'CANCELLED')
  ),
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  posted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at TIMESTAMPTZ,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inventory_count_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES inventory_warehouses(id) ON DELETE RESTRICT,
  counted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT' CHECK (
    status IN ('DRAFT', 'OPEN', 'APPROVED', 'POSTED', 'REJECTED', 'CANCELLED')
  ),
  counted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inventory_count_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  count_session_id UUID NOT NULL REFERENCES inventory_count_sessions(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES inventory_products(id) ON DELETE RESTRICT,
  location_id UUID REFERENCES inventory_locations(id) ON DELETE SET NULL,
  system_quantity NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (system_quantity >= 0),
  counted_quantity NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (counted_quantity >= 0),
  variance NUMERIC(20, 6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (count_session_id, product_id, location_id)
);

CREATE TABLE IF NOT EXISTS inventory_audit_events (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  inventory_entity_type VARCHAR(80) NOT NULL,
  inventory_entity_id UUID NOT NULL,
  action VARCHAR(80) NOT NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_inventory_products_org_active ON inventory_products(organization_id, active, product_type);
CREATE INDEX IF NOT EXISTS idx_inventory_stock_transactions_product ON inventory_stock_transactions(organization_id, product_id, transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_stock_transactions_warehouse ON inventory_stock_transactions(organization_id, warehouse_id, transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_transfer_requests_status ON inventory_transfer_requests(organization_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_adjustments_status ON inventory_adjustments(organization_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_count_lines_variance ON inventory_count_lines(organization_id, variance);
CREATE INDEX IF NOT EXISTS idx_inventory_audit_events_entity ON inventory_audit_events(organization_id, inventory_entity_type, inventory_entity_id, occurred_at DESC);

INSERT INTO inventory_uoms (organization_id, code, name, base_unit, factor)
SELECT o.id, defaults.code, defaults.name, defaults.base_unit, defaults.factor
FROM organizations o
CROSS JOIN (VALUES
  ('piece', 'Piece', 'piece', 1),
  ('kg', 'Kilogram', 'gram', 1000),
  ('gram', 'Gram', 'gram', 1),
  ('liter', 'Liter', 'liter', 1),
  ('meter', 'Meter', 'meter', 1),
  ('box', 'Box', 'piece', 1),
  ('carton', 'Carton', 'piece', 1),
  ('pallet', 'Pallet', 'piece', 1)
) AS defaults(code, name, base_unit, factor)
WHERE NOT EXISTS (
  SELECT 1 FROM inventory_uoms u WHERE u.organization_id = o.id AND u.code = defaults.code
);

INSERT INTO inventory_warehouses (organization_id, code, name, description, responsible_employee_id, active)
SELECT o.id, 'WH-01', 'Primary Warehouse', 'Primary operating warehouse', NULL, TRUE
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM inventory_warehouses w WHERE w.organization_id = o.id AND w.code = 'WH-01'
);
