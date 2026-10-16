CREATE TABLE IF NOT EXISTS bank_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(160) NOT NULL,
  bank_name VARCHAR(160),
  account_number VARCHAR(80) NOT NULL,
  currency CHAR(3) NOT NULL,
  opening_balance NUMERIC(20, 4) NOT NULL DEFAULT 0 CHECK (opening_balance >= 0),
  current_balance NUMERIC(20, 4) NOT NULL DEFAULT 0,
  account_type VARCHAR(40) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'SUSPENDED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS finance_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bank_account_id UUID NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  type VARCHAR(10) NOT NULL CHECK (type IN ('CREDIT', 'DEBIT')),
  amount NUMERIC(20, 4) NOT NULL CHECK (amount > 0),
  description VARCHAR(240) NOT NULL,
  category VARCHAR(100) NOT NULL,
  reference VARCHAR(120),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CLEARED')),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at TIMESTAMPTZ,
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sku VARCHAR(80) NOT NULL,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  quantity NUMERIC(20, 4) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  reorder_level NUMERIC(20, 4) NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  unit_cost NUMERIC(20, 4) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'ETB',
  location VARCHAR(120),
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'HOLD')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, sku)
);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  inventory_item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  direction VARCHAR(10) NOT NULL CHECK (direction IN ('IN', 'OUT')),
  quantity NUMERIC(20, 4) NOT NULL CHECK (quantity > 0),
  unit_cost NUMERIC(20, 4) NOT NULL CHECK (unit_cost >= 0),
  reference VARCHAR(120),
  reason VARCHAR(240),
  performed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_finance_transactions_account_occurred_at ON finance_transactions(bank_account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_finance_transactions_status ON finance_transactions(status, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_item_occurred_at ON inventory_movements(inventory_item_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_items_reorder ON inventory_items(organization_id, quantity, reorder_level);
