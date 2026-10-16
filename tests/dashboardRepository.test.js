import assert from 'node:assert/strict';
import test from 'node:test';
import { getDashboardData, getDashboardRangeDays } from '../repositories/dashboardRepository.js';

test('dashboard range validation only accepts the supported reporting windows', () => {
  assert.equal(getDashboardRangeDays('7d'), 7);
  assert.equal(getDashboardRangeDays('30d'), 30);
  assert.equal(getDashboardRangeDays('90d'), 90);
  assert.equal(getDashboardRangeDays('1y'), 365);
  assert.equal(getDashboardRangeDays('all'), null);
});

test('dashboard metrics are calculated from PostgreSQL query results', async () => {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('SELECT currency')) return { rows: [{ currency: 'ETB' }] };
      if (sql.includes('WITH buckets')) {
        return { rows: [{ bucket_start: '2026-09-01', sales: '120', purchases: '45' }] };
      }
      if (sql.includes('FROM sales_orders')) {
        return { rows: [{ current_total: '1200', previous_total: '1000', current_count: '4' }] };
      }
      if (sql.includes('FROM inventory_stock_transactions') && sql.includes('PURCHASE_RECEIPT')) {
        return { rows: [{ current_total: '450', previous_total: '300', current_count: '2' }] };
      }
      if (sql.includes('FROM bank_accounts')) return { rows: [{ value: '7500' }] };
      if (sql.includes('FROM customer_invoices')) return { rows: [{ value: '620' }] };
      if (sql.includes('FROM accounting_accounts')) return { rows: [{ value: '310' }] };
      if (sql.includes('JOIN inventory_products')) return { rows: [{ value: '890' }] };
      throw new Error(`Unexpected dashboard SQL: ${sql}`);
    },
  };
  const metrics = await getDashboardData(client, 'org-1', '30d', {
    sales: true,
    purchases: true,
    cash: true,
    receivables: true,
    payables: true,
    inventory: true,
  });

  assert.equal(metrics.currency, 'ETB');
  assert.deepEqual(metrics.metrics, {
    sales: { value: 1200, previousValue: 1000, count: 4 },
    purchases: { value: 450, previousValue: 300, count: 2 },
    cash: { value: 7500 },
    receivables: { value: 620 },
    payables: { value: 310 },
    inventory: { value: 890 },
  });
  assert.deepEqual(metrics.trend, [{ date: '2026-09-01', sales: 120, purchases: 45 }]);
  assert.ok(queries.every(({ params }) => params.includes('org-1')));
});

test('dashboard omits financial and operational metrics without explicit access', async () => {
  const client = {
    async query(sql) {
      assert.match(sql, /SELECT currency/);
      return { rows: [{ currency: 'ETB' }] };
    },
  };
  const metrics = await getDashboardData(client, 'org-1', '7d', {});

  assert.deepEqual(metrics.metrics, {});
  assert.deepEqual(metrics.trend, []);
});

test('dashboard rejects an unsupported range before querying PostgreSQL', async () => {
  const client = { query: async () => assert.fail('Database should not be queried') };
  await assert.rejects(getDashboardData(client, 'org-1', 'all', {}), /Unsupported dashboard reporting range/);
});
