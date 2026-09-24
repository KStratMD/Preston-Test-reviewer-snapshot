import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Order {
  key: string; currency: string; subtotalMinor: number; taxMinor: number;
  shippingMinor: number; refundsMinor: number; totalMinor: number;
  customerEmail: string; fulfillment: string;
  lines: Array<{ sku: string; qty: number; unitMinor?: number }>;
}
export interface Doc {
  orderKey: string; currency: string; taxMinor: number; refundsMinor: number;
  totalMinor: number; customerEmail: string; fulfillment: string;
  lines: Array<{ sku: string; qty: number; unitMinor?: number }>;
}
export interface Payout { orderKey: string; grossMinor: number; feeMinor: number; netMinor: number }
export interface Detection { orderKey: string; type: string }

// Jest's CJS transform does not load .mjs. Exercise the actual module in native
// Node; fixture inputs travel as JSON on stdin, never as executable source.
export function detect(orders: Order[], docs: Doc[], payouts: Payout[]): Detection[] {
  const url = pathToFileURL(path.resolve(__dirname, '../../scripts/fixtures/lib/referenceDetector.mjs')).href;
  const source = `import fs from 'node:fs';
    import { detectDiscrepancies } from ${JSON.stringify(url)};
    const args = JSON.parse(fs.readFileSync(0, 'utf8'));
    const before = JSON.stringify(args);
    const result = detectDiscrepancies(...args);
    if (JSON.stringify(args) !== before) throw new Error('detector mutated its inputs');
    process.stdout.write(JSON.stringify(result));`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', source], {
    input: JSON.stringify([orders, docs, payouts]), encoding: 'utf8',
  })) as Detection[];
}
