INSERT INTO accounting_accounts (
  organization_id, account_code, account_name, account_type, active,
  description, normal_balance, opening_balance
)
SELECT
  organizations.id,
  payroll_account.code,
  payroll_account.name,
  payroll_account.account_type,
  TRUE,
  payroll_account.description,
  payroll_account.normal_balance,
  0
FROM organizations
CROSS JOIN (VALUES
  ('1210', 'Employee Advances Receivable', 'ASSET', 'DEBIT', 'Outstanding employee salary advances'),
  ('2010', 'Salary Payable', 'LIABILITY', 'CREDIT', 'Net salaries payable to employees'),
  ('2110', 'Other Deductions Payable', 'LIABILITY', 'CREDIT', 'Other payroll deductions payable'),
  ('2210', 'Income Tax Payable', 'LIABILITY', 'CREDIT', 'Employee income tax withheld'),
  ('2220', 'Pension Payable', 'LIABILITY', 'CREDIT', 'Employee and employer pension contributions'),
  ('6010', 'Salary Expense', 'OPERATING_EXPENSE', 'DEBIT', 'Employee basic pay, allowances, and overtime'),
  ('6020', 'Employer-related Expense', 'OPERATING_EXPENSE', 'DEBIT', 'Employer pension and payroll-related expense')
) AS payroll_account(code, name, account_type, normal_balance, description)
WHERE NOT EXISTS (
  SELECT 1
  FROM accounting_accounts existing
  WHERE existing.organization_id = organizations.id
    AND existing.account_code = payroll_account.code
);
