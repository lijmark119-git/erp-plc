CREATE TABLE IF NOT EXISTS manufacturing_demand_forecasts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES inventory_products(id) ON DELETE RESTRICT,
  forecast_date DATE NOT NULL,
  quantity NUMERIC(20, 6) NOT NULL CHECK (quantity > 0),
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, product_id, forecast_date)
);

CREATE INDEX IF NOT EXISTS idx_manufacturing_forecasts_period
  ON manufacturing_demand_forecasts (organization_id, forecast_date, product_id);

CREATE TABLE IF NOT EXISTS manufacturing_maintenance_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  work_center_id UUID NOT NULL REFERENCES manufacturing_work_centers(id) ON DELETE RESTRICT,
  maintenance_type VARCHAR(20) NOT NULL CHECK (maintenance_type IN ('PREVENTIVE', 'CORRECTIVE')),
  description VARCHAR(240) NOT NULL,
  scheduled_date DATE NOT NULL,
  next_due_date DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED', 'COMPLETED', 'CANCELLED')),
  downtime_minutes NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (downtime_minutes >= 0),
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  completed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_manufacturing_maintenance_schedule
  ON manufacturing_maintenance_events (organization_id, scheduled_date, status);
