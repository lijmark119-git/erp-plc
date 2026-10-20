CREATE TABLE IF NOT EXISTS manufacturing_downtime_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  work_center_id UUID NOT NULL REFERENCES manufacturing_work_centers(id) ON DELETE RESTRICT,
  manufacturing_order_id UUID REFERENCES manufacturing_orders(id) ON DELETE SET NULL,
  downtime_date DATE NOT NULL,
  downtime_minutes NUMERIC(12, 2) NOT NULL CHECK (downtime_minutes > 0),
  reason VARCHAR(120) NOT NULL,
  notes TEXT,
  recorded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_manufacturing_downtime_center_date
  ON manufacturing_downtime_events (organization_id, work_center_id, downtime_date DESC);
