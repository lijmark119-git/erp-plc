ALTER TABLE procurement_suppliers
  ADD COLUMN IF NOT EXISTS qualification_status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (qualification_status IN ('PENDING', 'QUALIFIED', 'SUSPENDED')),
  ADD COLUMN IF NOT EXISTS risk_level VARCHAR(20) NOT NULL DEFAULT 'MEDIUM'
    CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH'));

CREATE TABLE IF NOT EXISTS procurement_requisitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requisition_number VARCHAR(40) NOT NULL,
  title VARCHAR(180) NOT NULL,
  description TEXT NOT NULL,
  quantity NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  estimated_unit_cost NUMERIC(14,2) NOT NULL CHECK (estimated_unit_cost >= 0),
  budget_limit NUMERIC(14,2) NOT NULL CHECK (budget_limit >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED', 'APPROVED', 'REJECTED', 'SOURCING')),
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  decision_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, requisition_number)
);
CREATE INDEX IF NOT EXISTS idx_procurement_requisitions
  ON procurement_requisitions (organization_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS procurement_supplier_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  purchase_order_id UUID NOT NULL REFERENCES procurement_purchase_orders(id) ON DELETE RESTRICT,
  supplier_invoice_number VARCHAR(80) NOT NULL,
  invoice_quantity NUMERIC(14,3) NOT NULL CHECK (invoice_quantity > 0),
  invoice_amount NUMERIC(14,2) NOT NULL CHECK (invoice_amount >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING_MATCH'
    CHECK (status IN ('PENDING_MATCH', 'MATCHED', 'EXCEPTION', 'PAID')),
  match_notes TEXT,
  invoice_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  matched_by UUID REFERENCES users(id) ON DELETE SET NULL,
  matched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, supplier_invoice_number)
);
CREATE INDEX IF NOT EXISTS idx_procurement_supplier_invoices
  ON procurement_supplier_invoices (organization_id, status, created_at DESC);
