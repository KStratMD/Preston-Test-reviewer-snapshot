import 'reflect-metadata'; // Required for Inversify decorators in isolation-run tests
import { LineageQueryService } from '../../../../src/services/lineage/LineageQueryService';
import type { LineageRepository } from '../../../../src/services/lineage/LineageRepository';
import type { LineageEventView } from '../../../../src/services/lineage/LineageTypes';

function repoMock(): jest.Mocked<Pick<LineageRepository, 'findLatestChainForRecord' | 'listChain' | 'findReciprocalChainSeeds'>> {
  return {
    findLatestChainForRecord: jest.fn(),
    listChain: jest.fn(),
    findReciprocalChainSeeds: jest.fn(),
  };
}

describe('LineageQueryService', () => {
  it('returns the full chain for a source-record triple', async () => {
    const repo = repoMock();
    repo.findLatestChainForRecord.mockResolvedValue({ chainId: 'c1', occurredAt: '2026-05-23T00:00:00Z' });
    const events: LineageEventView[] = [
      { id: 'lin_1', tenantId: 't', chainId: 'c1', sequence: 1, eventType: 'source_read',
        sourceSystem: 'hubspot', sourceEntityType: 'contact', sourceEntityId: 'h1',
        targetSystem: null, targetEntityType: null, targetEntityId: null,
        templateId: 'tmpl', correlationId: 'corr', governanceResult: null,
        payloadHash: null, metadata: {}, occurredAt: '2026-05-23T00:00:00Z' },
    ];
    repo.listChain.mockResolvedValue(events);

    const svc = new LineageQueryService(repo as unknown as LineageRepository);
    const result = await svc.chainForRecord({
      tenantId: 't', system: 'hubspot', entityType: 'contact', entityId: 'h1',
    });

    expect(result).toEqual(events);
    expect(repo.findLatestChainForRecord).toHaveBeenCalledWith({
      tenantId: 't', system: 'hubspot', entityType: 'contact', entityId: 'h1',
    });
    expect(repo.listChain).toHaveBeenCalledWith('t', 'c1');
  });

  it('returns [] when no chain exists for the record', async () => {
    const repo = repoMock();
    repo.findLatestChainForRecord.mockResolvedValue(null);
    const svc = new LineageQueryService(repo as unknown as LineageRepository);
    const result = await svc.chainForRecord({
      tenantId: 't', system: 'hubspot', entityType: 'contact', entityId: 'nope',
    });
    expect(result).toEqual([]);
    expect(repo.listChain).not.toHaveBeenCalled();
  });

  it('findRecentReciprocalActivity delegates to repo.findReciprocalChainSeeds with full input', async () => {
    const repo = repoMock();
    repo.findReciprocalChainSeeds.mockResolvedValue([
      { chainId: 'rc1', occurredAt: '2026-05-24T01:00:00Z' },
    ]);
    const svc = new LineageQueryService(repo as unknown as LineageRepository);
    const input = {
      tenantId: 't', callerSystem: 'salesforce', targetSystem: 'netsuite',
      entityType: 'customer', entityId: 'c-1', withinMs: 60_000,
    };
    const result = await svc.findRecentReciprocalActivity(input);

    expect(result).toEqual([{ chainId: 'rc1', occurredAt: '2026-05-24T01:00:00Z' }]);
    expect(repo.findReciprocalChainSeeds).toHaveBeenCalledTimes(1);
    expect(repo.findReciprocalChainSeeds).toHaveBeenCalledWith(input);
  });
});
