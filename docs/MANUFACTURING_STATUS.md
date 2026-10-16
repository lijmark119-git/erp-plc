# Manufacturing Status

## Implemented

Manufacturing is an additive PostgreSQL extension of the existing ERP. The legacy `/api/manufacturing` sample overview and `/api/manufacturing/orders` endpoint remain available; the production workspace uses the new organization-scoped PostgreSQL APIs.

- Versioned bills of material with finished product, raw/semi-finished components, UOM conversion, quantities, scrap, effective dates, and one active version per finished product.
- Work centers with machine/labor capacity, machine identity, hourly labor/machine/overhead rates, and working-day calendars.
- Versioned routings with ordered operations, setup time, run time, labor standards, and work-center assignment.
- Manufacturing-order lifecycle: `PLANNED -> RELEASED -> IN_PROGRESS -> COMPLETED -> CLOSED`.
- Release-time material reservation against warehouse stock less other active reservations; material consumption cannot exceed required or reserved quantities.
- Material issues use existing immutable inventory transactions and post `DR WIP / CR Raw Material Inventory`.
- Operation completion records actual machine/labor hours and reclassifies direct labor/overhead into WIP through the existing accounting engine.
- Production output records good and rejected quantities, production date, batch/lot, unit and total cost; inventory receipt posts `DR Finished Goods / CR WIP`, with rejected cost posted to scrap expense.
- Lot-linked incoming, in-process, and final quality inspections record inspected, passed, and failed quantities, defect codes, inspector, notes, and an auditable pass/partial/fail result.
- Raw receipt lots can be registered from the inventory receipt transaction; consumption requires a registered lot. Genealogy follows consumed lots through produced lots and FIFO lot shipments to customer deliveries.
- MRP explodes multilevel active BOMs for approved sales demand or supplied demand overrides and nets on-hand inventory, reservations, open production, open purchase supply, and safety/reorder stock.
- Production plan, orders, material consumption, variance, WIP, production cost, machine utilization, yield, scrap, MRP, and batch traceability reports are calculated from PostgreSQL.
- Manufacturing actions are permission-gated and audited. Admin manages master data; Manager can execute production, consume/output, run MRP, and view reports; Seller has no manufacturing access.
- Responsive Manufacturing workspace tabs are integrated into the existing frontend; the prior overview remains as the Overview tab.

## Tables

- `manufacturing_work_centers`
- `manufacturing_boms`, `manufacturing_bom_lines`
- `manufacturing_routings`, `manufacturing_routing_operations`
- `manufacturing_orders`, `manufacturing_order_materials`, `manufacturing_order_operations`
- `manufacturing_material_reservations`, `manufacturing_material_consumptions`
- `manufacturing_lots`, `manufacturing_production_outputs`, `manufacturing_lot_genealogy`, `manufacturing_lot_shipments`
- `manufacturing_open_purchase_supply`
- `manufacturing_mrp_runs`, `manufacturing_mrp_requirements`
- `manufacturing_audit_trail`

## API

- `GET /api/manufacturing/workspace`
- `GET|POST /api/manufacturing/work-centers`
- `GET|POST /api/manufacturing/boms`, `POST /api/manufacturing/boms/:bomId/activate`
- `GET|POST /api/manufacturing/routings`
- `GET|POST /api/manufacturing/work-orders`, `GET /api/manufacturing/work-orders/:orderId`
- `POST /api/manufacturing/work-orders/:orderId/{reserve,release,start,consume,output,close}`
- `POST /api/manufacturing/work-orders/:orderId/operations/:operationId/{start,complete}`
- `POST /api/manufacturing/lots/raw`, `GET /api/manufacturing/lots/:lotNumber/trace`
- `GET|POST /api/manufacturing/quality-inspections`
- `POST /api/manufacturing/mrp/run`, `GET /api/manufacturing/mrp/latest`
- `POST /api/manufacturing/mrp/open-supply`, `PUT /api/manufacturing/mrp/open-supply/:supplyId/receive`
- `GET /api/manufacturing/reports/:reportType`, `GET /api/manufacturing/audit`

## Verification

`tests/manufacturing.test.js` covers BOM/routing, MRP stock/supply netting, reservation, lot registration, material consumption, operation costing, finished and rejected output, inventory/accounting entries, close workflow, and lot-to-delivery traceability. `tests/apiAuthorization.test.js` and `tests/authorization.test.js` cover role access. `tests/inventoryManagement.test.js` verifies inventory journal debit/credit mapping and posted API-mode receipts.

Database migration validation was attempted with `npm run db:migrate`. It stops before reaching `018_manufacturing.sql` because the pre-existing `017_sales_rbac.sql` inserts string values such as `sales-customers-read` into the UUID `permissions.id` column. That Sales migration was left unchanged to preserve the existing migration history. Apply a compatible fix to that migration in a separate approved change, then rerun `npm run db:migrate` and the full test suite.

## Operational Notes

- The current Procurement module has no PostgreSQL purchase-order line table. MRP therefore uses the manufacturing-owned `manufacturing_open_purchase_supply` register for expected material receipts; the legacy Procurement module remains unchanged.
- Quality inspections are auditable records only; they do not change inventory quantities, block shipment, or post accounting entries.
- A receipt must include `lotNumber` to create a raw manufacturing lot automatically, or operators can register a lot from an existing inventory receipt transaction in the Manufacturing MRP tab.
- Manufacturing product inventory/account codes are taken from the existing inventory product configuration; default WIP/finished-goods/COGS account codes are seeded by the existing accounting schema.
