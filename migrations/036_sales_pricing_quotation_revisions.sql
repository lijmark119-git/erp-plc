ALTER TABLE quotations
  ADD COLUMN IF NOT EXISTS revision_of UUID REFERENCES quotations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS revision_number INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_quotations_revision
  ON quotations (organization_id, revision_of, revision_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_quotations_revision_number
  ON quotations (organization_id, revision_of, revision_number)
  WHERE revision_of IS NOT NULL;

CREATE TABLE IF NOT EXISTS sales_customer_price_lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name VARCHAR(160) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'ETB',
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to DATE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS idx_sales_customer_price_lists_effective
  ON sales_customer_price_lists (organization_id, customer_id, active, effective_from DESC);

CREATE TABLE IF NOT EXISTS sales_customer_price_list_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  price_list_id UUID NOT NULL REFERENCES sales_customer_price_lists(id) ON DELETE CASCADE,
  product_sku VARCHAR(80) NOT NULL,
  unit_price NUMERIC(20, 6) NOT NULL CHECK (unit_price >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (price_list_id, product_sku)
);
