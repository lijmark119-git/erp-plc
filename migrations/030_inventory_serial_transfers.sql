ALTER TABLE inventory_serial_numbers
  ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS transfer_id UUID REFERENCES inventory_transfer_requests(id) ON DELETE SET NULL;

ALTER TABLE inventory_serial_numbers
  DROP CONSTRAINT IF EXISTS inventory_serial_numbers_status_check;

ALTER TABLE inventory_serial_numbers
  ADD CONSTRAINT inventory_serial_numbers_status_check
  CHECK (status IN ('AVAILABLE', 'ISSUED', 'IN_TRANSIT', 'QUARANTINED', 'DAMAGED', 'RETURNED'));

UPDATE inventory_serial_numbers s
SET location_id = l.location_id
FROM manufacturing_lots l
WHERE s.lot_id = l.id AND s.location_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_serial_numbers_transfer
  ON inventory_serial_numbers(organization_id, transfer_id, status);
