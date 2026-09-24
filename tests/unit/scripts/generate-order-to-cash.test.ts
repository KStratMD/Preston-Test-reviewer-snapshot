import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detect, type Order, type Doc, type Payout, type Detection } from '../../helpers/referenceDetector';

const script = path.resolve(__dirname, '../../../scripts/fixtures/generate-order-to-cash.mjs');
const files = ['orders.json', 'erp-documents.json', 'payouts.json', 'expected-detections.json'];
const allTypes = ['missing_in_target', 'duplicate_key', 'sku_mismatch', 'customer_mismatch', 'tax_mismatch', 'currency_mismatch', 'fulfillment_mismatch', 'refund_mismatch', 'amount_mismatch', 'missing_payout'];
const roots: string[] = [];
function temp() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o2c-test-')); roots.push(root); return root; }
function generate(seed: number, count = 60) {
  const out = temp();
  const result = spawnSync(process.execPath, [script, '--seed', String(seed), '--orders', String(count), '--out', out], { encoding: 'utf8' });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  return out;
}
const read = <T>(out: string, name: string): T => JSON.parse(fs.readFileSync(path.join(out, name), 'utf8')) as T;
const dataset = (out: string) => ({
  orders: read<Order[]>(out, files[0]), docs: read<Doc[]>(out, files[1]),
  payouts: read<Payout[]>(out, files[2]), expected: read<Detection[]>(out, files[3]),
});
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('writes byte-identical output for a seed and different data for a different seed', () => {
  const a = generate(42), b = generate(42), c = generate(43);
  for (const name of files) expect(fs.readFileSync(path.join(a, name), 'utf8')).toBe(fs.readFileSync(path.join(b, name), 'utf8'));
  expect(read(a, files[0])).not.toEqual(read(c, files[0]));
});
it.each([0, 7, 42, 12345])('covers all ten types for seed %s and derives exact expectations', seed => {
  const { orders, docs, payouts, expected } = dataset(generate(seed));
  expect(orders).toHaveLength(60);
  expect(new Set(expected.map(d => d.type))).toEqual(new Set(allTypes));
  const key = (d: Detection) => `${d.orderKey}|${d.type}`;
  expect(detect(orders, docs, payouts).map(key).sort()).toEqual(expected.map(key).sort());
  expect(expected.every(d => orders.some(order => order.key === d.orderKey))).toBe(true);
});
it('covers all ten types in ten orders with separate missing-document and missing-payout cases', () => {
  const { orders, docs, payouts, expected } = dataset(generate(7, 10));
  expect(new Set(expected.map(d => d.type))).toEqual(new Set(allTypes));
  expect(docs.some(d => d.orderKey === orders[0].key)).toBe(false);
  expect(payouts.some(p => p.orderKey === orders[0].key)).toBe(true);
  expect(expected.filter(d => d.orderKey === orders[0].key)).toEqual([{ orderKey: orders[0].key, type: 'missing_in_target' }]);
  expect(docs.filter(d => d.orderKey === orders[9].key)).toHaveLength(1);
  expect(payouts.some(p => p.orderKey === orders[9].key)).toBe(false);
  expect(expected.filter(d => d.orderKey === orders[9].key)).toEqual([{ orderKey: orders[9].key, type: 'missing_payout' }]);
});
it('unflagged orders tie out to the minor unit and generated payouts have consistent fees', () => {
  const { orders, docs, payouts, expected } = dataset(generate(7));
  const flagged = new Set(expected.map(d => d.orderKey));
  const clean = orders.filter(order => !flagged.has(order.key));
  expect(clean.length).toBeGreaterThan(0);
  for (const order of orders) {
    expect(order.totalMinor).toBe(order.subtotalMinor + order.taxMinor + order.shippingMinor - order.refundsMinor);
    expect(Number.isSafeInteger(order.totalMinor)).toBe(true);
  }
  for (const order of clean) expect(docs.find(d => d.orderKey === order.key)?.totalMinor).toBe(order.totalMinor);
  for (const payout of payouts) {
    expect(payout.grossMinor - payout.feeMinor).toBe(payout.netMinor);
    expect(payout.grossMinor).toBe(orders.find(order => order.key === payout.orderKey)?.totalMinor);
  }
});
it.each([
  ['--seed', 'NaN'], ['--seed', '-1'], ['--seed', '4294967296'],
  ['--orders', '-1'], ['--orders', '2.5'], ['--orders', 'Infinity'],
  ['--unknown'], ['--out'], ['--seed', '1', '--seed', '2'],
])('rejects invalid CLI arguments %j without writing output', (...args: string[]) => {
  const out = temp();
  const result = spawnSync(process.execPath, [script, '--out', out, ...args], { encoding: 'utf8' });
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/usage|invalid|duplicate/i);
  expect(fs.readdirSync(out)).toEqual([]);
});
it('supports an empty dataset explicitly', () => {
  const out = generate(0, 0);
  for (const name of files) expect(read(out, name)).toEqual([]);
});
