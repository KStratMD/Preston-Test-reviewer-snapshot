// tests/unit/services/syncErrorAssist/testHelpers.ts
import 'reflect-metadata';
import { SyncErrorAssistService } from '../../../../src/services/syncErrorAssist/SyncErrorAssistService';
import type { IdentityContext } from '../../../../src/services/governance/identityContext';
// R15-1 — Type imports added so test-double casts target named types via
// `as unknown as RealType` instead of `as any`. Each type is the real production
// interface that the corresponding @inject in SyncErrorAssistService's constructor
// expects (src/services/syncErrorAssist/SyncErrorAssistService.ts:88-97).
import type { Logger } from '../../../../src/utils/Logger';
import type { TenantConfigurationRepository } from '../../../../src/database/repositories/TenantConfigurationRepository';
import type { SyncErrorAssistRepository } from '../../../../src/services/syncErrorAssist/SyncErrorAssistRepository';
import type { ConnectorManager } from '../../../../src/services/integration/ConnectorManager';
import type { ProviderRegistry } from '../../../../src/services/ai/ProviderRegistry';
import type { ReasoningTraceEngine } from '../../../../src/services/ai/orchestrator/ReasoningTraceEngine';
import type { CostTrackingService } from '../../../../src/services/ai/CostTrackingService';
import type { AuditLogRepository } from '../../../../src/database/repositories/AuditLogRepository';
import type { DLPService, PIIFinding } from '../../../../src/services/security/DLPService';
import type { GovernanceService } from '../../../../src/services/ai/orchestrator/GovernanceService';
import { DEFAULT_POSTURE } from '../../../../src/services/ai/orchestrator/GovernanceService';
import type { SyncErrorAssistMetrics } from '../../../../src/services/syncErrorAssist/SyncErrorAssistMetrics';
import type { OwnershipResolver } from '../../../../src/governance/sourceOfTruth/OwnershipResolver';
import type { AuditService } from '../../../../src/services/ai/orchestrator/AuditService';
import type { ApprovalQueueService } from '../../../../src/services/governance/ApprovalQueueService';

/**
 * PR-C3.1a R1 — Mirror DLPService.redactData behavior for test mocks. The
 * production method walks data recursively and applies value-based
 * substitution per finding, narrowing findings to those whose `.location.path`
 * targets the current node. Tests can rely on this for "given findings X,
 * produce redaction Y" assertions without instantiating a real DLPService.
 *
 * PR-C3.1a R1 (Copilot R1) — Mirrors production `pathTargetsNode`: a finding
 * targets a node when its path EQUALS the node's path OR starts with the
 * node's path followed by either `.` (object child) or `[` (array element).
 * Without the `[` continuation, findings under array fields like
 * `users[0].email` wouldn't be associated with the parent `users` object key
 * during the object-walk filter, and tests could diverge from production.
 */
function pathTargetsNodeForMock(findingPath: string, nodePath: string): boolean {
  return (
    findingPath === nodePath ||
    findingPath.startsWith(`${nodePath}.`) ||
    findingPath.startsWith(`${nodePath}[`)
  );
}

export function mockRedactData(data: unknown, findings: PIIFinding[], currentPath = ''): unknown {
  if (typeof data === 'string') {
    let redacted = data;
    findings.forEach((f) => {
      redacted = redacted.replace(f.value, f.redactedValue);
    });
    return redacted;
  }
  if (Array.isArray(data)) {
    return data.map((item, index) => {
      const itemPath = `${currentPath}[${index}]`;
      const itemFindings = findings.filter((f) => pathTargetsNodeForMock(f.location.path, itemPath));
      return mockRedactData(item, itemFindings, itemPath);
    });
  }
  if (typeof data === 'object' && data !== null) {
    const result: Record<string, unknown> = {};
    Object.entries(data).forEach(([k, v]) => {
      const childPath = currentPath ? `${currentPath}.${k}` : k;
      const childFindings = findings.filter((f) => pathTargetsNodeForMock(f.location.path, childPath));
      result[k] = mockRedactData(v, childFindings, childPath);
    });
    return result;
  }
  return data;
}

