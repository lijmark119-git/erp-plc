CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS accounting_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_code VARCHAR(40) NOT NULL,
  account_name VARCHAR(160) NOT NULL,
  account_type VARCHAR(30) NOT NULL CHECK (
    account_type IN (
      'ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'COGS',
      'OPERATING_EXPENSE', 'OTHER_INCOME', 'OTHER_EXPENSE'
    )
  ),
  parent_account_id UUID REFERENCES accounting_accounts(id) ON DELETE RESTRICT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  description TEXT,
  normal_balance VARCHAR(20) NOT NULL CHECK (normal_balance IN ('DEBIT', 'CREDIT')),
  opening_balance NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (opening_balance >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, account_code),
  CHECK (parent_account_id IS NULL OR parent_account_id <> id)
);

CREATE TABLE IF NOT EXISTS accounting_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  fiscal_year INTEGER NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 9999),
  period_number INTEGER NOT NULL CHECK (period_number BETWEEN 1 AND 12),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  closed_at TIMESTAMPTZ,
  closed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, fiscal_year, period_number),
  CHECK (period_start < period_end)
);

CREATE TABLE IF NOT EXISTS accounting_journal_sequences (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  fiscal_year INTEGER NOT NULL,
  next_number BIGINT NOT NULL DEFAULT 1 CHECK (next_number > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS accounting_journals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  journal_number VARCHAR(40) NOT NULL,
  accounting_period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,
  transaction_date DATE NOT NULL,
  reference VARCHAR(120),
  description VARCHAR(400) NOT NULL,
  source_module VARCHAR(120) NOT NULL,
  source_transaction_id VARCHAR(160),
  currency CHAR(3) NOT NULL DEFAULT 'ETB',
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT' CHECK (
    status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED', 'REVERSED', 'CANCELLED')
  ),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  posted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reversed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  posted_at TIMESTAMPTZ,
  reversed_at TIMESTAMPTZ,
  reversal_journal_id UUID REFERENCES accounting_journals(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, journal_number),
  UNIQUE (organization_id, source_module, source_transaction_id)
);

CREATE TABLE IF NOT EXISTS accounting_journal_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_id UUID NOT NULL REFERENCES accounting_journals(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounting_accounts(id) ON DELETE RESTRICT,
  line_number INTEGER NOT NULL CHECK (line_number > 0),
  debit NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  description VARCHAR(240) NOT NULL,
  cost_center VARCHAR(120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (journal_id, line_number),
  CHECK (debit = 0 OR credit = 0),
  CHECK (debit + credit > 0)
);

CREATE TABLE IF NOT EXISTS accounting_journal_status_history (
  id BIGSERIAL PRIMARY KEY,
  journal_id UUID NOT NULL REFERENCES accounting_journals(id) ON DELETE CASCADE,
  from_status VARCHAR(20) NOT NULL,
  to_status VARCHAR(20) NOT NULL,
  changed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reason TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_accounting_accounts_org_parent ON accounting_accounts(organization_id, parent_account_id);
CREATE INDEX IF NOT EXISTS idx_accounting_periods_org_status ON accounting_periods(organization_id, status, period_start);
CREATE INDEX IF NOT EXISTS idx_accounting_journals_org_status_date ON accounting_journals(organization_id, status, transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_accounting_journal_lines_account ON accounting_journal_lines(account_id, journal_id);
CREATE INDEX IF NOT EXISTS idx_accounting_journal_status_history_journal ON accounting_journal_status_history(journal_id, changed_at DESC);

INSERT INTO accounting_accounts (
  organization_id, account_code, account_name, account_type, parent_account_id,
  active, description, normal_balance, opening_balance
)
SELECT
  o.id,
  account_seed.code,
  account_seed.name,
  account_seed.account_type,
  NULL,
  TRUE,
  account_seed.description,
  account_seed.normal_balance,
  account_seed.opening_balance
FROM organizations o
CROSS JOIN (VALUES
  ('1000', 'Cash and Cash Equivalents', 'ASSET', 'DEBIT', 0, 'Cash and cash equivalents'),
  ('1100', 'Accounts Receivable', 'ASSET', 'DEBIT', 0, 'Amounts due from customers'),
  ('1200', 'Inventory', 'ASSET', 'DEBIT', 0, 'Inventory held for sale or production'),
  ('1300', 'Work in Progress', 'ASSET', 'DEBIT', 0, 'Partially completed manufacturing work'),
  ('1400', 'Finished Goods', 'ASSET', 'DEBIT', 0, 'Completed manufacturing inventory'),
  ('2000', 'Accounts Payable', 'LIABILITY', 'CREDIT', 0, 'Amounts due to suppliers'),
  ('2100', 'Accrued Expenses', 'LIABILITY', 'CREDIT', 0, 'Expenses incurred but not yet paid'),
  ('2200', 'Sales Tax Payable', 'LIABILITY', 'CREDIT', 0, 'Sales tax payable to authorities'),
  ('2300', 'Unearned Revenue', 'LIABILITY', 'CREDIT', 0, 'Customer payments received before revenue is earned'),
  ('3000', 'Owner Equity', 'EQUITY', 'CREDIT', 0, 'Owner capital contribution'),
  ('3100', 'Retained Earnings', 'EQUITY', 'CREDIT', 0, 'Accumulated retained earnings'),
  ('4000', 'Sales Revenue', 'REVENUE', 'CREDIT', 0, 'Revenue generated from product and service sales'),
  ('5000', 'Cost of Goods Sold', 'COGS', 'DEBIT', 0, 'Cost of inventory sold'),
  ('6000', 'Operating Expenses', 'OPERATING_EXPENSE', 'DEBIT', 0, 'Core operating expenses'),
  ('7000', 'Other Income', 'OTHER_INCOME', 'CREDIT', 0, 'Non-operating income'),
  ('7100', 'Other Expenses', 'OTHER_EXPENSE', 'DEBIT', 0, 'Non-operating expenses')
) AS account_seed(code, name, account_type, normal_balance, opening_balance, description)
WHERE NOT EXISTS (
  SELECT 1 FROM accounting_accounts a WHERE a.organization_id = o.id AND a.account_code = account_seed.code
);

INSERT INTO accounting_periods (organization_id, fiscal_year, period_number, period_start, period_end, status)
SELECT
  o.id,
  EXTRACT(YEAR FROM CURRENT_DATE) AS fiscal_year,
  EXTRACT(MONTH FROM CURRENT_DATE)::INTEGER AS period_number,
  DATE_TRUNC('month', CURRENT_DATE)::DATE,
  (DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month - 1 day')::DATE,
  'OPEN'
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM accounting_periods p
  WHERE p.organization_id = o.id
    AND p.fiscal_year = EXTRACT(YEAR FROM CURRENT_DATE)
    AND p.period_number = EXTRACT(MONTH FROM CURRENT_DATE)::INTEGER
);

INSERT INTO accounting_journal_sequences (organization_id, fiscal_year, next_number)
SELECT o.id, EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER, 1
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM accounting_journal_sequences s
  WHERE s.organization_id = o.id
    AND s.fiscal_year = EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER
);
