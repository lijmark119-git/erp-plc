import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateQuotationCosts, createComparison, ProcurementError } from '../services/procurementService.js';

test('quotation totals include quantity, percentage tax, shipping, and additional costs', () => {
  assert.deepEqual(
    calculateQuotationCosts(3, { unitPrice: 12.34, taxRate: 15, shippingCost: 5, otherCost: 1.25 }),
    { subtotal: 37.02, taxAmount: 5.55, totalCost: 48.82 },
  );
});

test('quotation totals round tax and total cost to currency precision', () => {
  assert.deepEqual(
    calculateQuotationCosts(1, { unitPrice: 10, taxRate: 7.5, shippingCost: 0.1, otherCost: 0.1 }),
    { subtotal: 10, taxAmount: 0.75, totalCost: 10.95 },
  );
});

test('comparison creation requires two supplier quotations before persistence', async () => {
  await assert.rejects(
    createComparison({ query: async () => assert.fail('Should validate before querying') }, 'org', 'actor', {
      title: 'Test request',
      productDescription: 'Test item',
      quantity: 1,
      quotes: [{ supplierId: 'supplier', unitPrice: 10, deliveryDays: 1, paymentTerms: 'Net 30' }],
    }),
    (error) => error instanceof ProcurementError && error.status === 400,
  );
});

test('comparison creation rejects invalid unit prices before persistence', async () => {
  await assert.rejects(
    createComparison({ query: async () => assert.fail('Should validate before querying') }, 'org', 'actor', {
      title: 'Test request',
      productDescription: 'Test item',
      quantity: 1,
      quotes: [
        { supplierId: 'supplier-1', unitPrice: -1, deliveryDays: 1, paymentTerms: 'Net 30' },
        { supplierId: 'supplier-2', unitPrice: 5, deliveryDays: 2, paymentTerms: 'Net 30' },
      ],
    }),
    (error) => error instanceof ProcurementError && error.status === 400,
  );
});