export function makeMockLogger() {
  // R15-1 / R15-4 — TS infers the literal shape; no `: any` annotation. R15-4 also
  // requires withCorrelationId to return the same mock object (production `Logger.withCorrelationId`
  // returns a child Logger; tests need the parent's `info/warn/error` spies to observe the calls
  // the route makes on the correlation-bound child).
  const log = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    withCorrelationId: jest.fn(),
  };
  log.withCorrelationId.mockReturnValue(log);
  return log;
}

export function makeMockMetrics() {
  return {
    recordCycleOutcome: jest.fn(),
    recordErrorsScanned: jest.fn(),
    recordSuggestionWritten: jest.fn(),
    recordProcessedStatus: jest.fn(),
    observeCycleDuration: jest.fn(),
    recordCostCents: jest.fn(),
    recordWebhookReceivedRaw: jest.fn(),
    recordWebhookAuthenticated: jest.fn(),
    recordWebhookValidationFailed: jest.fn(),
    recordWebhookProcessed: jest.fn(),
    recordWebhookFireAndForgetError: jest.fn(),
    recordWebhookE2eLatency: jest.fn(),
    recordDlpScanOutcome: jest.fn(),
    recordPromptInjectionReplaced: jest.fn(),
  };
}

export function makeMockRepo() {
  return {
    getActiveTenants: jest.fn(),
    claim: jest.fn(),
    updateSucceeded: jest.fn(),
    updateFailed: jest.fn(),
    getWatermark: jest.fn().mockResolvedValue(null),
    tryAdvanceWatermark: jest.fn().mockResolvedValue(true),
    reapStuckProcessing: jest.fn().mockResolvedValue({ reaped: 0, recoveries: [] }),
  };
}

export function makeMockTenantConfig(overrides: Record<string, string | boolean> = {}) {
  return {
    getBoolean: jest.fn().mockImplementation(async (_t: string, key: string) => {
      if (key in overrides && typeof overrides[key] === 'boolean') return overrides[key] as boolean;
      return true;                                          // default enabled
    }),
    getString: jest.fn().mockImplementation(async (_t: string, key: string) => {
      if (key in overrides && typeof overrides[key] === 'string') return overrides[key] as string;
      if (key === 'sync_error_assist.confidence_threshold') return 'mid';
      return null;
    }),
    getInt: jest.fn(),
    upsert: jest.fn(),
  };
}

export function makeNsConnectorStub(opts: { createId?: string } = {}) {
  return {
    search: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: opts.createId ?? 'ns-1' }),
  };
}

export function makeProviderInfo() {
  // R15-1 — TS infers from the literal; no `: any`. The shape covers the AIProvider methods
  // SyncErrorAssistService actually calls (chat + getLastTokenUsage); broader provider surface
  // (suggest, assessQuality, etc.) is not exercised by this code path.
  // R17-1 — After R16-2 added tsconfig.test.json (which type-checks tests against the same
  // production tsconfig include set), this provider literal is passed to `runCycle(..., providerInfo)`
  // and `processClaimedRecord({..., providerInfo})` whose parameter is typed `ResolvedProvider`
  // (i.e. `{provider: AIProvider, providerId: string}`). The AIProvider interface at
  // src/services/ai/providers/types.ts:47 requires `isAvailable`, `getCapabilities`, `suggest`,
  // `assessQuality`, `testConnection` in addition to `chat`. Expose harmless `jest.fn()` stubs
  // for the unused surface so the literal is structurally assignable to AIProvider without
  // a wide `as any` cast at every call site. Tests that don't exercise those methods simply
  // never invoke them.
  const provider = {
    mode: 'cloud-api' as const,
    isAvailable: true,
    chat: jest.fn(),
    getLastTokenUsage: jest.fn().mockReturnValue({ estimatedCost: 0, totalTokens: 0 }),
    getCapabilities: jest.fn().mockResolvedValue({
      models: ['claude-3-5-sonnet'],
      maxTokens: 200000,
      supportsTools: true,
      supportsStreaming: true,
    }),
    suggest: jest.fn(),
    assessQuality: jest.fn(),
    testConnection: jest.fn().mockResolvedValue({ ok: true }),
  };
  return { provider, providerId: 'claude' };
}

