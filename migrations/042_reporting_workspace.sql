CREATE TABLE IF NOT EXISTS saved_report_configurations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(80) NOT NULL CHECK (length(trim(name)) > 0),
  report_key VARCHAR(60) NOT NULL CHECK (report_key IN ('dashboard-summary')),
  configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_saved_report_configurations_user
  ON saved_report_configurations (organization_id, user_id, name);

CREATE INDEX IF NOT EXISTS idx_report_export_audit
  ON audit_events (organization_id, occurred_at DESC)
  WHERE action = 'report.exported';
