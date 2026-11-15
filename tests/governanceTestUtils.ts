import { ConnectorManager } from '../src/services/integration/ConnectorManager';
import type { OutboundGovernanceService } from '../src/services/governance/OutboundGovernanceService';
import type { OwnershipResolver } from '../src/governance/sourceOfTruth/OwnershipResolver';
import type { AuditService } from '../src/services/ai/orchestrator/AuditService';
import type { ApprovalQueueService } from '../src/services/governance/ApprovalQueueService';
import type { ConnectorCredentialResolver } from '../src/services/integration/ConnectorCredentialResolver';
import type { IConnector } from '../src/interfaces/IConnector';
import type { SerializedAssetSyncService } from '../src/services/serializedAsset/SerializedAssetSyncService';
import type { AuthService } from '../src/services/AuthService';
import type { IntegrationConfig } from '../src/types';
import type { Logger } from '../src/utils/Logger';

const makeApprovedDecision = (payload: unknown) => Promise.resolve({
  approved: true,
  approvalRequired: false,
  redactedPayload: payload,
  findings: [],
  riskLevel: 'none' as const,
  auditMetadata: { scanDurationMs: 0, findingsCount: 0, redacted: false, blocked: false },
});

export function createMockOutboundGovernanceService(): jest.Mocked<OutboundGovernanceService> {
  return {
    validateAIProviderRequest: jest.fn().mockImplementation(makeApprovedDecision),
    validateAuditLogPayload: jest.fn().mockImplementation(makeApprovedDecision),
    validateConnectorWrite: jest.fn().mockImplementation(makeApprovedDecision),
  } as unknown as jest.Mocked<OutboundGovernanceService>;
}

/** Always-allow OwnershipResolver stub for tests that don't exercise ownership blocks. */
export function createMockOwnershipResolver(): Pick<OwnershipResolver, 'validateWrite' | 'detectLoop'> {
  return {
    validateWrite: jest.fn().mockResolvedValue({ allowed: true as const, owner: 'netsuite' as const }),
    detectLoop: jest.fn().mockResolvedValue({ loopDetected: false }),
  };
}

/** No-op AuditService stub for tests that don't assert audit log interactions. */
export function createMockAuditService(): Pick<AuditService, 'logGovernanceCheck'> {
  return {
    logGovernanceCheck: jest.fn().mockResolvedValue('test-audit-id'),
  };
}

/**
 * No-op ApprovalQueueService stub for tests that don't exercise the
 * queue_for_human path. Required as the 9th IntegrationService ctor arg
 * and the 6th SyncCentralOrchestrator ctor arg as of PR 13b Stage A2.5.
 */
export function createMockApprovalQueueService(): Pick<ApprovalQueueService, 'enqueue'> {
  return {
    enqueue: jest.fn().mockResolvedValue('q-id'),
  };
}

/**
 * ConnectorManager double for the 10th `IntegrationService` ctor arg (Task 8,
 * 2026-07-27 NetSuite serialized-asset sync plan). Rejects by default: tests
 * that never exercise the `netsuite_serialized_asset` dispatch branch never
 * call it, so a loud failure here would only ever surface a genuinely
 * unexpected specialized-profile dispatch.
 */
export function createMockConnectorManager(): Pick<ConnectorManager, 'getConnector' | 'initializeConnectorsForConfig'> {
  return {
    getConnector: jest.fn().mockRejectedValue(
      new Error('createMockConnectorManager: getConnector was not stubbed for this test'),
    ),
    initializeConnectorsForConfig: jest.fn().mockRejectedValue(
      new Error('createMockConnectorManager: initializeConnectorsForConfig was not stubbed for this test'),
    ),
  };
}

/**
 * A REAL `ConnectorManager` wired with a stub credential resolver, for the
 * suites that drive `IntegrationService`'s STANDARD execution paths.
 *
 * PR A2 (deployment-readiness Tranche A) routed run/test/single-record/
 * initialize through `ConnectorManager` — previously those paths used
 * `IntegrationService`'s own private connector map and read
 * `sourceAuthentication`/`targetAuthentication` inline. `createMockConnectorManager()`
 * above rejects by default, which is still correct for suites that must never
 * reach a connector, but it cannot serve a suite that actually syncs.
 *
 * A real manager rather than another hand-rolled double on purpose: the cache
 * keying, the `connectorKeyForSystem()` projection, and
 * `assertDistinguishableManagedSides` are all behavior A2's tests depend on,
 * and re-implementing them in test code would let the double and the real
 * chokepoint drift. Connector CREATION still runs through the canonical
 * registry factory, so a suite's `jest.mock('.../XConnector')` double is what
 * gets built — exactly as before A2.
 *
 * The default resolver reproduces the pre-A2 inline behavior
 * (`sourceAuthentication ?? authentication?.source`, likewise for target), so
 * an inline-credential suite sees no behavior change. Pass `resolve` to model
 * a managed (`secret_manager`) reference or a resolution failure.
 *
 * `connectorFor` replaces what the registry factory would build, keyed by the
 * PROJECTED connector key (`connectorKeyForSystem()`'s output — trimmed and
 * lowercased), and exists for the suites that supplied their own connector
 * doubles by assigning `(service as any).getConnector = ...` before A2. Those
 * doubles are the point of those suites — a benchmark measuring registry
 * connectors is measuring different work, and a governance suite needs a
 * `create()` it can assert on. Routing them through the real manager keeps the
 * cache keying and `assertDistinguishableManagedSides` real while leaving the
 * connector itself deterministic. Suites that pass nothing keep the registry
 * factory, so a `jest.mock('.../XConnector')` double still gets built.
 */
export function createStandardPathConnectorManager(
  overrides: {
    resolve?: ConnectorCredentialResolver['resolve'];
    connectorFor?: (connectorKey: string) => IConnector;
  } = {},
): { manager: ConnectorManager; resolver: jest.Mocked<ConnectorCredentialResolver> } {
  const resolver = {
    resolve: jest.fn(
      overrides.resolve ??
        (async (config: IntegrationConfig, side: 'source' | 'target') =>
          side === 'source'
            ? (config.sourceAuthentication ?? config.authentication?.source)
            : (config.targetAuthentication ?? config.authentication?.target)),
    ),
  } as unknown as jest.Mocked<ConnectorCredentialResolver>;

  const logger = {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnThis(),
    setCorrelationId: jest.fn().mockReturnThis(),
  } as unknown as Logger;

  const manager = new ConnectorManager(
    logger,
    {} as AuthService,
    createMockOutboundGovernanceService(),
    resolver,
  );

  if (overrides.connectorFor) {
    const connectorFor = overrides.connectorFor;
    // Only CREATION is replaced. `getConnector()` still owns the cache
    // lookup and stores under `${systemType}_${systemId}`. Standard-path
    // callers pass `${connectorKey}_${config.id}` as `systemId`, so this
    // harness leaves the manager's cache-key construction intact; the stub
    // does not invent a separate cache identity.
    jest
      .spyOn(manager as unknown as { createConnector: (key: string, id: string) => IConnector }, 'createConnector')
      .mockImplementation((connectorKey: string) => connectorFor(connectorKey));
  }

  return { manager, resolver };
}

/**
 * SerializedAssetSyncService double for the 11th `IntegrationService` ctor arg
 * (Task 8). Same rejects-by-default rationale as `createMockConnectorManager`.
 */
export function createMockSerializedAssetSyncService(): Pick<SerializedAssetSyncService, 'run'> {
  return {
    run: jest.fn().mockRejectedValue(
      new Error('createMockSerializedAssetSyncService: run was not stubbed for this test'),
    ),
  };
}
