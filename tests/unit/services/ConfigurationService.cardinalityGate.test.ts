/**
 * ConfigurationService cardinality activation gate (Task 7).
 *
 * Covers the atomic activation-authorization + durable-approval behavior:
 * draft bypass, fail-closed on missing/mismatched context and missing gate,
 * clean activation, blocking no-mutation, override validation, restart
 * durability, sample invalidation, bidirectional audit, disk rollback, and the
 * bulk (importAll) preflight-before-mutation / abort-outcome contract.
 *
 * Uses the REAL filesystem (a fresh mkdtemp dir per test) because the restart
 * proof constructs a second service over the same directory and loads from disk.
 * Schema validation is mocked to always-valid so the gate — not Zod — is what
 * is under test. Blocking/override scenarios are driven through the injected
 * preflight double (the config path's real coordinator only emits flatten +
 * evidence-unavailable findings; see Task 5 known limitation).
 */

import 'reflect-metadata';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

jest.mock('../../../src/schemas/configurationSchemas', () => ({
  validateIntegrationConfig: jest.fn(() => ({ isValid: true, errors: [], warnings: [] })),
}));

import { ConfigurationService } from '../../../src/services/ConfigurationService';
import { BadRequestAppError, ForbiddenAppError, ServiceUnavailableAppError } from '../../../src/errors/AppError';
import { CardinalityViolationError } from '../../../src/errors/CardinalityViolationError';
import { NotFoundError } from '../../../src/errors/NotFoundError';
import type { IntegrationConfig } from '../../../src/types';
import type {
  CardinalityActivationGate,
  ConfigurationActivationGuard,
} from '../../../src/services/ConfigurationService';
import type {
  CardinalityAuthorizationInput,
  CardinalityOverrideRequest,
  ConfigurationCommandContext,
  PreflightRunResult,
} from '../../../src/types/cardinality';
import {
  makeAuditDouble,
  makeCleanPreflight,
  makeFinding,
  makeGateDouble,
  makePreflightRunResult,
  makeReport,
  makeStubPreflight,
  type CardinalityAuditDouble,
} from '../../helpers/cardinalityTestDoubles';

const silentLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as import('../../../src/utils/Logger').Logger;

function makeConfig(overrides: Partial<IntegrationConfig> = {}): IntegrationConfig {
  return {
    id: 'cfg-1',
    tenantId: 'tenant-a',
    name: 'Gate Test Config',
    sourceSystem: 'Salesforce',
    targetSystem: 'NetSuite',
    sourceEntity: 'Account',
    targetEntity: 'Customer',
    syncDirection: 'source_to_target',
    syncMode: 'batch',
    isActive: true,
    fieldMappings: [
      { sourceField: 'Name', targetField: 'companyname', transformationType: 'direct', isRequired: true },
    ],
    sourceAuthentication: { type: 'api_key', credentials: { apiKey: 'k' } },
    ...overrides,
  };
}

function makeCtx(overrides: Partial<ConfigurationCommandContext> = {}): ConfigurationCommandContext {
  return {
    tenantId: 'tenant-a',
    actorUserId: 'user-1',
    correlationId: 'corr-1',
    operation: 'create',
    ...overrides,
  };
}

/** A run with one overrideable blocking finding (key `k1`), fingerprint `fp`. */
function blockingResult(fp = 'fp-1', overrideable = true): PreflightRunResult {
  return makePreflightRunResult({
    blocking: true,
    combinedFingerprint: fp,
    reports: [makeReport({ findings: [makeFinding({ key: 'k1', overrideable, severity: 'blocking' })] })],
  });
}

