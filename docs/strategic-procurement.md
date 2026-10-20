# Strategic procurement

This is an additive extension to the existing supplier comparison, approval, purchase order, and goods-receipt workflow. Existing procurement actions and the legacy quick-create PO remain available.

## Requisitions and sourcing

- Submit a purchase requisition with quantity, estimated unit cost, and a budget cap. Requests above the cap are rejected before persistence; submitted requests use the existing purchase-order approval permission.
- Existing multi-supplier quote comparisons provide RFQ/bid comparison and supplier selection.
- Supplier records now include qualification status and risk level; supplier scorecards summarize spend, order completion, and on-time delivery from receipt history.

## Supplier invoice matching

- Register a supplier invoice against an approved purchase order.
- Run a three-way check of invoice quantity against both ordered and received quantities, and invoice value against the purchase-order landed value. Exceptions remain flagged for review and are not automatically posted for payment.
- Existing PO approvals and partial/full goods receipts remain available. On `POST /api/procurement/orders/:orderId/receive`, inventory-managed goods can specify an organization-owned inventory SKU and active warehouse; each partial receipt creates an inventory ledger transaction and posts the configured inventory/GRNI journal atomically with the procurement receipt. A purchase order is kept tied to the same product and warehouse across partial receipts. Service/non-stock receipts can continue without an inventory mapping.
- Receipt requests accept an idempotency UUID. The UI reuses the same key on retries, preventing duplicate stock and journal postings. Receipt valuation uses the quoted unit price; quote taxes, shipping, and other costs are not reallocated into inventory valuation.
- Three-way invoice matching remains a matching status only; it does not create an accounts-payable invoice journal or initiate supplier payment. Requisition approval is not yet automatically linked to creation of a sourcing comparison.

## Supplier documents

- Register supplier certifications and other qualification documents with an expiry date and an optional HTTP(S) document reference.
- The supplier workspace labels documents as expired, expiring within 30 days, current, or without a recorded expiry. These are live status indicators, not emailed reminders.
- Document metadata is scoped to the organization and supplier; files are not uploaded or stored by this feature.
- Document registration uses the existing supplier-management permission and is included in procurement audit history.

The controlled-sourcing additions are in `migrations/033_procurement_controlled_sourcing.sql`; supplier document tracking is in `migrations/038_procurement_supplier_documents.sql`; inventory-linked PO receipts are added in `migrations/045_procurement_inventory_receipts.sql`. Requisitions use the existing procurement order permissions; invoice entry uses receipt permission, invoice matching uses approval permission, and document registration uses supplier-management permission.

## Rollback

Roll back the application code before removing these additive schema changes. The procurement receipt migration can be rolled back by dropping `idx_procurement_receipts_idempotency`, then dropping `inventory_transaction_id` and `idempotency_key` from `procurement_purchase_order_receipts`, and `inventory_product_id` and `inventory_warehouse_id` from `procurement_purchase_orders`. Do not delete the posted inventory transactions or journals; they are part of the auditable ledger. The rollback only removes the procurement-to-inventory references and idempotency keys.