// R17-2 — Distinct helper for `ProviderRegistry.getAvailableProvider` mock results.
// `ProviderRegistry.getAvailableProvider()` (ProviderRegistry.ts:110) returns
// `{ provider: AIProvider, id: string } | null` — NOT the `{ provider, providerId }` shape of
// `ResolvedProvider`. `SyncErrorAssistService.findChatCapableProvider()` (SyncErrorAssistService.ts:447)
// reads `p.id` from this result and rebuilds it as `{ provider, providerId: p.id }`. Using
// `makeProviderInfo()` for both purposes (as earlier rounds did) leaves `p.id` undefined and the
// `providerId` field on the synthesised ResolvedProvider becomes `undefined`, hiding the
// registry-to-service mapping in `findChatCapableProvider()` from coverage.
//
// Use this helper for every `providerRegistry.getAvailableProvider.mockResolvedValueOnce(...)`
// site; use `makeProviderInfo()` only when handing a `ResolvedProvider` directly to a method
// that takes one (e.g. `runCycle(..., providerInfo)`).
export function makeProviderRegistryResult() {
  const { provider } = makeProviderInfo();
  return { provider, id: 'claude' };
}

export function makeClaim(overrides: Partial<{ id: string; tenantId: string; errorRecordId: string; attempts: number }> = {}) {
  return {
    id: overrides.id ?? 'c-1',
    tenantId: overrides.tenantId ?? 'acme',
    errorRecordId: overrides.errorRecordId ?? 'err-1',
    attempts: overrides.attempts ?? 1,
  };
}

export function makeWebhookPayload(overrides: Partial<{ tenantId: string; errorRecordId: string; errorMessage: string; sourcePayload: Record<string, unknown> }> = {}) {
  return {
    tenantId: overrides.tenantId ?? 'acme',
    errorRecordId: overrides.errorRecordId ?? 'err-1',
    lastModified: '2026-05-10T00:00:00.000Z',
    errorType: 'sync_failure',
    errorMessage: overrides.errorMessage ?? 'NS error',
    sourcePayload: overrides.sourcePayload,
    attemptCount: 0,
  };
}

// R16-1 — IdentityContext is { tenantId: string; userId: string } only (identityContext.ts:3).
// Earlier draft had `isSystem: false` which doesn't exist on the type.
export const identityCtx: IdentityContext = { tenantId: 'acme', userId: 'u' };

export interface ServiceTestKit {
  service: SyncErrorAssistService;
  stubs: {
    logger: ReturnType<typeof makeMockLogger>;
    metrics: ReturnType<typeof makeMockMetrics>;
    repo: ReturnType<typeof makeMockRepo>;
    tenantConfig: ReturnType<typeof makeMockTenantConfig>;
    connectorManager: { getConnector: jest.Mock };
    providerRegistry: { getAvailableProvider: jest.Mock };
    traceEngine: { startTrace: jest.Mock; recordStep: jest.Mock; completeTrace: jest.Mock };
    costTracking: { recordCost: jest.Mock };
    auditLog: { create: jest.Mock };
    dlpService: { scanForPII: jest.Mock; scanText: jest.Mock; redactData: jest.Mock };
    // PR-C3.1a — minimal GovernanceService stub (only `getPostureForTenant` is
    // consumed by SyncErrorAssistService + the promptBuilder helpers). Default
    // resolution = DEFAULT_POSTURE (regression-equivalent with pre-C3.1
    // behavior); override per-test via `mockResolvedValueOnce` to exercise
    // allowPII / piiTypes / autoRedact branches.
    governanceService: { getPostureForTenant: jest.Mock };
    // PR 13b — minimal ownership-governance stubs. Default: always-allow for
    // unit tests that don't exercise ownership-block paths.
    ownershipResolver: { validateWrite: jest.Mock; detectLoop: jest.Mock };
    auditService: { logGovernanceCheck: jest.Mock };
    approvalQueueService: { enqueue: jest.Mock };
  };
}

