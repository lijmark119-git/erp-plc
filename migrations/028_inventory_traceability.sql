ALTER TABLE manufacturing_lots
  ADD COLUMN IF NOT EXISTS expiry_date DATE,
  ADD COLUMN IF NOT EXISTS warranty_end_date DATE,
  ADD COLUMN IF NOT EXISTS barcode VARCHAR(128),
  ADD COLUMN IF NOT EXISTS quality_status VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE';

ALTER TABLE manufacturing_lots
  DROP CONSTRAINT IF EXISTS manufacturing_lots_quality_status_check;

ALTER TABLE manufacturing_lots
  ADD CONSTRAINT manufacturing_lots_quality_status_check
  CHECK (quality_status IN ('AVAILABLE', 'QUARANTINED', 'DAMAGED', 'RETURNED'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_manufacturing_lots_org_barcode
  ON manufacturing_lots(organization_id, barcode)
  WHERE barcode IS NOT NULL;

CREATE TABLE IF NOT EXISTS inventory_serial_numbers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lot_id UUID NOT NULL REFERENCES manufacturing_lots(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES inventory_products(id) ON DELETE RESTRICT,
  warehouse_id UUID REFERENCES inventory_warehouses(id) ON DELETE RESTRICT,
  serial_number VARCHAR(128) NOT NULL,
  barcode VARCHAR(128),
  status VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE'
    CHECK (status IN ('AVAILABLE', 'ISSUED', 'QUARANTINED', 'DAMAGED', 'RETURNED')),
  warranty_end_date DATE,
  issued_by_transaction_id UUID REFERENCES inventory_stock_transactions(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, serial_number)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_serial_numbers_org_barcode
  ON inventory_serial_numbers(organization_id, barcode)
  WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_serial_numbers_product_status
  ON inventory_serial_numbers(organization_id, product_id, warehouse_id, status);

CREATE TABLE IF NOT EXISTS inventory_stock_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES inventory_products(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES inventory_warehouses(id) ON DELETE RESTRICT,
  location_id UUID REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  reference_type VARCHAR(60),
  reference_id VARCHAR(128),
  quantity NUMERIC(20, 6) NOT NULL CHECK (quantity > 0),
  fulfilled_quantity NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (fulfilled_quantity >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'RELEASED', 'FULFILLED')),
  reason TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  released_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (fulfilled_quantity <= quantity)
);

CREATE INDEX IF NOT EXISTS idx_inventory_reservations_position
  ON inventory_stock_reservations(organization_id, product_id, warehouse_id, status);
