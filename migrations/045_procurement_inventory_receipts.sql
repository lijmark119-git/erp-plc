ALTER TABLE procurement_purchase_orders
  ADD COLUMN IF NOT EXISTS inventory_product_id UUID REFERENCES inventory_products(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS inventory_warehouse_id UUID REFERENCES inventory_warehouses(id) ON DELETE RESTRICT;

ALTER TABLE procurement_purchase_order_receipts
  ADD COLUMN IF NOT EXISTS inventory_transaction_id UUID REFERENCES inventory_stock_transactions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS idempotency_key UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_procurement_receipts_idempotency
  ON procurement_purchase_order_receipts (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
