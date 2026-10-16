CREATE TABLE IF NOT EXISTS manufacturing_work_centers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(160) NOT NULL,
  machine_name VARCHAR(160),
  machine_capacity NUMERIC(20, 6) NOT NULL DEFAULT 1 CHECK (machine_capacity > 0),
  labor_capacity NUMERIC(20, 6) NOT NULL DEFAULT 1 CHECK (labor_capacity > 0),
  machine_hour_rate NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (machine_hour_rate >= 0),
  labor_hour_rate NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (labor_hour_rate >= 0),
  overhead_hour_rate NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (overhead_hour_rate >= 0),
  calendar JSONB NOT NULL DEFAULT '{"workingDays":[1,2,3,4,5],"hoursPerDay":8}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS manufacturing_boms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bom_code VARCHAR(60) NOT NULL,
  version VARCHAR(40) NOT NULL,
  finished_product_id UUID NOT NULL REFERENCES inventory_products(id) ON DELETE RESTRICT,
  effective_from DATE NOT NULL,
  effective_to DATE,
  scrap_percent NUMERIC(8, 4) NOT NULL DEFAULT 0 CHECK (scrap_percent >= 0 AND scrap_percent < 100),
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE')),
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, bom_code, version),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_manufacturing_bom_active_product
  ON manufacturing_boms (organization_id, finished_product_id) WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS manufacturing_bom_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bom_id UUID NOT NULL REFERENCES manufacturing_boms(id) ON DELETE CASCADE,
  line_number INTEGER NOT NULL CHECK (line_number > 0),
  raw_material_product_id UUID NOT NULL REFERENCES inventory_products(id) ON DELETE RESTRICT,
  quantity_per NUMERIC(20, 6) NOT NULL CHECK (quantity_per > 0),
  unit_of_measure_id UUID NOT NULL REFERENCES inventory_uoms(id) ON DELETE RESTRICT,
  scrap_percent NUMERIC(8, 4) NOT NULL DEFAULT 0 CHECK (scrap_percent >= 0 AND scrap_percent < 100),
  operation_sequence INTEGER NOT NULL DEFAULT 10 CHECK (operation_sequence > 0),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (bom_id, line_number)
);

CREATE TABLE IF NOT EXISTS manufacturing_routings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  routing_code VARCHAR(60) NOT NULL,
  version VARCHAR(40) NOT NULL,
  finished_product_id UUID NOT NULL REFERENCES inventory_products(id) ON DELETE RESTRICT,
  effective_from DATE NOT NULL,
  effective_to DATE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, routing_code, version),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE TABLE IF NOT EXISTS manufacturing_routing_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  routing_id UUID NOT NULL REFERENCES manufacturing_routings(id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
  operation_name VARCHAR(160) NOT NULL,
  work_center_id UUID NOT NULL REFERENCES manufacturing_work_centers(id) ON DELETE RESTRICT,
  setup_minutes NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (setup_minutes >= 0),
  machine_minutes_per_unit NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (machine_minutes_per_unit >= 0),
  labor_hours_per_unit NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (labor_hours_per_unit >= 0),
  instructions TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (routing_id, sequence_number)
);

CREATE TABLE IF NOT EXISTS manufacturing_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_number VARCHAR(60) NOT NULL,
  finished_product_id UUID NOT NULL REFERENCES inventory_products(id) ON DELETE RESTRICT,
  bom_id UUID NOT NULL REFERENCES manufacturing_boms(id) ON DELETE RESTRICT,
  routing_id UUID REFERENCES manufacturing_routings(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES inventory_warehouses(id) ON DELETE RESTRICT,
  planned_quantity NUMERIC(20, 6) NOT NULL CHECK (planned_quantity > 0),
  completed_quantity NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (completed_quantity >= 0),
  rejected_quantity NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (rejected_quantity >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED', 'RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CLOSED')),
  planned_start DATE,
  due_date DATE,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  released_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, order_number)
);

CREATE TABLE IF NOT EXISTS manufacturing_order_materials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  manufacturing_order_id UUID NOT NULL REFERENCES manufacturing_orders(id) ON DELETE CASCADE,
  bom_line_id UUID REFERENCES manufacturing_bom_lines(id) ON DELETE SET NULL,
  raw_material_product_id UUID NOT NULL REFERENCES inventory_products(id) ON DELETE RESTRICT,
  required_quantity NUMERIC(20, 6) NOT NULL CHECK (required_quantity > 0),
  reserved_quantity NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0),
  consumed_quantity NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (consumed_quantity >= 0),
  unit_cost NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (manufacturing_order_id, raw_material_product_id)
);

