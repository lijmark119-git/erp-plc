CREATE TABLE IF NOT EXISTS sales_crm_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  record_type VARCHAR(20) NOT NULL CHECK (record_type IN ('LEAD', 'OPPORTUNITY')),
  name VARCHAR(180) NOT NULL,
  contact_name VARCHAR(120),
  email VARCHAR(255),
  phone VARCHAR(24),
  source VARCHAR(80),
  stage VARCHAR(40) NOT NULL DEFAULT 'NEW',
  estimated_value NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (estimated_value >= 0),
  expected_close_date DATE,
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sales_crm_pipeline
  ON sales_crm_records (organization_id, record_type, stage, expected_close_date);

CREATE TABLE IF NOT EXISTS sales_customer_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  crm_record_id UUID REFERENCES sales_crm_records(id) ON DELETE CASCADE,
  activity_type VARCHAR(30) NOT NULL CHECK (activity_type IN ('CALL', 'EMAIL', 'MEETING', 'NOTE', 'FOLLOW_UP')),
  subject VARCHAR(180) NOT NULL,
  details TEXT,
  activity_date TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  next_follow_up DATE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (customer_id IS NOT NULL OR crm_record_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_sales_customer_activities
  ON sales_customer_activities (organization_id, activity_date DESC);

CREATE TABLE IF NOT EXISTS sales_receivable_disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  receivable_id UUID NOT NULL REFERENCES accounts_receivable(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'REJECTED')),
  reason VARCHAR(240) NOT NULL,
  resolution TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sales_receivable_disputes
  ON sales_receivable_disputes (organization_id, status, created_at DESC);
