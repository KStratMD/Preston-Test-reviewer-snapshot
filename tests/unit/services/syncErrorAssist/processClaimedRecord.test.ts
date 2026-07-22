// PR-C3.1a R3 (Copilot) — `reflect-metadata` must load before any
// Inversify-decorated module evaluates. `SyncErrorAssistService` is
// decorated and `testHelpers` (which side-effect-imports reflect-metadata)
// would otherwise load AFTER it here — fragile, fix at the source.
import 'reflect-metadata';
// Fix B / Defect 2 — SyncErrorAssistService calls `buildNetSuiteEnvAuthConfig()`
// immediately after every `ConnectorManager.getConnector()` resolution, then
// passes the result to `connector.initialize(...)`. This test environment has
// no real NETSUITE_* env credentials configured, so mock the helper to a stable
// fixture AuthConfig.
jest.mock('../../../../src/services/syncErrorAssist/netsuiteEnvAuth', () => {
  const FIXTURE_AUTH_CONFIG = {
    type: 'oauth1',
    credentials: {
      accountId: 'test-ns-account',
      consumerKey: 'test-ns-consumer-key',
      consumerSecret: 'test-ns-consumer-secret',
      tokenId: 'test-ns-token-id',
      tokenSecret: 'test-ns-token-secret',
    },
  };
  return {
    buildNetSuiteEnvAuthConfig: jest.fn().mockReturnValue(FIXTURE_AUTH_CONFIG),
    // Codex P1 — call sites now go through the tenant-checked variant.
    buildNetSuiteEnvAuthConfigForTenant: jest.fn().mockResolvedValue(FIXTURE_AUTH_CONFIG),
    NetSuiteEnvCredentialsMissingError: class NetSuiteEnvCredentialsMissingError extends Error {},
    NetSuiteTenantAccountMismatchError: class NetSuiteTenantAccountMismatchError extends Error {},
  };
});
import { SyncErrorAssistService } from '../../../../src/services/syncErrorAssist/SyncErrorAssistService';
import { buildServiceWithStubs, identityCtx, makeClaim, makeProviderRegistryResult,
         makeNsConnectorStub, makeWebhookPayload }
  from './testHelpers';

