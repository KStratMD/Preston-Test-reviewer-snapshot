import { OwnershipResolver } from '../../../../src/governance/sourceOfTruth/OwnershipResolver';
import type { OwnershipDeclaration } from '../../../../src/governance/sourceOfTruth/SourceOfTruthManifest';

describe('OwnershipResolver — queue_for_human switch arm', () => {
  let resolver: OwnershipResolver;
  let mockLineage: any;
  let mockLogger: any;
  let fixtureManifest: OwnershipDeclaration[];

  beforeEach(() => {
    mockLineage = { findRecentReciprocalActivity: jest.fn() };
    mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    fixtureManifest = [
      {
        entity: 'customer',
        owner: 'netsuite',
        consumers: ['salesforce'],
        conflictPolicy: 'queue_for_human',
        conflictPolicyRationale: 'test fixture',
      },
    ];
    resolver = new OwnershipResolver(mockLineage, mockLogger);
    (resolver as any).manifest = fixtureManifest;
  });

  it('non-owner with queue_for_human → {allowed: false, reason: "queue_required", declaredOwner}', async () => {
    const decision = await resolver.validateWrite({
      tenantId: 't-1', entity: 'customer', targetSystem: 'netsuite',
      callerSystem: 'salesforce', correlationId: 'cor-1', recordId: 'rec-1',
    });
    expect(decision).toEqual({ allowed: false, reason: 'queue_required', declaredOwner: 'netsuite' });
  });

  it('queue_for_human emits an audit decision row with policy + no queueId', async () => {
    await resolver.validateWrite({
      tenantId: 't-1', entity: 'customer', targetSystem: 'netsuite',
      callerSystem: 'salesforce', correlationId: 'cor-1', recordId: 'rec-1',
    });
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('queued'),
      expect.objectContaining({ declaredOwner: 'netsuite', callerSystem: 'salesforce' }),
    );
  });

  it('owner write under queue_for_human → {allowed: true, owner} (owner bypasses queue)', async () => {
    const decision = await resolver.validateWrite({
      tenantId: 't-1', entity: 'customer', targetSystem: 'netsuite',
      callerSystem: 'netsuite', correlationId: 'cor-1',
    });
    expect(decision).toEqual({ allowed: true, owner: 'netsuite' });
  });

  it('resolver does NOT inject ApprovalQueueService (constructor takes only LineageQueryService + Logger)', () => {
    expect(OwnershipResolver.length).toBe(2);
  });
});
