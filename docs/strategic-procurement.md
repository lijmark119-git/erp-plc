# Strategic procurement

This is an additive extension to the existing supplier comparison, approval, purchase order, and goods-receipt workflow. Existing procurement actions and the legacy quick-create PO remain available.

## Requisitions and sourcing

- Submit a purchase requisition with quantity, estimated unit cost, and a budget cap. Requests above the cap are rejected before persistence; submitted requests use the existing purchase-order approval permission.
- Existing multi-supplier quote comparisons provide RFQ/bid comparison and supplier selection.
- Supplier records now include qualification status and risk level; supplier scorecards summarize spend, order completion, and on-time delivery from receipt history.

## Supplier invoice matching

- Register a supplier invoice against an approved purchase order.
- Run a three-way check of invoice quantity against both ordered and received quantities, and invoice value against the purchase-order landed value. Exceptions remain flagged for review and are not automatically posted for payment.
- Existing PO approvals and partial/full goods receipts are unchanged.

The additions are in `migrations/033_procurement_controlled_sourcing.sql`. Requisitions use the existing procurement order permissions; invoice entry uses receipt permission, and invoice matching uses approval permission.
