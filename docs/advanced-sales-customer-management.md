# Advanced sales and customer management

This is an additive extension of the existing customer-to-cash workflows. The existing credit controls, quotations and order approvals, delivery and returns, invoicing, payments, receivables aging, and customer/salesperson profitability reports remain available.

## CRM and customer activity

- Open **Sales → CRM & activity** to record leads or opportunities, optionally associate an existing customer, and capture stage, estimated value, expected close date, source, and notes.
- Log calls, email, meetings, notes, or follow-ups against a customer or CRM record. Follow-up dates and the activity timeline are retained.
- Existing customers remain in the customer register; CRM records may be created before a customer is onboarded.

## Receivable disputes

- From **Sales → Receivables**, open a dispute against an outstanding receivable.
- Authorized users can move disputes to review, resolve them with a resolution note, or reject them with a resolution note.
- Dispute records do not change invoice balances or accounting postings; those continue through the established payment and credit workflows.

CRM records, activities, and disputes are stored in the additive migration `032_sales_crm_disputes.sql`. CRM and dispute changes use the existing `sales:customers:manage` permission; dispute listing uses `sales:receivables:read`.
