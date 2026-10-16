import { useCallback, useEffect, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import {
  createFinancialAccount,
  getAccountLedger,
  getFinancialAccounts,
  getJournalEntries,
  postJournalEntry,
  type FinancialAccount,
  type JournalEntryRecord,
  type LedgerRecord,
} from './api';

type FinancePageProps = {
  organizationId: string;
  page: string;
  canManageAccounts: boolean;
  canPost: boolean;
};

type JournalDraftLine = { key: number; accountId: string; debit: string; credit: string; memo: string };
const accountTypes: FinancialAccount['account_type'][] = ['asset', 'liability', 'equity', 'revenue', 'expense'];

export default function FinancePage({
  organizationId,
  page,
  canManageAccounts,
  canPost,
}: FinancePageProps) {
  const [accounts, setAccounts] = useState<FinancialAccount[]>([]);
  const [entries, setEntries] = useState<JournalEntryRecord[]>([]);
  const [ledger, setLedger] = useState<{ accountId: string; record: LedgerRecord } | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [loadedOrganizationId, setLoadedOrganizationId] = useState('');
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [accountType, setAccountType] = useState<FinancialAccount['account_type']>('asset');
  const [postingDate, setPostingDate] = useState(new Date().toISOString().slice(0, 10));
  const [currency, setCurrency] = useState('USD');
  const [description, setDescription] = useState('');
  const [reference, setReference] = useState('');
  const [lines, setLines] = useState<JournalDraftLine[]>([
    { key: 0, accountId: '', debit: '', credit: '', memo: '' },
    { key: 1, accountId: '', debit: '', credit: '', memo: '' },
  ]);

  const refresh = useCallback(async () => {
    const [accountRows, entryRows] = await Promise.all([
      getFinancialAccounts(organizationId),
      getJournalEntries(organizationId),
    ]);
    setAccounts(accountRows);
    setEntries(entryRows);
    setSelectedAccountId((current) => current || accountRows[0]?.id || '');
    setLoadedOrganizationId(organizationId);
    setLoadError('');
  }, [organizationId]);

  useEffect(() => {
    let active = true;
    if (!organizationId) return () => { active = false; };
    Promise.all([getFinancialAccounts(organizationId), getJournalEntries(organizationId)])
      .then(([accountRows, entryRows]) => {
        if (!active) return;
        setAccounts(accountRows);
        setEntries(entryRows);
        setSelectedAccountId((current) => current || accountRows[0]?.id || '');
        setLoadedOrganizationId(organizationId);
        setLoadError('');
      })
      .catch((loadError: unknown) => {
        if (active) setLoadError(loadError instanceof Error ? loadError.message : 'Finance records could not be loaded.');
      });
    return () => { active = false; };
  }, [organizationId]);

  useEffect(() => {
    let active = true;
    if (!organizationId || !selectedAccountId) return () => { active = false; };
    getAccountLedger(organizationId, selectedAccountId)
      .then((result) => { if (active) setLedger({ accountId: selectedAccountId, record: result }); })
      .catch((loadError: unknown) => {
        if (active) setLoadError(loadError instanceof Error ? loadError.message : 'The account ledger could not be loaded.');
      });
    return () => { active = false; };
  }, [organizationId, selectedAccountId, entries]);

  async function submitAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await createFinancialAccount({ organization_id: organizationId, code, name, account_type: accountType });
      setCode('');
      setName('');
      setNotice('Financial account created.');
      await refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'The financial account could not be created.');
    } finally {
      setSaving(false);
    }
  }

  async function submitEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      if (lines.some((line) => !line.accountId)) throw new Error('Select an account for each journal line.');
      if (lines.some((line) => !line.debit && !line.credit)) throw new Error('Enter a debit or credit amount for each line.');
      await postJournalEntry({
        organization_id: organizationId,
        posting_date: postingDate,
        currency: currency.trim().toUpperCase(),
        description,
        reference: reference.trim() || undefined,
        lines: lines.map((line) => ({
          account_id: line.accountId,
          debit: line.debit || '0',
          credit: line.credit || '0',
          memo: line.memo.trim() || undefined,
        })),
      });
      setDescription('');
      setReference('');
      setLines([
        { key: Date.now(), accountId: '', debit: '', credit: '', memo: '' },
        { key: Date.now() + 1, accountId: '', debit: '', credit: '', memo: '' },
      ]);
      setNotice('Journal entry posted. Posted entries are immutable.');
      await refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'The journal entry could not be posted.');
    } finally {
      setSaving(false);
    }
  }

  if (!organizationId) return <div className="state-panel">Select an organization context to use Finance.</div>;
  if (loadError) {
    return (
      <div className="state-panel error-panel" role="alert">
        <span>{loadError}</span>
        <button className="button button-secondary" onClick={() => void refresh().catch((retryError: unknown) => {
          setLoadError(retryError instanceof Error ? retryError.message : 'Finance records could not be loaded.');
        })}>Retry</button>
      </div>
    );
  }
  if (loadedOrganizationId !== organizationId) return <div className="state-panel"><span className="spinner" /> Loading finance records…</div>;

  const debitTotal = lines.reduce((total, line) => {
    const amount = moneyUnits(line.debit);
    return amount === null ? null : total === null ? null : total + amount;
  }, 0n as bigint | null);
  const creditTotal = lines.reduce((total, line) => {
    const amount = moneyUnits(line.credit);
    return amount === null ? null : total === null ? null : total + amount;
  }, 0n as bigint | null);
  const totalsMatch = debitTotal !== null && creditTotal !== null && debitTotal === creditTotal;
  return (
    <div className="inventory-workspace">
      <div className="inventory-message finance-notice">Manual journals only. Each entry is balanced and single-currency; exchange conversion and automated subledger postings are not configured.</div>
      {error && <div className="inventory-message error-panel" role="alert">{error}</div>}
      {notice && <div className="inventory-message success-message" role="status">{notice}</div>}
      {page === 'overview' && (
        <>
          <div className="inventory-summary">
            <SummaryCard label="Chart of accounts" value={String(accounts.length)} />
            <SummaryCard label="Posted journals" value={String(entries.length)} />
            <SummaryCard label="Currencies" value={String(new Set(entries.map((entry) => entry.currency)).size)} />
          </div>
          <EntryTable entries={entries.slice(0, 10)} />
        </>
      )}
      {page === 'accounts' && (
        <>
          {canManageAccounts && (
            <form className="inventory-form" onSubmit={(event) => void submitAccount(event)}>
              <div className="form-intro"><h2>Create financial account</h2><p>Maintain your organization’s chart of accounts.</p></div>
              <label>Account code<input required maxLength={32} value={code} onChange={(event) => setCode(event.target.value)} /></label>
              <label>Account name<input required maxLength={255} value={name} onChange={(event) => setName(event.target.value)} /></label>
              <label>Account type<select value={accountType} onChange={(event) => setAccountType(event.target.value as FinancialAccount['account_type'])}>{accountTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
              <button className="button button-primary" disabled={saving} type="submit">{saving ? 'Saving…' : 'Create account'}</button>
            </form>
          )}
          <AccountTable accounts={accounts} />
          {!canManageAccounts && <p className="inventory-hint">You have read-only chart-of-accounts access.</p>}
        </>
      )}
      {page === 'journals' && (
        <>
          {canPost && (
            <form className="inventory-form journal-form" onSubmit={(event) => void submitEntry(event)}>
              <div className="form-intro"><h2>Post journal entry</h2><p>Entries post immediately and cannot be edited or deleted. Use a reversal to correct a posting.</p></div>
              <label>Posting date<input required type="date" value={postingDate} onChange={(event) => setPostingDate(event.target.value)} /></label>
              <label>Currency<input required pattern="[A-Za-z]{3}" maxLength={3} value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} /></label>
              <label>Description<input required maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
              <label>Reference<input maxLength={100} value={reference} onChange={(event) => setReference(event.target.value)} /></label>
              {lines.map((line, index) => (
                <div className="journal-line" key={line.key}>
                  <label>Account<select required value={line.accountId} onChange={(event) => updateLine(setLines, line.key, 'accountId', event.target.value)}><option value="">Select account</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.code} — {account.name}</option>)}</select></label>
                  <label>Debit<input min="0" step="0.0001" type="number" value={line.debit} onChange={(event) => updateLine(setLines, line.key, 'debit', event.target.value)} /></label>
                  <label>Credit<input min="0" step="0.0001" type="number" value={line.credit} onChange={(event) => updateLine(setLines, line.key, 'credit', event.target.value)} /></label>
                  <label>Memo<input maxLength={255} value={line.memo} onChange={(event) => updateLine(setLines, line.key, 'memo', event.target.value)} /></label>
                  {lines.length > 2 && <button className="button button-secondary" type="button" onClick={() => setLines((current) => current.filter((row) => row.key !== line.key))}>Remove line {index + 1}</button>}
                </div>
              ))}
              <div className="journal-totals" aria-live="polite">
                <span>Debits <strong>{formatMoneyUnits(debitTotal)} {currency.toUpperCase()}</strong></span>
                <span>Credits <strong>{formatMoneyUnits(creditTotal)} {currency.toUpperCase()}</strong></span>
                <span className={totalsMatch ? 'balanced' : 'unbalanced'}>
                  {totalsMatch ? 'Balanced' : 'Out of balance'}
                </span>
              </div>
              <button className="button button-secondary" type="button" onClick={() => setLines((current) => [...current, { key: Date.now(), accountId: '', debit: '', credit: '', memo: '' }])}>Add journal line</button>
              <button className="button button-primary" disabled={saving || accounts.length < 2} type="submit">{saving ? 'Posting…' : 'Post journal entry'}</button>
              {accounts.length < 2 && <p className="inventory-hint">Create at least two accounts before posting a journal entry.</p>}
            </form>
          )}
          <EntryTable entries={entries} />
          {!canPost && <p className="inventory-hint">You have read-only journal access.</p>}
        </>
      )}
      {page === 'ledger' && (
        <section className="table-card">
          <div className="table-heading ledger-heading">
            <div><h2>General ledger</h2><p>Running balance shown as net debits, separately by currency.</p></div>
            <label>Account<select aria-label="Ledger account" value={selectedAccountId} onChange={(event) => setSelectedAccountId(event.target.value)}><option value="">Select account</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.code} — {account.name}</option>)}</select></label>
          </div>
          <LedgerTable ledger={ledger?.accountId === selectedAccountId ? ledger.record : null} />
        </section>
      )}
    </div>
  );
}

