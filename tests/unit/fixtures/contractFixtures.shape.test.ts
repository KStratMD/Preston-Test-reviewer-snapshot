import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { loadContractFixture } from '../../helpers/contractFixtures';

const money = z.object({ amount: z.string().regex(/^-?\d+\.\d{2}$/), currencyCode: z.literal('USD') });
const bag = z.object({ shopMoney: money });
const shopifyOrder = z.object({
  id: z.string().startsWith('gid://shopify/Order/'), name: z.string(),
  displayFinancialStatus: z.enum(['PAID', 'PARTIALLY_REFUNDED']),
  displayFulfillmentStatus: z.string(), totalPriceSet: bag, subtotalPriceSet: bag,
  totalTaxSet: bag, totalShippingPriceSet: bag,
  lineItems: z.object({ nodes: z.array(z.object({ sku: z.string(), quantity: z.number().int(), originalUnitPriceSet: bag })).min(1) }),
  taxLines: z.array(z.object({ priceSet: bag })), transactions: z.array(z.object({ amountSet: bag })),
  customer: z.object({ id: z.string(), email: z.string().email() }), refunds: z.array(z.object({ id: z.string(), totalRefundedSet: bag })),
});
const nsDoc = z.object({
  links: z.array(z.object({ rel: z.string(), href: z.string().url() })), id: z.string(),
  tranId: z.string(), externalId: z.string(), entity: z.object({ id: z.string() }),
  total: z.number(), currency: z.object({ refName: z.literal('USD') }),
  item: z.object({ items: z.array(z.object({ quantity: z.number(), rate: z.number(), amount: z.number() })).min(1) }),
});
const bcBase = z.object({
  '@odata.etag': z.string(), id: z.string().uuid(), number: z.string(), customerId: z.string().uuid(),
  totalAmountIncludingTax: z.number(), totalTaxAmount: z.number(), currencyCode: z.literal('USD'),
});
const bcLine = z.object({ lineObjectNumber: z.string(), quantity: z.number(), unitPrice: z.number(), amountExcludingTax: z.number() });
const wcOrder = z.object({
  id: z.number().int(), number: z.string(), status: z.string(), currency: z.literal('USD'),
  total: z.string(), total_tax: z.string(), shipping_total: z.string(), customer_id: z.number().int(),
  line_items: z.array(z.object({ sku: z.string(), quantity: z.number().int(), total: z.string() })).min(1),
  tax_lines: z.array(z.object({ tax_total: z.string() })), refunds: z.array(z.unknown()),
});
const cases: Array<[string, string, string, z.ZodType]> = [
  ['shopify', 'order', 'order-paid', shopifyOrder],
  ['shopify', 'order', 'order-partially-refunded', shopifyOrder],
  ['shopify', 'payout', 'payout', z.object({ id: z.string(), net: money, status: z.string(), issuedAt: z.string() })],
  ['shopify', 'balancetransaction', 'balance-transactions', z.array(z.object({ id: z.string(), amount: money, fee: money, net: money, type: z.string() })).min(1)],
  ['netsuite', 'salesorder', 'salesorder', nsDoc],
  ['netsuite', 'invoice', 'invoice', nsDoc],
  ['netsuite', 'customer', 'customer', z.object({ links: z.array(z.unknown()), id: z.string(), email: z.string().email(), entityId: z.string() })],
  ['businesscentral', 'salesorder', 'salesorder', bcBase.extend({ salesOrderLines: z.array(bcLine).min(1) })],
  ['businesscentral', 'salesinvoice', 'salesinvoice', bcBase.extend({ salesInvoiceLines: z.array(bcLine).min(1) })],
  ['businesscentral', 'customer', 'customer', z.object({ '@odata.etag': z.string(), id: z.string().uuid(), number: z.string(), displayName: z.string(), email: z.string().email() })],
  ['woocommerce', 'order', 'order', wcOrder],
  ['woocommerce', 'refund', 'refund', z.object({ id: z.number().int(), amount: z.string(), reason: z.string(), line_items: z.array(z.object({ quantity: z.number().negative(), total: z.string() })).min(1) })],
];
const minor = (amount: string) => Math.round(Number(amount) * 100);

it.each(cases)('%s/%s/%s has the documented shape and rung-1 provenance', (vendor, entity, name, schema) => {
  const { data, provenance } = loadContractFixture(vendor, entity, name);
  expect(schema.safeParse(data).success).toBe(true);
  expect(provenance).toMatchObject({ vendor, entity, rung: 1, capturedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  expect(provenance.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(provenance.sourceUrl).not.toContain('/latest/');
});
it('the shape matrix accounts for every shipped payload', () => {
  const root = path.resolve(__dirname, '../../fixtures/contracts');
  const actual = fs.readdirSync(root, { recursive: true }).filter(file =>
    typeof file === 'string' && file.endsWith('.json') && !file.endsWith('_provenance.json'));
  expect(actual.map(String).map(file => file.replace(/\\/g, '/')).sort()).toEqual(
    cases.map(([vendor, entity, name]) => `${vendor}/${entity}/${name}.json`).sort(),
  );
});
it('paid order totals tie across the vendor examples', () => {
  const shop = shopifyOrder.parse(loadContractFixture('shopify', 'order', 'order-paid').data);
  expect(minor(shop.totalPriceSet.shopMoney.amount)).toBe(11875);
  expect(minor(shop.subtotalPriceSet.shopMoney.amount) + minor(shop.totalTaxSet.shopMoney.amount)
    + minor(shop.totalShippingPriceSet.shopMoney.amount)).toBe(11875);
  expect(shop.lineItems.nodes.reduce((total, line) => total + line.quantity * minor(line.originalUnitPriceSet.shopMoney.amount), 0)).toBe(10500);
  for (const entity of ['salesorder', 'invoice']) {
    const doc = nsDoc.parse(loadContractFixture('netsuite', entity, entity).data);
    expect(doc.total).toBe(118.75);
    expect(doc.item.items.reduce((sum, line) => sum + line.amount, 0)).toBe(105);
  }
  for (const entity of ['salesorder', 'salesinvoice']) {
    expect(bcBase.parse(loadContractFixture('businesscentral', entity, entity).data).totalAmountIncludingTax).toBe(118.75);
  }
  const woo = wcOrder.parse(loadContractFixture('woocommerce', 'order', 'order').data);
  expect(minor(woo.total)).toBe(11875);
  expect(woo.line_items.reduce((sum, line) => sum + minor(line.total), 0) + minor(woo.total_tax) + minor(woo.shipping_total)).toBe(11875);
});
it('partial refund and payout cases carry distinct, consistent money', () => {
  const order = shopifyOrder.parse(loadContractFixture('shopify', 'order', 'order-partially-refunded').data);
  expect(order.displayFinancialStatus).toBe('PARTIALLY_REFUNDED');
  expect(order.refunds).toHaveLength(1);
  expect(order.refunds[0].totalRefundedSet.shopMoney.amount).toBe('35.00');
  const payout = z.object({ net: money }).parse(loadContractFixture('shopify', 'payout', 'payout').data);
  const transactions = z.array(z.object({ amount: money, fee: money, net: money })).parse(
    loadContractFixture('shopify', 'balancetransaction', 'balance-transactions').data);
  expect(minor(payout.net.amount)).toBe(11531);
  expect(transactions.reduce((sum, t) => sum + minor(t.net.amount), 0)).toBe(11531);
  for (const t of transactions) expect(minor(t.amount.amount) - minor(t.fee.amount)).toBe(minor(t.net.amount));
});
