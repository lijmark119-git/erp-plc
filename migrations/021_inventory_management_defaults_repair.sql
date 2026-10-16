INSERT INTO inventory_uoms (organization_id, code, name, base_unit, factor)
SELECT o.id, defaults.code, defaults.name, defaults.base_unit, defaults.factor
FROM organizations o
CROSS JOIN (VALUES
  ('piece', 'Piece', 'piece', 1),
  ('kg', 'Kilogram', 'gram', 1000),
  ('gram', 'Gram', 'gram', 1),
  ('liter', 'Liter', 'liter', 1),
  ('meter', 'Meter', 'meter', 1),
  ('box', 'Box', 'piece', 1),
  ('carton', 'Carton', 'piece', 1),
  ('pallet', 'Pallet', 'piece', 1)
) AS defaults(code, name, base_unit, factor)
WHERE NOT EXISTS (
  SELECT 1 FROM inventory_uoms u WHERE u.organization_id = o.id AND u.code = defaults.code
);

INSERT INTO inventory_warehouses (organization_id, code, name, description, responsible_employee_id, active)
SELECT o.id, 'WH-01', 'Primary Warehouse', 'Primary operating warehouse', NULL, TRUE
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM inventory_warehouses w WHERE w.organization_id = o.id AND w.code = 'WH-01'
);