describe('ConfigurationService cardinality activation gate', () => {
  let dir: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cardgate-'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  function makeService(gate?: CardinalityActivationGate): ConfigurationService {
    return new ConfigurationService(silentLogger, dir, gate);
  }

  describe('draft bypass', () => {
    it('saves a draft without context and never touches the gate', async () => {
      const gate = makeGateDouble();
      const svc = makeService(gate);

      await svc.saveConfiguration(makeConfig({ isActive: false }));

      expect(svc.getConfigurationForTenant('tenant-a', 'cfg-1')).toBeDefined();
      expect(gate.preflight.runForConfig).not.toHaveBeenCalled();
      expect(gate.audit.logCardinalityDecision).not.toHaveBeenCalled();
    });

    it('does not mutate the caller when generating a missing id', async () => {
      const gate = makeGateDouble();
      const svc = makeService(gate);
      const config = makeConfig({ id: '' });

      await svc.saveConfiguration(config, makeCtx());

      expect(config.id).toBe('');
      const saved = svc.getAllConfigurationsForTenant('tenant-a');
      expect(saved).toHaveLength(1);
      expect(saved[0].id).toEqual(expect.any(String));
      expect(gate.preflight.runForConfig).toHaveBeenCalledWith(
        expect.objectContaining({ id: expect.any(String) }),
        undefined,
      );
    });
  });

  describe('fail-closed', () => {
    it('rejects an active save with no command context (403) and writes nothing', async () => {
      const gate = makeGateDouble();
      const svc = makeService(gate);

      await expect(svc.saveConfiguration(makeConfig())).rejects.toBeInstanceOf(ForbiddenAppError);
      expect(gate.preflight.runForConfig).not.toHaveBeenCalled();
      expect(svc.getConfigurationForTenant('tenant-a', 'cfg-1')).toBeUndefined();
    });

    it('rejects an active save whose context tenant does not match the config (403)', async () => {
      const gate = makeGateDouble();
      const svc = makeService(gate);

      await expect(
        svc.saveConfiguration(makeConfig({ tenantId: 'tenant-a' }), makeCtx({ tenantId: 'tenant-b' })),
      ).rejects.toBeInstanceOf(ForbiddenAppError);
      expect(gate.preflight.runForConfig).not.toHaveBeenCalled();
    });

    it('fails closed on an active save when no gate is wired (503)', async () => {
      const svc = makeService(undefined);

      await expect(svc.saveConfiguration(makeConfig(), makeCtx())).rejects.toBeInstanceOf(
        ServiceUnavailableAppError,
      );
      expect(svc.getConfigurationForTenant('tenant-a', 'cfg-1')).toBeUndefined();
    });
  });

  describe('clean activation', () => {
    it('activates with a clean preflight, auditing an allowed decision then a succeeded outcome', async () => {
      const gate = makeGateDouble(makeCleanPreflight());
      const svc = makeService(gate);

      await svc.saveConfiguration(makeConfig(), makeCtx());

      const saved = svc.getConfigurationForTenant('tenant-a', 'cfg-1');
      expect(saved).toBeDefined();
      expect(saved?.cardinalityValidation?.reportFingerprint).toBe('combined-fingerprint');
      expect(gate.audit.logCardinalityDecision).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'allowed', configurationId: 'cfg-1' }),
      );
      expect(gate.audit.logCardinalityOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'succeeded' }),
      );
    });

    it('rechecks cross-tenant ownership after an active preflight await', async () => {
      let resolveFirst!: (result: PreflightRunResult) => void;
      let resolveSecond!: (result: PreflightRunResult) => void;
      const preflight = makeStubPreflight();
      (preflight.runForConfig as jest.Mock)
        .mockImplementationOnce(() => new Promise<PreflightRunResult>(resolve => { resolveFirst = resolve; }))
        .mockImplementationOnce(() => new Promise<PreflightRunResult>(resolve => { resolveSecond = resolve; }));
      const svc = makeService(makeGateDouble(preflight));

      const first = svc.saveConfiguration(makeConfig({ id: 'shared', tenantId: 'tenant-a' }), makeCtx({ tenantId: 'tenant-a' }));
      await Promise.resolve();
      const second = svc.saveConfiguration(makeConfig({ id: 'shared', tenantId: 'tenant-b' }), makeCtx({ tenantId: 'tenant-b' }));
      await Promise.resolve();

      resolveFirst(makePreflightRunResult());
      resolveSecond(makePreflightRunResult());

      const results = await Promise.allSettled([first, second]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
      expect(
        [
          svc.getConfigurationForTenant('tenant-a', 'shared'),
          svc.getConfigurationForTenant('tenant-b', 'shared'),
        ].filter(Boolean),
      ).toHaveLength(1);
    });

    it('audits one decision per direction for a bidirectional config', async () => {
      const gate = makeGateDouble(
        makeStubPreflight(
          makePreflightRunResult({
            reports: [
              makeReport({ direction: 'source_to_target' }),
              makeReport({ direction: 'target_to_source' }),
            ],
          }),
        ),
      );
      const svc = makeService(gate);

      await svc.saveConfiguration(makeConfig({ syncDirection: 'bidirectional' }), makeCtx());

      const directions = (gate.audit.logCardinalityDecision as jest.Mock).mock.calls.map(c => c[0].direction);
      expect(directions).toEqual(['source_to_target', 'target_to_source']);
    });
  });

  describe('blocking findings leave state unchanged', () => {
    it('throws CardinalityViolationError and writes neither memory nor disk', async () => {
      const gate = makeGateDouble(makeStubPreflight(blockingResult()));
      const writeSpy = jest.spyOn(fs, 'writeFile');
      const svc = makeService(gate);

      await expect(svc.saveConfiguration(makeConfig(), makeCtx())).rejects.toBeInstanceOf(
        CardinalityViolationError,
      );

      expect(gate.audit.logCardinalityDecision).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'blocked' }),
      );
      expect(gate.audit.logCardinalityOutcome).not.toHaveBeenCalled();
      expect(svc.getConfigurationForTenant('tenant-a', 'cfg-1')).toBeUndefined();
      expect(writeSpy).not.toHaveBeenCalled();
    });
  });

  describe('override validation', () => {
    function overrideAuth(override: CardinalityOverrideRequest): CardinalityAuthorizationInput {
      return { override };
    }

    it('activates when a valid override covers the overrideable blocking finding', async () => {
      const gate = makeGateDouble(makeStubPreflight(blockingResult('fp-1', true)));
      const svc = makeService(gate);

      await svc.saveConfiguration(
        makeConfig(),
        makeCtx(),
        overrideAuth({ reason: 'known-safe flatten', findingKeys: ['k1'], reportFingerprint: 'fp-1' }),
      );

      const saved = svc.getConfigurationForTenant('tenant-a', 'cfg-1');
      expect(saved?.cardinalityApproval?.findingKeys).toEqual(['k1']);
      expect(saved?.cardinalityApproval?.actorUserId).toBe('user-1');
      expect(gate.audit.logCardinalityDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: 'overridden',
          override: { reason: 'known-safe flatten', scope: ['k1'] },
        }),
      );
    });

    it('never overrides a non-overrideable finding even when it is named', async () => {
      const gate = makeGateDouble(makeStubPreflight(blockingResult('fp-1', false)));
      const svc = makeService(gate);

      await expect(
        svc.saveConfiguration(
          makeConfig(),
          makeCtx(),
          overrideAuth({ reason: 'attempted override', findingKeys: ['k1'], reportFingerprint: 'fp-1' }),
        ),
      ).rejects.toBeInstanceOf(CardinalityViolationError);
    });

    it('rejects an override request with a blank reason (400)', async () => {
      const gate = makeGateDouble(makeStubPreflight(blockingResult('fp-1', true)));
      const svc = makeService(gate);

      await expect(
        svc.saveConfiguration(
          makeConfig(),
          makeCtx(),
          overrideAuth({ reason: '   ', findingKeys: ['k1'], reportFingerprint: 'fp-1' }),
        ),
      ).rejects.toBeInstanceOf(BadRequestAppError);
    });

    it('rejects an override request with a reason shorter than 10 characters (400)', async () => {
      const gate = makeGateDouble(makeStubPreflight(blockingResult('fp-1', true)));
      const svc = makeService(gate);

      await expect(
        svc.saveConfiguration(
          makeConfig(),
          makeCtx(),
          overrideAuth({ reason: 'tooshort', findingKeys: ['k1'], reportFingerprint: 'fp-1' }),
        ),
      ).rejects.toBeInstanceOf(BadRequestAppError);
    });

    it('treats an override with a stale fingerprint as inapplicable (422)', async () => {
      const gate = makeGateDouble(makeStubPreflight(blockingResult('fp-1', true)));
      const svc = makeService(gate);

      await expect(
        svc.saveConfiguration(
          makeConfig(),
          makeCtx(),
          overrideAuth({ reason: 'stale override reason', findingKeys: ['k1'], reportFingerprint: 'OLD-FP' }),
        ),
      ).rejects.toBeInstanceOf(CardinalityViolationError);
    });

    it('ignores a body-supplied actor: the persisted approval uses the verified context actor', async () => {
      const gate = makeGateDouble(makeStubPreflight(blockingResult('fp-1', true)));
      const svc = makeService(gate);

      await svc.saveConfiguration(
        makeConfig(),
        makeCtx({ actorUserId: 'verified-actor' }),
        // A body-supplied actorUserId is not part of CardinalityOverrideRequest; even
        // if smuggled it is dropped — the server authors actor/tenant from context.
        { override: { reason: 'ok override reason', findingKeys: ['k1'], reportFingerprint: 'fp-1' } },
      );

      const saved = svc.getConfigurationForTenant('tenant-a', 'cfg-1');
      expect(saved?.cardinalityApproval?.actorUserId).toBe('verified-actor');
      expect(saved?.cardinalityApproval?.actorTenantId).toBe('tenant-a');
    });
  });

  describe('durable approval', () => {
    it('reuses the persisted approval across a restart when the fingerprint is unchanged', async () => {
      // 1. Activate with an override; the approval persists on disk.
      const gate1 = makeGateDouble(makeStubPreflight(blockingResult('fp-1', true)));
      const svc1 = makeService(gate1);
      await svc1.saveConfiguration(
        makeConfig(),
        makeCtx(),
        { override: { reason: 'first activation', findingKeys: ['k1'], reportFingerprint: 'fp-1' } },
      );

      // 2. A brand-new service over the SAME directory loads from disk.
      const gate2 = makeGateDouble(makeStubPreflight(blockingResult('fp-1', true)));
      const svc2 = makeService(gate2);
      await svc2.loadConfigurations();
      expect(svc2.getConfigurationForTenant('tenant-a', 'cfg-1')?.cardinalityApproval?.findingKeys).toEqual([
        'k1',
      ]);

      // 3. Re-save the unchanged active config WITHOUT a request override — the
      //    persisted approval clears the same blocking finding.
      // saveConfiguration resolves with the PERSISTED record (the create route
      // needs the server-generated id); this assertion only means "the save
      // was allowed by the persisted approval and did not throw".
      await expect(svc2.saveConfiguration(makeConfig(), makeCtx()))
        .resolves.toMatchObject({ id: 'cfg-1', isActive: true });
      expect(gate2.audit.logCardinalityDecision).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'overridden' }),
      );
    });

    it('rejects the reused approval when the fingerprint changed (config drift)', async () => {
      const gate1 = makeGateDouble(makeStubPreflight(blockingResult('fp-1', true)));
      const svc1 = makeService(gate1);
      await svc1.saveConfiguration(
        makeConfig(),
        makeCtx(),
        { override: { reason: 'first activation reason', findingKeys: ['k1'], reportFingerprint: 'fp-1' } },
      );

      // New service, but preflight now reports a DIFFERENT fingerprint.
      const gate2 = makeGateDouble(makeStubPreflight(blockingResult('fp-2', true)));
      const svc2 = makeService(gate2);
      await svc2.loadConfigurations();

      await expect(svc2.saveConfiguration(makeConfig(), makeCtx())).rejects.toBeInstanceOf(
        CardinalityViolationError,
      );
    });

    it('invalidates a sample-derived approval when re-activation omits the samples', async () => {
      // The stub returns fp-A only when samples are present; without them, fp-B.
      const withSamples = blockingResult('fp-A', true);
      const withoutSamples = blockingResult('fp-B', true);
      const sampleAwarePreflight = makeStubPreflight();
      (sampleAwarePreflight.runForConfig as jest.Mock).mockImplementation(
        async (_c: IntegrationConfig, samples?: Record<string, unknown>[]) =>
          samples && samples.length > 0 ? withSamples : withoutSamples,
      );
      const gate = makeGateDouble(sampleAwarePreflight);
      const svc = makeService(gate);

      // Activate with sample A + override bound to fp-A.
      await svc.saveConfiguration(
        makeConfig(),
        makeCtx(),
        {
          samples: [{ email: 'a@example.com' }],
          override: { reason: 'observed collision ok', findingKeys: ['k1'], reportFingerprint: 'fp-A' },
        },
      );
      expect(svc.getConfigurationForTenant('tenant-a', 'cfg-1')?.cardinalityApproval?.reportFingerprint).toBe(
        'fp-A',
      );

      // Re-activate WITHOUT samples → fingerprint fp-B → stored fp-A approval is stale.
      await expect(svc.saveConfiguration(makeConfig(), makeCtx())).rejects.toBeInstanceOf(
        CardinalityViolationError,
      );
    });
  });

  describe('disk rollback', () => {
    it('preserves memory, disk, and approval when the file write fails; failed outcome after the decision row', async () => {
      // v1 activates cleanly and persists.
      const gate = makeGateDouble(makeCleanPreflight());
      const svc = makeService(gate);
      await svc.saveConfiguration(makeConfig({ name: 'V1' }), makeCtx());
      (gate.audit.logCardinalityDecision as jest.Mock).mockClear();
      (gate.audit.logCardinalityOutcome as jest.Mock).mockClear();

      // v2 write is rejected.
      const writeSpy = jest.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('disk full'));

      await expect(
        svc.saveConfiguration(makeConfig({ name: 'V2' }), makeCtx({ operation: 'update' })),
      ).rejects.toThrow(/disk full/);

      // In-memory config unchanged.
      expect(svc.getConfigurationForTenant('tenant-a', 'cfg-1')?.name).toBe('V1');
      // On-disk config unchanged.
      const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'cfg-1.json'), 'utf-8'));
      expect(onDisk.name).toBe('V1');

      // The mandatory decision row was written BEFORE the failed outcome row.
      const decisionOrder = (gate.audit.logCardinalityDecision as jest.Mock).mock.invocationCallOrder[0];
      const outcomeCall = (gate.audit.logCardinalityOutcome as jest.Mock).mock;
      expect(outcomeCall.calls[0]?.[0]).toEqual(expect.objectContaining({ outcome: 'failed' }));
      expect(outcomeCall.invocationCallOrder[0]).toBeGreaterThan(decisionOrder);
      writeSpy.mockRestore();
    });
  });

  describe('importAll bulk gate', () => {
    it('rejects a bulk restore with active members and no command context (403)', async () => {
      const gate = makeGateDouble();
      const svc = makeService(gate);

      await expect(
        svc.importAll({ configurations: [makeConfig({ id: 'a' })] }),
      ).rejects.toBeInstanceOf(ForbiddenAppError);
      expect(svc.getAllConfigurations().length).toBe(0);
    });

    it('preflights every active member and writes them all when all pass', async () => {
      const gate = makeGateDouble(makeCleanPreflight());
      const svc = makeService(gate);

      await svc.importAll(
        { configurations: [makeConfig({ id: 'a' }), makeConfig({ id: 'b' })] },
        makeCtx({ operation: 'bulk_restore' }),
      );

      expect(svc.getConfigurationForTenant('tenant-a', 'a')).toBeDefined();
      expect(svc.getConfigurationForTenant('tenant-a', 'b')).toBeDefined();
      expect(gate.preflight.runForConfig).toHaveBeenCalledTimes(2);
    });

    it('aborts before any mutation when a later active member blocks, recording failed outcomes for staged members', async () => {
      const preflight = makeStubPreflight();
      (preflight.runForConfig as jest.Mock).mockImplementation(async (config: IntegrationConfig) =>
        config.id === 'bad' ? blockingResult('fp-bad') : makePreflightRunResult(),
      );
      const gate: { preflight: typeof preflight; audit: CardinalityAuditDouble } = {
        preflight,
        audit: makeAuditDouble(),
      };
      const svc = makeService(gate);

      await expect(
        svc.importAll(
          { configurations: [makeConfig({ id: 'good' }), makeConfig({ id: 'bad' })] },
          makeCtx({ operation: 'bulk_restore' }),
        ),
      ).rejects.toBeInstanceOf(CardinalityViolationError);

      // No configuration written.
      expect(svc.getAllConfigurations().length).toBe(0);
      // Failed outcome recorded for the earlier (allowed) member.
      expect(gate.audit.logCardinalityOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'failed', configurationId: 'good' }),
      );
      // The blocking member's decision row is 'blocked'.
      expect(gate.audit.logCardinalityDecision).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'blocked', configurationId: 'bad' }),
      );
    });

    it("threads source='import' to the pre-activation guard for every active member (review fix)", async () => {
      const gate = makeGateDouble(makeCleanPreflight());
      const guard: ConfigurationActivationGuard = { assertReady: jest.fn(async () => undefined) };
      const svc = new ConfigurationService(silentLogger, dir, gate, guard);

      await svc.importAll(
        { configurations: [makeConfig({ id: 'a' }), makeConfig({ id: 'b' })] },
        makeCtx({ operation: 'bulk_restore' }),
      );

      expect(guard.assertReady).toHaveBeenCalledTimes(2);
      const sources = (guard.assertReady as jest.Mock).mock.calls.map((call) => call[2]);
      expect(sources).toEqual(['import', 'import']);
    });

    it('a rejecting pre-activation guard aborts the WHOLE batch with ZERO members written to memory or disk (review fix)', async () => {
      const gate = makeGateDouble(makeCleanPreflight());
      const guard: ConfigurationActivationGuard = {
        assertReady: jest.fn(async (config: IntegrationConfig) => {
          if (config.id === 'bad') {
            throw new Error('not ready for import');
          }
        }),
      };
      const svc = new ConfigurationService(silentLogger, dir, gate, guard);

      await expect(
        svc.importAll(
          { configurations: [makeConfig({ id: 'good' }), makeConfig({ id: 'bad' })] },
          makeCtx({ operation: 'bulk_restore' }),
        ),
      ).rejects.toThrow('not ready for import');

      // Zero members written to memory...
      expect(svc.getAllConfigurations().length).toBe(0);
      // ...and zero written to disk.
      const entries = await fs.readdir(dir);
      expect(entries.filter((name) => name.endsWith('.json'))).toHaveLength(0);
    });

    // Copilot R4: closing out the staged members used to happen ONLY on the
    // blocking-findings branch. Every other abort — the activation guard
    // refusing, the preflight coordinator erroring — left the earlier members
    // holding a decision row with no terminal outcome, so the audit chain could
    // not be reconciled. Each abort path is asserted separately because they
    // leave the loop at different points.
    // The guard runs as its OWN pass over every active member before the
    // preflight loop, so a refusal aborts before ANY decision row exists. That
    // is the stronger outcome: rather than pairing decision rows with failed
    // outcomes, there is no audit trail at all for a restore that never began.
    // The catch below it covers the aborts that can only surface mid-loop.
    it('writes NO audit rows at all when the activation GUARD aborts the batch', async () => {
      const gate: { preflight: ReturnType<typeof makeCleanPreflight>; audit: CardinalityAuditDouble } = {
        preflight: makeCleanPreflight(),
        audit: makeAuditDouble(),
      };
      const guard: ConfigurationActivationGuard = {
        assertReady: jest.fn(async (config: IntegrationConfig) => {
          if (config.id === 'bad') throw new Error('not ready for import');
        }),
      };
      const svc = new ConfigurationService(silentLogger, dir, gate, guard);

      await expect(
        svc.importAll(
          { configurations: [makeConfig({ id: 'good' }), makeConfig({ id: 'bad' })] },
          makeCtx({ operation: 'bulk_restore' }),
        ),
      ).rejects.toThrow('not ready for import');

      // The guard refused member 2 before member 1's preflight ever ran, so
      // 'good' has neither a decision row nor an outcome row to reconcile.
      expect(gate.preflight.runForConfig).not.toHaveBeenCalled();
      expect(gate.audit.logCardinalityDecision).not.toHaveBeenCalled();
      expect(gate.audit.logCardinalityOutcome).not.toHaveBeenCalled();
      expect(svc.getAllConfigurations().length).toBe(0);
    });

    // Codex R5 BLOCKS-MERGE. `auditDecisionPerDirection` writes one row PER
    // DIRECTION and awaits each, so a BIDIRECTIONAL member whose first direction
    // persists and whose second throws holds a durable decision row while still
    // absent from `stagedOutcomes`. The flush must close out exactly the
    // directions that got a decision row — and no others, since inventing an
    // outcome for a direction that never had a decision is the mirror-image bug.
    it('closes out the PARTIAL decision rows of the member whose own decision audit fails mid-direction', async () => {
      const preflight = makeStubPreflight();
      (preflight.runForConfig as jest.Mock).mockResolvedValue(
        makePreflightRunResult({
          reports: [
            makeReport({ direction: 'source_to_target' }),
            makeReport({ direction: 'target_to_source' }),
          ],
        }),
      );
      const audit = makeAuditDouble();
      // First direction persists; second throws.
      let decisionCalls = 0;
      (audit.logCardinalityDecision as jest.Mock).mockImplementation(async () => {
        decisionCalls += 1;
        if (decisionCalls === 2) throw new Error('audit sink rejected direction 2');
        return 'audit-1';
      });
      const svc = makeService({ preflight, audit });

      await expect(
        svc.importAll(
          { configurations: [makeConfig({ id: 'partial' })] },
          makeCtx({ operation: 'bulk_restore' }),
        ),
      ).rejects.toThrow('audit sink rejected direction 2');

      // Exactly ONE terminal outcome — for the one direction that got a decision.
      expect(audit.logCardinalityOutcome).toHaveBeenCalledTimes(1);
      expect(audit.logCardinalityOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'failed',
          configurationId: 'partial',
          direction: 'source_to_target',
        }),
      );
      expect(svc.getAllConfigurations().length).toBe(0);
    });

    // The mirror-image guard: when the decision audit fails on the FIRST
    // direction, nothing was written, so nothing may be closed out.
    it('writes no outcome when the decision audit fails before ANY direction lands', async () => {
      const preflight = makeStubPreflight();
      (preflight.runForConfig as jest.Mock).mockResolvedValue(
        makePreflightRunResult({
          reports: [
            makeReport({ direction: 'source_to_target' }),
            makeReport({ direction: 'target_to_source' }),
          ],
        }),
      );
      const audit = makeAuditDouble();
      (audit.logCardinalityDecision as jest.Mock).mockRejectedValue(new Error('audit sink down'));
      const svc = makeService({ preflight, audit });

      await expect(
        svc.importAll(
          { configurations: [makeConfig({ id: 'none' })] },
          makeCtx({ operation: 'bulk_restore' }),
        ),
      ).rejects.toThrow('audit sink down');

      expect(audit.logCardinalityOutcome).not.toHaveBeenCalled();
    });

    // Codex R5 SHOULD-FIX: the failed-outcome reason was hardcoded to
    // 'disk_write_rejected', which is false for an abort where no disk write was
    // ever attempted.
    it('stamps import aborts with import_batch_aborted, not disk_write_rejected', async () => {
      const preflight = makeStubPreflight();
      (preflight.runForConfig as jest.Mock).mockImplementation(async (config: IntegrationConfig) => {
        if (config.id === 'bad') throw new Error('preflight coordinator unavailable');
        return makePreflightRunResult();
      });
      const gate: { preflight: typeof preflight; audit: CardinalityAuditDouble } = {
        preflight,
        audit: makeAuditDouble(),
      };
      const svc = makeService(gate);

      await expect(
        svc.importAll(
          { configurations: [makeConfig({ id: 'good' }), makeConfig({ id: 'bad' })] },
          makeCtx({ operation: 'bulk_restore' }),
        ),
      ).rejects.toThrow('preflight coordinator unavailable');

      expect(gate.audit.logCardinalityOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'failed', reason: 'import_batch_aborted' }),
      );
      expect(gate.audit.logCardinalityOutcome).not.toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'disk_write_rejected' }),
      );
    });

    it('records failed outcomes for staged members when the PREFLIGHT coordinator throws', async () => {
      const preflight = makeStubPreflight();
      (preflight.runForConfig as jest.Mock).mockImplementation(async (config: IntegrationConfig) => {
        if (config.id === 'bad') throw new Error('preflight coordinator unavailable');
        return makePreflightRunResult();
      });
      const gate: { preflight: typeof preflight; audit: CardinalityAuditDouble } = {
        preflight,
        audit: makeAuditDouble(),
      };
      const svc = makeService(gate);

      await expect(
        svc.importAll(
          { configurations: [makeConfig({ id: 'good' }), makeConfig({ id: 'bad' })] },
          makeCtx({ operation: 'bulk_restore' }),
        ),
      ).rejects.toThrow('preflight coordinator unavailable');

      expect(gate.audit.logCardinalityOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'failed', configurationId: 'good' }),
      );
      expect(svc.getAllConfigurations().length).toBe(0);
    });

    // The flush is best-effort and must never replace the real failure — an
    // operator debugging a preflight outage should not be handed an audit error.
    it('rethrows the ORIGINAL abort even when the failed-outcome flush itself fails', async () => {
      const preflight = makeStubPreflight();
      (preflight.runForConfig as jest.Mock).mockImplementation(async (config: IntegrationConfig) => {
        if (config.id === 'bad') throw new Error('preflight coordinator unavailable');
        return makePreflightRunResult();
      });
      const gate: { preflight: typeof preflight; audit: CardinalityAuditDouble } = {
        preflight,
        audit: makeAuditDouble(),
      };
      (gate.audit.logCardinalityOutcome as jest.Mock).mockRejectedValue(new Error('audit sink down'));
      const svc = makeService(gate);

      await expect(
        svc.importAll(
          { configurations: [makeConfig({ id: 'good' }), makeConfig({ id: 'bad' })] },
          makeCtx({ operation: 'bulk_restore' }),
        ),
      ).rejects.toThrow('preflight coordinator unavailable');
    });
  });

  describe('activateConfigurationForTenant (Prerequisite C)', () => {
    it('activates a stored draft through the SAME gate as an active save', async () => {
      const gate = makeGateDouble(makeCleanPreflight());
      const svc = makeService(gate);
      await svc.saveConfiguration(makeConfig({ isActive: false }));

      await svc.activateConfigurationForTenant('tenant-a', 'cfg-1', makeCtx({ operation: 'admin_activation' }));

      const saved = svc.getConfigurationForTenant('tenant-a', 'cfg-1');
      expect(saved?.isActive).toBe(true);
      expect(saved?.cardinalityValidation?.reportFingerprint).toBe('combined-fingerprint');
      expect(gate.preflight.runForConfig).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'cfg-1', isActive: true }),
        undefined,
      );
      expect(gate.audit.logCardinalityOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'succeeded' }),
      );
    });

    it('rejects an unknown configuration id with NotFoundError and writes nothing', async () => {
      const gate = makeGateDouble();
      const svc = makeService(gate);

      await expect(
        svc.activateConfigurationForTenant('tenant-a', 'missing', makeCtx({ operation: 'admin_activation' })),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(gate.preflight.runForConfig).not.toHaveBeenCalled();
    });

    it('rejects a cross-tenant configuration id with the identical NotFoundError as unknown', async () => {
      const gate = makeGateDouble(makeCleanPreflight());
      const svc = makeService(gate);
      await svc.saveConfiguration(makeConfig({ isActive: false, tenantId: 'tenant-a' }));

      await expect(
        svc.activateConfigurationForTenant(
          'tenant-b',
          'cfg-1',
          makeCtx({ tenantId: 'tenant-b', operation: 'admin_activation' }),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      // The owning tenant's draft is untouched.
      expect(svc.getConfigurationForTenant('tenant-a', 'cfg-1')?.isActive).toBe(false);
    });

    it('forwards cardinality authorization (samples) to the fresh preflight run', async () => {
      const gate = makeGateDouble(makeCleanPreflight());
      const svc = makeService(gate);
      await svc.saveConfiguration(makeConfig({ isActive: false }));
      const samples = [{ accountId: 'a-1' }];

      await svc.activateConfigurationForTenant(
        'tenant-a',
        'cfg-1',
        makeCtx({ operation: 'admin_activation' }),
        { samples },
      );

      expect(gate.preflight.runForConfig).toHaveBeenCalledWith(expect.anything(), samples);
    });

    it('rolls back (leaves the stored draft inactive) when the gate blocks', async () => {
      const gate = makeGateDouble(makeStubPreflight(blockingResult()));
      const svc = makeService(gate);
      await svc.saveConfiguration(makeConfig({ isActive: false })); // draft bypasses the gate entirely

      await expect(
        svc.activateConfigurationForTenant('tenant-a', 'cfg-1', makeCtx({ operation: 'admin_activation' })),
      ).rejects.toBeInstanceOf(CardinalityViolationError);

      const saved = svc.getConfigurationForTenant('tenant-a', 'cfg-1');
      expect(saved?.isActive).toBe(false);
      expect(saved?.cardinalityValidation).toBeUndefined();
    });

    it('rolls back (leaves the stored draft inactive) when the preflight coordinator throws', async () => {
      const preflight = makeStubPreflight();
      (preflight.runForConfig as jest.Mock).mockImplementation(async () => {
        throw new Error('coordinator exploded');
      });
      const gate = makeGateDouble(preflight);
      const svc = makeService(gate);
      await svc.saveConfiguration(makeConfig({ isActive: false }));

      await expect(
        svc.activateConfigurationForTenant('tenant-a', 'cfg-1', makeCtx({ operation: 'admin_activation' })),
      ).rejects.toThrow('coordinator exploded');

      expect(svc.getConfigurationForTenant('tenant-a', 'cfg-1')?.isActive).toBe(false);
    });

    it('rolls back (memory AND disk stay the inactive draft) when the file write fails', async () => {
      const gate = makeGateDouble(makeCleanPreflight());
      const svc = makeService(gate);
      await svc.saveConfiguration(makeConfig({ isActive: false }));

      const writeSpy = jest.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('disk full'));

      await expect(
        svc.activateConfigurationForTenant('tenant-a', 'cfg-1', makeCtx({ operation: 'admin_activation' })),
      ).rejects.toThrow(/disk full/);

      expect(svc.getConfigurationForTenant('tenant-a', 'cfg-1')?.isActive).toBe(false);
      const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'cfg-1.json'), 'utf-8'));
      expect(onDisk.isActive).toBe(false);
      writeSpy.mockRestore();
    });

    it("threads source='stored_id' through the optional pre-activation guard extension point", async () => {
      const gate = makeGateDouble(makeCleanPreflight());
      const guard: ConfigurationActivationGuard = { assertReady: jest.fn(async () => undefined) };
      const svc = new ConfigurationService(silentLogger, dir, gate, guard);
      await svc.saveConfiguration(makeConfig({ isActive: false }));

      await svc.activateConfigurationForTenant('tenant-a', 'cfg-1', makeCtx({ operation: 'admin_activation' }));

      expect(guard.assertReady).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'cfg-1', isActive: true }),
        expect.objectContaining({ tenantId: 'tenant-a' }),
        'stored_id',
      );
    });

    it('rolls back (leaves the stored draft inactive) when the pre-activation guard rejects', async () => {
      const gate = makeGateDouble(makeCleanPreflight());
      const guard: ConfigurationActivationGuard = {
        assertReady: jest.fn(async () => {
          throw new ForbiddenAppError('not ready for this source');
        }),
      };
      const svc = new ConfigurationService(silentLogger, dir, gate, guard);
      await svc.saveConfiguration(makeConfig({ isActive: false }));

      await expect(
        svc.activateConfigurationForTenant('tenant-a', 'cfg-1', makeCtx({ operation: 'admin_activation' })),
      ).rejects.toBeInstanceOf(ForbiddenAppError);

      expect(svc.getConfigurationForTenant('tenant-a', 'cfg-1')?.isActive).toBe(false);
      expect(gate.preflight.runForConfig).not.toHaveBeenCalled();
    });

    it('does not thread a guard binding into direct create/update saves as anything but direct_save', async () => {
      const gate = makeGateDouble(makeCleanPreflight());
      const guard: ConfigurationActivationGuard = { assertReady: jest.fn(async () => undefined) };
      const svc = new ConfigurationService(silentLogger, dir, gate, guard);

      await svc.saveConfiguration(makeConfig(), makeCtx());

      expect(guard.assertReady).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'cfg-1' }),
        expect.objectContaining({ tenantId: 'tenant-a' }),
        'direct_save',
      );
    });
  });
});
