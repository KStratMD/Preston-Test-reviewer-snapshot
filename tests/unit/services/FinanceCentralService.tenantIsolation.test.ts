import { FinanceCentralService } from '../../../src/services/FinanceCentralService';

function makeService(): FinanceCentralService {
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;
  const operatorService = { listPendingApprovals: async () => [] } as never;
  return new FinanceCentralService(logger, operatorService);
}

describe('FinanceCentralService per-tenant isolation', () => {
  it('seeds a fresh tenant with populated demo documents', async () => {
    const svc = makeService();
    const docs = await svc.getFinancialDocuments('tenant-a');
    expect(docs.length).toBeGreaterThan(0);
  });

  it('isolates a recorded payment to the writing tenant', async () => {
    const svc = makeService();
    const before = await svc.getFinancialDocuments('tenant-a');
    const target = before.find(d => d.amountDue > 0)!;
    await svc.recordPayment('tenant-a', target.id, target.amountDue, Date.now(), 'wire');

    const aDoc = (await svc.getFinancialDocuments('tenant-a')).find(d => d.id === target.id)!;
    const bDoc = (await svc.getFinancialDocuments('tenant-b')).find(d => d.id === target.id)!;
    expect(aDoc.status).toBe('paid');
    expect(bDoc.status).not.toBe('paid');
  });
});
