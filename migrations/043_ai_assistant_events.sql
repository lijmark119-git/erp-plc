CREATE TABLE IF NOT EXISTS ai_assistant_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  request_category VARCHAR(40) NOT NULL CHECK (request_category IN ('business_summary', 'workflow_help')),
  provider_mode VARCHAR(40) NOT NULL CHECK (provider_mode IN ('local_only', 'external_configured')),
  authorized_modules JSONB NOT NULL DEFAULT '[]'::jsonb,
  metric_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  question_length INTEGER NOT NULL CHECK (question_length BETWEEN 1 AND 1500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_assistant_events_user_created
  ON ai_assistant_events (organization_id, user_id, created_at DESC);