CREATE TABLE IF NOT EXISTS manufacturing_material_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_material_id UUID NOT NULL REFERENCES manufacturing_order_materials(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES inventory_warehouses(id) ON DELETE RESTRICT,
  quantity NUMERIC(20, 6) NOT NULL CHECK (quantity > 0),
  consumed_quantity NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (consumed_quantity >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED', 'CONSUMED', 'RELEASED')),
  reserved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS manufacturing_order_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  manufacturing_order_id UUID NOT NULL REFERENCES manufacturing_orders(id) ON DELETE CASCADE,
  routing_operation_id UUID REFERENCES manufacturing_routing_operations(id) ON DELETE SET NULL,
  sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
  operation_name VARCHAR(160) NOT NULL,
  work_center_id UUID NOT NULL REFERENCES manufacturing_work_centers(id) ON DELETE RESTRICT,
  status VARCHAR(20) NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED', 'IN_PROGRESS', 'COMPLETED')),
  planned_machine_hours NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (planned_machine_hours >= 0),
  actual_machine_hours NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (actual_machine_hours >= 0),
  planned_labor_hours NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (planned_labor_hours >= 0),
  actual_labor_hours NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (actual_labor_hours >= 0),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  completed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (manufacturing_order_id, sequence_number)
);

CREATE TABLE IF NOT EXISTS manufacturing_lots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES inventory_products(id) ON DELETE RESTRICT,
  lot_number VARCHAR(100) NOT NULL,
  lot_type VARCHAR(20) NOT NULL CHECK (lot_type IN ('RAW_MATERIAL', 'FINISHED_GOOD')),
  manufacturing_order_id UUID REFERENCES manufacturing_orders(id) ON DELETE SET NULL,
  source_inventory_transaction_id UUID REFERENCES inventory_stock_transactions(id) ON DELETE RESTRICT,
  warehouse_id UUID REFERENCES inventory_warehouses(id) ON DELETE RESTRICT,
  quantity NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  remaining_quantity NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (remaining_quantity >= 0),
  unit_cost NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  production_date DATE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, product_id, lot_number)
);

CREATE TABLE IF NOT EXISTS manufacturing_material_consumptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_material_id UUID NOT NULL REFERENCES manufacturing_order_materials(id) ON DELETE RESTRICT,
  inventory_transaction_id UUID NOT NULL REFERENCES inventory_stock_transactions(id) ON DELETE RESTRICT,
  lot_id UUID REFERENCES manufacturing_lots(id) ON DELETE RESTRICT,
  quantity NUMERIC(20, 6) NOT NULL CHECK (quantity > 0),
  unit_cost NUMERIC(20, 6) NOT NULL CHECK (unit_cost >= 0),
  total_cost NUMERIC(20, 6) NOT NULL CHECK (total_cost >= 0),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (inventory_transaction_id)
);

CREATE TABLE IF NOT EXISTS manufacturing_production_outputs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  manufacturing_order_id UUID NOT NULL REFERENCES manufacturing_orders(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES inventory_products(id) ON DELETE RESTRICT,
  lot_id UUID NOT NULL REFERENCES manufacturing_lots(id) ON DELETE RESTRICT,
  inventory_transaction_id UUID NOT NULL REFERENCES inventory_stock_transactions(id) ON DELETE RESTRICT,
  produced_quantity NUMERIC(20, 6) NOT NULL CHECK (produced_quantity > 0),
  rejected_quantity NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (rejected_quantity >= 0),
  unit_cost NUMERIC(20, 6) NOT NULL CHECK (unit_cost >= 0),
  total_cost NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (total_cost >= 0),
  scrap_cost NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (scrap_cost >= 0),
  production_date DATE NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (inventory_transaction_id)
);

CREATE TABLE IF NOT EXISTS manufacturing_lot_genealogy (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  material_consumption_id UUID NOT NULL REFERENCES manufacturing_material_consumptions(id) ON DELETE CASCADE,
  source_lot_id UUID NOT NULL REFERENCES manufacturing_lots(id) ON DELETE RESTRICT,
  output_lot_id UUID NOT NULL REFERENCES manufacturing_lots(id) ON DELETE RESTRICT,
  quantity NUMERIC(20, 6) NOT NULL CHECK (quantity > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (material_consumption_id, output_lot_id)
);

CREATE TABLE IF NOT EXISTS manufacturing_lot_shipments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lot_id UUID NOT NULL REFERENCES manufacturing_lots(id) ON DELETE RESTRICT,
  inventory_transaction_id UUID NOT NULL REFERENCES inventory_stock_transactions(id) ON DELETE RESTRICT,
  delivery_id UUID,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  quantity NUMERIC(20, 6) NOT NULL CHECK (quantity > 0),
  shipped_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (inventory_transaction_id, lot_id)
);