/**
 * Builds a SyncErrorAssistService with all 14 constructor dependencies wired to mock stubs.
 * Returns both the service and the underlying mocks so tests can assert
 * interactions and override per-test behavior via mockResolvedValueOnce.
 */
export function buildServiceWithStubs(): ServiceTestKit {
  const logger = makeMockLogger();
  const metrics = makeMockMetrics();
  const repo = makeMockRepo();
  const tenantConfig = makeMockTenantConfig();
  const connectorManager = { getConnector: jest.fn() };
  const providerRegistry = { getAvailableProvider: jest.fn() };
  const traceEngine = {
    startTrace: jest.fn().mockResolvedValue(undefined),
    recordStep: jest.fn().mockResolvedValue(undefined),
    completeTrace: jest.fn().mockResolvedValue(undefined),
  };
  const costTracking = { recordCost: jest.fn() };
  const auditLog = { create: jest.fn() };
  const dlpService = {
    // R22-1 — scanForPII MUST default to a configured resolution. Task 6's red-test cycle
    // exercises `sanitizeSourcePayloadForPrompt()`, which reads `scan.scanFailed` from
    // this stub's resolution. An unconfigured `jest.fn()` returns a thenable that resolves
    // to `undefined`, so `scan.scanFailed` would throw `TypeError: Cannot read properties
    // of undefined`. The default below is the "PII-clean" shape — tests that need
    // detected: true / scanFailed: true override via `mockResolvedValueOnce`.
    scanForPII: jest.fn().mockResolvedValue({
      detected: false, piiTypes: [], findings: [],
      riskLevel: 'low', recommendation: 'allow', redactedData: undefined, scanFailed: false,
    }),
    scanText: jest.fn().mockResolvedValue({
      detected: false, piiTypes: [], findings: [],
      riskLevel: 'low', recommendation: 'allow', redactedData: undefined,
    }),
    // PR-C3.1a R1 — redactData mirrors real DLPService.redactData behavior:
    // for string input, value-based .replace() per finding; for objects/arrays,
    // recursively narrow findings by `.location.path`. Tests with non-trivial
    // redaction shapes can override via `redactData.mockReturnValue(...)`.
    redactData: jest.fn(mockRedactData),
  };
  // PR-C3.1a — minimal GovernanceService stub. Default = DEFAULT_POSTURE (the
  // production fallback for system-identity / unknown tenants / repo errors),
  // which is regression-equivalent with pre-C3.1 syncErrorAssist behavior.
  // Tests can override via `mockResolvedValueOnce` to exercise allowPII /
  // piiTypes / autoRedact branches.
  const governanceService = {
    getPostureForTenant: jest.fn().mockResolvedValue(DEFAULT_POSTURE),
  };

  // Minimal OwnershipResolver stub — always allows writes (test mocks do not
  // exercise ownership-block paths). AuditService stub swallows logGovernanceCheck.
  const ownershipResolver = {
    validateWrite: jest.fn().mockResolvedValue({ allowed: true, owner: 'netsuite' as const }),
    detectLoop: jest.fn().mockResolvedValue({ loopDetected: false }),
  };
  const auditService = {
    logGovernanceCheck: jest.fn().mockResolvedValue(undefined),
  };
  const approvalQueueService = {
    enqueue: jest.fn().mockResolvedValue('queue-id'),
  };

  // R15-1 — Cast each mock through `unknown` to the real injected type instead of `as any`.
  // The any-budget script counts both `: any` and `as any`; `as unknown as T` counts as neither.
  // Each target type matches the @inject decorator at SyncErrorAssistService.ts:88-97.
  const service = new SyncErrorAssistService(
    logger as unknown as Logger,
    tenantConfig as unknown as TenantConfigurationRepository,
    repo as unknown as SyncErrorAssistRepository,
    connectorManager as unknown as ConnectorManager,
    providerRegistry as unknown as ProviderRegistry,
    traceEngine as unknown as ReasoningTraceEngine,
    costTracking as unknown as CostTrackingService,
    auditLog as unknown as AuditLogRepository,
    dlpService as unknown as DLPService,
    metrics as unknown as SyncErrorAssistMetrics,
    governanceService as unknown as GovernanceService,
    ownershipResolver as unknown as OwnershipResolver,
    auditService as unknown as AuditService,
    approvalQueueService as unknown as ApprovalQueueService,
  );

  return {
    service,
    stubs: {
      logger, metrics, repo, tenantConfig, connectorManager,
      providerRegistry, traceEngine, costTracking, auditLog, dlpService,
      governanceService, ownershipResolver, auditService, approvalQueueService,
    },
  };
}

