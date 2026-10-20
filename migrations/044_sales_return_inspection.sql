CREATE TABLE IF NOT EXISTS sales_return_inspections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  return_request_id UUID NOT NULL REFERENCES sales_return_requests(id) ON DELETE CASCADE,
  inspected_by UUID REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,
  inspected_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, return_request_id)
);

CREATE TABLE IF NOT EXISTS sales_return_inspection_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id UUID NOT NULL REFERENCES sales_return_inspections(id) ON DELETE CASCADE,
  delivery_line_item_id UUID NOT NULL REFERENCES delivery_line_items(id) ON DELETE RESTRICT,
  received_quantity NUMERIC(20, 6) NOT NULL CHECK (received_quantity >= 0),
  restock_quantity NUMERIC(20, 6) NOT NULL CHECK (restock_quantity >= 0),
  quarantine_quantity NUMERIC(20, 6) NOT NULL CHECK (quarantine_quantity >= 0),
  damaged_quantity NUMERIC(20, 6) NOT NULL CHECK (damaged_quantity >= 0),
  CHECK (received_quantity = restock_quantity + quarantine_quantity + damaged_quantity),
  UNIQUE (inspection_id, delivery_line_item_id)
);

CREATE INDEX IF NOT EXISTS idx_sales_return_inspections_org_date
  ON sales_return_inspections (organization_id, inspected_at DESC);
