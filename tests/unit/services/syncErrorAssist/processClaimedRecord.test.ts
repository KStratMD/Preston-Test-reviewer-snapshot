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
    expect(nsStub.create).toHaveBeenCalledWith(
      'customrecord_suitecentral_fix_suggestion',
      expect.objectContaining({ references_field: null }),
    );
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
      expect.objectContaining({ references_field: 'item_id' }),
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
      expect.objectContaining({ references_field: null }),
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
});
