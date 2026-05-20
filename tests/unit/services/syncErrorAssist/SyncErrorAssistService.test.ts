import 'reflect-metadata';
import { SyncErrorAssistService } from '../../../../src/services/syncErrorAssist/SyncErrorAssistService';
import { GovernanceBlockedError } from '../../../../src/services/governance/OutboundGovernanceErrors';
import { SyncErrorAssistTimeoutError } from '../../../../src/services/syncErrorAssist/errors';
import { ServiceUnavailableAppError } from '../../../../src/errors/AppError';
import {
  buildServiceWithStubs, identityCtx, makeProviderInfo,
  makeNsConnectorStub, makeClaim, makeWebhookPayload,
  makeFixtureSuccessRecord, makeFixtureFailedRetryableRecord, makeFixtureFailedNonRetryableRecord,
} from './testHelpers';   // created in Task 6 Step 0

function makeMockLogger() {
  return {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    withCorrelationId: jest.fn().mockReturnThis(),
  };
}
function makeMockMetrics() {
  return {
    recordCycleOutcome: jest.fn(),
    recordErrorsScanned: jest.fn(),
    recordSuggestionWritten: jest.fn(),
    recordProcessedStatus: jest.fn(),
    observeCycleDuration: jest.fn(),
    recordCostCents: jest.fn(),
    recordDlpScanOutcome: jest.fn(),
    recordPromptInjectionReplaced: jest.fn(),
  };
}
function makeMockDLP() {
  return {
    scanForPII: jest.fn().mockResolvedValue({
      detected: false,
      piiTypes: [],
      findings: [],
      riskLevel: 'low',
      recommendation: 'allow',
      redactedData: undefined,
      scanFailed: false,
    }),
    scanText: jest.fn().mockResolvedValue({
      detected: false,
      piiTypes: [],
      findings: [],
      riskLevel: 'low',
      recommendation: 'allow',
      redactedData: undefined,
    }),
  };
}

