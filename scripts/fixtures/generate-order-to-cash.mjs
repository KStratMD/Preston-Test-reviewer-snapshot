#!/usr/bin/env node
// Rung-2 deterministic synthetic data. Expected detections come from the reference
// detector, whose correctness is separately pinned by hand-authored table cases.
import fs from 'node:fs';
import path from 'node:path';
import { detectDiscrepancies } from './lib/referenceDetector.mjs';

function parseArgs(args) {
  const values = { seed: '42', orders: '200', out: 'tests/fixtures/order-to-cash' };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].slice(2);
    if (!args[i].startsWith('--') || !Object.hasOwn(values, key)) throw new Error(`invalid argument ${args[i]}`);
    if (seen.has(key)) throw new Error(`duplicate argument --${key}`);
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`invalid value for --${key}`);
    seen.add(key);
    values[key] = args[i + 1];
  }
  if (!/^\d+$/.test(values.seed) || Number(values.seed) > 0xffffffff) throw new Error('invalid seed: expected uint32');
  if (!/^\d+$/.test(values.orders) || Number(values.orders) > 100000) throw new Error('invalid orders: expected integer 0..100000');
  return { seed: Number(values.seed), count: Number(values.orders), out: values.out };
}
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function generate({ seed, count, out }) {
  const rnd = mulberry32(seed);
  const pick = arr => arr[Math.floor(rnd() * arr.length)];
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const skus = ['SKU-RED-M', 'SKU-RED-L', 'SKU-BLUE-S', 'SKU-BLUE-M', 'SKU-GREEN-XL'];
  const types = ['missing_in_target', 'duplicate_key', 'sku_mismatch', 'customer_mismatch', 'tax_mismatch', 'currency_mismatch', 'fulfillment_mismatch', 'refund_mismatch', 'amount_mismatch', 'missing_payout'];
  const orders = [], docs = [], payouts = [];
  for (let i = 0; i < count; i++) {
    const key = `#${1001 + i}`;
    const lines = Array.from({ length: int(1, 3) }, () => ({ sku: pick(skus), qty: int(1, 4), unitMinor: int(1500, 9900) }));
    const subtotalMinor = lines.reduce((sum, line) => sum + line.qty * line.unitMinor, 0);
    const taxMinor = Math.round(subtotalMinor * 0.0833);
    const shippingMinor = pick([0, 500, 999]);
    const refundsMinor = rnd() < 0.1 ? Math.round(subtotalMinor * 0.25) : 0;
    const order = {
      key, source: 'shopify', currency: 'USD', subtotalMinor, taxMinor, shippingMinor,
      totalMinor: subtotalMinor + taxMinor + shippingMinor - refundsMinor, lines,
      customerEmail: `buyer-${int(100, 999)}@example.test`, refundsMinor,
      fulfillment: pick(['unfulfilled', 'partial', 'fulfilled']),
    };
    const doc = {
      orderKey: key, system: 'erp', currency: order.currency, totalMinor: order.totalMinor,
      taxMinor, lines: lines.map(line => ({ ...line })), customerEmail: order.customerEmail,
      refundsMinor, fulfillment: order.fulfillment,
    };
    // A ten-order prefix guarantees coverage for every seed when count >= 10.
    const inject = i < types.length ? types[i] : (rnd() < 0.08 ? pick(types) : null);
    switch (inject) {
      case 'duplicate_key': docs.push({ ...doc }); break;
      case 'sku_mismatch': doc.lines[0].sku = 'SKU-UNKNOWN'; break;
      case 'customer_mismatch': doc.customerEmail = 'other@example.test'; break;
      case 'tax_mismatch': doc.taxMinor += 100; doc.totalMinor += 100; break;
      case 'currency_mismatch': doc.currency = 'CAD'; break;
      case 'fulfillment_mismatch': doc.fulfillment = order.fulfillment === 'fulfilled' ? 'unfulfilled' : 'fulfilled'; break;
      case 'refund_mismatch': doc.refundsMinor += 500; doc.totalMinor -= 500; break;
      case 'amount_mismatch': doc.totalMinor += 1; break;
    }
    orders.push(order);
    if (inject !== 'missing_in_target') docs.push(doc);
    // Missing ERP data retains its payout; the two failures remain independent.
    if (inject !== 'missing_payout' && (inject !== null || rnd() >= 0.03)) {
      const feeMinor = Math.round(order.totalMinor * 0.029) + 30;
      payouts.push({ orderKey: key, grossMinor: order.totalMinor, feeMinor, netMinor: order.totalMinor - feeMinor });
    }
  }
  const expected = detectDiscrepancies(orders, docs, payouts);
  fs.mkdirSync(out, { recursive: true });
  for (const [name, data] of [
    ['orders.json', orders], ['erp-documents.json', docs], ['payouts.json', payouts], ['expected-detections.json', expected],
  ]) fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 2) + '\n');
  console.log(`wrote ${orders.length} orders, ${docs.length} ERP documents, ${expected.length} detections to ${out}`);
}

try { generate(parseArgs(process.argv.slice(2))); }
catch (error) {
  console.error(`fixture generator: ${error.message}\nusage: --seed <uint32> --orders <0..100000> --out <directory>`);
  process.exitCode = 2;
}
