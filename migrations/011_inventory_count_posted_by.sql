ALTER TABLE inventory_count_sessions
  ADD COLUMN IF NOT EXISTS posted_by UUID REFERENCES users(id) ON DELETE SET NULL;