CREATE TABLE IF NOT EXISTS manufacturing_open_purchase_supply (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  purchase_order_number VARCHAR(80) NOT NULL,
  product_id UUID NOT NULL REFERENCES inventory_products(id) ON DELETE RESTRICT,
  ordered_quantity NUMERIC(20, 6) NOT NULL CHECK (ordered_quantity > 0),
  received_quantity NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
  due_date DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'PARTIALLY_RECEIVED', 'CLOSED', 'CANCELLED')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, purchase_order_number, product_id)
);

CREATE TABLE IF NOT EXISTS manufacturing_mrp_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  planning_date DATE NOT NULL,
  demand_source VARCHAR(40) NOT NULL DEFAULT 'SALES_ORDERS',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS manufacturing_mrp_requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES manufacturing_mrp_runs(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES inventory_products(id) ON DELETE RESTRICT,
  gross_required NUMERIC(20, 6) NOT NULL DEFAULT 0,
  safety_stock NUMERIC(20, 6) NOT NULL DEFAULT 0,
  on_hand NUMERIC(20, 6) NOT NULL DEFAULT 0,
  reserved NUMERIC(20, 6) NOT NULL DEFAULT 0,
  open_purchase NUMERIC(20, 6) NOT NULL DEFAULT 0,
  open_production NUMERIC(20, 6) NOT NULL DEFAULT 0,
  net_requirement NUMERIC(20, 6) NOT NULL DEFAULT 0,
  suggested_quantity NUMERIC(20, 6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (run_id, product_id)
);

CREATE TABLE IF NOT EXISTS manufacturing_audit_trail (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(80) NOT NULL,
  entity_id UUID,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_manufacturing_boms_product ON manufacturing_boms(organization_id, finished_product_id, status);
CREATE INDEX IF NOT EXISTS idx_manufacturing_orders_status ON manufacturing_orders(organization_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_manufacturing_order_materials_product ON manufacturing_order_materials(organization_id, raw_material_product_id);
CREATE INDEX IF NOT EXISTS idx_manufacturing_reservations_product ON manufacturing_material_reservations(organization_id, warehouse_id, status);
CREATE INDEX IF NOT EXISTS idx_manufacturing_lots_product ON manufacturing_lots(organization_id, product_id, lot_type, production_date);
CREATE INDEX IF NOT EXISTS idx_manufacturing_mrp_runs_date ON manufacturing_mrp_runs(organization_id, planning_date DESC);
CREATE INDEX IF NOT EXISTS idx_manufacturing_audit_entity ON manufacturing_audit_trail(organization_id, entity_type, entity_id, created_at DESC);

INSERT INTO permissions (code, name, description, category)
VALUES
  ('manufacturing:read', 'Read manufacturing', 'View bills of material, routing, production, and reports', 'manufacturing'),
  ('manufacturing:bom:manage', 'Manage bills of material', 'Create and activate BOM versions', 'manufacturing'),
  ('manufacturing:routing:manage', 'Manage routings', 'Create work centers and production routings', 'manufacturing'),
  ('manufacturing:orders:release', 'Release manufacturing orders', 'Release planned orders and reserve materials', 'manufacturing'),
  ('manufacturing:materials:reserve', 'Reserve materials', 'Reserve inventory materials for production', 'manufacturing'),
  ('manufacturing:materials:consume', 'Consume materials', 'Record production material consumption', 'manufacturing'),
  ('manufacturing:output:record', 'Record production output', 'Record finished and rejected quantities', 'manufacturing'),
  ('manufacturing:mrp:run', 'Run material requirements planning', 'Calculate material requirements', 'manufacturing'),
  ('manufacturing:reports:read', 'Read manufacturing reports', 'View production, costing, utilization, yield, scrap, WIP, and traceability', 'manufacturing')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM roles role JOIN permissions permission ON permission.code LIKE 'manufacturing:%'
WHERE role.code = 'ADMIN'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT role.id, permission.id FROM roles role JOIN permissions permission ON permission.code IN (
  'manufacturing:read', 'manufacturing:orders:create', 'manufacturing:orders:release',
  'manufacturing:materials:reserve', 'manufacturing:materials:consume',
  'manufacturing:output:record', 'manufacturing:mrp:run', 'manufacturing:reports:read'
)
WHERE role.code = 'MANAGER'
ON CONFLICT (role_id, permission_id) DO NOTHING;
