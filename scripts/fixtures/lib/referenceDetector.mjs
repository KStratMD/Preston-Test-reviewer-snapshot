// Rung-2 simulation reference, not the product reconciler. Every applicable
// discrepancy is emitted per order. Quantities and payout amounts are out of scope.
export function detectDiscrepancies(orders, docs, payouts) {
  const out = [];
  const byKey = new Map();
  for (const doc of docs) {
    const group = byKey.get(doc.orderKey) ?? [];
    group.push(doc);
    byKey.set(doc.orderKey, group);
  }
  const payoutKeys = new Set(payouts.map(p => p.orderKey));
  // Preserve multiplicity and SKU boundaries, including commas within SKUs.
  const skus = lines => JSON.stringify(lines.map(line => line.sku).sort());
  for (const order of orders) {
    const emit = type => out.push({ orderKey: order.key, type });
    const group = byKey.get(order.key) ?? [];
    if (group.length === 0) emit('missing_in_target');
    if (group.length > 1) emit('duplicate_key');
    const doc = group[0];
    if (doc) {
      if (doc.currency !== order.currency) emit('currency_mismatch');
      if (doc.taxMinor !== order.taxMinor) emit('tax_mismatch');
      if (doc.refundsMinor !== order.refundsMinor) emit('refund_mismatch');
      if (doc.totalMinor !== order.totalMinor) emit('amount_mismatch');
      if (doc.customerEmail !== order.customerEmail) emit('customer_mismatch');
      if (doc.fulfillment !== order.fulfillment) emit('fulfillment_mismatch');
      if (skus(doc.lines) !== skus(order.lines)) emit('sku_mismatch');
    }
    if (!payoutKeys.has(order.key)) emit('missing_payout');
  }
  return out;
}
