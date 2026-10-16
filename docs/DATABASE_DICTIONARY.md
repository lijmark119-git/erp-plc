# Database Dictionary (Phase 1 Baseline)

## Purpose
This dictionary summarizes the baseline database design used to support the secure foundation and modular monolith architecture. It reflects the current migration patterns and the design guidance in the phase 1 architecture document. It is intentionally not a complete final-schema claim; it is a verified baseline for shared components and transactional operations.

## Master and shared tables

| Table | Purpose | Key columns | Important constraints | Notes |
| --- | --- | --- | --- | --- |
| organizations | Top-level legal or operational tenant | id, code, name, currency, timezone | `UNIQUE (code)` | Primary tenant boundary |
| roles | Named business roles within an organization | id, organization_id, code, name | `UNIQUE (organization_id, code)` | Role-scoped access model |
| permissions | Catalog of permissions | id, code, name, category | `UNIQUE (code)` | Reusable capability model |
| role_permissions | join between roles and permissions | role_id, permission_id | PK `(role_id, permission_id)` | RBAC relationship |
| users | End-user identity records | id, organization_id, username, role_id, password_hash | unique username; failed_login_count check | Must be scoped to organization |
| audit_events | system and user action trail | id, organization_id, actor_user_id, action, entity_type, entity_id, details | `occurred_at` + JSONB details | Mandatory operational audit |

## Finance and banking tables

| Table | Purpose | Key columns | Important constraints | Notes |
| --- | --- | --- | --- | --- |
| bank_accounts | bank account register | id, organization_id, code, account_number, currency | unique org/code | Account references must be stable |
| finance_transactions | bank movement and financial posting history | id, bank_account_id, type, amount, category, status | `CHECK (type IN ('CREDIT', 'DEBIT'))` | Write-through to accounting layer |

## Inventory tables

| Table | Purpose | Key columns | Important constraints | Notes |
| --- | --- | --- | --- | --- |
| inventory_uoms | units of measure catalog | id, organization_id, code, base_unit, factor | unique org/code; factor>0 | Supports conversion model |
| inventory_products | product master data | id, organization_id, sku, product_type, unit_of_measure_id | unique org/sku and org/product_code | Financial and stock master |
| inventory_uom_conversions | conversion between units | id, from_uom_id, to_uom_id, factor | factor>0 | Required for inventory operations |
| inventory_warehouses | warehouse master | id, organization_id, code, name | unique org/code | Storage location model |
| inventory_locations | bin or storage location | id, warehouse_id, code, zone | unique org/warehouse/code | Narrower location granularity |
| inventory_transfer_requests | movement approval workflow | id, product_id, source_warehouse_id, destination_warehouse_id, status | `CHECK (source_warehouse_id <> destination_warehouse_id)` | tracks transfer state |
| inventory_stock_transactions | immutable stock ledger | id, product_id, warehouse_id, transaction_type, direction, quantity, unit_cost | unique org/reference; positive quantity | source of truth for stock movement |
| inventory_adjustments | stock corrections | id, product_id, warehouse_id, quantity, adjustment_type | positive quantity and explicit type | for approval-based adjustment |

## Sales and customer tables

| Table | Purpose | Key columns | Important constraints | Notes |
| --- | --- | --- | --- | --- |
| customers | customer master | id, customer_code, legal_name, credit_limit | unique code | requires credit policy confirmation |
| customer_addresses | address records | id, customer_id, address_type, city, country | N/A | supports billing/shipping separation |
| quotations | sales quote header | id, quotation_number, customer_id, status, total | unique quotation number | draft-to-order flow |
| quotation_lines | quote detail | id, quotation_id, product_sku, quantity, unit_price | N/A | supports dynamic pricing |
| sales_orders | sales order header | id, order_number, customer_id, status, total | unique order number | approval states are required |
| sales_order_lines | order detail | id, sales_order_id, product_sku, quantity, unit_price | N/A | link to delivery and invoice |
| delivery_notes | shipping documents | id, delivery_number, sales_order_id, status | unique delivery number | shipment status tracking |
| delivery_line_items | delivery detail | id, delivery_id, delivered_qty | N/A | tracks actual shipped quantities |
| customer_invoices | invoice header | id, invoice_number, customer_id, total, status | unique invoice number | invoice lifecycle states |
| invoice_lines | invoice detail | id, invoice_id, product_sku, line_total | N/A | invoice breakdown |
| customer_payments | payment receipt records | id, payment_number, invoice_id, amount, payment_method | unique payment number | linked to receivables |
| accounts_receivable | AR aging snapshot | id, invoice_id, customer_id, outstanding, status | N/A | should be recalculated, not solely trusted input |

## Manufacturing tables

| Table | Purpose | Key columns | Important constraints | Notes |
| --- | --- | --- | --- | --- |
| manufacturing_work_centers | production capacity | id, organization_id, code, machine_capacity, labor_capacity | unique org/code | stores work center capability |
| manufacturing_boms | bill of materials header | id, organization_id, bom_code, version, finished_product_id, status | unique org/bom_code/version | active BOMs must be unique per product |
| manufacturing_bom_lines | BOM items | id, bom_id, line_number, raw_material_product_id | unique bom_id + line_number | maps required raw material quantities |
| manufacturing_routings | production routing definition | id, organization_id, routing_code, finished_product_id | unique org/routing_code/version | supports routing definitions |
| manufacturing_routing_operations | sequence operations | id, routing_id, sequence_number, work_center_id | unique routing/sequence | defines production steps |
| manufacturing_orders | production orders | id, organization_id, order_number, finished_product_id, bom_id | unique org/order_number | tracks production lifecycle |
| manufacturing_order_materials | planned material requirements | id, manufacturing_order_id, raw_material_product_id, required_quantity | unique order + product | required for reservation logic |
| manufacturing_material_reservations | material reservations | id, order_material_id, warehouse_id, quantity, status | status enum | must remain auditable |
| manufacturing_order_operations | order step execution status | id, manufacturing_order_id, sequence_number, operation_name | unique sequence per order | supports production control |

## Integrity and operational design rules

1. Every operational table should be scoped by `organization_id` unless the table is a global lookup.
2. Every resource that can be edited must have a clear owner or actor and an audit trail.
3. Inventory and financial tables must use transactions and status-based approval flows instead of route-level direct updates.
4. `ON DELETE RESTRICT` should be favored for ledger or historical records; `ON DELETE CASCADE` should be limited to owned child data within the same business object.
5. Deletion of organization-level objects should be controlled carefully because it can cascade into shared operational history.
6. Without a confirmed business policy, default assumptions should be conservative and configurable.

## Pending confirmation items

These items are still open and should not be treated as final design requirements:
- multi-company legal entity enforcement
- branch and warehouse ownership mapping
- factory and work-center ownership mapping
- cost center and department hierarchy
- product cross-organization sharing
- accounting chart and financial close policy
- manufacturing and procurement approval policies
