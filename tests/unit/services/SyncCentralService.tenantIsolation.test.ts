import { SyncCentralService } from '../../../src/services/SyncCentralService';

function makeService(): SyncCentralService {
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;
  const telemetry = { record: () => {}, recordEvent: () => {} } as never;
  return new SyncCentralService(logger, telemetry);
}

describe('SyncCentralService per-tenant isolation', () => {
  it('isolates subscriptions between tenants', async () => {
    const svc = makeService();
    const baseB = (await svc.getSubscriptions('tenant-b')).totalCount;
    await svc.createSubscription('tenant-a', {
      customerId: 'c1', customerName: 'C1', tierId: 'tier_starter', status: 'active',
    } as never);
    const a = await svc.getSubscriptions('tenant-a');
    const b = await svc.getSubscriptions('tenant-b');
    expect(a.totalCount).toBe(b.totalCount + 1);
    expect(b.totalCount).toBe(baseB);
  });

  it('keeps the pricing-tier catalog shared (not tenant-scoped)', async () => {
    const svc = makeService();
    const tiers = await svc.getPricingTiers();
    expect(tiers.length).toBeGreaterThan(0);
  });
});