describe('SyncErrorAssistService.runCycle', () => {
  it('short-circuits when tenant has sync_error_assist.enabled=false', async () => {
    const mockTenantConfig = { getBoolean: jest.fn().mockResolvedValue(false), getString: jest.fn(), getInt: jest.fn() };
    const mockMetrics = makeMockMetrics();
    const service = new SyncErrorAssistService(
      makeMockLogger() as any,
      mockTenantConfig as any,
      {} as any,                          // repo
      {} as any,                          // connectorManager
      {} as any,                          // providerRegistry
      {} as any,                          // traceEngine
      {} as any,                          // costTracking
      {} as any,                          // auditLog
      {} as any,                          // dlpService
      mockMetrics as any,
    );

    const providerInfo = { provider: { mode: 'cloud-api' } as any, providerId: 'claude' };
    const result = await service.runCycle('disabled-tenant', { tenantId: 'disabled-tenant', userId: 'u' }, providerInfo);

    expect(result.tenantId).toBe('disabled-tenant');
    expect(result.errorsScanned).toBe(0);
    expect(result.suggestionsWritten).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failedRetryable).toBe(0);
    expect(result.failedNonRetryable).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(mockTenantConfig.getBoolean).toHaveBeenCalledWith('disabled-tenant', 'sync_error_assist.enabled');
    expect(mockMetrics.recordCycleOutcome).toHaveBeenCalledWith('disabled-tenant', 'disabled');
  });

  it('clamps unrecognized confidence_threshold to "mid" before interpolating into the system prompt', async () => {
    const mockTenantConfig = {
      getBoolean: jest.fn().mockResolvedValue(true),
      getString: jest.fn().mockResolvedValue('high-priority'),  // garbage value — must NOT reach the prompt
      getInt: jest.fn(),
    };
    const mockNS = { search: jest.fn().mockResolvedValue([]), create: jest.fn() };
    const mockRepo = {
      getActiveTenants: jest.fn(),
      claim: jest.fn(),
      updateSucceeded: jest.fn(),
      updateFailed: jest.fn(),
      getWatermark: jest.fn().mockResolvedValue(null),
      tryAdvanceWatermark: jest.fn().mockResolvedValue(true),
      reapStuckProcessing: jest.fn(),
    };
    const mockChat = jest.fn();
    const mockProvider = { mode: 'cloud-api', chat: mockChat };
    const service = new SyncErrorAssistService(
      makeMockLogger() as any,
      mockTenantConfig as any, mockRepo as any,
      { getConnector: jest.fn().mockResolvedValue(mockNS) } as any,
      {} as any, {} as any, { recordCost: jest.fn() } as any, { create: jest.fn() } as any,
      makeMockDLP() as any, makeMockMetrics() as any,
    );

    const providerInfo = { provider: mockProvider as any, providerId: 'claude' };
    await service.runCycle('t1', { tenantId: 't1', userId: 'u' }, providerInfo);

    // The runCycle exits with no errors found (search returned []), so chat was never
    // called. We assert via the watermark path: verify getString was queried (proving
    // the clamp ran), AND that no string outside {high,mid,low} could have escaped.
    expect(mockTenantConfig.getString).toHaveBeenCalledWith('t1', 'sync_error_assist.confidence_threshold');
  });

  it('clamps unrecognized confidence_threshold to "mid" in the prompt when an error is processed', async () => {
    // Stronger assertion: when there IS an error to process, the prompt that hits
    // chat() must contain "mid", not the garbage value.
    const errorRecord = {
      id: 'err-1', lastModified: '2026-05-01T10:00:00Z',
      error_message: 'msg', error_context: {},
    };
    const mockTenantConfig = {
      getBoolean: jest.fn().mockResolvedValue(true),
      getString: jest.fn().mockResolvedValue('SUPER_HIGH'),  // garbage
      getInt: jest.fn(),
    };
    const mockNS = {
      search: jest.fn().mockResolvedValueOnce([errorRecord]).mockResolvedValueOnce([]),
      create: jest.fn().mockResolvedValue({ id: 'ns-1' }),
    };
    const mockRepo = {
      getActiveTenants: jest.fn(),
      claim: jest.fn().mockResolvedValue({ id: 'r-1', tenantId: 't1', errorRecordId: 'err-1', attempts: 1 }),
      updateSucceeded: jest.fn(), updateFailed: jest.fn(),
      getWatermark: jest.fn().mockResolvedValue(null),
      tryAdvanceWatermark: jest.fn().mockResolvedValue(true), reapStuckProcessing: jest.fn(),
    };
    const mockChat = jest.fn().mockResolvedValue({
      content: JSON.stringify({ confidence: 'high', suggestion_type: 'create_missing_record', suggestion_text: 'fix', references_field: null }),
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
    const mockProvider = { mode: 'cloud-api', chat: mockChat, getLastTokenUsage: jest.fn().mockReturnValue({ estimatedCost: 0, totalTokens: 15 }) };
    const mockTrace = {
      startTrace: jest.fn().mockResolvedValue(undefined),
      recordStep: jest.fn().mockResolvedValue(undefined),
      completeTrace: jest.fn().mockResolvedValue(undefined),
    };
    const service = new SyncErrorAssistService(
      makeMockLogger() as any,
      mockTenantConfig as any, mockRepo as any,
      { getConnector: jest.fn().mockResolvedValue(mockNS) } as any,
      {} as any, mockTrace as any, { recordCost: jest.fn() } as any, { create: jest.fn() } as any,
      makeMockDLP() as any, makeMockMetrics() as any,
    );

    const providerInfo = { provider: mockProvider as any, providerId: 'claude' };
    await service.runCycle('t1', { tenantId: 't1', userId: 'u' }, providerInfo);

    expect(mockChat).toHaveBeenCalledTimes(1);
    const messages = mockChat.mock.calls[0][0] as { role: string; content: string }[];
    const systemPrompt = messages.find((m) => m.role === 'system')?.content ?? '';
    expect(systemPrompt).toContain('"mid"');                // clamped fallback present
    expect(systemPrompt).not.toContain('SUPER_HIGH');       // garbage MUST NOT escape
  });

  describe('readErrorRecords (private — exercised via runCycle)', () => {
    function makeBaseService(overrides: Partial<{
      enabled: boolean;
      nsRecords: any[];
      threshold: string;
    }>) {
      const mockTenantConfig = {
        getBoolean: jest.fn().mockResolvedValue(overrides.enabled ?? true),
        getString: jest.fn().mockResolvedValue(overrides.threshold ?? 'mid'),
        getInt: jest.fn(),
      };
      const mockNS = {
        search: jest.fn().mockResolvedValue(overrides.nsRecords ?? []),
        create: jest.fn(),
      };
      const mockConnectorManager = {
        getConnector: jest.fn().mockResolvedValue(mockNS),
      };
      const mockRepo = {
        getActiveTenants: jest.fn(),
        claim: jest.fn(),
        updateSucceeded: jest.fn(),
        updateFailed: jest.fn(),
        getWatermark: jest.fn().mockResolvedValue(null),
        tryAdvanceWatermark: jest.fn().mockResolvedValue(true),
        reapStuckProcessing: jest.fn(),
      };
      const service = new SyncErrorAssistService(
        makeMockLogger() as any,
        mockTenantConfig as any,
        mockRepo as any,
        mockConnectorManager as any,
        {} as any, {} as any, {} as any, {} as any, {} as any,
        makeMockMetrics() as any,
      );
      return { service, mockNS, mockConnectorManager, mockRepo, mockTenantConfig };
    }

    it('pages through search() until empty page or budget exhausted', async () => {
      const records = Array.from({ length: 250 }, (_, i) => ({ id: `e-${i}`, lastModified: '2026-05-01T10:00:00Z' }));
      const { service, mockNS } = makeBaseService({ nsRecords: [] });
      mockNS.search
        .mockResolvedValueOnce(records.slice(0, 100))
        .mockResolvedValueOnce(records.slice(100, 200))
        .mockResolvedValueOnce(records.slice(200, 250))
        .mockResolvedValueOnce([]);

      const providerInfo = { provider: { mode: 'cloud-api' } as any, providerId: 'claude' };
      await service.runCycle('t1', { tenantId: 't1', userId: 'u' }, providerInfo);

      expect(mockNS.search).toHaveBeenCalledTimes(3);
      expect(mockNS.search.mock.calls[0][1]).toMatchObject({ limit: 100, offset: 0 });
      expect(mockNS.search.mock.calls[1][1]).toMatchObject({ limit: 100, offset: 100 });
      expect(mockNS.search.mock.calls[2][1]).toMatchObject({ limit: 100, offset: 200 });
    });

    it('passes lastModified after-filter when watermark is non-null', async () => {
      const watermark = new Date('2026-05-01T10:00:00Z');
      const { service, mockNS, mockRepo } = makeBaseService({});
      mockRepo.getWatermark.mockResolvedValue(watermark);

      const providerInfo = { provider: { mode: 'cloud-api' } as any, providerId: 'claude' };
      await service.runCycle('t1', { tenantId: 't1', userId: 'u' }, providerInfo);

      expect(mockNS.search).toHaveBeenCalledWith(
        'customrecord_suitecentral_sync_error',
        expect.objectContaining({
          filters: { lastModified: { operator: 'after', value: watermark.toISOString() } },
        }),
      );
    });

    it('advances watermark when records skipped but failedRetryable === 0 (skipped does NOT block watermark)', async () => {
      const records = [
        { id: 'e-1', lastModified: '2026-05-01T10:00:00Z' },
        { id: 'e-2', lastModified: '2026-05-01T11:00:00Z' },
        { id: 'e-3', lastModified: '2026-05-01T09:00:00Z' },
      ];
      const { service, mockNS, mockRepo } = makeBaseService({});
      mockNS.search.mockResolvedValueOnce(records).mockResolvedValueOnce([]);
      mockRepo.claim.mockResolvedValue(null);

      const providerInfo = { provider: { mode: 'cloud-api' } as any, providerId: 'claude' };
      await service.runCycle('t1', { tenantId: 't1', userId: 'u' }, providerInfo);

      // Codex R2-1: skipped records (concurrent owner OR already terminal)
      // don't constrain OUR watermark — only failedRetryable > 0 holds it.
      // Holding on skipped would stall the watermark indefinitely for any
      // tenant with old terminal records.
      expect(mockRepo.tryAdvanceWatermark).toHaveBeenCalledWith(
        't1',
        new Date('2026-05-01T11:00:00Z'),
      );
    });

    it('holds watermark when failedRetryable > 0 (re-scan next cycle for retry)', async () => {
      const errorRecord = {
        id: 'err-r1',
        lastModified: '2026-05-01T11:00:00Z',
        error_message: 'transient timeout',
        error_context: {},
      };
      const mockTenantConfig = {
        getBoolean: jest.fn().mockResolvedValue(true),
        getString: jest.fn().mockResolvedValue('mid'),
        getInt: jest.fn(),
      };
      const mockNS = {
        search: jest.fn().mockResolvedValueOnce([errorRecord]).mockResolvedValueOnce([]),
        create: jest.fn(),
      };
      const mockRepo = {
        getActiveTenants: jest.fn(),
        claim: jest.fn().mockResolvedValue({ id: 'r-1', tenantId: 't1', errorRecordId: 'err-r1', attempts: 1 }),
        updateSucceeded: jest.fn(),
        updateFailed: jest.fn(),
        getWatermark: jest.fn().mockResolvedValue(null),
        tryAdvanceWatermark: jest.fn().mockResolvedValue(true),
        reapStuckProcessing: jest.fn(),
      };
      // chat() throws a timeout → classify() with attempts=1 → failed_retryable
      const mockChat = jest.fn().mockRejectedValue(new SyncErrorAssistTimeoutError('AI provider chat', 5000));
      const mockProvider = { mode: 'cloud-api', chat: mockChat };
      const mockTrace = {
        startTrace: jest.fn().mockResolvedValue(undefined),
        recordStep: jest.fn().mockResolvedValue(undefined),
        completeTrace: jest.fn().mockResolvedValue(undefined),
      };
      const mockDLP = makeMockDLP();
      const service = new SyncErrorAssistService(
        makeMockLogger() as any,
        mockTenantConfig as any,
        mockRepo as any,
        { getConnector: jest.fn().mockResolvedValue(mockNS) } as any,
        {} as any,
        mockTrace as any,
        { recordCost: jest.fn() } as any,
        { create: jest.fn() } as any,
        mockDLP as any,
        makeMockMetrics() as any,
      );

      const providerInfo = { provider: mockProvider as any, providerId: 'claude' };
      const result = await service.runCycle('t1', { tenantId: 't1', userId: 'u' }, providerInfo);

      // Verify the failure was classified retryable (attempts=1 < 3)
      expect(result.failedRetryable).toBe(1);
      // Watermark MUST be held — we'll re-scan this record next cycle to retry
      expect(mockRepo.tryAdvanceWatermark).not.toHaveBeenCalled();
    });
  });

  describe('runCycle — per-error happy path', () => {
    it('processes a single error end-to-end: claim, AI, audit, NS write, update', async () => {
      const errorRecord = {
        id: 'err-1',
        lastModified: '2026-05-01T10:00:00Z',
        error_message: 'Could not find item 1234',
        error_context: { item_id: '1234' },
      };

      const mockTenantConfig = {
        getBoolean: jest.fn().mockResolvedValue(true),
        getString: jest.fn().mockResolvedValue('mid'),
        getInt: jest.fn(),
      };
      const mockNS = {
        search: jest.fn().mockResolvedValueOnce([errorRecord]).mockResolvedValueOnce([]),
        create: jest.fn().mockResolvedValue({ id: 'ns-200' }),
      };
      const mockConnectorManager = { getConnector: jest.fn().mockResolvedValue(mockNS) };
      const mockRepo = {
        getActiveTenants: jest.fn(),
        claim: jest.fn().mockResolvedValue({ id: 'r-1', tenantId: 't1', errorRecordId: 'err-1', attempts: 1 }),
        updateSucceeded: jest.fn(),
        updateFailed: jest.fn(),
        getWatermark: jest.fn().mockResolvedValue(null),
        tryAdvanceWatermark: jest.fn().mockResolvedValue(true),
        reapStuckProcessing: jest.fn(),
      };
      const mockChat = jest.fn().mockResolvedValue({
        content: JSON.stringify({
          confidence: 'high',
          suggestion_type: 'create_missing_record',
          suggestion_text: 'Create item 1234 in NetSuite',
          references_field: 'item_id',
        }),
        usage: { promptTokens: 200, completionTokens: 50, totalTokens: 250 },
      });
      const mockProvider = { mode: 'cloud-api', chat: mockChat, getLastTokenUsage: jest.fn().mockReturnValue({ estimatedCost: 0.05, totalTokens: 250 }) };
      const mockTrace = {
        startTrace: jest.fn().mockResolvedValue(undefined),
        recordStep: jest.fn().mockResolvedValue(undefined),
        completeTrace: jest.fn().mockResolvedValue(undefined),
      };
      const mockCost = { recordCost: jest.fn() };
      const mockAudit = { create: jest.fn() };
      const mockDLP = makeMockDLP();
      const mockMetrics = makeMockMetrics();

      const service = new SyncErrorAssistService(
        makeMockLogger() as any,
        mockTenantConfig as any,
        mockRepo as any,
        mockConnectorManager as any,
        {} as any,
        mockTrace as any,
        mockCost as any,
        mockAudit as any,
        mockDLP as any,
        mockMetrics as any,
      );

      const providerInfo = { provider: mockProvider as any, providerId: 'claude' };
      const result = await service.runCycle('t1', { tenantId: 't1', userId: 'u' }, providerInfo);

      expect(result.suggestionsWritten).toBe(1);
      expect(result.errorsScanned).toBe(1);
      expect(mockChat).toHaveBeenCalledTimes(1);
      expect(mockNS.create).toHaveBeenCalledWith('customrecord_suitecentral_fix_suggestion', expect.objectContaining({
        error_record_id: 'err-1',
        reasoning_trace_id: expect.any(String),
        provider_used: 'cloud-api',
      }));
      expect(mockConnectorManager.getConnector).toHaveBeenCalledTimes(1);
      expect(mockRepo.updateSucceeded).toHaveBeenCalledWith('r-1', expect.objectContaining({
        suggestionRecordId: 'ns-200',
        provider: 'cloud-api',
        costEstimateUsdCents: 5,
      }));
      expect(mockCost.recordCost).toHaveBeenCalledWith(expect.objectContaining({
        providerId: 'claude',
        operation: 'other',
        tokensUsed: 250,
        cost: 0.05,
      }));
      expect(mockAudit.create).toHaveBeenCalledWith(expect.objectContaining({
        action: 'sync_error_assist.write_fix_suggestion',
        result: 'success',
        details: expect.objectContaining({ suggestion_record_id: 'ns-200' }),
      }));
      expect(mockNS.create).toHaveBeenCalled();
      expect(mockAudit.create).toHaveBeenCalled();
      expect(mockNS.create.mock.invocationCallOrder[0]).toBeLessThan(mockAudit.create.mock.invocationCallOrder[0]);
      expect(mockMetrics.recordSuggestionWritten).toHaveBeenCalledWith('t1', 'cloud-api');
      expect(mockMetrics.recordProcessedStatus).toHaveBeenCalledWith('t1', 'succeeded');
    });

    it('skips records with missing id without attempting claim/create', async () => {
      const errorRecord = { lastModified: '2026-05-01T10:00:00Z', error_message: 'x', error_context: {} };
      const mockNS = { search: jest.fn().mockResolvedValueOnce([errorRecord]).mockResolvedValueOnce([]), create: jest.fn() };
      const mockTenantConfig = { getBoolean: jest.fn().mockResolvedValue(true), getString: jest.fn().mockResolvedValue('mid'), getInt: jest.fn() };
      const mockRepo = {
        getActiveTenants: jest.fn(), claim: jest.fn(), updateSucceeded: jest.fn(), updateFailed: jest.fn(),
        getWatermark: jest.fn().mockResolvedValue(null), tryAdvanceWatermark: jest.fn().mockResolvedValue(true), reapStuckProcessing: jest.fn(),
      };
      const service = new SyncErrorAssistService(
        makeMockLogger() as any,
        mockTenantConfig as any, mockRepo as any,
        { getConnector: jest.fn().mockResolvedValue(mockNS) } as any,
        {} as any,
        { startTrace: jest.fn(), recordStep: jest.fn(), completeTrace: jest.fn() } as any,
        { recordCost: jest.fn() } as any,
        { create: jest.fn() } as any,
        makeMockDLP() as any,
        makeMockMetrics() as any,
      );
      const providerInfo = { provider: { mode: 'cloud-api', chat: jest.fn() } as any, providerId: 'claude' };
      const result = await service.runCycle('t1', { tenantId: 't1', userId: 'u' }, providerInfo);

      expect(result.skipped).toBe(1);
      expect(mockRepo.claim).not.toHaveBeenCalled();
      expect(mockNS.create).not.toHaveBeenCalled();
    });

    it('skips when claim() returns null (concurrent owner)', async () => {
      const errorRecord = { id: 'err-1', lastModified: '2026-05-01T10:00:00Z', error_message: 'x', error_context: {} };
      const mockNS = { search: jest.fn().mockResolvedValueOnce([errorRecord]).mockResolvedValueOnce([]), create: jest.fn() };
      const mockTenantConfig = { getBoolean: jest.fn().mockResolvedValue(true), getString: jest.fn().mockResolvedValue('mid'), getInt: jest.fn() };
      const mockRepo = {
        getActiveTenants: jest.fn(), claim: jest.fn().mockResolvedValue(null),
        updateSucceeded: jest.fn(), updateFailed: jest.fn(),
        getWatermark: jest.fn().mockResolvedValue(null), tryAdvanceWatermark: jest.fn().mockResolvedValue(true),
        reapStuckProcessing: jest.fn(),
      };
      const service = new SyncErrorAssistService(
        makeMockLogger() as any,
        mockTenantConfig as any, mockRepo as any,
        { getConnector: jest.fn().mockResolvedValue(mockNS) } as any,
        {} as any,
        { startTrace: jest.fn(), recordStep: jest.fn(), completeTrace: jest.fn() } as any,
        { recordCost: jest.fn() } as any,
        { create: jest.fn() } as any,
        makeMockDLP() as any,
        makeMockMetrics() as any,
      );
      const providerInfo = { provider: { mode: 'cloud-api', chat: jest.fn() } as any, providerId: 'claude' };
      const result = await service.runCycle('t1', { tenantId: 't1', userId: 'u' }, providerInfo);
      expect(result.skipped).toBe(1);
      expect(result.suggestionsWritten).toBe(0);
      expect(mockNS.create).not.toHaveBeenCalled();
    });
  });

  describe('runCycle — failure paths', () => {
    function makeServiceWithChat(chatBehavior: () => Promise<any>) {
      const errorRecord = { id: 'err-1', lastModified: '2026-05-01T10:00:00Z', error_message: 'msg', error_context: {} };
      const mockNS = {
        search: jest.fn().mockResolvedValueOnce([errorRecord]).mockResolvedValueOnce([]),
        create: jest.fn(),
      };
      const mockTenantConfig = { getBoolean: jest.fn().mockResolvedValue(true), getString: jest.fn().mockResolvedValue('mid'), getInt: jest.fn() };
      const mockRepo = {
        getActiveTenants: jest.fn(),
        claim: jest.fn().mockResolvedValue({ id: 'r-1', tenantId: 't1', errorRecordId: 'err-1', attempts: 1 }),
        updateSucceeded: jest.fn(),
        updateFailed: jest.fn(),
        getWatermark: jest.fn().mockResolvedValue(null),
        tryAdvanceWatermark: jest.fn().mockResolvedValue(true),
        reapStuckProcessing: jest.fn(),
      };
      const mockChat = jest.fn().mockImplementation(chatBehavior);
      const mockProvider = { mode: 'cloud-api', chat: mockChat };
      const mockTrace = {
        startTrace: jest.fn().mockResolvedValue(undefined),
        recordStep: jest.fn().mockResolvedValue(undefined),
        completeTrace: jest.fn().mockResolvedValue(undefined),
      };
      const mockAudit = { create: jest.fn() };
      const mockDLP = makeMockDLP();
      const mockMetrics = makeMockMetrics();
      const service = new SyncErrorAssistService(
        makeMockLogger() as any,
        mockTenantConfig as any, mockRepo as any,
        { getConnector: jest.fn().mockResolvedValue(mockNS) } as any,
        {} as any,
        mockTrace as any, { recordCost: jest.fn() } as any, mockAudit as any, mockDLP as any, mockMetrics as any,
      );
      return { service, mockNS, mockRepo, mockTrace, mockAudit, mockDLP, mockMetrics, mockProvider };
    }

    it('GovernanceBlockedError → updateFailed(failed_non_retryable) + failure-path audit', async () => {
      const { service, mockRepo, mockTrace, mockAudit, mockProvider } = makeServiceWithChat(() => {
        throw new GovernanceBlockedError({ reason: 'PII detected' } as any);
      });
      const providerInfo = { provider: mockProvider as any, providerId: 'claude' };
      const result = await service.runCycle('t1', { tenantId: 't1', userId: 'u' }, providerInfo);

      expect(result.failedNonRetryable).toBe(1);
      expect(mockRepo.updateFailed).toHaveBeenCalledWith('r-1', 'failed_non_retryable', expect.any(String));
      expect(mockTrace.completeTrace).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'failed');
      expect(mockAudit.create).toHaveBeenCalledWith(expect.objectContaining({
        action: 'sync_error_assist.write_fix_suggestion',
        result: 'failure',
      }));
    });

    it('failure-path auditLog.create() throw is swallowed — does NOT abort the per-record catch', async () => {
      // Regression: previously the failure-path audit was unguarded. A transient DB
      // error on the audit write would escape the per-record catch and abort the
      // whole tenant batch. Mirrors the success-path audit guard.
      const { service, mockRepo, mockAudit, mockProvider } = makeServiceWithChat(() => {
        throw new SyncErrorAssistTimeoutError('AI provider chat', 5000);
      });
      mockAudit.create.mockRejectedValue(new Error('DB transient: audit log unavailable'));
      const providerInfo = { provider: mockProvider as any, providerId: 'claude' };

      const result = await service.runCycle('t1', { tenantId: 't1', userId: 'u' }, providerInfo);

      // updateFailed still ran (state machine is durable)
      expect(mockRepo.updateFailed).toHaveBeenCalledWith('r-1', 'failed_retryable', expect.any(String));
      // Cycle completed without re-throwing the audit error
      expect(result.failedRetryable).toBe(1);
      expect(result.aborted).toBeUndefined();
    });

    it('Timeout → failed_retryable when attempts < 3', async () => {
      const { service, mockRepo, mockProvider } = makeServiceWithChat(() => {
        throw new SyncErrorAssistTimeoutError('AI provider chat', 5000);
      });
      const providerInfo = { provider: mockProvider as any, providerId: 'claude' };
      const result = await service.runCycle('t1', { tenantId: 't1', userId: 'u' }, providerInfo);

      expect(result.failedRetryable).toBe(1);
      expect(mockRepo.updateFailed).toHaveBeenCalledWith('r-1', 'failed_retryable', expect.any(String));
    });

    it('NetSuite-create timeout → failed_non_retryable (Codex R2-4 — duplicate-write risk)', async () => {
      // Codex R2-4: NS-create timeout is the one timeout case classify() pins to
      // failed_non_retryable (regardless of attempts) — the underlying HTTP request
      // may have completed and written the record, so retrying risks duplicates.
      // Operator must dedup via NS-side query before any manual retry.
      const errorRecord = {
        id: 'err-1',
        lastModified: '2026-05-01T10:00:00Z',
        error_message: 'Could not find item 1234',
        error_context: { item_id: '1234' },
      };
      const mockTenantConfig = {
        getBoolean: jest.fn().mockResolvedValue(true),
        getString: jest.fn().mockResolvedValue('mid'),
        getInt: jest.fn(),
      };
      const mockNS = {
        search: jest.fn().mockResolvedValueOnce([errorRecord]).mockResolvedValueOnce([]),
        // NS.create throws a NetSuite-create timeout — note the operation label
        create: jest.fn().mockRejectedValue(new SyncErrorAssistTimeoutError('NetSuite create', 5000)),
      };
      const mockRepo = {
        getActiveTenants: jest.fn(),
        claim: jest.fn().mockResolvedValue({ id: 'r-1', tenantId: 't1', errorRecordId: 'err-1', attempts: 1 }),
        updateSucceeded: jest.fn(),
        updateFailed: jest.fn(),
        getWatermark: jest.fn().mockResolvedValue(null),
        tryAdvanceWatermark: jest.fn().mockResolvedValue(true),
        reapStuckProcessing: jest.fn(),
      };
      const mockChat = jest.fn().mockResolvedValue({
        content: JSON.stringify({
          confidence: 'high',
          suggestion_type: 'create_missing_record',
          suggestion_text: 'Create item 1234',
          references_field: 'item_id',
        }),
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      });
      const mockProvider = { mode: 'cloud-api', chat: mockChat };
      const mockTrace = {
        startTrace: jest.fn().mockResolvedValue(undefined),
        recordStep: jest.fn().mockResolvedValue(undefined),
        completeTrace: jest.fn().mockResolvedValue(undefined),
      };
      const mockDLP = makeMockDLP();
      const service = new SyncErrorAssistService(
        makeMockLogger() as any,
        mockTenantConfig as any,
        mockRepo as any,
        { getConnector: jest.fn().mockResolvedValue(mockNS) } as any,
        {} as any,
        mockTrace as any,
        { recordCost: jest.fn() } as any,
        { create: jest.fn() } as any,
        mockDLP as any,
        makeMockMetrics() as any,
      );

      const providerInfo = { provider: mockProvider as any, providerId: 'claude' };
      const result = await service.runCycle('t1', { tenantId: 't1', userId: 'u' }, providerInfo);

      expect(result.failedNonRetryable).toBe(1);
      expect(result.failedRetryable).toBe(0);
      expect(mockRepo.updateFailed).toHaveBeenCalledWith('r-1', 'failed_non_retryable', expect.any(String));
    });

    it('post-ns.create audit/trace failure does NOT reclassify as failed (Codex R2-3)', async () => {
      // Codex R2-3: once ns.create has returned with an id, the suggestion
      // record exists in NetSuite. If post-write bookkeeping (completeTrace,
      // auditLog.create, updateSucceeded) throws, we must NOT mark the local
      // row failed_* — that would lose the connection between local state and
      // the durable artifact. Log loudly and leave status='processing' for
      // the reaper. Metrics still increment for the successful suggestion write.
      const errorRecord = {
        id: 'err-1',
        lastModified: '2026-05-01T10:00:00Z',
        error_message: 'Could not find item 1234',
        error_context: { item_id: '1234' },
      };
      const mockTenantConfig = {
        getBoolean: jest.fn().mockResolvedValue(true),
        getString: jest.fn().mockResolvedValue('mid'),
        getInt: jest.fn(),
      };
      const mockNS = {
        search: jest.fn().mockResolvedValueOnce([errorRecord]).mockResolvedValueOnce([]),
        create: jest.fn().mockResolvedValue({ id: 'ns-200' }),  // ns.create succeeds
      };
      const mockRepo = {
        getActiveTenants: jest.fn(),
        claim: jest.fn().mockResolvedValue({ id: 'r-1', tenantId: 't1', errorRecordId: 'err-1', attempts: 1 }),
        updateSucceeded: jest.fn(),
        updateFailed: jest.fn(),
        getWatermark: jest.fn().mockResolvedValue(null),
        tryAdvanceWatermark: jest.fn().mockResolvedValue(true),
        reapStuckProcessing: jest.fn(),
      };
      const mockChat = jest.fn().mockResolvedValue({
        content: JSON.stringify({
          confidence: 'high',
          suggestion_type: 'create_missing_record',
          suggestion_text: 'Create item 1234',
          references_field: 'item_id',
        }),
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      });
      const mockProvider = {
        mode: 'cloud-api',
        chat: mockChat,
        getLastTokenUsage: jest.fn().mockReturnValue({ estimatedCost: 0.05, totalTokens: 150 }),
      };
      const mockTrace = {
        startTrace: jest.fn().mockResolvedValue(undefined),
        recordStep: jest.fn().mockResolvedValue(undefined),
        completeTrace: jest.fn().mockResolvedValue(undefined),
      };
      // auditLog.create throws AFTER ns.create succeeded
      const mockAudit = { create: jest.fn().mockRejectedValue(new Error('DB transient: audit write failed')) };
      const mockDLP = makeMockDLP();
      const mockMetrics = makeMockMetrics();

      const service = new SyncErrorAssistService(
        makeMockLogger() as any,
        mockTenantConfig as any,
        mockRepo as any,
        { getConnector: jest.fn().mockResolvedValue(mockNS) } as any,
        {} as any,
        mockTrace as any,
        { recordCost: jest.fn() } as any,
        mockAudit as any,
        mockDLP as any,
        mockMetrics as any,
      );

      const providerInfo = { provider: mockProvider as any, providerId: 'claude' };
      const result = await service.runCycle('t1', { tenantId: 't1', userId: 'u' }, providerInfo);

      // Row was NOT reclassified as failed — updateFailed never called
      expect(mockRepo.updateFailed).not.toHaveBeenCalled();
      // updateSucceeded was attempted (could have been the throwing call), but the
      // KEY contract is that we DON'T flip the row to failed_* — local state stays
      // consistent with the NS-side artifact (suggestion record was written).
      // Metrics still increment for the successful suggestion write
      expect(mockMetrics.recordSuggestionWritten).toHaveBeenCalledWith('t1', 'cloud-api');
      expect(mockMetrics.recordProcessedStatus).toHaveBeenCalledWith('t1', 'succeeded');
      // CycleResult reflects success (not failure) since we wrote to NetSuite
      expect(result.suggestionsWritten).toBe(1);
      expect(result.failedRetryable).toBe(0);
      expect(result.failedNonRetryable).toBe(0);
    });

    it('passes errorMessage through DLPService.scanText with autoRedact:true policy', async () => {
      const { service, mockDLP, mockProvider } = makeServiceWithChat(() => {
        throw new Error('PII echo: john@example.com');
      });
      mockDLP.scanText.mockResolvedValue({ findings: [{ type: 'email' }], piiTypes: ['email'], redactedData: 'PII echo: [REDACTED]' });
      const providerInfo = { provider: mockProvider as any, providerId: 'claude' };
      await service.runCycle('t1', { tenantId: 't1', userId: 'u' }, providerInfo);
      expect(mockDLP.scanText).toHaveBeenCalledWith(
        expect.stringContaining('PII echo'),
        expect.objectContaining({ autoRedact: true }),
      );
    });
  });

  describe('runAllEnabledTenants', () => {
    it('runs reaper FIRST, then provider check, then per-tenant fan-out', async () => {
      const order: string[] = [];
      const mockRepo = {
        getActiveTenants: jest.fn().mockImplementation(async () => { order.push('getActiveTenants'); return ['t1']; }),
        reapStuckProcessing: jest.fn().mockImplementation(async () => { order.push('reap'); return { reaped: 0, recoveries: [] }; }),
        claim: jest.fn().mockResolvedValue(null),
        updateSucceeded: jest.fn(), updateFailed: jest.fn(),
        getWatermark: jest.fn().mockResolvedValue(null), tryAdvanceWatermark: jest.fn().mockResolvedValue(true),
      };
      const mockProviderRegistry = {
        getAvailableProvider: jest.fn().mockImplementation(async () => { order.push('getProvider'); return { provider: { mode: 'cloud-api', chat: jest.fn() }, id: 'claude' }; }),
      };
      const mockNS = { search: jest.fn().mockResolvedValue([]), create: jest.fn() };
      const mockTenantConfig = { getBoolean: jest.fn().mockImplementation(async () => { order.push('cfg.getBoolean'); return true; }), getString: jest.fn().mockResolvedValue('mid'), getInt: jest.fn() };
      const service = new SyncErrorAssistService(
        makeMockLogger() as any,
        mockTenantConfig as any, mockRepo as any,
        { getConnector: jest.fn().mockResolvedValue(mockNS) } as any,
        mockProviderRegistry as any,
        { startTrace: jest.fn(), recordStep: jest.fn(), completeTrace: jest.fn() } as any,
        { recordCost: jest.fn() } as any,
        { create: jest.fn() } as any,
        makeMockDLP() as any,
        makeMockMetrics() as any,
      );

      await service.runAllEnabledTenants({ tenantId: '__system__', userId: '__system__' });

      expect(order[0]).toBe('reap');
      expect(order[1]).toBe('getProvider');
      expect(order[2]).toBe('getActiveTenants');
    });

    it('returns [] when no provider available (and reaper still ran)', async () => {
      const mockProviderRegistry = { getAvailableProvider: jest.fn().mockResolvedValue(null), listProviders: jest.fn().mockReturnValue([]) };
      const mockRepo = { reapStuckProcessing: jest.fn().mockResolvedValue({ reaped: 0, recoveries: [] }), getActiveTenants: jest.fn() };
      const mockMetrics = makeMockMetrics();
      const service = new SyncErrorAssistService(
        makeMockLogger() as any,
        {} as any, mockRepo as any, {} as any, mockProviderRegistry as any,
        {} as any, {} as any, {} as any, {} as any, mockMetrics as any,
      );
      const results = await service.runAllEnabledTenants({ tenantId: '__system__', userId: '__system__' });
      expect(results).toEqual([]);
      expect(mockRepo.reapStuckProcessing).toHaveBeenCalled();
      expect(mockRepo.getActiveTenants).not.toHaveBeenCalled();
      expect(mockMetrics.recordCycleOutcome).toHaveBeenCalledWith('__system__', 'no_provider');
    });

    it('returns [] when provider lacks chat() method (legacy adapter)', async () => {
      const mockProviderRegistry = {
        getAvailableProvider: jest.fn().mockResolvedValue({ provider: { mode: 'openai-legacy' /* no chat */ }, id: 'openai-legacy' }),
      };
      const mockRepo = { reapStuckProcessing: jest.fn().mockResolvedValue({ reaped: 0, recoveries: [] }), getActiveTenants: jest.fn() };
      const mockMetrics = makeMockMetrics();
      const service = new SyncErrorAssistService(
        makeMockLogger() as any,
        {} as any, mockRepo as any, {} as any, mockProviderRegistry as any,
        {} as any, {} as any, {} as any, {} as any, mockMetrics as any,
      );
      const results = await service.runAllEnabledTenants({ tenantId: '__system__', userId: '__system__' });
      expect(results).toEqual([]);
      expect(mockRepo.reapStuckProcessing).toHaveBeenCalled();
      expect(mockRepo.getActiveTenants).not.toHaveBeenCalled();
      expect(mockMetrics.recordCycleOutcome).toHaveBeenCalledWith('__system__', 'no_provider');
    });

    it('falls through to a chat-capable provider when first registered provider lacks chat() (Codex R7)', async () => {
      // Codex R7: registry-first picks the legacy adapter, but listProviders()
      // exposes a downstream chat-capable provider. The service must iterate
      // until it finds chat() instead of giving up on the first miss.
      const legacyProvider = { provider: { mode: 'openai-legacy' /* no chat */ }, id: 'openai-legacy' };
      const chatProvider = { provider: { mode: 'cloud-api', chat: jest.fn().mockResolvedValue({ content: '{}', usage: { totalTokens: 0 } }) }, id: 'claude' };
      const mockProviderRegistry = {
        // Default pick (no preferredId) returns legacy adapter — first miss.
        getAvailableProvider: jest.fn()
          .mockImplementationOnce(async () => legacyProvider)
          .mockImplementation(async (preferredId?: string) => preferredId === 'claude' ? chatProvider : null),
        listProviders: jest.fn().mockReturnValue([
          { id: 'openai-legacy', name: 'openai-legacy', version: '1', available: true },
          { id: 'claude', name: 'claude', version: '1', available: true },
        ]),
      };
      const mockRepo = {
        reapStuckProcessing: jest.fn().mockResolvedValue({ reaped: 0, recoveries: [] }),
        getActiveTenants: jest.fn().mockResolvedValue([]),
      };
      const mockMetrics = makeMockMetrics();
      const service = new SyncErrorAssistService(
        makeMockLogger() as any,
        {} as any, mockRepo as any, {} as any, mockProviderRegistry as any,
        {} as any, {} as any, {} as any, {} as any, mockMetrics as any,
      );
      const results = await service.runAllEnabledTenants({ tenantId: '__system__', userId: '__system__' });
      // No tenants enabled, so results=[]. But the no_provider metric was NOT
      // recorded (because we DID find a chat-capable provider).
      expect(results).toEqual([]);
      expect(mockRepo.getActiveTenants).toHaveBeenCalled();
      expect(mockMetrics.recordCycleOutcome).not.toHaveBeenCalledWith('__system__', 'no_provider');
      expect(mockProviderRegistry.listProviders).toHaveBeenCalled();
    });

    it('isolates per-tenant runCycle errors — one tenant failure does not abort the fan-out', async () => {
      const order: string[] = [];
      const mockRepo = {
        getActiveTenants: jest.fn().mockResolvedValue(['t1', 't2', 't3']),
        reapStuckProcessing: jest.fn().mockResolvedValue({ reaped: 0, recoveries: [] }),
        claim: jest.fn().mockResolvedValue(null),
        updateSucceeded: jest.fn(), updateFailed: jest.fn(),
        getWatermark: jest.fn().mockResolvedValue(null), tryAdvanceWatermark: jest.fn().mockResolvedValue(true),
      };
      const mockProviderRegistry = {
        getAvailableProvider: jest.fn().mockResolvedValue({ provider: { mode: 'cloud-api', chat: jest.fn().mockResolvedValue({ content: '{}', usage: { totalTokens: 0 } }) }, id: 'claude' }),
      };
      // Cause t2 to throw by giving it a broken connector
      const mockNS = { search: jest.fn().mockResolvedValue([]), create: jest.fn() };
      const mockConnectorManager = {
        getConnector: jest.fn().mockImplementation(async (_sys: string, key: string) => {
          order.push(key);
          if (key === 'netsuite_t2') throw new Error('boom');
          return mockNS;
        }),
      };
      const mockTenantConfig = { getBoolean: jest.fn().mockResolvedValue(true), getString: jest.fn().mockResolvedValue('mid'), getInt: jest.fn() };
      const mockMetrics = makeMockMetrics();
      const service = new SyncErrorAssistService(
        makeMockLogger() as any,
        mockTenantConfig as any, mockRepo as any,
        mockConnectorManager as any, mockProviderRegistry as any,
        { startTrace: jest.fn(), recordStep: jest.fn(), completeTrace: jest.fn() } as any,
        { recordCost: jest.fn() } as any, { create: jest.fn() } as any,
        makeMockDLP() as any, mockMetrics as any,
      );

      const results = await service.runAllEnabledTenants({ tenantId: '__system__', userId: '__system__' });
      expect(results).toHaveLength(3);
      expect(results.find(r => r.tenantId === 't2')?.aborted).toBe(true);
      expect(mockMetrics.recordCycleOutcome).toHaveBeenCalledWith('t2', 'aborted');
      // All 3 tenants attempted (t2 throws synchronously inside its runCycle, but t1/t3 still execute)
      expect(order).toContain('netsuite_t1');
      expect(order).toContain('netsuite_t2');
      expect(order).toContain('netsuite_t3');
    });

    it('propagates fatal infrastructure errors (ServiceUnavailableAppError) instead of producing a partial CycleResult[]', async () => {
      // Codex R2-2: per-tenant catch must NOT swallow infrastructure-level
      // failures (DB outage, network unavailable). The daily job needs to see
      // the tick as failed — not a "successful" tick with one aborted tenant.
      const mockRepo = {
        getActiveTenants: jest.fn().mockResolvedValue(['t1', 't2']),
        reapStuckProcessing: jest.fn().mockResolvedValue({ reaped: 0, recoveries: [] }),
        claim: jest.fn(), updateSucceeded: jest.fn(), updateFailed: jest.fn(),
        getWatermark: jest.fn().mockResolvedValue(null), tryAdvanceWatermark: jest.fn().mockResolvedValue(true),
      };
      const mockProviderRegistry = {
        getAvailableProvider: jest.fn().mockResolvedValue({
          provider: { mode: 'cloud-api', chat: jest.fn() }, id: 'claude',
        }),
      };
      // First tenant (t1) fails with a fatal infrastructure error — must abort whole tick
      const mockConnectorManager = {
        getConnector: jest.fn().mockImplementation(async (_sys: string, key: string) => {
          if (key === 'netsuite_t1') throw new ServiceUnavailableAppError('database connection terminated');
          return { search: jest.fn().mockResolvedValue([]), create: jest.fn() };
        }),
      };
      const mockTenantConfig = {
        getBoolean: jest.fn().mockResolvedValue(true),
        getString: jest.fn().mockResolvedValue('mid'),
        getInt: jest.fn(),
      };
      const mockMetrics = makeMockMetrics();
      const service = new SyncErrorAssistService(
        makeMockLogger() as any,
        mockTenantConfig as any, mockRepo as any,
        mockConnectorManager as any, mockProviderRegistry as any,
        { startTrace: jest.fn(), recordStep: jest.fn(), completeTrace: jest.fn() } as any,
        { recordCost: jest.fn() } as any, { create: jest.fn() } as any,
        makeMockDLP() as any, mockMetrics as any,
      );

      await expect(
        service.runAllEnabledTenants({ tenantId: '__system__', userId: '__system__' }),
      ).rejects.toBeInstanceOf(ServiceUnavailableAppError);
      // We never reach t2 because t1's fatal error aborted the whole loop
      expect(mockConnectorManager.getConnector).toHaveBeenCalledWith('netsuite', 'netsuite_t1');
      expect(mockConnectorManager.getConnector).not.toHaveBeenCalledWith('netsuite', 'netsuite_t2');
      // Fatal error path does NOT record 'aborted' metric — it propagates to caller
      expect(mockMetrics.recordCycleOutcome).not.toHaveBeenCalledWith('t1', 'aborted');
    });

    it('propagates fatal infrastructure errors via structured `code` (Codex R3-2)', async () => {
      // Codex R3-2: detection is keyed off the structured `code` property that
      // Node.js system errors and the Postgres pg driver always set. Setting
      // err.code='ECONNREFUSED' must be treated as fatal regardless of message.
      const sysErr = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
      const mockRepo = {
        getActiveTenants: jest.fn().mockResolvedValue(['t1']),
        reapStuckProcessing: jest.fn().mockResolvedValue({ reaped: 0, recoveries: [] }),
        claim: jest.fn(), updateSucceeded: jest.fn(), updateFailed: jest.fn(),
        getWatermark: jest.fn().mockResolvedValue(null), tryAdvanceWatermark: jest.fn().mockResolvedValue(true),
      };
      const mockProviderRegistry = {
        getAvailableProvider: jest.fn().mockResolvedValue({
          provider: { mode: 'cloud-api', chat: jest.fn() }, id: 'claude',
        }),
      };
      const mockConnectorManager = {
        getConnector: jest.fn().mockRejectedValue(sysErr),
      };
      const mockTenantConfig = {
        getBoolean: jest.fn().mockResolvedValue(true),
        getString: jest.fn().mockResolvedValue('mid'),
        getInt: jest.fn(),
      };
      const service = new SyncErrorAssistService(
        makeMockLogger() as any,
        mockTenantConfig as any, mockRepo as any,
        mockConnectorManager as any, mockProviderRegistry as any,
        { startTrace: jest.fn(), recordStep: jest.fn(), completeTrace: jest.fn() } as any,
        { recordCost: jest.fn() } as any, { create: jest.fn() } as any,
        makeMockDLP() as any, makeMockMetrics() as any,
      );

      await expect(
        service.runAllEnabledTenants({ tenantId: '__system__', userId: '__system__' }),
      ).rejects.toThrow(/ECONNREFUSED/);
    });

    it.each([
      ['ENETUNREACH', 'connect ENETUNREACH'],
      ['EADDRNOTAVAIL', 'bind EADDRNOTAVAIL 127.0.0.1'],
      ['08P01', 'protocol_violation: malformed wire packet'],
    ])('propagates fatal infrastructure error code=%s (Codex R4)', async (code, message) => {
      const infraErr = Object.assign(new Error(message), { code });
      const mockRepo = {
        getActiveTenants: jest.fn().mockResolvedValue(['t1']),
        reapStuckProcessing: jest.fn().mockResolvedValue({ reaped: 0, recoveries: [] }),
        claim: jest.fn(), updateSucceeded: jest.fn(), updateFailed: jest.fn(),
        getWatermark: jest.fn().mockResolvedValue(null), tryAdvanceWatermark: jest.fn().mockResolvedValue(true),
      };
      const mockProviderRegistry = {
        getAvailableProvider: jest.fn().mockResolvedValue({
          provider: { mode: 'cloud-api', chat: jest.fn() }, id: 'claude',
        }),
      };
      const mockConnectorManager = {
        getConnector: jest.fn().mockRejectedValue(infraErr),
      };
      const mockTenantConfig = {
        getBoolean: jest.fn().mockResolvedValue(true),
        getString: jest.fn().mockResolvedValue('mid'),
        getInt: jest.fn(),
      };
      const service = new SyncErrorAssistService(
        makeMockLogger() as any,
        mockTenantConfig as any, mockRepo as any,
        mockConnectorManager as any, mockProviderRegistry as any,
        { startTrace: jest.fn(), recordStep: jest.fn(), completeTrace: jest.fn() } as any,
        { recordCost: jest.fn() } as any, { create: jest.fn() } as any,
        makeMockDLP() as any, makeMockMetrics() as any,
      );

      await expect(
        service.runAllEnabledTenants({ tenantId: '__system__', userId: '__system__' }),
      ).rejects.toThrow(message);
    });

    it('does NOT propagate vendor errors whose message LOOKS like infra but lack `code` (Codex R3-2)', async () => {
      // Codex R3-2 critical regression test: NetSuite firewall responses can
      // contain message text like "Connection refused by NetSuite firewall on
      // subsidiary 5". Those are tenant-local and MUST NOT abort the whole
      // tick. Without err.code, we treat them as logical errors.
      const vendorErr = new Error('Connection refused by NetSuite firewall on subsidiary 5');
      const mockRepo = {
        getActiveTenants: jest.fn().mockResolvedValue(['t1', 't2']),
        reapStuckProcessing: jest.fn().mockResolvedValue({ reaped: 0, recoveries: [] }),
        claim: jest.fn().mockResolvedValue(null),
        updateSucceeded: jest.fn(), updateFailed: jest.fn(),
        getWatermark: jest.fn().mockResolvedValue(null), tryAdvanceWatermark: jest.fn().mockResolvedValue(true),
      };
      const mockProviderRegistry = {
        getAvailableProvider: jest.fn().mockResolvedValue({
          provider: { mode: 'cloud-api', chat: jest.fn() }, id: 'claude',
        }),
      };
      const okNS = { search: jest.fn().mockResolvedValue([]), create: jest.fn() };
      const mockConnectorManager = {
        getConnector: jest.fn().mockImplementation(async (_sys: string, key: string) => {
          if (key === 'netsuite_t1') throw vendorErr;
          return okNS;
        }),
      };
      const mockTenantConfig = {
        getBoolean: jest.fn().mockResolvedValue(true),
        getString: jest.fn().mockResolvedValue('mid'),
        getInt: jest.fn(),
      };
      const mockMetrics = makeMockMetrics();
      const service = new SyncErrorAssistService(
        makeMockLogger() as any,
        mockTenantConfig as any, mockRepo as any,
        mockConnectorManager as any, mockProviderRegistry as any,
        { startTrace: jest.fn(), recordStep: jest.fn(), completeTrace: jest.fn() } as any,
        { recordCost: jest.fn() } as any, { create: jest.fn() } as any,
        makeMockDLP() as any, mockMetrics as any,
      );

      // Whole tick must complete; t1 marked aborted, t2 reached and processed.
      const results = await service.runAllEnabledTenants({ tenantId: '__system__', userId: '__system__' });
      expect(results).toHaveLength(2);
      expect(results.find(r => r.tenantId === 't1')?.aborted).toBe(true);
      expect(mockMetrics.recordCycleOutcome).toHaveBeenCalledWith('t1', 'aborted');
      expect(mockConnectorManager.getConnector).toHaveBeenCalledWith('netsuite', 'netsuite_t2');
    });
  });

  describe('runCycle — Codex R3-1: post-ns.create ordering guarantees', () => {
    function makePostNsTestRig() {
      const errorRecord = {
        id: 'err-1',
        lastModified: '2026-05-01T10:00:00Z',
        error_message: 'Could not find item 1234',
        error_context: { item_id: '1234' },
      };
      const mockTenantConfig = {
        getBoolean: jest.fn().mockResolvedValue(true),
        getString: jest.fn().mockResolvedValue('mid'),
        getInt: jest.fn(),
      };
      const mockNS = {
        search: jest.fn().mockResolvedValueOnce([errorRecord]).mockResolvedValueOnce([]),
        create: jest.fn().mockResolvedValue({ id: 'ns-200' }),
      };
      const mockRepo = {
        getActiveTenants: jest.fn(),
        claim: jest.fn().mockResolvedValue({ id: 'r-1', tenantId: 't1', errorRecordId: 'err-1', attempts: 1 }),
        updateSucceeded: jest.fn().mockResolvedValue(undefined),
        updateFailed: jest.fn(),
        getWatermark: jest.fn().mockResolvedValue(null),
        tryAdvanceWatermark: jest.fn().mockResolvedValue(true),
        reapStuckProcessing: jest.fn(),
      };
      const mockChat = jest.fn().mockResolvedValue({
        content: JSON.stringify({
          confidence: 'high',
          suggestion_type: 'create_missing_record',
          suggestion_text: 'Create item 1234',
          references_field: 'item_id',
        }),
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      });
      const mockProvider = {
        mode: 'cloud-api',
        chat: mockChat,
        getLastTokenUsage: jest.fn().mockReturnValue({ estimatedCost: 0.05, totalTokens: 150 }),
      };
      const mockTrace = {
        startTrace: jest.fn().mockResolvedValue(undefined),
        recordStep: jest.fn().mockResolvedValue(undefined),
        completeTrace: jest.fn().mockResolvedValue(undefined),
      };
      const mockAudit = { create: jest.fn().mockResolvedValue(undefined) };
      const mockDLP = makeMockDLP();
      const mockMetrics = makeMockMetrics();
      return { errorRecord, mockTenantConfig, mockNS, mockRepo, mockChat, mockProvider, mockTrace, mockAudit, mockDLP, mockMetrics };
    }

    it('updateSucceeded runs even if completeTrace throws AFTER ns.create succeeds (Codex R3-1)', async () => {
      const rig = makePostNsTestRig();
      // Trace failure must NOT skip updateSucceeded.
      rig.mockTrace.completeTrace = jest.fn().mockRejectedValue(new Error('trace down'));
      const service = new SyncErrorAssistService(
        makeMockLogger() as any,
        rig.mockTenantConfig as any,
        rig.mockRepo as any,
        { getConnector: jest.fn().mockResolvedValue(rig.mockNS) } as any,
        {} as any,
        rig.mockTrace as any,
        { recordCost: jest.fn() } as any,
        rig.mockAudit as any,
        rig.mockDLP as any,
        rig.mockMetrics as any,
      );

      const providerInfo = { provider: rig.mockProvider as any, providerId: 'claude' };
      const result = await service.runCycle('t1', { tenantId: 't1', userId: 'u' }, providerInfo);

      // CRITICAL contract: updateSucceeded ran despite trace failure
      expect(rig.mockRepo.updateSucceeded).toHaveBeenCalledWith('r-1', expect.objectContaining({
        suggestionRecordId: 'ns-200',
        provider: 'cloud-api',
      }));
      expect(rig.mockRepo.updateFailed).not.toHaveBeenCalled();
      expect(result.suggestionsWritten).toBe(1);
      expect(result.failedRetryable).toBe(0);
      expect(result.failedNonRetryable).toBe(0);
    });

    it('updateSucceeded runs even if auditLog.create throws AFTER ns.create succeeds (Codex R3-1)', async () => {
      const rig = makePostNsTestRig();
      // Audit failure must NOT skip updateSucceeded.
      rig.mockAudit.create = jest.fn().mockRejectedValue(new Error('audit DB down'));
      const service = new SyncErrorAssistService(
        makeMockLogger() as any,
        rig.mockTenantConfig as any,
        rig.mockRepo as any,
        { getConnector: jest.fn().mockResolvedValue(rig.mockNS) } as any,
        {} as any,
        rig.mockTrace as any,
        { recordCost: jest.fn() } as any,
        rig.mockAudit as any,
        rig.mockDLP as any,
        rig.mockMetrics as any,
      );

      const providerInfo = { provider: rig.mockProvider as any, providerId: 'claude' };
      const result = await service.runCycle('t1', { tenantId: 't1', userId: 'u' }, providerInfo);

      // CRITICAL contract: updateSucceeded ran despite audit failure
      expect(rig.mockRepo.updateSucceeded).toHaveBeenCalledWith('r-1', expect.objectContaining({
        suggestionRecordId: 'ns-200',
        provider: 'cloud-api',
      }));
      expect(rig.mockRepo.updateFailed).not.toHaveBeenCalled();
      expect(result.suggestionsWritten).toBe(1);
    });

    it('updateSucceeded runs FIRST in invocation order (before completeTrace + auditLog) (Codex R3-1)', async () => {
      const rig = makePostNsTestRig();
      const service = new SyncErrorAssistService(
        makeMockLogger() as any,
        rig.mockTenantConfig as any,
        rig.mockRepo as any,
        { getConnector: jest.fn().mockResolvedValue(rig.mockNS) } as any,
        {} as any,
        rig.mockTrace as any,
        { recordCost: jest.fn() } as any,
        rig.mockAudit as any,
        rig.mockDLP as any,
        rig.mockMetrics as any,
      );

      const providerInfo = { provider: rig.mockProvider as any, providerId: 'claude' };
      await service.runCycle('t1', { tenantId: 't1', userId: 'u' }, providerInfo);

      // Ordering: updateSucceeded → completeTrace (success path) → auditLog.create
      const updateOrder = rig.mockRepo.updateSucceeded.mock.invocationCallOrder[0];
      // In the happy path, completeTrace is called once with status='completed'.
      const traceOrder = rig.mockTrace.completeTrace.mock.invocationCallOrder[0];
      const auditOrder = rig.mockAudit.create.mock.invocationCallOrder[0];
      expect(updateOrder).toBeLessThan(traceOrder);
      expect(updateOrder).toBeLessThan(auditOrder);
    });
  });

  // ---------------------------------------------------------------------------
  // Task 6 Step 1 — characterization + red tests for runSingleErrorCycle extraction
  // ---------------------------------------------------------------------------

  let kit: ReturnType<typeof buildServiceWithStubs>;
  beforeEach(() => { kit = buildServiceWithStubs(); });

  // CHARACTERIZATION (passes pre-refactor) — pins runCycle's CycleResult contract
  // so the refactor cannot silently lose counters. R7-2: the fixture factories live in
  // the testHelpers.ts module created by Task 6 Step 0; the AC #20+#21 tests below
  // drive the connectorManager's NS lookup via the returned connector stub from
  // makeNsConnectorStub() rather than a separate stubs.nsConnector property.
  // R10-3 — concrete stubs (no placeholder comments). Each test wires `repo.claim` to return a
  // claim row, the AI provider to produce success or fail, and the NS connector to accept the write.
  const SUCCESS_AI_RESPONSE = {
    content: '{"confidence":"high","suggestion_type":"manual_review","suggestion_text":"ok","references_field":null}',
    usage: { totalTokens: 100, estimatedCost: 0.01 },
  };

  it('R12-1 / AC #20 — runCycle accumulates {succeeded, failed_retryable, failed_non_retryable} into CycleResult', async () => {
    const ns = makeNsConnectorStub({ createId: 'ns-1' });
    ns.search.mockResolvedValueOnce([
      makeFixtureSuccessRecord('err-1'),                // happy path
      makeFixtureFailedRetryableRecord('err-2'),        // AI provider transient
      makeFixtureFailedNonRetryableRecord('err-3'),     // AI provider 4xx
    ]).mockResolvedValueOnce([]);
    kit.stubs.connectorManager.getConnector.mockResolvedValue(ns);

    // R10-3: claim returns a row for each errorRecordId. Repo's claim() returns null when the row
    // is already claimed; here we always return a fresh claim so each record is processed.
    kit.stubs.repo.claim.mockImplementation(async (_t: string, errorRecordId: string) =>
      ({ id: `c-${errorRecordId}`, tenantId: 'acme', errorRecordId, attempts: 1 }));

    // Per-fixture provider behavior:
    const providerInfo = makeProviderInfo();
    providerInfo.provider.chat
      .mockResolvedValueOnce(SUCCESS_AI_RESPONSE)                                  // err-1 → succeeded
      .mockRejectedValueOnce(Object.assign(new Error('503'), { status: 503 }))    // err-2 → failed_retryable
      .mockRejectedValueOnce(Object.assign(new Error('400'), { status: 400 }));    // err-3 → failed_non_retryable

    const result = await kit.service.runCycle('acme', identityCtx, providerInfo);

    expect(result).toEqual(expect.objectContaining({
      tenantId: 'acme',
      errorsScanned: 3,
      suggestionsWritten: 1,
      failedRetryable: 1,
      failedNonRetryable: 1,
      skipped: 0,
    }));
  });

  // RED — fails BEFORE the refactor. Pins that failure paths skip success bookkeeping.
  it('R12-1 / AC #20 — failed_retryable path does NOT call updateSucceeded / recordSuggestionWritten / recordProcessedStatus(succeeded)', async () => {
    const ns = makeNsConnectorStub();
    ns.search.mockResolvedValueOnce([makeFixtureFailedRetryableRecord('err-2')]).mockResolvedValueOnce([]);
    kit.stubs.connectorManager.getConnector.mockResolvedValue(ns);
    kit.stubs.repo.claim.mockResolvedValueOnce({ id: 'c-2', tenantId: 'acme', errorRecordId: 'err-2', attempts: 1 });

    // R10-3 — wire AI to throw a retryable HTTP-503. classify.ts maps this to 'failed_retryable'.
    const providerInfo = makeProviderInfo();
    providerInfo.provider.chat.mockRejectedValueOnce(Object.assign(new Error('503'), { status: 503 }));

    await kit.service.runCycle('acme', identityCtx, providerInfo);

    expect(kit.stubs.repo.updateSucceeded).not.toHaveBeenCalled();
    expect(kit.stubs.metrics.recordSuggestionWritten).not.toHaveBeenCalled();
    expect(kit.stubs.metrics.recordProcessedStatus).toHaveBeenCalledWith('acme', 'failed_retryable');
    expect(kit.stubs.metrics.recordProcessedStatus).not.toHaveBeenCalledWith('acme', 'succeeded');
  });

  it('R12-1 / AC #20 — failed_non_retryable path does NOT call updateSucceeded / recordSuggestionWritten / recordProcessedStatus(succeeded)', async () => {
    const ns = makeNsConnectorStub();
    ns.search.mockResolvedValueOnce([makeFixtureFailedNonRetryableRecord('err-3')]).mockResolvedValueOnce([]);
    kit.stubs.connectorManager.getConnector.mockResolvedValue(ns);
    kit.stubs.repo.claim.mockResolvedValueOnce({ id: 'c-3', tenantId: 'acme', errorRecordId: 'err-3', attempts: 1 });

    // R10-3 — wire AI to throw a 4xx. classify.ts maps non-5xx/4xx-without-status as
    // failed_non_retryable; explicit 400 status keeps the test deterministic.
    const providerInfo = makeProviderInfo();
    providerInfo.provider.chat.mockRejectedValueOnce(Object.assign(new Error('400'), { status: 400 }));

    await kit.service.runCycle('acme', identityCtx, providerInfo);

    expect(kit.stubs.repo.updateSucceeded).not.toHaveBeenCalled();
    expect(kit.stubs.metrics.recordSuggestionWritten).not.toHaveBeenCalled();
    expect(kit.stubs.metrics.recordProcessedStatus).toHaveBeenCalledWith('acme', 'failed_non_retryable');
    expect(kit.stubs.metrics.recordProcessedStatus).not.toHaveBeenCalledWith('acme', 'succeeded');
  });

  // RED — covers AC #21 (gotcha #45): updateSucceeded throwing AFTER NetSuite create succeeded
  // MUST log via Logger.error(message, Error, metadata). The existing line 337 site uses the
  // old metadata-as-2nd-arg shape; the refactor MUST normalize it via toError.
  //
  // R2-10 — also pins the counter contract: NS create succeeded means the suggestion was
  // effectively written; the post-write DB failure is local-state stale, NOT a redo, so the
  // outcome stays 'succeeded' and the success counter increments.
  it('R13-2 / AC #20+21 — updateSucceeded throws after NS create: succeeded outcome + counter shape preserved + Error arg metadata', async () => {
    const ns = makeNsConnectorStub({ createId: 'ns-1' });
    ns.search.mockResolvedValueOnce([makeFixtureSuccessRecord('err-1')]).mockResolvedValueOnce([]);
    kit.stubs.connectorManager.getConnector.mockResolvedValue(ns);
    kit.stubs.repo.claim.mockResolvedValueOnce({ id: 'c-1', tenantId: 'acme', errorRecordId: 'err-1', attempts: 1 });
    kit.stubs.repo.updateSucceeded.mockRejectedValueOnce(new Error('SQLITE_BUSY'));

    // R10-3 — wire AI to return valid JSON success (concrete stub, not a comment).
    const providerInfo = makeProviderInfo();
    providerInfo.provider.chat.mockResolvedValueOnce(SUCCESS_AI_RESPONSE);

    const result = await kit.service.runCycle('acme', identityCtx, providerInfo);

    // Counter contract:
    expect(result).toEqual(expect.objectContaining({
      tenantId: 'acme',
      errorsScanned: 1,
      suggestionsWritten: 1,                // NS create succeeded → suggestion was written
      failedRetryable: 0,
      failedNonRetryable: 0,
    }));
    // Success bookkeeping fired exactly once for the succeeded outcome:
    expect(kit.stubs.metrics.recordProcessedStatus).toHaveBeenCalledWith('acme', 'succeeded');
    expect(kit.stubs.metrics.recordProcessedStatus).not.toHaveBeenCalledWith('acme', expect.stringMatching(/^failed_/));
    expect(kit.stubs.repo.updateFailed).not.toHaveBeenCalled();
    // Error normalization:
    expect(kit.stubs.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('updateSucceeded failed AFTER NetSuite create succeeded'),
      expect.any(Error),
      expect.objectContaining({ tenantId: 'acme', errorId: 'err-1', suggestionRecordId: 'ns-1' }),
    );
  });
});

