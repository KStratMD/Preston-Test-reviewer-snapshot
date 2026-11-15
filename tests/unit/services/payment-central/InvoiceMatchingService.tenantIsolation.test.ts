import { InvoiceMatchingService } from '../../../../src/services/payment-central/invoices/InvoiceMatchingService';

function makeRuntime() {
  let n = 0;
  return {
    createId: (p: string) => `${p}-${++n}`,
    now: () => 1000,
    random: () => 0.5,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as never;
}

const invoiceArgs = { invoiceNumber: 'INV-1', invoiceDate: 1, dueDate: 2, amount: 100, lineItems: [] };

describe('InvoiceMatchingService per-tenant isolation', () => {
  it('does not leak a created invoice across tenants', async () => {
    const svc = new InvoiceMatchingService(makeRuntime());
    const inv = await svc.createInvoice('tenant-a', 'vendor-1', invoiceArgs);
    expect((await svc.getInvoices('tenant-a')).totalCount).toBe(1);
    expect((await svc.getInvoices('tenant-b')).totalCount).toBe(0);
    expect(await svc.getInvoice('tenant-b', inv.id)).toBeNull();
    expect(await svc.getInvoice('tenant-a', inv.id)).not.toBeNull();
  });
});
