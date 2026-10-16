ALTER TABLE bank_accounts
  ADD COLUMN IF NOT EXISTS legacy_id VARCHAR(120);

ALTER TABLE finance_transactions
  ADD COLUMN IF NOT EXISTS legacy_id VARCHAR(120);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_accounts_legacy_id
  ON bank_accounts (organization_id, legacy_id)
  WHERE legacy_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_transactions_legacy_id
  ON finance_transactions (organization_id, legacy_id)
  WHERE legacy_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS bank_statement_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bank_account_id UUID NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  legacy_id VARCHAR(120),
  transaction_date DATE NOT NULL,
  description VARCHAR(240) NOT NULL,
  category VARCHAR(100) NOT NULL,
  type VARCHAR(10) NOT NULL CHECK (type IN ('CREDIT', 'DEBIT')),
  amount NUMERIC(20, 4) NOT NULL CHECK (amount > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  reference VARCHAR(120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, legacy_id)
);

CREATE INDEX IF NOT EXISTS idx_bank_statement_transactions_org_date
  ON bank_statement_transactions (organization_id, transaction_date DESC);

CREATE TABLE IF NOT EXISTS bank_reconciliation_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  legacy_id VARCHAR(120),
  statement_transaction_id UUID NOT NULL REFERENCES bank_statement_transactions(id) ON DELETE RESTRICT,
  finance_transaction_id UUID REFERENCES finance_transactions(id) ON DELETE RESTRICT,
  legacy_cashbook_transaction_id VARCHAR(120),
  amount NUMERIC(20, 4) NOT NULL CHECK (amount > 0),
  method VARCHAR(20) NOT NULL CHECK (method IN ('reference', 'manual', 'amount')),
  status VARCHAR(20) NOT NULL DEFAULT 'MATCHED',
  matched_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (organization_id, legacy_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_reconciliation_statement
  ON bank_reconciliation_matches (organization_id, statement_transaction_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_reconciliation_finance_transaction
  ON bank_reconciliation_matches (organization_id, finance_transaction_id)
  WHERE finance_transaction_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS legacy_data_imports (
  import_key VARCHAR(100) PRIMARY KEY,
  source_sha256 CHAR(64) NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  imported_by UUID REFERENCES users(id) ON DELETE SET NULL,
  record_counts JSONB NOT NULL
);

INSERT INTO permissions (code, name, description, category)
VALUES ('finance:accounts:manage', 'Manage bank accounts', 'Create bank accounts and configure opening balances', 'finance')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM roles role
JOIN permissions permission ON permission.code = 'finance:accounts:manage'
WHERE role.code = 'ADMIN'
ON CONFLICT (role_id, permission_id) DO NOTHING;
