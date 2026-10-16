ALTER TABLE accounting_journal_sequences
  DROP CONSTRAINT accounting_journal_sequences_pkey;

ALTER TABLE accounting_journal_sequences
  ADD PRIMARY KEY (organization_id, fiscal_year);
