#!/usr/bin/env node
// scripts/check-static-payment-fields.mjs
//
// No HTML under public/ may collect payment-card data.
//
// The static tree is served to anyone (see src/middleware/staticHtmlPolicy.ts for
// what is reachable). A page that takes a card number, CVV or expiry there is
// collecting cardholder data outside any server-side control, which is how
// customer-payment-portal.html came to POST PAN and CVV to a route that did not
// exist. Deleting that page fixes the instance; this gate fixes the class.
//
// There is deliberately NO allowlist: a page that needs card entry belongs
// behind a payment processor's hosted fields, not in this tree, so there is no
// legitimate exception to record.
//
// Exit codes: 0 clean, 1 violation, 2 env/usage error.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootIdx = process.argv.indexOf('--root');
if (rootIdx !== -1) {
  const value = process.argv[rootIdx + 1];
  if (!value || value.startsWith('-')) {
    console.error('[static-payment-fields] --root requires a path argument.');
    process.exit(2);
  }
}
const ROOT = rootIdx !== -1 ? process.argv[rootIdx + 1] : path.resolve(scriptDir, '..');

const PUBLIC_DIR = path.join(ROOT, 'public');
if (!fs.existsSync(PUBLIC_DIR)) {
  console.error(`[static-payment-fields] missing ${PUBLIC_DIR}`);
  process.exit(2);
}

// Input-collection signals only. Prose that merely says "card number" is not a
// violation, so the patterns are anchored to form plumbing: binding names,
// autocomplete tokens the browser fills with card data, and input identifiers.
//
// These are heuristics over markup, not a parser, and the honest limit is worth
// stating: a page that collects a card through a name this list does not know
// will pass. The list covers the shapes that actually appear — browser autofill
// tokens, two-way bindings in every framework style used here, and input
// id/name attributes quoted or unquoted — and every widening below came from a
// concrete bypass someone demonstrated. Treat a pass as "no known collection
// shape", not as proof the page is clean; the primary control is that a page
// must be whitelisted to be served at all.
const PATTERNS = [
  // Browser autofill tokens for card data, quoted or unquoted.
  /autocomplete\s*=\s*["']?cc-(?:number|csc|exp|exp-month|exp-year|name)\b/i,
  // Two-way bindings in any prefix style — x-model, v-model, ng-model,
  // wire:model, data-model, formControlName, @bind — including modifiers such
  // as .lazy or .defer, and dotted paths like "payment.cardNumber".
  /(?:[\w:@.-]*model[\w.:-]*|formControlName|@bind[\w.-]*)\s*=\s*["'][^"']*\b(?:card(?:number|no|cvv|cvc|csc|code|expiry|expiration)|cvv|cvc|csc|pan)\b[^"']*["']/i,
  // Input identifiers, quoted or unquoted. "pan" is bounded so "panel" and
  // "panic" do not match.
  /\b(?:id|name)\s*=\s*["']?(?:card[-_]?(?:number|no|cvv|cvc|csc|code|expiry|expiration)|cardnumber|cvv2?|cvc2?|csc|pan|cc[-_]?(?:number|csc|exp))\b/i,
];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return walk(p);
    return /\.html?$/i.test(d.name) ? [p] : [];
  });
}

const hits = [];
for (const file of walk(PUBLIC_DIR)) {
  const text = fs.readFileSync(file, 'utf8');
  for (const re of PATTERNS) {
    const m = re.exec(text);
    if (m) {
      hits.push(`${path.relative(ROOT, file).split(path.sep).join('/')}: ${m[0].trim()}`);
      break;
    }
  }
}

if (hits.length > 0) {
  console.error(`[static-payment-fields] FAIL (${hits.length}):`);
  for (const h of hits) console.error(`  - ${h}`);
  console.error('  Card entry belongs in a processor-hosted field, not in the static tree.');
  process.exit(1);
}
console.log('[static-payment-fields] OK (no payment-card field patterns under public/).');
