CREATE TABLE IF NOT EXISTS procurement_suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  supplier_code VARCHAR(60) NOT NULL,
  name VARCHAR(180) NOT NULL,
  contact_name VARCHAR(160),
  email VARCHAR(254),
  phone VARCHAR(60),
  payment_terms VARCHAR(240),
  notes TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, supplier_code),
  UNIQUE (organization_id, name)
);

CREATE TABLE IF NOT EXISTS procurement_comparisons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  comparison_number BIGSERIAL,
  title VARCHAR(180) NOT NULL,
  product_description TEXT NOT NULL,
  sku VARCHAR(100),
  quantity NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  currency CHAR(3) NOT NULL DEFAULT 'ETB',
  status VARCHAR(30) NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'SELECTED', 'ORDERED', 'CLOSED')),
  selected_quote_id UUID,
  selection_reason TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS procurement_supplier_quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  comparison_id UUID NOT NULL REFERENCES procurement_comparisons(id) ON DELETE CASCADE,
  supplier_id UUID NOT NULL REFERENCES procurement_suppliers(id),
  quote_reference VARCHAR(120),
  unit_price NUMERIC(14,2) NOT NULL CHECK (unit_price >= 0),
  tax_rate NUMERIC(7,4) NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 100),
  tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  shipping_cost NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (shipping_cost >= 0),
  other_cost NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (other_cost >= 0),
  delivery_days INTEGER NOT NULL CHECK (delivery_days >= 0),
  payment_terms VARCHAR(240) NOT NULL,
  valid_until DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (comparison_id, supplier_id),
  UNIQUE (id, comparison_id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'procurement_comparisons_selected_quote_fk'
  ) THEN
    ALTER TABLE procurement_comparisons
      ADD CONSTRAINT procurement_comparisons_selected_quote_fk
      FOREIGN KEY (selected_quote_id, id)
      REFERENCES procurement_supplier_quotes (id, comparison_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS procurement_purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  po_number VARCHAR(40) NOT NULL,
  comparison_id UUID NOT NULL REFERENCES procurement_comparisons(id),
  quote_id UUID NOT NULL REFERENCES procurement_supplier_quotes(id),
  supplier_id UUID NOT NULL REFERENCES procurement_suppliers(id),
  status VARCHAR(30) NOT NULL DEFAULT 'PENDING_APPROVAL'
    CHECK (status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED')),
  expected_delivery_date DATE,
  received_quantity NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
  rejection_reason TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, po_number),
  UNIQUE (comparison_id)
);

CREATE TABLE IF NOT EXISTS procurement_purchase_order_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  purchase_order_id UUID NOT NULL REFERENCES procurement_purchase_orders(id) ON DELETE CASCADE,
  quantity NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  received_by UUID REFERENCES users(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS procurement_audit_history (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type VARCHAR(40) NOT NULL,
  entity_id UUID NOT NULL,
  action VARCHAR(60) NOT NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_procurement_suppliers_org_active
  ON procurement_suppliers (organization_id, active, name);
CREATE INDEX IF NOT EXISTS idx_procurement_comparisons_org_date
  ON procurement_comparisons (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_procurement_quotes_comparison
  ON procurement_supplier_quotes (organization_id, comparison_id);
CREATE INDEX IF NOT EXISTS idx_procurement_orders_org_status
  ON procurement_purchase_orders (organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_procurement_audit_entity
  ON procurement_audit_history (organization_id, entity_type, entity_id, occurred_at DESC);

INSERT INTO permissions (code, name, description, category)
VALUES
  ('procurement:suppliers:manage', 'Manage suppliers', 'Create and update procurement suppliers', 'procurement'),
  ('procurement:comparisons:read', 'Read supplier comparisons', 'View supplier quotations and comparisons', 'procurement'),
  ('procurement:comparisons:create', 'Create supplier comparisons', 'Save supplier quotation comparisons', 'procurement'),
  ('procurement:comparisons:select', 'Select supplier quotations', 'Select a supplier quote for purchasing', 'procurement'),
  ('procurement:orders:read', 'Read purchase orders', 'View purchase orders and history', 'procurement'),
  ('procurement:orders:approve', 'Approve purchase orders', 'Approve or reject purchase orders', 'procurement'),
  ('procurement:orders:receive', 'Receive purchase orders', 'Record purchase order receipts', 'procurement')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.name IN ('ADMIN', 'MANAGER')
  AND p.code IN (
    'procurement:suppliers:manage',
    'procurement:comparisons:read',
    'procurement:comparisons:create',
    'procurement:comparisons:select',
    'procurement:orders:read',
    'procurement:orders:create',
    'procurement:orders:manage',
    'procurement:orders:approve',
    'procurement:orders:receive'
  )
ON CONFLICT (role_id, permission_id) DO NOTHING;
