# Entity Relationship Diagram

## Core ER diagram for the secure foundation and modular monolith baseline

```mermaid
erDiagram
  ORGANIZATIONS ||--o{ ROLES : owns
  ORGANIZATIONS ||--o{ USERS : contains
  ORGANIZATIONS ||--o{ AUDIT_EVENTS : logs
  ORGANIZATIONS ||--o{ BANK_ACCOUNTS : hosts
  ORGANIZATIONS ||--o{ INVENTORY_PRODUCTS : manages
  ORGANIZATIONS ||--o{ INVENTORY_WAREHOUSES : hosts
  ORGANIZATIONS ||--o{ CUSTOMERS : serves
  ORGANIZATIONS ||--o{ SALES_ORDERS : books
  ORGANIZATIONS ||--o{ MANUFACTURING_ORDERS : plans

  ROLES ||--o{ ROLE_PERMISSIONS : grants
  PERMISSIONS ||--o{ ROLE_PERMISSIONS : assigned_to

  USERS ||--o{ AUDIT_EVENTS : creates
  USERS ||--o{ USERS : manages
  USERS ||--o{ SALES_ORDERS : creates
  USERS ||--o{ MANUFACTURING_ORDERS : creates
  USERS ||--o{ FINANCE_TRANSACTIONS : approves

  INVENTORY_PRODUCTS ||--o{ INVENTORY_STOCK_TRANSACTIONS : receives_movement
  INVENTORY_WAREHOUSES ||--o{ INVENTORY_STOCK_TRANSACTIONS : stores
  INVENTORY_PRODUCTS ||--o{ MANUFACTURING_BOMS : finished_by
  MANUFACTURING_BOMS ||--o{ MANUFACTURING_BOM_LINES : contains
  INVENTORY_PRODUCTS ||--o{ MANUFACTURING_BOM_LINES : consumed_by
  MANUFACTURING_ORDERS }o--|| MANUFACTURING_BOMS : uses
  MANUFACTURING_ORDERS ||--o{ MANUFACTURING_ORDER_MATERIALS : requires
  MANUFACTURING_ORDERS ||--o{ MANUFACTURING_ORDER_OPERATIONS : executes

  CUSTOMERS ||--o{ SALES_ORDERS : places
  SALES_ORDERS ||--o{ SALES_ORDER_LINES : contains
  SALES_ORDERS ||--o{ DELIVERY_NOTES : ships
  SALES_ORDERS ||--o{ CUSTOMER_INVOICES : invoices
  CUSTOMER_INVOICES ||--o{ INVOICE_LINES : contains
  CUSTOMER_INVOICES ||--o{ CUSTOMER_PAYMENTS : receives
  BANK_ACCOUNTS ||--o{ FINANCE_TRANSACTIONS : records
```

## Diagram notes

- `organization_id` is the primary tenant boundary across all operational and accounting tables.
- business actions are not allowed to bypass transactional service logic for inventory movement or ledger posting.
- audit history is explicitly separated from business tables and acts as a traceable event stream.
- several operational concepts such as branch, legal entity, and factory semantics are represented conceptually but remain pending confirmation before final schema commitment.

## Relationship and integrity rules

1. Organization-scoped master data is unique within an organization.
2. financial postings and inventory movements are not allowed to operate without a valid organization and transaction reference.
3. all order and production references remain in UUID form to avoid accidental collisions.
4. soft-delete or status-based inactivation is preferred over hard deletion for master data and approvals.
5. history tables must remain append-only for critical ledger and stock events.
