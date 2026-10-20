ALTER TABLE delivery_notes
  ADD COLUMN IF NOT EXISTS tracking_url TEXT,
  ADD COLUMN IF NOT EXISTS recipient_name VARCHAR(160),
  ADD COLUMN IF NOT EXISTS proof_of_delivery_ref VARCHAR(255),
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS sales_commission_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  salesperson_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rate_percent NUMERIC(7, 4) NOT NULL CHECK (rate_percent >= 0 AND rate_percent <= 100),
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to DATE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS idx_sales_commission_rules_effective
  ON sales_commission_rules (organization_id, salesperson_id, active, effective_from DESC);

CREATE TABLE IF NOT EXISTS sales_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  salesperson_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_month DATE NOT NULL,
  target_amount NUMERIC(15, 2) NOT NULL CHECK (target_amount >= 0),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, salesperson_id, target_month)
);

CREATE INDEX IF NOT EXISTS idx_sales_targets_month
  ON sales_targets (organization_id, target_month);

CREATE TABLE IF NOT EXISTS sales_return_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  delivery_id UUID NOT NULL REFERENCES delivery_notes(id) ON DELETE CASCADE,
  reason VARCHAR(500) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  resolution TEXT,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_return_requests_one_active
  ON sales_return_requests (organization_id, delivery_id)
  WHERE status IN ('PENDING', 'APPROVED');

CREATE INDEX IF NOT EXISTS idx_sales_return_requests
  ON sales_return_requests (organization_id, status, created_at DESC);
