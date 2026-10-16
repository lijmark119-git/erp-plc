ALTER TABLE manufacturing_lots
  ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES inventory_locations(id) ON DELETE RESTRICT;