function moneyUnits(value: string): bigint | null {
  if (!value) return 0n;
  if (!/^\d+(?:\.\d{1,4})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0'));
}

function formatMoneyUnits(value: bigint | null): string {
  if (value === null) return '—';
  return `${value / 10000n}.${(value % 10000n).toString().padStart(4, '0')}`;
}

function updateLine(
  setLines: Dispatch<SetStateAction<JournalDraftLine[]>>,
  key: number,
  field: 'accountId' | 'debit' | 'credit' | 'memo',
  value: string,
) {
  setLines((current) => current.map((line) => {
    if (line.key !== key) return line;
    return field === 'debit'
      ? { ...line, debit: value, credit: value ? '' : line.credit }
      : field === 'credit'
        ? { ...line, credit: value, debit: value ? '' : line.debit }
        : { ...line, [field]: value };
  }));
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return <div className="inventory-summary-card"><span>{label}</span><strong>{value}</strong></div>;
}

function AccountTable({ accounts }: { accounts: FinancialAccount[] }) {
  return (
    <div className="table-card">
      <div className="table-heading"><div><h2>Chart of accounts</h2><p>Organization-scoped financial accounts.</p></div></div>
      <div className="table-scroll"><table><thead><tr><th>Code</th><th>Account</th><th>Type</th><th>Status</th></tr></thead><tbody>
        {accounts.map((account) => <tr key={account.id}><td>{account.code}</td><td>{account.name}</td><td>{account.account_type}</td><td>{account.is_active ? 'Active' : 'Inactive'}</td></tr>)}
        {!accounts.length && <tr><td colSpan={4}>No financial accounts have been created.</td></tr>}
      </tbody></table></div>
    </div>
  );
}

function EntryTable({ entries }: { entries: JournalEntryRecord[] }) {
  return (
    <section className="table-card">
      <div className="table-heading"><div><h2>Posted journal entries</h2><p>Immutable, balanced manual postings.</p></div></div>
      <div className="table-scroll"><table><thead><tr><th>Date / Entry</th><th>Description</th><th>Account</th><th>Debit</th><th>Credit</th><th>Currency</th></tr></thead><tbody>
        {entries.flatMap((entry) => entry.lines.map((line) => (
          <tr key={line.id}><td>{entry.posting_date}<span className="table-secondary">{entry.entry_number}</span></td><td>{entry.description}</td><td>{line.account_code} — {line.account_name}</td><td>{line.debit}</td><td>{line.credit}</td><td>{entry.currency}</td></tr>
        )))}
        {!entries.length && <tr><td colSpan={6}>No journal entries have been posted.</td></tr>}
      </tbody></table></div>
    </section>
  );
}

function LedgerTable({ ledger }: { ledger: LedgerRecord | null }) {
  return (
    <div className="table-scroll"><table><thead><tr><th>Date</th><th>Entry</th><th>Description</th><th>Reference</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead><tbody>
      {ledger?.entries.map((line) => <tr key={line.entry_id}><td>{line.posting_date}</td><td>{line.entry_number}</td><td>{line.description}</td><td>{line.reference || '—'}</td><td>{line.debit} {line.currency}</td><td>{line.credit} {line.currency}</td><td>{line.running_balance} {line.currency}</td></tr>)}
      {ledger && !ledger.entries.length && <tr><td colSpan={7}>No posted entries for this account.</td></tr>}
      {!ledger && <tr><td colSpan={7}>Select an account to view its ledger.</td></tr>}
    </tbody></table></div>
  );
}
