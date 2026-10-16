const RANGE_DAYS = Object.freeze({
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '1y': 365,
});

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function getDashboardRangeDays(range) {
  return RANGE_DAYS[range] || null;
}

export async function getDashboardData(client, organizationId, range, access) {
  const days = getDashboardRangeDays(range);
  if (!days) throw new Error('Unsupported dashboard reporting range.');

  const currencyResult = await client.query(
    'SELECT currency FROM organizations WHERE id = $1',
    [organizationId],
  );
  const result = { range, currency: currencyResult.rows[0]?.currency || 'ETB', metrics: {}, trend: [] };

  if (access.sales) {
    const sales = await client.query(
      `SELECT
         COALESCE(SUM(total) FILTER (
           WHERE order_date >= CURRENT_DATE - $2::int
             AND order_date < CURRENT_DATE + 1
         ), 0) AS current_total,
         COALESCE(SUM(total) FILTER (
           WHERE order_date >= CURRENT_DATE - ($2::int * 2)
             AND order_date < CURRENT_DATE - $2::int
         ), 0) AS previous_total,
         COUNT(*) FILTER (
           WHERE order_date >= CURRENT_DATE - $2::int
             AND order_date < CURRENT_DATE + 1
         ) AS current_count
       FROM sales_orders
       WHERE organization_id = $1
         AND status NOT IN ('Draft', 'Cancelled', 'Rejected')`,
      [organizationId, days],
    );
    const row = sales.rows[0] || {};
    result.metrics.sales = {
      value: number(row.current_total),
      previousValue: number(row.previous_total),
      count: number(row.current_count),
    };
  }

  if (access.purchases) {
    const purchases = await client.query(
      `SELECT
         COALESCE(SUM(total_cost) FILTER (
           WHERE transaction_date >= CURRENT_DATE - $2::int
             AND transaction_date < CURRENT_DATE + 1
         ), 0) AS current_total,
         COALESCE(SUM(total_cost) FILTER (
           WHERE transaction_date >= CURRENT_DATE - ($2::int * 2)
             AND transaction_date < CURRENT_DATE - $2::int
         ), 0) AS previous_total,
         COUNT(*) FILTER (
           WHERE transaction_date >= CURRENT_DATE - $2::int
             AND transaction_date < CURRENT_DATE + 1
         ) AS current_count
       FROM inventory_stock_transactions
       WHERE organization_id = $1
         AND transaction_type = 'PURCHASE_RECEIPT'
         AND direction = 'IN'`,
      [organizationId, days],
    );
    const row = purchases.rows[0] || {};
    result.metrics.purchases = {
      value: number(row.current_total),
      previousValue: number(row.previous_total),
      count: number(row.current_count),
    };
  }

  if (access.cash) {
    const cash = await client.query(
      `SELECT COALESCE(SUM(current_balance), 0) AS value
       FROM bank_accounts
       WHERE organization_id = $1 AND status = 'ACTIVE'`,
      [organizationId],
    );
    result.metrics.cash = { value: number(cash.rows[0]?.value) };
  }

  if (access.receivables) {
    const receivables = await client.query(
      `SELECT COALESCE(SUM(GREATEST(total - paid_amount, 0)), 0) AS value
       FROM customer_invoices
       WHERE organization_id = $1
         AND status NOT IN ('Draft', 'Cancelled', 'Paid')`,
      [organizationId],
    );
    result.metrics.receivables = { value: number(receivables.rows[0]?.value) };
  }

  if (access.payables) {
    const payables = await client.query(
      `SELECT COALESCE(SUM(
         a.opening_balance + CASE
           WHEN a.normal_balance = 'CREDIT' THEN COALESCE(jl.credit, 0) - COALESCE(jl.debit, 0)
           ELSE COALESCE(jl.debit, 0) - COALESCE(jl.credit, 0)
         END
       ), 0) AS value
       FROM accounting_accounts a
       LEFT JOIN (
         SELECT jl.account_id, SUM(jl.debit) AS debit, SUM(jl.credit) AS credit
         FROM accounting_journal_lines jl
         JOIN accounting_journals j ON j.id = jl.journal_id AND j.status = 'POSTED'
         WHERE j.organization_id = $1
         GROUP BY jl.account_id
       ) jl ON jl.account_id = a.id
       WHERE a.organization_id = $1 AND a.active = TRUE
         AND (a.account_code = '2000' OR LOWER(a.account_name) = 'accounts payable')`,
      [organizationId],
    );
    result.metrics.payables = { value: number(payables.rows[0]?.value) };
  }

  if (access.inventory) {
    const inventory = await client.query(
      `SELECT COALESCE(SUM(
         CASE
           WHEN t.direction = 'IN' THEN t.total_cost
           WHEN t.direction = 'OUT' THEN -t.total_cost
           ELSE 0
         END
       ), 0) AS value
       FROM inventory_stock_transactions t
       JOIN inventory_products p ON p.id = t.product_id
       WHERE t.organization_id = $1 AND p.active = TRUE`,
      [organizationId],
    );
    result.metrics.inventory = { value: number(inventory.rows[0]?.value) };
  }

  if (access.sales || access.purchases) {
    const series = await client.query(
      `WITH buckets AS (
         SELECT bucket.idx,
                CURRENT_DATE - $1::int + (bucket.idx * ($1::int + 1) / 6)::int AS bucket_start,
                CURRENT_DATE - $1::int + ((bucket.idx + 1) * ($1::int + 1) / 6)::int AS bucket_end
         FROM generate_series(0, 5) AS bucket(idx)
       ),
       sales AS (
         SELECT b.idx, COALESCE(SUM(o.total), 0) AS amount
         FROM buckets b
         LEFT JOIN sales_orders o ON $2::boolean
           AND o.organization_id = $3
           AND o.status NOT IN ('Draft', 'Cancelled', 'Rejected')
           AND o.order_date >= b.bucket_start AND o.order_date < b.bucket_end
         GROUP BY b.idx
       ),
       purchases AS (
         SELECT b.idx, COALESCE(SUM(t.total_cost), 0) AS amount
         FROM buckets b
         LEFT JOIN inventory_stock_transactions t ON $4::boolean
           AND t.organization_id = $3
           AND t.transaction_type = 'PURCHASE_RECEIPT'
           AND t.direction = 'IN'
           AND t.transaction_date >= b.bucket_start
           AND t.transaction_date < b.bucket_end
         GROUP BY b.idx
       )
       SELECT b.idx, b.bucket_start,
              CASE WHEN $2::boolean THEN s.amount ELSE NULL END AS sales,
              CASE WHEN $4::boolean THEN p.amount ELSE NULL END AS purchases
       FROM buckets b
       JOIN sales s ON s.idx = b.idx
       JOIN purchases p ON p.idx = b.idx
       ORDER BY b.idx`,
      [days, access.sales, organizationId, access.purchases],
    );
    result.trend = series.rows.map((row) => ({
      date: row.bucket_start,
      sales: row.sales === null ? null : number(row.sales),
      purchases: row.purchases === null ? null : number(row.purchases),
    }));
  }

  return result;
}
