/**
 * Trace-sanitizer suite — DLP sanitization at the recordStep chokepoint.
 * Design: memory ledger project_followup_ledger_reasoning_traces_persist_raw_agent_io.md
 * (DECIDED section, 7 refinements) + docs/superpowers/plans/2026-07-28-reasoning-trace-sanitizer.md.
 * Uses a REAL DLPService (pure, logger-only ctor) so redaction behavior is
 * exercised end-to-end, plus a mock repo to observe exactly what would be
 * persisted.
 */
import 'reflect-metadata';
import { ReasoningTraceEngine } from '../../../../src/services/ai/orchestrator/ReasoningTraceEngine';
import { DLPService } from '../../../../src/services/security/DLPService';
import type { ReasoningStep } from '../../../../src/services/ai/orchestrator/interfaces';
import type { ReasoningTraceRepository } from '../../../../src/database/repositories/ReasoningTraceRepository';
import type { Logger } from '../../../../src/utils/Logger';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as jest.Mocked<Logger>;

function buildRepoMock() {
  return {
    insertSession: jest.fn().mockResolvedValue(undefined),
    updateSession: jest.fn().mockResolvedValue(undefined),
    insertTrace: jest.fn().mockResolvedValue(undefined),
    getSession: jest.fn().mockResolvedValue(null),
    getTracesBySession: jest.fn().mockResolvedValue([]),
    queryTraces: jest.fn().mockResolvedValue([]),
    countSessions: jest.fn().mockResolvedValue(0),
    countBySession: jest.fn().mockResolvedValue(0),
    deleteOlderThan: jest.fn().mockResolvedValue(0),
  } as unknown as jest.Mocked<ReasoningTraceRepository>;
}

function buildStep(overrides: Partial<ReasoningStep> = {}): ReasoningStep {
  return {
    step: 1,
    agent: 'test-agent',
    action: 'execute',
    input: { note: 'benign' },
    output: { result: 'benign' },
    confidence: 0.9,
    reasoning: 'benign reasoning',
    timestamp: new Date(),
    executionTime: 10,
    ...overrides,
  };
}

