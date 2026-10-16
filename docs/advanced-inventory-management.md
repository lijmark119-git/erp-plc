# Advanced inventory and warehouse management

This expansion is additive to the existing inventory module. The existing multi-warehouse/location/bin structure, product barcodes, reorder settings and suggestions, stock valuation and aging reports, transfer approvals and in-transit status, cycle counts, adjustments, and accounting journals remain in place.

## Added capabilities

- Extend receipt lots with warehouse/bin, expiry date, warranty end date, barcode/QR data, and quality disposition.
- Register unique serial numbers against a lot and track issue status, warranty, current location, and in-transit transfers.
- Resolve a product barcode, lot number/barcode, or serial number/barcode using the trace lookup endpoint.
- Generate PNG QR labels for lot or serial lookup codes from the traceability workspace.
- Reserve available stock against a warehouse, location, and optional sales/production reference. Reservations reduce stock available to ordinary issues and warehouse dispatches.
- Fulfill a reservation while issuing inventory; the sales-delivery workflow automatically applies a matching active reservation when its reference is the delivery ID.
- Put remaining lot stock into quarantine, mark it damaged/returned, or release it after review. Quarantined, damaged, returned, and expired lot quantities are excluded from available stock.
- Automatically select eligible serials in expiry/FIFO order when an issue does not specify serial numbers. A serial-tracked product cannot be issued without enough eligible serials.

Receipts without lot, expiry, warranty, barcode, quality, or serial fields continue through the existing receipt behavior. Stock without active reservations or restricted/expired traced lots continues to use the existing issue path.

## API

All routes are scoped to the authenticated organization and use existing inventory permissions.

- `GET /api/inventory-management/trace/lots`
- `GET /api/inventory-management/trace/serials`
- `GET /api/inventory-management/trace/lookup?code=...`
- `GET /api/inventory-management/trace/qr?code=...` returns a PNG QR label for the lookup code.
- `POST /api/inventory-management/trace/lots/:id/quality` changes a lot's quality disposition.
- `GET /api/inventory-management/reservations`
- `POST /api/inventory-management/reservations`
- `POST /api/inventory-management/reservations/:id/release`

The existing `POST /api/inventory-management/stock/receive` accepts optional `lotNumber`, `lotQuantity`, `expiryDate`, `warrantyEndDate`, `lotBarcode`, `qualityStatus`, and `serialNumbers` fields. The existing issue endpoint accepts optional `reservationId` and `serialNumbers`.

## Boundaries

Lot traceability uses the existing manufacturing lot register so production trace records remain visible. Reservations and quality/serial actions are audit-logged. Serialized units follow the existing approved/in-transit transfer workflow and update their warehouse/bin on receipt; this extension does not change how transfer lines are valued or posted. For non-serialized bulk lots, batch-level identity remains on the receipt lot while quantity continues through the existing transfer ledger. Migrations `028_inventory_traceability.sql`, `029_inventory_lot_locations.sql`, and `030_inventory_serial_transfers.sql` only add traceability fields and tables.

QR labels encode lookup codes already registered in the system. Handheld barcode/QR scanners that enter decoded text into the lookup field are supported; the workspace does not request camera access.
