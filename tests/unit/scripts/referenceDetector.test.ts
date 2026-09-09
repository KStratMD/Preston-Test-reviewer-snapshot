import { detect, type Order, type Doc, type Payout } from '../../helpers/referenceDetector';

const order = (o: Partial<Order> = {}): Order => ({ key: 'o1', currency: 'USD', subtotalMinor: 10000, taxMinor: 800, shippingMinor: 500, refundsMinor: 0, totalMinor: 11300, customerEmail: 'a@example.test', fulfillment: 'fulfilled', lines: [{ sku: 'SKU-1', qty: 1 }], ...o });
const doc = (d: Partial<Doc> = {}): Doc => ({ orderKey: 'o1', currency: 'USD', taxMinor: 800, refundsMinor: 0, totalMinor: 11300, customerEmail: 'a@example.test', fulfillment: 'fulfilled', lines: [{ sku: 'SKU-1', qty: 1 }], ...d });
const payout: Payout = { orderKey: 'o1', grossMinor: 11300, feeMinor: 300, netMinor: 11000 };
const table: Array<[string, Order[], Doc[], Payout[], string[]]> = [
  ['clean order', [order()], [doc()], [payout], []],
  ['no ERP document', [order()], [], [payout], ['missing_in_target']],
  ['two ERP documents', [order()], [doc(), doc()], [payout], ['duplicate_key']],
  ['currency differs', [order()], [doc({ currency: 'EUR' })], [payout], ['currency_mismatch']],
  ['tax and total differ', [order()], [doc({ taxMinor: 900, totalMinor: 11400 })], [payout], ['amount_mismatch', 'tax_mismatch']],
  ['tax differs, total equal', [order()], [doc({ taxMinor: 900 })], [payout], ['tax_mismatch']],
  ['refund differs', [order()], [doc({ refundsMinor: 500, totalMinor: 10800 })], [payout], ['amount_mismatch', 'refund_mismatch']],
  ['customer differs', [order()], [doc({ customerEmail: 'b@example.test' })], [payout], ['customer_mismatch']],
  ['fulfillment differs', [order()], [doc({ fulfillment: 'unfulfilled' })], [payout], ['fulfillment_mismatch']],
  ['sku differs', [order()], [doc({ lines: [{ sku: 'SKU-2', qty: 1 }] })], [payout], ['sku_mismatch']],
  ['sku order irrelevant', [order({ lines: [{ sku: 'A', qty: 1 }, { sku: 'B', qty: 1 }] })], [doc({ lines: [{ sku: 'B', qty: 1 }, { sku: 'A', qty: 1 }] })], [payout], []],
  ['no payout', [order()], [doc()], [], ['missing_payout']],
  ['missing document and payout', [order()], [], [], ['missing_in_target', 'missing_payout']],
  ['duplicates compare the first', [order()], [doc({ currency: 'EUR' }), doc()], [payout], ['currency_mismatch', 'duplicate_key']],
  ['two independent orders', [order(), order({ key: 'o2' })], [doc()], [payout], ['missing_in_target', 'missing_payout']],
  ['amount alone differs', [order()], [doc({ totalMinor: 11301 })], [payout], ['amount_mismatch']],
  ['SKU multiplicity matters', [order()], [doc({ lines: [{ sku: 'SKU-1', qty: 1 }, { sku: 'SKU-1', qty: 1 }] })], [payout], ['sku_mismatch']],
  ['comma-containing SKU cannot collide with two SKUs', [order({ lines: [{ sku: 'A,B', qty: 1 }] })], [doc({ lines: [{ sku: 'A', qty: 1 }, { sku: 'B', qty: 1 }] })], [payout], ['sku_mismatch']],
  ['documented limits: quantity and payout amounts ignored', [order()], [doc({ lines: [{ sku: 'SKU-1', qty: 99 }] })], [{ ...payout, netMinor: 0 }], []],
];
it.each(table)('%s', (_name, orders, docs, payouts, expected) => {
  expect(detect(orders, docs, payouts).map(d => d.type).sort()).toEqual([...expected].sort());
});
it('attributes each detection to the correct order key', () => {
  expect(detect([order(), order({ key: 'o2' })], [doc()], [payout])).toEqual([
    { orderKey: 'o2', type: 'missing_in_target' }, { orderKey: 'o2', type: 'missing_payout' },
  ]);
});
