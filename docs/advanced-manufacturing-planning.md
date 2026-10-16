# Advanced manufacturing and production planning

The manufacturing workspace extends the existing production workflows without replacing them. Existing versioned BOMs, routing and work centers, work orders, material reservation and consumption, WIP and cost reporting, scrap/yield, quality inspections, MRP, and batch genealogy remain available.

## Demand forecasting and MRP

- Record a forecast by finished/semi-finished product and date from **Manufacturing → Forecast & maintenance**.
- Saving another forecast for the same product and date updates that forecast entry.
- Run MRP with approved sales orders (the existing default), forecasts, or both. A manually supplied demand list continues to take precedence when provided.
- Forecast quantities are included only when their dates fall inside the MRP demand horizon.

## Maintenance and downtime

- Schedule preventive or corrective maintenance against an active work center, with a planned date and optional next-due date.
- Complete a scheduled event and record actual downtime in minutes. Completed maintenance events remain visible in the schedule for historical reporting.
- Existing work-center calendars and machine-utilization reporting remain unchanged.

Schema additions are applied by `migrations/031_manufacturing_planning_maintenance.sql`. Forecast entry and MRP use the existing `manufacturing:mrp:run` permission; maintenance scheduling and completion use `manufacturing:routing:manage`.