/**
 * Convenience: seeds the NS search() result with a list of error rows for the next runCycle()
 * invocation. Mirrors the existing inline pattern at SyncErrorAssistService.test.ts:103.
 */
export function seedErrorRecords(records: Array<Record<string, unknown>>, kit: ServiceTestKit['stubs']): void {
  // Default ns mock — registers a getConnector → ns lookup that returns a stub.
  const ns = makeNsConnectorStub();
  ns.search.mockResolvedValueOnce(records).mockResolvedValueOnce([]);
  kit.connectorManager.getConnector.mockResolvedValueOnce(ns);
}

export function makeFixtureSuccessRecord(id: string): Record<string, unknown> {
  return { id, lastModified: '2026-05-10T10:00:00Z', error_message: 'happy', error_context: {} };
}
export function makeFixtureFailedRetryableRecord(id: string): Record<string, unknown> {
  return { id, lastModified: '2026-05-10T10:00:00Z', error_message: 'transient', error_context: {} };
}
export function makeFixtureFailedNonRetryableRecord(id: string): Record<string, unknown> {
  return { id, lastModified: '2026-05-10T10:00:00Z', error_message: 'permanent', error_context: {} };
}

/**
 * PR 13c-5 wedge4 — minimal mocks for the three governance-deps constructor
 * params that SyncErrorAssistService will REQUIRE post-NOOP_GOVERNANCE_DEPS
 * deletion. Each factory accepts an overrides object so tests can customize
 * a single method without redeclaring the whole stub.
 *
 * The constructor takes these as three separate positional args at indices
 * 12, 13, 14 (after the 12 @inject'd deps). See
 * src/services/syncErrorAssist/SyncErrorAssistService.ts:324-346.
 */

export function makeMockOwnershipResolver(
  overrides: Partial<{ validateWrite: jest.Mock; detectLoop: jest.Mock }> = {},
): OwnershipResolver {
  return {
    validateWrite: jest.fn().mockResolvedValue({ allowed: true, owner: 'netsuite' as const }),
    detectLoop: jest.fn().mockResolvedValue({ loopDetected: false }),
    ...overrides,
  } as unknown as OwnershipResolver;
}

export function makeMockAuditService(
  overrides: Partial<{ logGovernanceCheck: jest.Mock }> = {},
): AuditService {
  return {
    logGovernanceCheck: jest.fn().mockResolvedValue('audit-id'),
    ...overrides,
  } as unknown as AuditService;
}

export function makeMockApprovalQueueService(
  overrides: Partial<{ enqueue: jest.Mock }> = {},
): ApprovalQueueService {
  return {
    enqueue: jest.fn().mockResolvedValue('queue-id'),
    ...overrides,
  } as unknown as ApprovalQueueService;
}

/**
 * Convenience: returns the three governance-deps mocks as a 3-tuple
 * matching the constructor's positional order. Tests that don't need to
 * inspect individual mocks can spread this into the constructor call:
 *
 *   new SyncErrorAssistService(...12Deps, ...makeSyncErrorAssistGovernanceArgs())
 */
export function makeSyncErrorAssistGovernanceArgs(): [
  OwnershipResolver,
  AuditService,
  ApprovalQueueService,
] {
  return [
    makeMockOwnershipResolver(),
    makeMockAuditService(),
    makeMockApprovalQueueService(),
  ];
}