describe('processClaimedRecord (PR 17c outcome contract — gotcha #41)', () => {
  let service: SyncErrorAssistService;
  let stubs: ReturnType<typeof buildServiceWithStubs>['stubs'];

  beforeEach(() => {
    ({ service, stubs } = buildServiceWithStubs());
    stubs.dlpService.scanForPII.mockResolvedValue({
      detected: false, piiTypes: [], findings: [],
      riskLevel: 'low', recommendation: 'allow', redactedData: undefined, scanFailed: false,
    });
  });

  it('R12-1 — no chat-capable provider: returns failed_retryable, calls updateFailed(claim.id, "failed_retryable", "no_provider")', async () => {
    stubs.providerRegistry.getAvailableProvider.mockResolvedValueOnce(null);
    const claim = makeClaim({ id: 'c-1', tenantId: 'acme' });

    const outcome = await service.processClaimedRecord({
      claim, tenantId: 'acme', errorRecord: makeWebhookPayload(),
      ctx: identityCtx, correlationId: 'corr', source: 'webhook',
    });

    expect(outcome).toBe('failed_retryable');
    expect(stubs.repo.updateFailed).toHaveBeenCalledWith('c-1', 'failed_retryable', 'no_provider');
    // Copilot R3 — early-return branches must also emit processed_status so
    // failed_retryable counts include pre-runSingleErrorCycle failures.
    expect(stubs.metrics.recordProcessedStatus).toHaveBeenCalledWith('acme', 'failed_retryable');
  });

  it('R12-1 — NS connector throws: returns failed_retryable, calls updateFailed(claim.id, "failed_retryable", "connector_unavailable")', async () => {
    stubs.providerRegistry.getAvailableProvider.mockResolvedValueOnce(makeProviderRegistryResult());
    stubs.connectorManager.getConnector.mockRejectedValueOnce(new Error('no NS connector'));

    const outcome = await service.processClaimedRecord({
      claim: makeClaim({ id: 'c-2', tenantId: 'acme' }), tenantId: 'acme',
      errorRecord: makeWebhookPayload(), ctx: identityCtx,
      correlationId: 'corr', source: 'webhook',
    });

    expect(outcome).toBe('failed_retryable');
    expect(stubs.repo.updateFailed).toHaveBeenCalledWith('c-2', 'failed_retryable', 'connector_unavailable');
    // Copilot R3 — early-return branches must also emit processed_status so
    // failed_retryable counts include pre-runSingleErrorCycle failures.
    expect(stubs.metrics.recordProcessedStatus).toHaveBeenCalledWith('acme', 'failed_retryable');
  });

  it('Fix B / Defect 2 — missing NetSuite env credentials: initialize() throws NetSuiteEnvCredentialsMissingError, ' +
     'degrades to the SAME outcome as a getConnector throw (failed_retryable / connector_unavailable)', async () => {
    // The env credentials are read inside buildNetSuiteEnvAuthConfigForTenant
    // (the tenant-checked variant call sites use since Codex P1, PR #966), so
    // the missing-env throw surfaces from there.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildNetSuiteEnvAuthConfigForTenant, NetSuiteEnvCredentialsMissingError } =
      require('../../../../src/services/syncErrorAssist/netsuiteEnvAuth') as {
        buildNetSuiteEnvAuthConfigForTenant: jest.Mock;
        NetSuiteEnvCredentialsMissingError: new (missingKeys: string[]) => Error;
      };
    stubs.providerRegistry.getAvailableProvider.mockResolvedValueOnce(makeProviderRegistryResult());
    stubs.connectorManager.getConnector.mockResolvedValueOnce(makeNsConnectorStub());
    buildNetSuiteEnvAuthConfigForTenant.mockRejectedValueOnce(
      new NetSuiteEnvCredentialsMissingError(['accountId', 'consumerKey', 'consumerSecret', 'tokenId', 'tokenSecret']),
    );

    const outcome = await service.processClaimedRecord({
      claim: makeClaim({ id: 'c-noenv', tenantId: 'acme' }), tenantId: 'acme',
      errorRecord: makeWebhookPayload(), ctx: identityCtx,
      correlationId: 'corr', source: 'webhook',
    });

    expect(outcome).toBe('failed_retryable');
    expect(stubs.repo.updateFailed).toHaveBeenCalledWith('c-noenv', 'failed_retryable', 'connector_unavailable');
    expect(stubs.metrics.recordProcessedStatus).toHaveBeenCalledWith('acme', 'failed_retryable');
  });

  it('Codex P1 (PR #966) — tenant-account guard mismatch: degrades to failed_retryable / ' +
     'connector_unavailable, same as any other connector-init failure', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildNetSuiteEnvAuthConfigForTenant, NetSuiteTenantAccountMismatchError } =
      require('../../../../src/services/syncErrorAssist/netsuiteEnvAuth') as {
        buildNetSuiteEnvAuthConfigForTenant: jest.Mock;
        NetSuiteTenantAccountMismatchError: new (...args: unknown[]) => Error;
      };
    stubs.providerRegistry.getAvailableProvider.mockResolvedValueOnce(makeProviderRegistryResult());
    const ns = makeNsConnectorStub();
    stubs.connectorManager.getConnector.mockResolvedValueOnce(ns);
    buildNetSuiteEnvAuthConfigForTenant.mockRejectedValueOnce(
      new NetSuiteTenantAccountMismatchError('acme', 'TENANT_ACCT', 'ENV_ACCT'),
    );

    const outcome = await service.processClaimedRecord({
      claim: makeClaim({ id: 'c-mismatch', tenantId: 'acme' }), tenantId: 'acme',
      errorRecord: makeWebhookPayload(), ctx: identityCtx,
      correlationId: 'corr', source: 'webhook',
    });

    expect(outcome).toBe('failed_retryable');
    expect(buildNetSuiteEnvAuthConfigForTenant).toHaveBeenCalledWith('acme', stubs.repo);
    expect(ns.initialize).not.toHaveBeenCalled();
    expect(stubs.repo.updateFailed).toHaveBeenCalledWith('c-mismatch', 'failed_retryable', 'connector_unavailable');
    expect(stubs.metrics.recordProcessedStatus).toHaveBeenCalledWith('acme', 'failed_retryable');
  });

  it('webhook field-shape mapping: errorMessage/sourcePayload → success path, resolves succeeded', async () => {
    const registryResult = makeProviderRegistryResult();
    registryResult.provider.chat.mockResolvedValueOnce({
      content: '{"confidence":"high","suggestion_type":"manual_review","suggestion_text":"ok"}',
      usage: { totalTokens: 100, estimatedCost: 0.05 },
    });
    stubs.providerRegistry.getAvailableProvider.mockResolvedValueOnce(registryResult);
    stubs.connectorManager.getConnector.mockResolvedValueOnce(makeNsConnectorStub({ createId: 'ns-1' }));

    const outcome = await service.processClaimedRecord({
      claim: makeClaim({ id: 'c-3', tenantId: 'acme' }), tenantId: 'acme',
      errorRecord: makeWebhookPayload({ errorRecordId: 'err-1', errorMessage: 'NS error msg', sourcePayload: { foo: 'bar' } }),
      ctx: identityCtx, correlationId: 'corr', source: 'webhook',
    });
    expect(outcome).toBe('succeeded');
    expect(registryResult.provider.chat).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining('NS error msg') }),
      ]),
      expect.objectContaining({ maxTokens: expect.any(Number), temperature: expect.any(Number) }),
      identityCtx,
    );
  });

  it('polling field-shape mapping: error_message/error_context passes through unchanged, resolves succeeded', async () => {
    const registryResult = makeProviderRegistryResult();
    registryResult.provider.chat.mockResolvedValueOnce({
      content: '{"confidence":"high","suggestion_type":"manual_review","suggestion_text":"ok"}',
      usage: { totalTokens: 100, estimatedCost: 0.05 },
    });
    stubs.providerRegistry.getAvailableProvider.mockResolvedValueOnce(registryResult);
    stubs.connectorManager.getConnector.mockResolvedValueOnce(makeNsConnectorStub({ createId: 'ns-1' }));

    const outcome = await service.processClaimedRecord({
      claim: makeClaim({ id: 'c-4', tenantId: 'acme' }), tenantId: 'acme',
      errorRecord: { id: 'err-poll-1', error_message: 'polling msg', error_context: { p: 1 }, attempt_count: 0 },
      ctx: identityCtx, correlationId: 'corr', source: 'polling', threshold: 'mid',
    });
    expect(outcome).toBe('succeeded');
  });

  it('AC #10 — AI provider exceeds PER_RECORD_TIMEOUT_MS → failed_retryable + persisted via updateFailed', async () => {
    jest.useFakeTimers();
    try {
      const registryResult = makeProviderRegistryResult();
      registryResult.provider.chat.mockImplementationOnce(() => new Promise(() => {}));
      stubs.providerRegistry.getAvailableProvider.mockResolvedValueOnce(registryResult);
      stubs.connectorManager.getConnector.mockResolvedValueOnce(makeNsConnectorStub());

      const claim = makeClaim({ id: 'c-5', tenantId: 'acme', attempts: 1 });
      const promise = service.processClaimedRecord({
        claim, tenantId: 'acme', errorRecord: makeWebhookPayload(),
        ctx: identityCtx, correlationId: 'corr', source: 'webhook',
      });

      await jest.advanceTimersByTimeAsync(SyncErrorAssistService.PER_RECORD_TIMEOUT_MS + 100);
      const outcome = await promise;

      expect(outcome).toBe('failed_retryable');
      expect(stubs.repo.updateFailed).toHaveBeenCalledWith('c-5', 'failed_retryable', expect.any(String));
    } finally {
      jest.useRealTimers();
    }
  });

  it("AC #10 — NetSuite create exceeds PER_RECORD_TIMEOUT_MS → failed_non_retryable (classify.ts:18 contract)", async () => {
    jest.useFakeTimers();
    try {
      const registryResult = makeProviderRegistryResult();
      registryResult.provider.chat.mockResolvedValueOnce({
        content: '{"confidence":"high","suggestion_type":"manual_review","suggestion_text":"ok"}',
        usage: { totalTokens: 100, estimatedCost: 0.05 },
      });
      stubs.providerRegistry.getAvailableProvider.mockResolvedValueOnce(registryResult);
      const slowConnector = makeNsConnectorStub();
      slowConnector.create.mockImplementationOnce(() => new Promise(() => {}));
      stubs.connectorManager.getConnector.mockResolvedValueOnce(slowConnector);

      const promise = service.processClaimedRecord({
        claim: makeClaim({ id: 'c-6', tenantId: 'acme', attempts: 1 }), tenantId: 'acme',
        errorRecord: makeWebhookPayload(), ctx: identityCtx,
        correlationId: 'corr', source: 'webhook',
      });

      await jest.advanceTimersByTimeAsync(SyncErrorAssistService.PER_RECORD_TIMEOUT_MS + 100);
      const outcome = await promise;

      expect(outcome).toBe('failed_non_retryable');
      expect(stubs.repo.updateFailed).toHaveBeenCalledWith('c-6', 'failed_non_retryable', expect.any(String));
    } finally {
      jest.useRealTimers();
    }
  });

  it('Codex R4 — AI returns references_field with only U+200B (zero-width space) → normalized to null', async () => {
    const registryResult = makeProviderRegistryResult();
    // ​ is NOT stripped by ECMAScript .trim(). Without the post-trim Unicode-format
    // sweep, this would be persisted as a non-null but visually-empty field in NetSuite.
    registryResult.provider.chat.mockResolvedValueOnce({
      content: '{"confidence":"low","suggestion_type":"manual_review","suggestion_text":"ok","references_field":"​​​"}',
      usage: { totalTokens: 100, estimatedCost: 0.05 },
    });
    stubs.providerRegistry.getAvailableProvider.mockResolvedValueOnce(registryResult);
    const nsStub = makeNsConnectorStub({ createId: 'ns-zws' });
    stubs.connectorManager.getConnector.mockResolvedValueOnce(nsStub);

    const outcome = await service.processClaimedRecord({
      claim: makeClaim({ id: 'c-zws', tenantId: 'acme', attempts: 1 }), tenantId: 'acme',
      errorRecord: makeWebhookPayload(), ctx: identityCtx,
      correlationId: 'corr', source: 'webhook',
    });

    expect(outcome).toBe('succeeded');
    // Defect 1 — payload must be wrapped in { fields: ... } to match the
    // NetSuiteConnector.formatDataForNetSuite contract.
    expect(nsStub.create).toHaveBeenCalledWith(
      'customrecord_suitecentral_fix_suggestion',
      { fields: expect.objectContaining({ references_field: null }) },
    );
    // Defect 2 — the connector resolved via getConnector() must be initialized
    // (with the env-derived AuthConfig) before it is used, and BEFORE the write.
    expect(nsStub.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'oauth1', credentials: expect.objectContaining({ accountId: 'test-ns-account' }) }),
    );
    expect(nsStub.initialize.mock.invocationCallOrder[0]).toBeLessThan(nsStub.create.mock.invocationCallOrder[0]);
  });

  it('Codex R3 — AI returns references_field with leading/trailing whitespace → trimmed before NetSuite create', async () => {
    const registryResult = makeProviderRegistryResult();
    // The model occasionally returns " item_id " with surrounding whitespace.
    // The transform must normalize to "item_id" so NetSuite field-name matching doesn't break.
    registryResult.provider.chat.mockResolvedValueOnce({
      content: '{"confidence":"high","suggestion_type":"fix_field_value","suggestion_text":"ok","references_field":"  item_id  "}',
      usage: { totalTokens: 100, estimatedCost: 0.05 },
    });
    stubs.providerRegistry.getAvailableProvider.mockResolvedValueOnce(registryResult);
    const nsStub = makeNsConnectorStub({ createId: 'ns-trim' });
    stubs.connectorManager.getConnector.mockResolvedValueOnce(nsStub);

    const outcome = await service.processClaimedRecord({
      claim: makeClaim({ id: 'c-trim', tenantId: 'acme', attempts: 1 }), tenantId: 'acme',
      errorRecord: makeWebhookPayload(), ctx: identityCtx,
      correlationId: 'corr', source: 'webhook',
    });

    expect(outcome).toBe('succeeded');
    expect(nsStub.create).toHaveBeenCalledWith(
      'customrecord_suitecentral_fix_suggestion',
      { fields: expect.objectContaining({ references_field: 'item_id' }) },
    );
  });

  it('Codex R2 — AI returns references_field: "" → normalized to null before NetSuite create (contract compliance)', async () => {
    const registryResult = makeProviderRegistryResult();
    // Valid response, but references_field is an empty string. The schema MUST coerce it
    // to null so downstream consumers don't have to handle two semantically-equal forms.
    registryResult.provider.chat.mockResolvedValueOnce({
      content: '{"confidence":"high","suggestion_type":"manual_review","suggestion_text":"ok","references_field":""}',
      usage: { totalTokens: 100, estimatedCost: 0.05 },
    });
    stubs.providerRegistry.getAvailableProvider.mockResolvedValueOnce(registryResult);
    const nsStub = makeNsConnectorStub({ createId: 'ns-norm' });
    stubs.connectorManager.getConnector.mockResolvedValueOnce(nsStub);

    const outcome = await service.processClaimedRecord({
      claim: makeClaim({ id: 'c-rfnorm', tenantId: 'acme', attempts: 1 }), tenantId: 'acme',
      errorRecord: makeWebhookPayload(), ctx: identityCtx,
      correlationId: 'corr', source: 'webhook',
    });

    expect(outcome).toBe('succeeded');
    // NS.create receives null, NOT "" — verified by inspecting the call args.
    expect(nsStub.create).toHaveBeenCalledWith(
      'customrecord_suitecentral_fix_suggestion',
      { fields: expect.objectContaining({ references_field: null }) },
    );
  });

  it('Codex R1 #3 — AI returns shape-invalid JSON (confidence not in enum) → fails, NS create NOT called, no updateSucceeded', async () => {
    const registryResult = makeProviderRegistryResult();
    // Syntactically valid JSON, but `confidence: "ultra-high"` is NOT in the AI_RESPONSE_SCHEMA enum.
    // Without the Zod parse this would have been persisted to NetSuite verbatim.
    registryResult.provider.chat.mockResolvedValueOnce({
      content: '{"confidence":"ultra-high","suggestion_type":"manual_review","suggestion_text":"ok","references_field":null}',
      usage: { totalTokens: 100, estimatedCost: 0.05 },
    });
    stubs.providerRegistry.getAvailableProvider.mockResolvedValueOnce(registryResult);
    const nsStub = makeNsConnectorStub({ createId: 'ns-X' });
    stubs.connectorManager.getConnector.mockResolvedValueOnce(nsStub);

    const outcome = await service.processClaimedRecord({
      claim: makeClaim({ id: 'c-zod', tenantId: 'acme', attempts: 1 }), tenantId: 'acme',
      errorRecord: makeWebhookPayload(), ctx: identityCtx,
      correlationId: 'corr', source: 'webhook',
    });

    expect(outcome).toMatch(/^failed_/);
    expect(nsStub.create).not.toHaveBeenCalled();
    expect(stubs.repo.updateSucceeded).not.toHaveBeenCalled();
    expect(stubs.metrics.recordSuggestionWritten).not.toHaveBeenCalled();
  });

  it('AC #20 — AI 4xx (classify → failed_non_retryable): returns failed_non_retryable, no updateSucceeded, no recordSuggestionWritten', async () => {
    const registryResult = makeProviderRegistryResult();
    const aiErr = Object.assign(new Error('400 bad request'), { status: 400 });
    registryResult.provider.chat.mockRejectedValueOnce(aiErr);
    stubs.providerRegistry.getAvailableProvider.mockResolvedValueOnce(registryResult);
    stubs.connectorManager.getConnector.mockResolvedValueOnce(makeNsConnectorStub());

    const outcome = await service.processClaimedRecord({
      claim: makeClaim({ id: 'c-7', tenantId: 'acme', attempts: 1 }), tenantId: 'acme',
      errorRecord: makeWebhookPayload(), ctx: identityCtx,
      correlationId: 'corr', source: 'webhook',
    });

    expect(outcome).toBe('failed_non_retryable');
    expect(stubs.repo.updateSucceeded).not.toHaveBeenCalled();
    expect(stubs.metrics.recordSuggestionWritten).not.toHaveBeenCalled();
  });

  it('Copilot R4 — DLP scanText throw in inner failure path: redactedMessage falls back to placeholder, stays in inner catch (does NOT escape to outer catch)', async () => {
    const registryResult = makeProviderRegistryResult();
    // Inner failure: AI chat throws — exercises the failure-path scanText call.
    registryResult.provider.chat.mockRejectedValueOnce(new Error('ai upstream 502'));
    stubs.providerRegistry.getAvailableProvider.mockResolvedValueOnce(registryResult);
    stubs.connectorManager.getConnector.mockResolvedValueOnce(makeNsConnectorStub());
    // DLP scan throws every time — both the success-path call (Codex R1 #2:
    // sanitizeErrorMessageForPrompt) AND the failure-path redaction call must fall back
    // gracefully without escaping to the outer catch (which would overwrite the failure
    // reason with 'unhandled_error').
    stubs.dlpService.scanText.mockRejectedValue(new Error('dlp engine offline'));

    const outcome = await service.processClaimedRecord({
      claim: makeClaim({ id: 'c-dlp', tenantId: 'acme', attempts: 1 }), tenantId: 'acme',
      errorRecord: makeWebhookPayload(), ctx: identityCtx,
      correlationId: 'corr', source: 'webhook',
    });

    // Outer catch never fired → updateFailed reason is the redacted AI message,
    // NOT the 'unhandled_error' literal the outer catch would emit.
    expect(outcome).toMatch(/^failed_/);
    expect(stubs.repo.updateFailed).toHaveBeenCalledWith('c-dlp', expect.any(String), '[redaction-unavailable]');
    expect(stubs.repo.updateFailed).not.toHaveBeenCalledWith('c-dlp', expect.any(String), 'unhandled_error');
  });

  it('R13-3 / outer catch: unexpected throw in collaborator → failed_non_retryable, updateFailed called, no uncaught rejection', async () => {
    stubs.providerRegistry.getAvailableProvider.mockResolvedValueOnce(makeProviderRegistryResult());
    stubs.connectorManager.getConnector.mockResolvedValueOnce(makeNsConnectorStub());
    stubs.traceEngine.startTrace.mockRejectedValueOnce(new Error('trace engine off-the-rails'));

    const outcome = await service.processClaimedRecord({
      claim: makeClaim({ id: 'c-8', tenantId: 'acme', attempts: 3 }), tenantId: 'acme',
      errorRecord: makeWebhookPayload(), ctx: identityCtx,
      correlationId: 'corr', source: 'webhook',
    });

    expect(outcome).toBe('failed_non_retryable');
    expect(stubs.repo.updateFailed).toHaveBeenCalled();
    // Copilot R4 — outer catch must emit recordProcessedStatus mirroring the inner
    // failure paths so unhandled-error rows are visible in processed_status_total.
    expect(stubs.metrics.recordProcessedStatus).toHaveBeenCalledWith('acme', 'failed_non_retryable');
  });

  it('AC #22 / gotcha #46 — outer catch on hostile value (toString throws): logs Error("[unstringifiable error]") + persists', async () => {
    stubs.providerRegistry.getAvailableProvider.mockResolvedValueOnce(makeProviderRegistryResult());
    stubs.connectorManager.getConnector.mockResolvedValueOnce(makeNsConnectorStub());
    const hostile = { toString() { throw new Error('boom from toString'); } };
    stubs.traceEngine.startTrace.mockRejectedValueOnce(hostile);

    const outcome = await service.processClaimedRecord({
      claim: makeClaim({ id: 'c-9', tenantId: 'acme', attempts: 3 }), tenantId: 'acme',
      errorRecord: makeWebhookPayload(), ctx: identityCtx,
      correlationId: 'corr', source: 'webhook',
    });

    expect(outcome).toBe('failed_non_retryable');
    expect(stubs.logger.error).toHaveBeenCalledWith(
      'processClaimedRecord: unhandled error',
      expect.any(Error),
      expect.objectContaining({ tenantId: 'acme', claimId: 'c-9' }),
    );
    const [, errArg] = (stubs.logger.error as jest.Mock).mock.calls.find(
      (c) => c[0] === 'processClaimedRecord: unhandled error',
    )!;
    expect((errArg as Error).message).toBe('[unstringifiable error]');
  });

  /* ==================================================================
   * PR-C3.1a — site #3: failure-path scanText posture migration.
   * The per-record outer-catch redaction call now consumes per-tenant
   * posture at the DECISION layer.
   * ================================================================== */

  it('PR-C3.1a site #3 — posture.allowPII=true: failure-path scanText skipped, raw errorMessage persisted', async () => {
    const registryResult = makeProviderRegistryResult();
    registryResult.provider.chat.mockRejectedValueOnce(new Error('NS upstream 502 for record acct-99'));
    stubs.providerRegistry.getAvailableProvider.mockResolvedValueOnce(registryResult);
    stubs.connectorManager.getConnector.mockResolvedValueOnce(makeNsConnectorStub());
    // Tenant has opted in to allowing PII through this path.
    stubs.governanceService.getPostureForTenant.mockResolvedValue({
      allowPII: true, blockOnDetection: false, autoRedact: true, piiTypes: [],
    });

    const outcome = await service.processClaimedRecord({
      claim: makeClaim({ id: 'c-allow', tenantId: 'acme', attempts: 1 }), tenantId: 'acme',
      errorRecord: makeWebhookPayload(), ctx: identityCtx,
      correlationId: 'corr', source: 'webhook',
    });

    expect(outcome).toMatch(/^failed_/);
    // Failure-path scanText must NOT be called for the redaction step when allowPII=true.
    // It's still permitted to be called by the sanitize* prompt-prep helpers earlier in the path
    // (but those also short-circuit on allowPII=true), so net: scanText for redactedMessage step
    // is skipped. We assert via the persisted reason being the raw message (not a placeholder).
    expect(stubs.repo.updateFailed).toHaveBeenCalledWith(
      'c-allow',
      expect.any(String),
      'NS upstream 502 for record acct-99',
    );
  });

  it('PR-C3.1a site #3 — posture.piiTypes=["ssn"] but error message contains only EMAIL: no redaction, raw persisted', async () => {
    const registryResult = makeProviderRegistryResult();
    registryResult.provider.chat.mockRejectedValueOnce(new Error('Failed sync: user a@b.com'));
    stubs.providerRegistry.getAvailableProvider.mockResolvedValueOnce(registryResult);
    stubs.connectorManager.getConnector.mockResolvedValueOnce(makeNsConnectorStub());
    // Tenant only cares about SSN, not EMAIL.
    stubs.governanceService.getPostureForTenant.mockResolvedValue({
      allowPII: false, blockOnDetection: false, autoRedact: true, piiTypes: ['ssn'],
    });
    // DLP scan returns an email finding (which is NOT on the posture allowlist).
    stubs.dlpService.scanText.mockResolvedValue({
      findings: [{
        type: 'email', value: 'a@b.com', confidence: 0.99,
        location: { path: '' }, severity: 'medium', redactedValue: '[REDACTED:email]',
      }],
      piiTypes: ['email'],
      redactedData: 'Failed sync: user [REDACTED:email]',
    });

    await service.processClaimedRecord({
      claim: makeClaim({ id: 'c-filter', tenantId: 'acme', attempts: 1 }), tenantId: 'acme',
      errorRecord: makeWebhookPayload(), ctx: identityCtx,
      correlationId: 'corr', source: 'webhook',
    });

    // EMAIL filtered out → no relevant findings → raw errorMessage persisted.
    expect(stubs.repo.updateFailed).toHaveBeenCalledWith(
      'c-filter',
      expect.any(String),
      'Failed sync: user a@b.com',
    );
  });

  it('PR-C3.1a site #3 — posture.autoRedact=false with findings: placeholder persisted', async () => {
    const registryResult = makeProviderRegistryResult();
    registryResult.provider.chat.mockRejectedValueOnce(new Error('Failed sync for SSN 123-45-6789'));
    stubs.providerRegistry.getAvailableProvider.mockResolvedValueOnce(registryResult);
    stubs.connectorManager.getConnector.mockResolvedValueOnce(makeNsConnectorStub());
    // Tenant opted OUT of auto-redaction.
    stubs.governanceService.getPostureForTenant.mockResolvedValue({
      allowPII: false, blockOnDetection: false, autoRedact: false, piiTypes: [],
    });
    stubs.dlpService.scanText.mockResolvedValue({
      findings: [{
        type: 'ssn', value: '123-45-6789', confidence: 0.99,
        location: { path: '' }, severity: 'critical', redactedValue: '[REDACTED:ssn]',
      }],
      piiTypes: ['ssn'],
      redactedData: 'Failed sync for SSN [REDACTED:ssn]',
    });

    await service.processClaimedRecord({
      claim: makeClaim({ id: 'c-noredact', tenantId: 'acme', attempts: 1 }), tenantId: 'acme',
      errorRecord: makeWebhookPayload(), ctx: identityCtx,
      correlationId: 'corr', source: 'webhook',
    });

    // autoRedact=false + findings → placeholder (NOT raw, NOT substituted).
    expect(stubs.repo.updateFailed).toHaveBeenCalledWith(
      'c-noredact',
      expect.any(String),
      '[redaction-unavailable]',
    );
  });

  it('PR-C3.1a site #3 — DEFAULT_POSTURE (no per-tenant config): regression-equivalent with pre-C3.1 behavior', async () => {
    const registryResult = makeProviderRegistryResult();
    registryResult.provider.chat.mockRejectedValueOnce(new Error('SSN 123-45-6789 leaked'));
    stubs.providerRegistry.getAvailableProvider.mockResolvedValueOnce(registryResult);
    stubs.connectorManager.getConnector.mockResolvedValueOnce(makeNsConnectorStub());
    // Default posture (the testHelpers builder's default — equivalent to a
    // tenant with no governance.* configs and no per-tenant overrides).
    stubs.dlpService.scanText.mockResolvedValue({
      findings: [{
        type: 'ssn', value: '123-45-6789', confidence: 0.99,
        location: { path: '' }, severity: 'critical', redactedValue: '[REDACTED:ssn]',
      }],
      piiTypes: ['ssn'],
      redactedData: 'SSN [REDACTED:ssn] leaked',
    });

    await service.processClaimedRecord({
      claim: makeClaim({ id: 'c-default', tenantId: 'acme', attempts: 1 }), tenantId: 'acme',
      errorRecord: makeWebhookPayload(), ctx: identityCtx,
      correlationId: 'corr', source: 'webhook',
    });

    // Pre-C3.1 behavior: scanText runs, findings present, redactedData used → substituted.
    expect(stubs.repo.updateFailed).toHaveBeenCalledWith(
      'c-default',
      expect.any(String),
      'SSN [REDACTED:ssn] leaked',
    );
  });
});