describe('ReasoningTraceEngine sanitization', () => {
  let dlp: DLPService;

  beforeEach(() => {
    jest.clearAllMocks();
    dlp = new DLPService(mockLogger);
  });

  describe('constructor', () => {
    it('throws when DLPService is missing (fail-closed)', () => {
      const EngineConstructor = ReasoningTraceEngine as unknown as new (
        logger: Logger,
        dlpService?: DLPService
      ) => ReasoningTraceEngine;
      expect(() => new EngineConstructor(mockLogger, undefined)).toThrow(
        /requires DLPService/
      );
    });

    it('constructs with a DLPService and no repo', () => {
      const engine = new ReasoningTraceEngine(mockLogger, dlp);
      expect(engine).toBeDefined();
      engine.destroy();
    });
  });

  describe('recordStep input/output sanitization', () => {
    let engine: ReasoningTraceEngine;
    let repo: jest.Mocked<ReasoningTraceRepository>;

    beforeEach(async () => {
      repo = buildRepoMock();
      engine = new ReasoningTraceEngine(mockLogger, dlp, repo);
      await engine.startTrace('s1', { sourceSystem: 'sf', targetSystem: 'ns' });
    });

    afterEach(() => engine.destroy());

    it('redacts PII in object input before BOTH the in-memory cache and the DB row', async () => {
      const input = {
        sampleData: [{ email: 'jane.doe@example.com', ssn: '123-45-6789' }],
      };
      await engine.recordStep('s1', buildStep({ input }));

      // DB side: the persisted summary is the sanitized serialization
      const row = repo.insertTrace.mock.calls[0][0];
      expect(row.inputSummary).toBeDefined();
      expect(row.inputSummary).not.toContain('jane.doe@example.com');
      expect(row.inputSummary).not.toContain('123-45-6789');

      // Memory side: getSteps serves the sanitized step, not the raw one
      const steps = await engine.getSteps('s1');
      const memJson = JSON.stringify(steps[0].input);
      expect(memJson).not.toContain('jane.doe@example.com');
      expect(memJson).not.toContain('123-45-6789');
    });

    it('redacts PII in output the same way', async () => {
      await engine.recordStep('s1', buildStep({ output: { contact: 'reach me at jane.doe@example.com' } }));
      const row = repo.insertTrace.mock.calls[0][0];
      expect(row.outputSummary).toBeDefined();
      expect(row.outputSummary).not.toContain('jane.doe@example.com');
    });

    it('preserves field-gated context: token redacted in a bank_account field, kept in a version field', async () => {
      // bank_account is one of the six field-gated patterns; the same digit
      // run in a non-bank field must NOT be flagged. (Fixture verified
      // against DLPService.test.ts:1065-1081. Plain `phone` is value-gated,
      // not field-gated, so it cannot prove field context — plan executor
      // note applied: swapped to the gated bank_account fixture.)
      const input = { customer: { bank_account: '12345678' }, meta: { version: '12345678' } };
      await engine.recordStep('s1', buildStep({ input }));
      const row = repo.insertTrace.mock.calls[0][0];
      const parsed = JSON.parse(row.inputSummary as string) as {
        customer: { bank_account: string };
        meta: { version: string };
      };
      expect(parsed.customer.bank_account).not.toBe('12345678'); // gated pattern fired on bank path
      expect(parsed.meta.version).toBe('12345678');              // and NOT on the version path
    });

    it('passes clean values through unchanged (no findings ⇒ no rewrite)', async () => {
      const input = { orderId: 'SO-1042', qty: 3 };
      await engine.recordStep('s1', buildStep({ input }));
      const row = repo.insertTrace.mock.calls[0][0];
      expect(JSON.parse(row.inputSummary as string)).toEqual(input);
    });

    it('scans the canonical toJSON result rather than the original object shape', async () => {
      const input = {
        harmless: true,
        toJSON: () => ({ customer: { email: 'jane.doe@example.com' } }),
      };
      await engine.recordStep('s1', buildStep({ input }));
      const row = repo.insertTrace.mock.calls[0][0];
      expect(row.inputSummary).toBeDefined();
      expect(row.inputSummary).not.toContain('jane.doe@example.com');
      expect(JSON.stringify((await engine.getSteps('s1'))[0].input))
        .not.toContain('jane.doe@example.com');
    });

    it('parses JSON-object strings so field-gated PII is redacted and string type is preserved', async () => {
      const input = JSON.stringify({ customer: { bank_account: '12345678' } });
      await engine.recordStep('s1', buildStep({ input }));
      const row = repo.insertTrace.mock.calls[0][0];
      const persistedString = JSON.parse(row.inputSummary as string);
      expect(typeof persistedString).toBe('string');
      expect(persistedString).not.toContain('12345678');
      expect(typeof (await engine.getSteps('s1'))[0].input).toBe('string');
    });

    it('omits oversize input (>10KB serialized) WITHOUT scanning it', async () => {
      const scanSpy = jest.spyOn(dlp, 'scanForPII');
      const big = { blob: 'x'.repeat(11000) };
      await engine.recordStep('s1', buildStep({ input: big, output: undefined }));
      const row = repo.insertTrace.mock.calls[0][0];
      expect(row.inputSummary).toBeUndefined();
      expect(scanSpy).not.toHaveBeenCalled();
      const steps = await engine.getSteps('s1');
      expect(steps[0].input).toBeUndefined();
    });

    it('enforces the 10KB cap AFTER redaction too (redaction can grow the payload)', async () => {
      // 'a@b.co' redacts to 'a***@b.co' (+2 chars per email), so a
      // just-under-10KB payload grows past the cap after redaction. Assert
      // the invariant: whatever is persisted is ≤10KB and contains no raw
      // email.
      const emails: string[] = [];
      while (JSON.stringify({ emails }).length < 9800) emails.push('a@b.co');
      await engine.recordStep('s1', buildStep({ input: { emails } }));
      const row = repo.insertTrace.mock.calls[0][0];
      if (row.inputSummary !== undefined) {
        expect((row.inputSummary as string).length).toBeLessThanOrEqual(10000);
        expect(row.inputSummary).not.toContain('a@b.co');
      }
    });

    it('keeps free-text strings ONLY in the transient cache, redacted; durable summary omitted', async () => {
      await engine.recordStep('s1', buildStep({
        input: 'contact jane.doe@example.com about the sync',
        output: undefined,
      }));
      const row = repo.insertTrace.mock.calls[0][0];
      expect(row.inputSummary).toBeUndefined();            // DB never holds free text
      const mem = (await engine.getSteps('s1'))[0].input as string;
      expect(mem).toContain('contact');                    // prose retained in memory
      expect(mem).not.toContain('jane.doe@example.com');   // but redacted
    });

    it('keeps clean primitives in the cache with type preserved; durable summary omitted', async () => {
      await engine.recordStep('s1', buildStep({ input: 12345, output: true }));
      const row = repo.insertTrace.mock.calls[0][0];
      expect(row.inputSummary).toBeUndefined();
      expect(row.outputSummary).toBeUndefined();
      const step = (await engine.getSteps('s1'))[0];
      expect(step.input).toBe(12345);
      expect(step.output).toBe(true);
    });

    it('omits null input entirely', async () => {
      await engine.recordStep('s1', buildStep({ input: null, output: undefined }));
      const row = repo.insertTrace.mock.calls[0][0];
      expect(row.inputSummary).toBeUndefined();
      expect((await engine.getSteps('s1'))[0].input).toBeUndefined();
    });

    it('fails closed when scanForPII resolves scanFailed', async () => {
      jest.spyOn(dlp, 'scanForPII').mockResolvedValue({
        detected: false,
        piiTypes: [],
        findings: [],
        riskLevel: 'low',
        recommendation: 'Scan failed - manual review recommended',
        scanFailed: true,
      });
      await engine.recordStep('s1', buildStep({ input: { email: 'jane.doe@example.com' } }));
      const row = repo.insertTrace.mock.calls[0][0];
      expect(row.inputSummary).toBeUndefined();
      expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain('jane.doe@example.com');
    });

    it('fails closed when scanForPII rejects without logging error-message PII', async () => {
      jest.spyOn(dlp, 'scanForPII').mockRejectedValue(
        new Error('scanner failed on jane.doe@example.com')
      );
      const input = { email: 'jane.doe@example.com' };
      await engine.recordStep('s1', buildStep({ input }));
      const row = repo.insertTrace.mock.calls[0][0];
      expect(row.inputSummary).toBeUndefined();
      expect(row.agentName).toBe('test-agent'); // structure still persisted
      const warnJson = JSON.stringify(mockLogger.warn.mock.calls);
      expect(warnJson).not.toContain('jane.doe@example.com');
    });

    it('logs no error-derived content even when the thrown error carries PII in its NAME', async () => {
      // A hostile toJSON() throws during canonicalization; Error.name is
      // mutable, so even err.name is attacker-controlled data.
      const evil = new Error('boom');
      evil.name = 'jane.doe@example.com';
      const input = { toJSON: () => { throw evil; } };
      await engine.recordStep('s1', buildStep({ input, output: undefined }));
      const row = repo.insertTrace.mock.calls[0][0];
      expect(row.inputSummary).toBeUndefined();
      expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain('jane.doe@example.com');
    });
  });

  describe('reasoning: durable placeholder, transient redacted prose', () => {
    let engine: ReasoningTraceEngine;
    let repo: jest.Mocked<ReasoningTraceRepository>;

    beforeEach(async () => {
      repo = buildRepoMock();
      engine = new ReasoningTraceEngine(mockLogger, dlp, repo);
      await engine.startTrace('s1', { sourceSystem: 'sf', targetSystem: 'ns' });
    });

    afterEach(() => engine.destroy());

    it('persists the placeholder to the DB while the cache keeps redacted prose', async () => {
      await engine.recordStep('s1', buildStep({
        reasoning: 'Matched because sample email jane.doe@example.com appeared in both systems',
      }));
      expect(repo.insertTrace.mock.calls[0][0].reasoning)
        .toBe('[reasoning omitted: durable free-text disabled]');
      const mem = (await engine.getSteps('s1'))[0].reasoning;
      expect(mem).toContain('Matched because');            // live explainability retained
      expect(mem).not.toContain('jane.doe@example.com');   // but redacted
    });

    it('truncates >10KB reasoning BEFORE scanning, so served prose was fully scanned', async () => {
      const scanSpy = jest.spyOn(dlp, 'scanText');
      const long = 'a'.repeat(12000) + ' jane.doe@example.com';
      await engine.recordStep('s1', buildStep({ reasoning: long }));
      const mem = (await engine.getSteps('s1'))[0].reasoning;
      expect(mem.length).toBeLessThanOrEqual(10000);
      // buildStep input/output are objects (scanForPII), so the only
      // scanText call is the reasoning scan — and it saw EXACTLY the
      // pre-truncated prefix. A scan-then-truncate implementation would
      // pass a ≤-length check by truncating afterward; prefix equality
      // pins the truncate-BEFORE-scan order itself.
      expect(scanSpy.mock.calls[0][0]).toBe(long.slice(0, 10000));
      expect(mem).not.toContain('jane.doe@example.com');   // fell past the cap entirely
    });

    it('fails closed to the placeholder in BOTH cache and DB when scanText throws', async () => {
      jest.spyOn(dlp, 'scanText').mockRejectedValue(new Error('down'));
      await engine.recordStep('s1', buildStep({ reasoning: 'contains jane.doe@example.com' }));
      expect(repo.insertTrace.mock.calls[0][0].reasoning)
        .toBe('[reasoning omitted: durable free-text disabled]');
      expect((await engine.getSteps('s1'))[0].reasoning)
        .toBe('[reasoning omitted: durable free-text disabled]');
    });

    it('auto-completion still fires from redacted in-memory reasoning', async () => {
      await engine.recordStep('s1', buildStep({
        reasoning: 'final: notified jane.doe@example.com',
      }));
      expect(repo.updateSession).toHaveBeenCalledWith(
        's1',
        expect.objectContaining({ status: 'completed' })
      );
      expect(JSON.stringify(await engine.getTrace('s1'))).not.toContain('jane.doe@example.com');
    });

    it('does NOT auto-complete from a final-marked step 2 that arrives before step 1', async () => {
      // Contiguity guard: [2] alone must not complete; completion fires only
      // once the recorded set is exactly 1..N and the last step signals final.
      await engine.recordStep('s1', buildStep({ step: 2, reasoning: 'final result ready' }));
      expect(repo.updateSession).not.toHaveBeenCalled();
      await engine.recordStep('s1', buildStep({ step: 1, reasoning: 'intermediate work' }));
      expect(repo.updateSession).toHaveBeenCalledWith(
        's1',
        expect.objectContaining({ status: 'completed' })
      );
    });

    it('keeps parallel steps ordered even when step 2 sanitizes first', async () => {
      const realScan = dlp.scanForPII.bind(dlp);
      jest.spyOn(dlp, 'scanForPII').mockImplementation(async (data, policy) => {
        if ((data as { delay?: string }).delay === 'slow') {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        return realScan(data, policy);
      });
      await Promise.all([
        engine.recordStep('s1', buildStep({ step: 1, input: { delay: 'slow' } })),
        engine.recordStep('s1', buildStep({ step: 2, input: { delay: 'fast' } })),
      ]);
      expect((await engine.getSteps('s1')).map(step => step.step)).toEqual([1, 2]);
    });

    it('destroy() clears the cached traces, not just the cleanup timer', async () => {
      const bare = new ReasoningTraceEngine(mockLogger, dlp); // no repo → no lazy-load fallback
      await bare.startTrace('s-destroy', { sourceSystem: 'sf', targetSystem: 'ns' });
      await bare.recordStep('s-destroy', buildStep({ reasoning: 'prose that must not outlive the engine' }));
      bare.destroy();
      expect(await bare.getTrace('s-destroy')).toBeNull();
    });

    it.each([0, -1, 1.5])('rejects step number %p — completion is defined in terms of steps 1..N', async (badStep) => {
      // A step outside 1..N would silently disable the contiguity-guarded
      // auto-completion; reject it loudly at validation instead.
      await expect(engine.recordStep('s1', buildStep({ step: badStep })))
        .rejects.toThrow('Step number must be a positive integer');
    });
  });

  describe('lazy-load defense-in-depth (raw rows from pre-sanitizer or old writers)', () => {
    // Migration 060 nulls pre-sanitizer rows, but a rolling deploy can leave
    // an OLD writer inserting raw rows after 060 ran. The read paths must
    // therefore never trust DB content: everything lazy-loaded is sanitized
    // before it enters the cache or leaves the engine.
    const RAW_ROW = {
      id: 'row-1',
      session_id: 's-cold',
      step_number: 1,
      agent_name: 'agent-a',
      action: 'map_fields',
      input_summary: JSON.stringify({
        sampleData: [{ email: 'jane.doe@example.com', ssn: '123-45-6789' }],
      }),
      output_summary: JSON.stringify({ contact: 'reach jane.doe@example.com' }),
      confidence: 0.8,
      reasoning: 'Matched using sample email jane.doe@example.com from the record',
      timestamp: new Date().toISOString(),
      execution_time: 5,
      user_id: null,
      created_at: new Date().toISOString(),
    };
    const SESSION_ROW = {
      session_id: 's-cold',
      user_id: null,
      workflow_type: null,
      started_at: new Date().toISOString(),
      completed_at: null,
      status: 'running',
      overall_confidence: null,
      total_execution_time: null,
      metadata: { sourceSystem: 'sf', targetSystem: 'ns' },
      created_at: new Date().toISOString(),
    };

    let engine: ReasoningTraceEngine;
    afterEach(() => engine.destroy());

    it('getTrace sanitizes lazy-loaded raw rows before caching or returning them', async () => {
      const repo = buildRepoMock();
      (repo.getSession as jest.Mock).mockResolvedValue(SESSION_ROW);
      (repo.getTracesBySession as jest.Mock).mockResolvedValue([RAW_ROW]);
      engine = new ReasoningTraceEngine(mockLogger, dlp, repo);

      const trace = await engine.getTrace('s-cold');
      const json = JSON.stringify(trace);
      expect(json).not.toContain('jane.doe@example.com');
      expect(json).not.toContain('123-45-6789');
      // Explainability skeleton survives redaction
      expect(trace?.steps[0].reasoning).toContain('Matched using');

      // The CACHED copy (served on every later read) is the sanitized one
      const again = await engine.getTrace('s-cold');
      expect(JSON.stringify(again)).not.toContain('jane.doe@example.com');
    });

    it('getSteps sanitizes lazy-loaded raw rows on the cache-miss path', async () => {
      const repo = buildRepoMock();
      (repo.getTracesBySession as jest.Mock).mockResolvedValue([RAW_ROW]);
      engine = new ReasoningTraceEngine(mockLogger, dlp, repo);

      const steps = await engine.getSteps('s-cold');
      const json = JSON.stringify(steps);
      expect(json).not.toContain('jane.doe@example.com');
      expect(json).not.toContain('123-45-6789');
      expect(steps[0].step).toBe(1);
    });

    it('fails closed on lazy-load when the scanner reports failure — content omitted, skeleton kept', async () => {
      const repo = buildRepoMock();
      (repo.getTracesBySession as jest.Mock).mockResolvedValue([RAW_ROW]);
      jest.spyOn(dlp, 'scanForPII').mockResolvedValue({
        detected: false, piiTypes: [], findings: [], riskLevel: 'low',
        recommendation: 'Scan failed - manual review recommended', scanFailed: true,
      } as unknown as Awaited<ReturnType<DLPService['scanForPII']>>);
      engine = new ReasoningTraceEngine(mockLogger, dlp, repo);

      const steps = await engine.getSteps('s-cold');
      expect(steps[0].input).toBeUndefined();
      expect(steps[0].output).toBeUndefined();
      expect(steps[0].step).toBe(1);
      expect(steps[0].agent).toBe('agent-a');
    });
  });

  describe('completeTrace summary sanitization', () => {
    let engine: ReasoningTraceEngine;
    let repo: jest.Mocked<ReasoningTraceRepository>;

    beforeEach(async () => {
      repo = buildRepoMock();
      engine = new ReasoningTraceEngine(mockLogger, dlp, repo);
      await engine.startTrace('s1', { sourceSystem: 'sf', targetSystem: 'ns' });
    });

    afterEach(() => engine.destroy());

    it('redacts PII in a caller-provided summary (raw error interpolation chokepoint)', async () => {
      // Both producers interpolate raw error text: `Failed: ${workflowError}` /
      // `failed: ${normalizedErr.message}`. An agent error can embed customer
      // data — the chokepoint must redact it before the cache/exportTrace.
      const trace = await engine.completeTrace(
        's1',
        'Failed: could not notify jane.doe@example.com (ssn 123-45-6789)',
        'failed'
      );
      expect(trace?.summary).toContain('Failed:');
      expect(trace?.summary).not.toContain('jane.doe@example.com');
      expect(trace?.summary).not.toContain('123-45-6789');
    });

    it('passes clean summaries through unchanged', async () => {
      const trace = await engine.completeTrace('s1', 'All done');
      expect(trace?.summary).toBe('All done');
    });

    it('fails closed to a fixed placeholder when scanText throws', async () => {
      jest.spyOn(dlp, 'scanText').mockRejectedValue(new Error('down'));
      const trace = await engine.completeTrace('s1', 'contains jane.doe@example.com');
      expect(trace?.summary).toBe('[summary omitted: sanitization failed]');
    });
  });

  describe('tenantId threading', () => {
    it('persists tenantId in session metadata and restores it on lazy-load', async () => {
      const repo = buildRepoMock();
      const engine = new ReasoningTraceEngine(mockLogger, dlp, repo);
      await engine.startTrace('s-tenant', {
        sourceSystem: 'sf',
        targetSystem: 'ns',
        tenantId: 'tenant-42',
      });
      expect(repo.insertSession).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ tenantId: 'tenant-42' }),
        })
      );

      // Lazy-load path: cold engine hydrates tenantId back out of metadata
      const coldRepo = buildRepoMock();
      (coldRepo.getSession as jest.Mock).mockResolvedValue({
        session_id: 's-tenant',
        user_id: null,
        workflow_type: null,
        started_at: new Date().toISOString(),
        completed_at: null,
        status: 'running',
        overall_confidence: null,
        total_execution_time: null,
        metadata: { sourceSystem: 'sf', targetSystem: 'ns', tenantId: 'tenant-42' },
        created_at: new Date().toISOString(),
      });
      const cold = new ReasoningTraceEngine(mockLogger, dlp, coldRepo);
      const trace = await cold.getTrace('s-tenant');
      expect(trace?.metadata.tenantId).toBe('tenant-42');
      cold.destroy();
      engine.destroy();
    });
  });
});
