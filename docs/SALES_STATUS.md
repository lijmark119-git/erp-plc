# Sales Management Status

Sales management is implemented as an additive feature in the existing ERP. It uses the existing PostgreSQL schema, session authentication, role permissions, inventory services, and general ledger.

## Workflow

`Customer -> Quotation -> Sales order -> Approval -> Delivery -> Invoice -> Payment / receipt -> Accounting`

- Customer records include customer code, legal/contact details, tax ID, credit limit, payment terms, currency, active status, and billing/shipping/delivery addresses.
- Quotations and sales orders support line-level quantity, price, discount, tax, validity/delivery dates, payment terms, status transitions, approval, and quotation conversion.
- Delivery notes progress through Picking, Packed, Shipped, Delivered, and Returned. Shipment/return movements use the existing inventory service and write stock transactions and COGS/inventory journals.
- Customer invoices contain line totals, discounts, taxes, due dates, issuance, and receivable tracking.
- Customer receipts support cash, bank, transfer, cheque, and other methods. Payments update invoice balances and create receipt numbers.
- Receivables expose outstanding balance, overdue status, and aging buckets. Reports group sales by customer, product, salesperson, and period and summarize gross sales, discounts, VAT, net sales, receivables, and aging.

## Accounting

Invoice posting creates:

- DR Accounts Receivable (1100)
- CR Sales Revenue (4000)
- CR VAT Payable (2200), when tax applies

Payment posting creates:

- DR Cash/Bank (1000)
- CR Accounts Receivable (1100)

Delivery inventory transactions use the configured product inventory and COGS accounts through the inventory service. Posting remains subject to the existing accounting-period controls.

## APIs and permissions

The structured API is under `/api/sales`: customers and addresses, quotations, orders, deliveries, invoices, payments, receivables, reports, warehouses, and audit. Existing `/api/sales` legacy order behavior remains available for compatibility.

Sales actions use granular `sales:*` permissions, organization-scoped PostgreSQL records, and the sales audit trail. Sellers can create customers, quotations, and orders, but cannot approve quotes/orders or manage deliveries/invoices/payments.

## Database and verification

The additive sales schema and role mappings are defined by `migrations/016_sales_management.sql` and `migrations/017_sales_rbac.sql`. Apply unapplied migrations with `npm run db:migrate`.

The sales integration test covers the customer-to-cash path, inventory effects, accounting journals, receivables/report totals, and approval RBAC. Run with `npm test`.
