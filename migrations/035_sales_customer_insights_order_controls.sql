ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS client_request_id UUID,
  ADD COLUMN IF NOT EXISTS request_fingerprint TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_orders_idempotency
  ON sales_orders (organization_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sales_orders_quote
  ON sales_orders (organization_id, quotation_id)
  WHERE quotation_id IS NOT NULL;
