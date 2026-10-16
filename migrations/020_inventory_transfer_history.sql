ALTER TABLE inventory_transfer_requests
  DROP CONSTRAINT IF EXISTS inventory_transfer_requests_status_check;

ALTER TABLE inventory_transfer_requests
  ADD CONSTRAINT inventory_transfer_requests_status_check
  CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED', 'DISPATCHED', 'RECEIVED', 'COMPLETED', 'CANCELLED'));

CREATE TABLE IF NOT EXISTS inventory_transfer_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  transfer_id UUID NOT NULL REFERENCES inventory_transfer_requests(id) ON DELETE CASCADE,
  event_type VARCHAR(20) NOT NULL CHECK (
    event_type IN ('REQUESTED', 'APPROVED', 'REJECTED', 'DISPATCHED', 'RECEIVED', 'COMPLETED', 'CANCELLED')
  ),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reason TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_inventory_transfer_history_transfer
  ON inventory_transfer_history(organization_id, transfer_id, occurred_at, id);

INSERT INTO inventory_transfer_history (organization_id, transfer_id, event_type, actor_user_id, occurred_at, reason, details)
SELECT organization_id, id, 'REQUESTED', requested_by, requested_at, reason, jsonb_build_object('requestedQuantity', requested_quantity)
FROM inventory_transfer_requests
ON CONFLICT DO NOTHING;

INSERT INTO inventory_transfer_history (organization_id, transfer_id, event_type, actor_user_id, occurred_at, reason, details)
SELECT organization_id, id, 'APPROVED', approved_by, approved_at, NULL, jsonb_build_object('approvedQuantity', approved_quantity)
FROM inventory_transfer_requests
WHERE approved_at IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO inventory_transfer_history (organization_id, transfer_id, event_type, actor_user_id, occurred_at, reason, details)
SELECT organization_id, id, 'DISPATCHED', dispatched_by, dispatched_at, NULL, jsonb_build_object('dispatchedQuantity', dispatched_quantity)
FROM inventory_transfer_requests
WHERE dispatched_at IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO inventory_transfer_history (organization_id, transfer_id, event_type, actor_user_id, occurred_at, reason, details)
SELECT organization_id, id, 'RECEIVED', received_by, received_at, NULL, jsonb_build_object('receivedQuantity', received_quantity)
FROM inventory_transfer_requests
WHERE received_at IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO inventory_transfer_history (organization_id, transfer_id, event_type, actor_user_id, occurred_at, reason)
SELECT organization_id, id, 'COMPLETED', NULL, completed_at, NULL
FROM inventory_transfer_requests
WHERE completed_at IS NOT NULL
ON CONFLICT DO NOTHING;