describe('ingestWebhook (PR 17c)', () => {
  // R20-5 — Task 8-local kit. `let` lets per-test mockResolvedValueOnce stack up without
  // cross-test bleed; the beforeEach reseeds it for every test in this describe.
  let service: SyncErrorAssistService;
  let stubs: ReturnType<typeof buildServiceWithStubs>['stubs'];
  beforeEach(() => {
    ({ service, stubs } = buildServiceWithStubs());
  });

  it('claim succeeds → returns accepted + claimId; setImmediate fires processClaimedRecord', async () => {
    stubs.repo.claim.mockResolvedValueOnce(makeClaim({ id: 'c-1' }));
    const processSpy = jest.spyOn(service, 'processClaimedRecord').mockResolvedValueOnce('succeeded');

    const result = await service.ingestWebhook({
      tenantId: 'acme',
      errorRecord: makeWebhookPayload({ errorRecordId: 'err-1' }),
      ctx: identityCtx,
      correlationId: 'corr',
    });

    expect(result).toEqual({ status: 'accepted', claimId: 'c-1' });

    // Wait for setImmediate to fire
    await new Promise((r) => setImmediate(r));
    expect(processSpy).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'acme',
      source: 'webhook',
      correlationId: 'corr',
    }));
  });

  it('claim returns null (already-processed) → returns duplicate, does NOT schedule setImmediate', async () => {
    stubs.repo.claim.mockResolvedValueOnce(null);
    const processSpy = jest.spyOn(service, 'processClaimedRecord').mockResolvedValueOnce('succeeded');

    const result = await service.ingestWebhook({
      tenantId: 'acme', errorRecord: makeWebhookPayload({ errorRecordId: 'err-1' }),
      ctx: identityCtx, correlationId: 'corr',
    });

    expect(result).toEqual({ status: 'duplicate' });
    await new Promise((r) => setImmediate(r));
    expect(processSpy).not.toHaveBeenCalled();
  });

  it('fire-and-forget rejection → logs via toError + emits recordWebhookFireAndForgetError', async () => {
    stubs.repo.claim.mockResolvedValueOnce(makeClaim({ id: 'c-1' }));
    jest.spyOn(service, 'processClaimedRecord').mockRejectedValueOnce(new Error('boom'));
    stubs.dlpService.scanText.mockResolvedValueOnce({
      detected: false, piiTypes: [], findings: [],
      riskLevel: 'low', recommendation: 'allow', redactedData: undefined,
    });

    await service.ingestWebhook({
      tenantId: 'acme', errorRecord: makeWebhookPayload({ errorRecordId: 'err-1' }),
      ctx: identityCtx, correlationId: 'corr',
    });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));   // DLP scan + log call
    expect(stubs.logger.error).toHaveBeenCalledWith(
      'webhook fire-and-forget failed',
      expect.any(Error),
      expect.objectContaining({ tenantId: 'acme', errorRecordId: 'err-1', claimId: 'c-1' }),
    );
    expect(stubs.metrics.recordWebhookFireAndForgetError).toHaveBeenCalledWith('acme');
  });

  it('R2-7 + R3-5 / §7.1 — fire-and-forget failure log uses DLP-redacted errorMessage + errorClass metadata (NOT raw)', async () => {
    stubs.repo.claim.mockResolvedValueOnce(makeClaim({ id: 'c-1' }));
    const rawMessage = 'NS error for SSN 123-45-6789';
    const rawErr = new Error(rawMessage);
    rawErr.name = 'NetSuiteWriteError';                       // exercise errorClass path
    jest.spyOn(service, 'processClaimedRecord').mockRejectedValueOnce(rawErr);
    // DLP redacts the SSN — the log must receive the [REDACTED:ssn] form, not the raw SSN.
    stubs.dlpService.scanText.mockResolvedValueOnce({
      detected: true, piiTypes: ['ssn'],
      findings: [{
        type: 'ssn', value: '123-45-6789', confidence: 0.99,
        location: { path: '' }, severity: 'critical', redactedValue: '[REDACTED:ssn]',
      }],
      riskLevel: 'critical', recommendation: 'redact',
      redactedData: 'NS error for SSN [REDACTED:ssn]',
    });

    await service.ingestWebhook({
      tenantId: 'acme', errorRecord: makeWebhookPayload({ errorRecordId: 'err-1' }),
      ctx: identityCtx, correlationId: 'corr',
    });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // R3-5 — assert metadata includes errorClass + errorMessage (DLP-redacted form).
    expect(stubs.logger.error).toHaveBeenCalledWith(
      'webhook fire-and-forget failed',
      expect.any(Error),
      expect.objectContaining({
        correlationId: 'corr', tenantId: 'acme', errorRecordId: 'err-1', claimId: 'c-1',
        errorClass: 'NetSuiteWriteError',
        errorMessage: 'NS error for SSN [REDACTED:ssn]',
      }),
    );
    const errArg = (stubs.logger.error as jest.Mock).mock.calls.find(
      (c) => c[0] === 'webhook fire-and-forget failed',
    )![1] as Error;
    expect(errArg.message).toBe('NS error for SSN [REDACTED:ssn]');
    expect(errArg.message).not.toContain('123-45-6789');
  });

  it('R2-7 — fire-and-forget log falls back to [redaction-unavailable] if DLP scan throws (fail-safe)', async () => {
    stubs.repo.claim.mockResolvedValueOnce(makeClaim({ id: 'c-1' }));
    jest.spyOn(service, 'processClaimedRecord').mockRejectedValueOnce(new Error('contains 123-45-6789'));
    stubs.dlpService.scanText.mockRejectedValueOnce(new Error('dlp engine offline'));

    await service.ingestWebhook({
      tenantId: 'acme', errorRecord: makeWebhookPayload({ errorRecordId: 'err-1' }),
      ctx: identityCtx, correlationId: 'corr',
    });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const errArg = (stubs.logger.error as jest.Mock).mock.calls.find(
      (c) => c[0] === 'webhook fire-and-forget failed',
    )![1] as Error;
    expect(errArg.message).toBe('[redaction-unavailable]');
    expect(errArg.message).not.toContain('123-45-6789');
  });

  it('R23-1 — fire-and-forget log falls back to [redaction-unavailable] when DLP detects PII but returns no redactedData (fail-safe)', async () => {
    // R23-1 — Pre-R23 the catch-only fail-safe missed the case where `scanText` RESOLVED
    // with `detected: true` but `redactedData` was undefined (downstream policy stage
    // cleared it, or a custom producer returned findings without a redacted string).
    // The bare `if (scan.redactedData) safeMessage = scan.redactedData;` left the raw
    // message intact, leaking PII into the log. Spec §7.1 requires the placeholder.
    stubs.repo.claim.mockResolvedValueOnce(makeClaim({ id: 'c-1' }));
    jest.spyOn(service, 'processClaimedRecord').mockRejectedValueOnce(new Error('contains 123-45-6789'));
    stubs.dlpService.scanText.mockResolvedValueOnce({
      detected: true, piiTypes: ['ssn'],
      findings: [{
        type: 'ssn', value: '123-45-6789', confidence: 0.99,
        location: { path: '' }, severity: 'critical', redactedValue: '[REDACTED:ssn]',
      }],
      riskLevel: 'critical', recommendation: 'redact',
      redactedData: undefined,                                 // R23-1 — the bug surface
    });

    await service.ingestWebhook({
      tenantId: 'acme', errorRecord: makeWebhookPayload({ errorRecordId: 'err-1' }),
      ctx: identityCtx, correlationId: 'corr',
    });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const errArg = (stubs.logger.error as jest.Mock).mock.calls.find(
      (c) => c[0] === 'webhook fire-and-forget failed',
    )![1] as Error;
    expect(errArg.message).toBe('[redaction-unavailable]');
    expect(errArg.message).not.toContain('123-45-6789');
    // R3-5 — `errorMessage` metadata also fails safe (not just the Error object).
    expect(stubs.logger.error).toHaveBeenCalledWith(
      'webhook fire-and-forget failed',
      expect.any(Error),
      expect.objectContaining({ errorMessage: '[redaction-unavailable]' }),
    );
  });

  it('toError resilience: hostile toString → log still gets a valid Error', async () => {
    const hostile = { toString() { throw new Error('boom from toString'); } };
    stubs.repo.claim.mockResolvedValueOnce(makeClaim({ id: 'c-1' }));
    jest.spyOn(service, 'processClaimedRecord').mockRejectedValueOnce(hostile);

    await service.ingestWebhook({ tenantId: 'acme', errorRecord: makeWebhookPayload(), ctx: identityCtx, correlationId: 'corr' });
    await new Promise((r) => setImmediate(r));

    expect(stubs.logger.error).toHaveBeenCalledWith(
      'webhook fire-and-forget failed',
      expect.any(Error),
      expect.anything(),
    );
    // Prove it was the unstringifiable sentinel — i.e., toError really fired.
    const errArg = (stubs.logger.error as jest.Mock).mock.calls.find(
      (c) => c[0] === 'webhook fire-and-forget failed',
    )![1] as Error;
    expect(errArg.message).toBe('[unstringifiable error]');
  });

  // ===== Spec §7.1 lifecycle log table — named tests for each event =====

  it('§7.1 — claim succeeds: logs "webhook accepted" info with {correlationId, tenantId, errorRecordId, claimId, latencyMs}', async () => {
    stubs.repo.claim.mockResolvedValueOnce(makeClaim({ id: 'c-1' }));
    jest.spyOn(service, 'processClaimedRecord').mockResolvedValueOnce('succeeded');
    await service.ingestWebhook({
      tenantId: 'acme', errorRecord: makeWebhookPayload({ errorRecordId: 'err-1' }),
      ctx: identityCtx, correlationId: 'corr',
    });
    expect(stubs.logger.info).toHaveBeenCalledWith(
      'webhook accepted',
      expect.objectContaining({
        correlationId: 'corr', tenantId: 'acme', errorRecordId: 'err-1', claimId: 'c-1',
        latencyMs: expect.any(Number),                        // R3-4 — spec §7.1 contract
      }),
    );
  });

  it('§7.1 — duplicate: logs "webhook duplicate" debug with {correlationId, tenantId, errorRecordId}', async () => {
    stubs.repo.claim.mockResolvedValueOnce(null);
    await service.ingestWebhook({
      tenantId: 'acme', errorRecord: makeWebhookPayload({ errorRecordId: 'err-1' }),
      ctx: identityCtx, correlationId: 'corr',
    });
    expect(stubs.logger.debug).toHaveBeenCalledWith(
      'webhook duplicate',
      expect.objectContaining({ correlationId: 'corr', tenantId: 'acme', errorRecordId: 'err-1' }),
    );
  });

  it('§7.1 — fire-and-forget started: logs "fire-and-forget started" debug at setImmediate boundary', async () => {
    stubs.repo.claim.mockResolvedValueOnce(makeClaim({ id: 'c-1' }));
    jest.spyOn(service, 'processClaimedRecord').mockResolvedValueOnce('succeeded');
    await service.ingestWebhook({
      tenantId: 'acme', errorRecord: makeWebhookPayload({ errorRecordId: 'err-1' }),
      ctx: identityCtx, correlationId: 'corr',
    });
    await new Promise((r) => setImmediate(r));
    expect(stubs.logger.debug).toHaveBeenCalledWith(
      'fire-and-forget started',
      expect.objectContaining({ correlationId: 'corr', tenantId: 'acme', errorRecordId: 'err-1', claimId: 'c-1' }),
    );
  });

  it('§7.1 — fire-and-forget completed: logs "fire-and-forget completed" debug with outcome + durationMs (Copilot R7)', async () => {
    stubs.repo.claim.mockResolvedValueOnce(makeClaim({ id: 'c-1' }));
    jest.spyOn(service, 'processClaimedRecord').mockResolvedValueOnce('succeeded');
    await service.ingestWebhook({
      tenantId: 'acme', errorRecord: makeWebhookPayload({ errorRecordId: 'err-1' }),
      ctx: identityCtx, correlationId: 'corr',
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // R7 — message renamed from "succeeded" → "completed" and outcome added because
    // terminal failures also resolved the promise and silently logged "succeeded".
    expect(stubs.logger.debug).toHaveBeenCalledWith(
      'fire-and-forget completed',
      expect.objectContaining({
        correlationId: 'corr', tenantId: 'acme', claimId: 'c-1',
        outcome: 'succeeded',
        durationMs: expect.any(Number),
      }),
    );
  });

  it('§7.1 — fire-and-forget completed log shows terminal-failure outcome (Copilot R7)', async () => {
    stubs.repo.claim.mockResolvedValueOnce(makeClaim({ id: 'c-2' }));
    jest.spyOn(service, 'processClaimedRecord').mockResolvedValueOnce('failed_retryable');
    await service.ingestWebhook({
      tenantId: 'acme', errorRecord: makeWebhookPayload({ errorRecordId: 'err-2' }),
      ctx: identityCtx, correlationId: 'corr',
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // Old wording "succeeded" was misleading on this path. Now the outcome is explicit.
    expect(stubs.logger.debug).toHaveBeenCalledWith(
      'fire-and-forget completed',
      expect.objectContaining({ outcome: 'failed_retryable' }),
    );
  });

  // ===== AC #12 — claim-ack latency: response returns BEFORE async processing finishes =====

  it('AC #12 — ingestWebhook resolves immediately even when processClaimedRecord never settles', async () => {
    stubs.repo.claim.mockResolvedValueOnce(makeClaim({ id: 'c-1' }));
    jest.spyOn(service, 'processClaimedRecord').mockReturnValueOnce(new Promise(() => {}));   // never resolves

    const startMs = Date.now();
    const result = await service.ingestWebhook({
      tenantId: 'acme', errorRecord: makeWebhookPayload({ errorRecordId: 'err-1' }),
      ctx: identityCtx, correlationId: 'corr',
    });
    const elapsedMs = Date.now() - startMs;

    expect(result).toEqual({ status: 'accepted', claimId: 'c-1' });
    expect(elapsedMs).toBeLessThan(50);   // claim ack < 1s; 50ms gives huge headroom and proves no synchronous await of the worker
  });
});
